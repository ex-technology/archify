#!/usr/bin/env node
// Generate Archify diagrams with a local model served by LM Studio.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DIAGRAM_TYPES, resolveArchifyRoot } from '../lib/archify-cli.mjs';
import { generateDiagram } from '../lib/generate.mjs';
import { DEFAULT_BASE_URL, LMStudioClient } from '../lib/lmstudio-client.mjs';

const HELP = `Usage:
  archify-lmstudio "<what to diagram>" [options]
  archify-lmstudio --input request.txt [options]      (use --input - to read stdin)
  archify-lmstudio --edit diagram.json "<change>"     (revise an existing specification)
  archify-lmstudio --list-models

Options:
  -t, --type <type>        ${DIAGRAM_TYPES.join(' | ')} (default: auto-detect)
  -o, --out <file.html>    output HTML; the specification is written next to it as .json
                           (default: ./archify-out/<type>-<timestamp>.html, or next to --edit)
  -m, --model <id>         LM Studio model id (default: $LMSTUDIO_MODEL, else the loaded model)
      --base-url <url>     LM Studio API base (default: $LMSTUDIO_BASE_URL or ${DEFAULT_BASE_URL})
      --api-key <key>      API token if LM Studio auth is enabled (default: $LMSTUDIO_API_KEY)
      --quality <profile>  showcase | standard (default: showcase)
      --strict             never fall back from showcase to standard quality
      --max-repairs <n>    repair rounds after the first answer (default: 4)
      --temperature <t>    sampling temperature (default: 0.2)
      --max-tokens <n>     completion token limit (default: LM Studio's setting)
      --no-visual-check    skip the headless-Chrome check that the page fits desktop screens
      --open               open the delivered HTML in the browser
      --archify-root <dir> Archify Skill directory (default: $ARCHIFY_ROOT or this repository's archify/)
      --json               print the final result as JSON on stdout
  -h, --help`;

function fail(message) {
  process.stderr.write(`archify-lmstudio: ${message}\n`);
  process.exit(1);
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function number(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`--${name} must be a number`);
  return parsed;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    type: { type: 'string', short: 't' },
    input: { type: 'string', short: 'i' },
    edit: { type: 'string' },
    out: { type: 'string', short: 'o' },
    model: { type: 'string', short: 'm' },
    'base-url': { type: 'string' },
    'api-key': { type: 'string' },
    quality: { type: 'string', default: 'showcase' },
    strict: { type: 'boolean', default: false },
    'max-repairs': { type: 'string' },
    temperature: { type: 'string' },
    'max-tokens': { type: 'string' },
    open: { type: 'boolean', default: false },
    'no-visual-check': { type: 'boolean', default: false },
    'archify-root': { type: 'string' },
    'list-models': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const client = new LMStudioClient({
  baseUrl: values['base-url'] ?? process.env.LMSTUDIO_BASE_URL ?? DEFAULT_BASE_URL,
  apiKey: values['api-key'] ?? process.env.LMSTUDIO_API_KEY ?? 'lm-studio',
});

if (values['list-models']) {
  try {
    for (const m of await client.listModels()) {
      process.stdout.write(`${m.loaded ? '*' : ' '} ${m.id}\n`);
    }
    process.stdout.write('\n(* = currently loaded)\n');
    process.exit(0);
  } catch (error) {
    fail(`cannot list models at ${client.baseUrl}: ${error.message}`);
  }
}

if (values.type && !DIAGRAM_TYPES.includes(values.type)) fail(`--type must be one of ${DIAGRAM_TYPES.join(', ')}`);
if (!['showcase', 'standard'].includes(values.quality)) fail('--quality must be showcase or standard');

let request = positionals.join(' ');
if (values.input) request = [values.input === '-' ? readStdin() : readFileSync(values.input, 'utf8'), request].join('\n').trim();
if (!request.trim()) fail(values.edit ? 'describe the change to apply to the specification' : `nothing to diagram.\n\n${HELP}`);

let archifyRoot;
try {
  archifyRoot = resolveArchifyRoot(values['archify-root']);
} catch (error) {
  fail(error.message);
}

// Progress: one self-overwriting status line on an interactive stderr.
const interactive = process.stderr.isTTY;
let progressShown = false;
const clearProgress = () => {
  if (progressShown) process.stderr.write('\r\x1b[2K');
  progressShown = false;
};
const log = (line) => {
  clearProgress();
  process.stderr.write(`${line}\n`);
};
const onProgress = interactive
  ? ({ kind, chars }) => {
      process.stderr.write(`\r\x1b[2K  ${kind === 'reasoning' ? 'thinking' : 'writing'}... ${chars} chars`);
      progressShown = true;
    }
  : undefined;

try {
  const result = await generateDiagram({
    client,
    archifyRoot,
    request,
    fromSpec: values.edit,
    type: values.type,
    out: values.out,
    model: values.model ?? process.env.LMSTUDIO_MODEL,
    quality: values.quality,
    allowFallback: !values.strict,
    maxRepairs: number(values['max-repairs'], 'max-repairs') ?? 4,
    temperature: number(values.temperature, 'temperature') ?? 0.2,
    maxTokens: number(values['max-tokens'], 'max-tokens'),
    open: values.open,
    visual: !values['no-visual-check'],
    log,
    onProgress,
  });
  clearProgress();

  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!result.ok) {
    process.stderr.write(`\nCould not produce a valid diagram.\n`);
    if (result.rejectedPath) process.stderr.write(`Best candidate kept for inspection: ${result.rejectedPath}\n`);
    if (result.message) process.stderr.write(`\n${result.message}\n`);
    process.exit(1);
  }
  if (!values.json && result.unresolvedShowcaseIssues) {
    process.stderr.write(
      '\nNote: delivered at standard quality. These showcase issues remain and may be visible ' +
        '(use --edit to ask for a fix, or --strict to refuse the fallback):\n' +
        `${result.unresolvedShowcaseIssues}\n`,
    );
  }
  if (!values.json && result.browserIssues?.length) {
    process.stderr.write(
      '\nNote: the browser check found layout problems that may be visible (use --edit to ask for a fix):\n' +
        result.browserIssues.map((issue) => `  - ${issue}`).join('\n') +
        '\n',
    );
  }
  if (!values.json) {
    process.stdout.write(
      [
        '',
        `Delivered ${result.type} diagram (${result.quality} quality) with ${result.model}`,
        `  HTML: ${result.htmlPath}`,
        `  Spec: ${result.specPath}`,
        `  Artifact sha256: ${result.receipt.artifact?.sha256}`,
        `  Browser check: ${result.browserCheck}`,
        '',
        `Revise it with: archify-lmstudio --edit "${result.specPath}" "<change>"`,
        '',
      ].join('\n'),
    );
  }
} catch (error) {
  clearProgress();
  fail(error.message);
}
