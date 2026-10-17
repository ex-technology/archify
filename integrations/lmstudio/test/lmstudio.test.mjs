import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessReceipt, resolveArchifyRoot, validate } from '../lib/archify-cli.mjs';
import { generateDiagram } from '../lib/generate.mjs';
import { LMStudioClient } from '../lib/lmstudio-client.mjs';
import { buildSystemPrompt, extractJsonObject, mermaidType, namedType, parseTypeAnswer } from '../lib/prompts.mjs';

const archifyRoot = resolveArchifyRoot();
const gridExamplePath = fileURLToPath(new URL('../examples/architecture.grid.json', import.meta.url));
const validExample = JSON.parse(readFileSync(gridExamplePath, 'utf8'));

describe('answer parsing', () => {
  test('extracts fenced JSON after reasoning', () => {
    const answer = '<think>plan {not json}</think>Here you go:\n```json\n{"diagram_type":"workflow","a":[1,2,]}\n```';
    assert.deepEqual(extractJsonObject(answer), { diagram_type: 'workflow', a: [1, 2] });
  });

  test('extracts a bare object wrapped in prose, ignoring braces inside strings', () => {
    const answer = 'Sure! {"meta":{"title":"a } b"},"diagram_type":"sequence"} Hope it helps {x}';
    assert.deepEqual(extractJsonObject(answer), { meta: { title: 'a } b' }, diagram_type: 'sequence' });
  });

  test('rejects answers without JSON', () => {
    assert.throws(() => extractJsonObject('I cannot do that.'), /parseable JSON/);
  });

  test('reads a type from a classifier answer', () => {
    assert.equal(parseTypeAnswer('<think>maybe workflow?</think>Sequence.'), 'sequence');
    assert.equal(parseTypeAnswer('no idea'), null);
  });

  test('maps Mermaid headers to diagram types', () => {
    assert.equal(mermaidType('sequenceDiagram\n A->>B: hi'), 'sequence');
    assert.equal(mermaidType('stateDiagram-v2\n [*] --> A'), 'lifecycle');
    assert.equal(mermaidType('flowchart LR\n A --> B'), 'workflow');
    assert.equal(mermaidType('Redis cache in front of Postgres'), null);
  });

  test('honours an explicitly named diagram kind in any language', () => {
    assert.equal(namedType('Webリクエストの構成図: ブラウザがAPIを呼び出す'), 'architecture');
    assert.equal(namedType('ログイン処理のシーケンス図を描いて'), 'sequence');
    assert.equal(namedType('注文の状態遷移図'), 'lifecycle');
    assert.equal(namedType('Draw a sequence diagram of the architecture diagram tool'), 'sequence');
    assert.equal(namedType('画一个数据流图'), 'dataflow');
    assert.equal(namedType('Browser calls the API'), null);
  });
});

describe('prompt and receipts', () => {
  test('system prompt embeds the schema, common schema, and a trimmed example', () => {
    for (const type of ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']) {
      const prompt = buildSystemPrompt(archifyRoot, type);
      assert.match(prompt, new RegExp(`${type}\\.schema\\.json`));
      assert.match(prompt, /common\.schema\.json/);
      const example = prompt.slice(prompt.indexOf('## Example'));
      assert.match(example, new RegExp(`"diagram_type": "${type}"`));
      assert.doesNotMatch(example, /"views":|"output":/);
    }
    assert.match(buildSystemPrompt(archifyRoot, 'architecture').slice(-3000), /"mode": "grid"/);
  });

  test('the bundled grid architecture example passes showcase validation', async () => {
    const receipt = await validate(archifyRoot, 'architecture', gridExamplePath, 'showcase');
    assert.equal(assessReceipt(receipt, 'showcase').pass, true, receipt.error);
    assert.equal(receipt.checks.length, 9);
  });

  test('schema errors outweigh geometry issues', () => {
    const schema = assessReceipt({ ok: false, diagnostics: [{ code: 'schema/required', severity: 'error' }] }, 'showcase');
    const geometry = assessReceipt(
      { ok: false, diagnostics: [1, 2, 3].map(() => ({ code: 'clean-flow/edge-through-node', severity: 'error' })) },
      'showcase',
    );
    assert.ok(schema.score > geometry.score);
    assert.equal(assessReceipt({ ok: true, checks: [], composition: { summary: { errors: 0, warnings: 0 } } }, 'showcase').pass, true);
    assert.equal(assessReceipt({ ok: true, checks: [], composition: { summary: { errors: 0, warnings: 1 } } }, 'showcase').pass, false);
  });
});

describe('generate loop against a mock LM Studio server', () => {
  let server;
  let baseUrl;
  let workDir;
  const requests = [];
  let answers = [];

  before(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'archify-lmstudio-'));
    server = createServer(async (req, res) => {
      if (req.url === '/api/v0/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'idle-model', type: 'llm', state: 'not-loaded' }, { id: 'mock-model', type: 'llm', state: 'loaded' }] }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const answer = answers.shift() ?? '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Split the answer across several SSE events, including a reasoning delta.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] })}\n\n`);
      for (let i = 0; i < answer.length; i += 50) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(i, i + 50) } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });

  after(() => {
    server.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  test('repairs a schema-invalid answer using Archify diagnostics, then delivers HTML', async () => {
    requests.length = 0;
    const broken = structuredClone(validExample);
    broken.components[0].type = 'person';
    answers = ['```json\n' + JSON.stringify(broken) + '\n```', JSON.stringify(validExample)];

    const out = path.join(workDir, 'web.html');
    const result = await generateDiagram({
      client: new LMStudioClient({ baseUrl }),
      archifyRoot,
      request: 'Browser -> API -> Redis, cache miss -> Postgres',
      type: 'architecture',
      out,
    });

    assert.equal(result.ok, true, result.message);
    assert.equal(result.model, 'mock-model');
    assert.equal(result.quality, 'showcase');
    assert.ok(existsSync(out));
    assert.ok(existsSync(result.specPath));
    assert.ok(!existsSync(path.join(workDir, 'web.candidate.json')));
    assert.equal(requests.length, 2);
    const repair = requests[1].messages.at(-1).content;
    assert.match(repair, /schema\/enum/);
    assert.match(repair, /\/components\/0\/type/);
    assert.equal(requests[1].messages.at(-2).role, 'assistant');
  });

  test('feeds browser-check overflow back to the model and delivers the fitted version', async (t) => {
    const tall = JSON.parse(readFileSync(new URL('./fixtures/sequence-tall-canvas.json', import.meta.url), 'utf8'));
    const fitted = structuredClone(tall);
    fitted.meta.viewBox = [1080, 480];
    requests.length = 0;
    answers = [JSON.stringify(tall), JSON.stringify(fitted)];

    const result = await generateDiagram({
      client: new LMStudioClient({ baseUrl }),
      archifyRoot,
      request: 'Webリクエストのシーケンス図',
      out: path.join(workDir, 'seq.html'),
    });
    if (result.browserCheck === 'skipped') return t.skip('Chrome is not available for visual-check');

    assert.equal(result.ok, true, result.message);
    assert.equal(result.type, 'sequence');
    assert.equal(result.browserCheck, 'pass');
    assert.equal(requests.length, 2);
    const feedback = requests[1].messages.at(-1).content;
    assert.match(feedback, /viewer\/viewport-overflow/);
    assert.ok(feedback.includes('[1080, 480]'), feedback);
    assert.deepEqual(JSON.parse(readFileSync(result.specPath, 'utf8')).meta.viewBox, [1080, 480]);
  });

  test('keeps the best rejected candidate and never overwrites the spec when repairs stall', async () => {
    const specPath = path.join(workDir, 'keep.json');
    writeFileSync(specPath, JSON.stringify(validExample));
    const before = readFileSync(specPath, 'utf8');
    const broken = structuredClone(validExample);
    broken.components[0].type = 'person';
    answers = [JSON.stringify(broken), JSON.stringify(broken), JSON.stringify(broken), 'no json here'];

    const result = await generateDiagram({
      client: new LMStudioClient({ baseUrl }),
      archifyRoot,
      request: 'Rename Users to Customers',
      fromSpec: specPath,
      maxRepairs: 3,
    });

    assert.equal(result.ok, false);
    assert.equal(readFileSync(specPath, 'utf8'), before);
    assert.ok(existsSync(result.rejectedPath));
    assert.equal(JSON.parse(readFileSync(result.rejectedPath, 'utf8')).components[0].type, 'person');
  });
});
