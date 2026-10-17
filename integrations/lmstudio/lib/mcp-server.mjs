// Dependency-free MCP (stdio, newline-delimited JSON-RPC) server so a model
// chatting inside LM Studio can author Archify diagrams itself:
//   archify_authoring_guide -> schema + example + rules for one diagram type
//   archify_render          -> validate, and deliver HTML when validation passes
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { assessReceipt, deliver, DIAGRAM_TYPES, guide, validate, visualCheck } from './archify-cli.mjs';
import { buildRepairMessage, buildSystemPrompt, buildVisualRepairMessage, mermaidType, namedType } from './prompts.mjs';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'archify_authoring_guide',
    description:
      'Call this FIRST before writing an Archify diagram. Returns the rules, JSON Schema, and an example for one diagram type. ' +
      'Pass "type" if known, otherwise pass "request" and the best type is chosen for you.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: DIAGRAM_TYPES, description: 'Diagram type, if already known.' },
        request: { type: 'string', description: "The user's diagram request, used to pick a type when none is given." },
      },
    },
  },
  {
    name: 'archify_render',
    description:
      'Validate an Archify JSON specification and, if it passes, write the interactive HTML diagram. ' +
      'On failure it returns diagnostics: fix exactly what they name and call this tool again with the complete corrected specification.',
    inputSchema: {
      type: 'object',
      required: ['spec'],
      properties: {
        spec: { type: 'object', description: 'The complete Archify specification JSON object.' },
        name: { type: 'string', description: 'Output file name without extension, e.g. "checkout-architecture".' },
        quality: { type: 'string', enum: ['showcase', 'standard'], description: 'Default showcase.' },
      },
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function safeName(name, type) {
  const cleaned = String(name ?? '')
    .replace(/\.(html?|json)$/i, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || `${type}-${Date.now()}`;
}

export function createArchifyMcpHandlers({ archifyRoot, outDir = path.join(os.homedir(), 'archify-out'), open = false }) {
  async function authoringGuide({ type, request } = {}) {
    let chosen = type;
    if (!chosen && request) {
      chosen = mermaidType(request) ?? namedType(request);
      if (!chosen) {
        try {
          chosen = (await guide(archifyRoot, request)).recommendation?.type;
        } catch {
          // fall through to the default below
        }
      }
    }
    if (!DIAGRAM_TYPES.includes(chosen)) chosen = 'architecture';
    return textResult(
      `Diagram type: ${chosen}\n` +
        `When the specification is ready, call archify_render with it as "spec".\n\n` +
        buildSystemPrompt(archifyRoot, chosen),
    );
  }

  async function render({ spec, name, quality = 'showcase' } = {}) {
    if (typeof spec === 'string') {
      try {
        spec = JSON.parse(spec);
      } catch {
        return textResult('"spec" must be a JSON object (the complete Archify specification).', true);
      }
    }
    if (!spec || typeof spec !== 'object') return textResult('"spec" is required.', true);
    const type = spec.diagram_type;
    if (!DIAGRAM_TYPES.includes(type)) {
      return textResult(`spec.diagram_type must be one of: ${DIAGRAM_TYPES.join(', ')}`, true);
    }
    if (!['showcase', 'standard'].includes(quality)) quality = 'showcase';

    mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, safeName(name ?? spec.meta?.title, type));
    const candidatePath = `${base}.candidate.json`;
    writeFileSync(candidatePath, JSON.stringify(spec, null, 2) + '\n');
    let receipt;
    try {
      receipt = await validate(archifyRoot, type, candidatePath, quality);
    } finally {
      rmSync(candidatePath, { force: true });
    }
    if (!assessReceipt(receipt, quality).pass) {
      return textResult(buildRepairMessage(receipt, quality), true);
    }

    const specPath = `${base}.json`;
    const htmlPath = `${base}.html`;
    writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
    const delivered = await deliver(archifyRoot, type, specPath, htmlPath, quality, { open });
    if (!delivered.ok) return textResult(`Delivery failed: ${delivered.error ?? 'unknown error'}`, true);
    const browser = await visualCheck(archifyRoot, htmlPath);
    if (browser.status === 'fail') {
      return textResult(
        `The HTML was written to ${htmlPath}, but it does not fit desktop screens yet.\n\n` +
          buildVisualRepairMessage(browser, spec) +
          `\nThen call archify_render again with the same name.`,
        true,
      );
    }
    return textResult(
      `Delivered ${type} diagram (${quality} quality, browser check: ${browser.status}).\nHTML: ${htmlPath}\nSpec: ${specPath}\n` +
        `Tell the user the HTML path; they can open it in a browser.`,
    );
  }

  return { archify_authoring_guide: authoringGuide, archify_render: render };
}

export function startMcpServer(options, { input = process.stdin, output = process.stdout } = {}) {
  const handlers = createArchifyMcpHandlers(options);
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);

  async function dispatch(message) {
    const { id, method, params } = message;
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'archify', version: '0.1.0' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const handler = handlers[params?.name];
        if (!handler) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
        try {
          return await handler(params.arguments ?? {});
        } catch (error) {
          return textResult(`archify error: ${error.message}`, true);
        }
      }
      default:
        if (id === undefined) return undefined; // notification
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      const result = await dispatch(message);
      if (message.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } });
      }
    }
  });
  return lines;
}
