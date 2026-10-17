import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../bin/archify-mcp.mjs', import.meta.url));
const example = JSON.parse(readFileSync(new URL('../examples/architecture.grid.json', import.meta.url), 'utf8'));

let child;
let outDir;
let nextId = 1;
const pending = new Map();

function call(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

before(() => {
  outDir = mkdtempSync(path.join(tmpdir(), 'archify-mcp-'));
  child = spawn(process.execPath, [serverPath], { env: { ...process.env, ARCHIFY_OUT_DIR: outDir } });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
});

after(() => {
  child.kill();
  rmSync(outDir, { recursive: true, force: true });
});

test('speaks MCP over stdio and lists both tools', async () => {
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } });
  assert.equal(init.result.serverInfo.name, 'archify');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const { result } = await call('tools/list');
  assert.deepEqual(result.tools.map((t) => t.name), ['archify_authoring_guide', 'archify_render']);
  const unknown = await call('nope/method');
  assert.equal(unknown.error.code, -32601);
});

test('authoring guide picks a type from a Mermaid request', async () => {
  const { result } = await call('tools/call', {
    name: 'archify_authoring_guide',
    arguments: { request: 'sequenceDiagram\n  Browser->>API: GET /orders' },
  });
  assert.match(result.content[0].text, /^Diagram type: sequence/);
  assert.match(result.content[0].text, /sequence\.schema\.json/);
});

test('render returns diagnostics for an invalid spec and HTML for a valid one', async () => {
  const broken = structuredClone(example);
  broken.components[0].type = 'person';
  const failed = await call('tools/call', { name: 'archify_render', arguments: { spec: broken, name: 'orders' } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /schema\/enum/);
  assert.ok(!existsSync(path.join(outDir, 'orders.html')));

  const ok = await call('tools/call', { name: 'archify_render', arguments: { spec: example, name: '../escape/orders' } });
  assert.equal(ok.result.isError, undefined, ok.result.content[0].text);
  assert.ok(existsSync(path.join(outDir, 'escape-orders.html')));
  assert.ok(existsSync(path.join(outDir, 'escape-orders.json')));
});
