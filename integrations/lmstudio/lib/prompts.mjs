// Prompt construction and answer parsing for local models.
// The rules below are a condensed, model-facing restatement of archify/SKILL.md's
// Fast authoring path; the schemas and one example are loaded verbatim.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGRAM_TYPES } from './archify-cli.mjs';

// Architecture uses this integration's own grid example (coordinate-free, which
// local models handle far better than pixel `pos`); other types use the Skill's.
const GRID_ARCHITECTURE_EXAMPLE = fileURLToPath(new URL('../examples/architecture.grid.json', import.meta.url));

const EXAMPLE_FOR_TYPE = {
  architecture: GRID_ARCHITECTURE_EXAMPLE,
  workflow: 'agent-tool-call.workflow.json',
  sequence: 'cache-miss-request.sequence.json',
  dataflow: 'event-stream.dataflow.json',
  lifecycle: 'agent-run.lifecycle.json',
};

const GENERAL_RULES = `
- Reply with exactly ONE JSON object and nothing else: no prose, no comments, no Markdown outside a single \`\`\`json fence.
- Follow the JSON Schema exactly. Never invent fields: every object uses "additionalProperties": false.
- The example shows field shape only. Author fresh ids, wording, facts, and layout for the user's request.
- Ids are short lowercase kebab-case and unique within their collection. Every reference (from/to, wraps, focus...) must name an existing id.
- Set "meta.quality_profile": "showcase".
- One obvious main path; short side branches that leave the nearest main-path node. At most 12 primary nodes.
- Keep relationship labels short (1-3 words) but meaningful. Prefer fewer edges over clutter.
- Never draw two relationships between the same pair of nodes in the same direction: their routes and labels overlap.
  Combine them into one relationship with a combined label (for example "read / fill on miss").
- Omit meta.visual_preset, meta.subtitle, meta.legend, meta.engineering_profile, meta.views, meta.output, brand, and sources unless the user explicitly asks for them.
- Do not add via, channelX, channelY, or labelAt unless a validation diagnostic asks for a routing fix.
- Language: write every reader-facing string (title, labels, sublabels, cards) in the user's language.
  Set meta.locale to "en" for English or "zh-CN" for Simplified Chinese. For any other language (for example Japanese) omit meta.locale.
- Keep product names, protocols, API paths, and commands exactly as the user wrote them.`;

const TYPE_RULES = {
  architecture: `
- Prefer grid placement over pixel coordinates: add
  "layout": {"mode": "grid", "cols": <number of columns, max 6>, "gapX": 110, "gapY": 80, "cellW": 150, "cellH": 64}
  and give every component integer "row" and "col" (0-based, col < cols) instead of "pos"/"size". Every (row, col) cell must be unique.
- Size gapX for the longest label on a left-right connection: the clear gap between neighbouring components is gapX + 30 px.
  Estimate a label's width as 7 px per Latin character and 12 px per Japanese/Chinese/Korean character; the clear gap must exceed it by 20 px, so gapX >= label width - 10 (never below 110).
  Example: a 13-character Japanese label is about 156 px wide, so use "gapX": 150.
- Put the main request path on a single row, left to right. Put supporting services (auth, cache, queues) in the row above or below the component that uses them.
- Boundaries only list member ids in "wraps"; they have no coordinates. Only wrap components that sit in adjacent cells.
- Component "type" is one of frontend, backend, database, cloud, security, messagebus, external. Connection "variant" is one of default, emphasis, security, dashed.`,
  workflow: `
- New workflows use "schema_version": 2 with the readable layout contract shown in the example; "col" stays within 0..5.
- Keep edge labels semantic (decisions such as yes/no, retry, approve).`,
  sequence: `
- Participants are ordered left to right as they first appear in the flow. Messages are listed in time order; include return messages.
- If participant labels are long or the diagram is wide, set meta.column_fit to "spread".`,
  dataflow: `
- Arrange stages left to right: sources, ingestion, processing, storage, consumers.`,
  lifecycle: `
- Phase columns 0..4 occupy the main rail; an event/terminal state in column N (0..2) sits exactly beneath main column N + 2.
- A recoverable state uses type "failure" plus a real transition back to the active state.`,
};

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The example is trimmed of optional Viewer features the model should not copy by default. */
function loadExample(archifyRoot, type) {
  const example = readJson(path.resolve(archifyRoot, 'examples', EXAMPLE_FOR_TYPE[type]));
  if (example.meta) {
    delete example.meta.output;
    delete example.meta.views;
    delete example.meta.subtitle;
  }
  return example;
}

export function buildSystemPrompt(archifyRoot, type) {
  if (!DIAGRAM_TYPES.includes(type)) throw new Error(`Unknown diagram type "${type}"`);
  const schema = readJson(path.join(archifyRoot, 'schemas', `${type}.schema.json`));
  const common = readJson(path.join(archifyRoot, 'schemas', 'common.schema.json'));
  const example = loadExample(archifyRoot, type);
  return [
    `You are an expert diagram author for Archify. You write a typed JSON specification for an Archify "${type}" diagram.`,
    `The Archify renderer turns this JSON into an interactive HTML diagram and a strict validator checks schema, layout, and routing.`,
    `\n## Rules${GENERAL_RULES}${TYPE_RULES[type]}`,
    `\n## JSON Schema: ${type}.schema.json\n${JSON.stringify(schema)}`,
    `\n## JSON Schema: common.schema.json (target of every "common.schema.json#/$defs/..." $ref)\n${JSON.stringify(common)}`,
    `\n## Example ${type} specification (structure reference only)\n${JSON.stringify(example, null, 1)}`,
  ].join('\n');
}

export function buildCreateMessage(request) {
  return `Create an Archify diagram for this request:\n\n${request.trim()}\n\nReturn only the complete JSON specification.`;
}

export function buildEditMessage(request, currentSpec) {
  return (
    `Here is the current Archify specification:\n\`\`\`json\n${JSON.stringify(currentSpec, null, 1)}\n\`\`\`\n\n` +
    `Apply this change and keep everything else unless the change requires it:\n\n${request.trim()}\n\n` +
    'Return only the complete updated JSON specification.'
  );
}

const MAX_DIAGNOSTICS = 20;

function compact(value, limit = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Turn a failing validate receipt into a focused repair instruction. */
export function buildRepairMessage(receipt, quality) {
  const lines = [`Archify validation failed (quality profile: ${quality}). Fix these problems:`];
  if (receipt.error) lines.push('', compact(receipt.error, 4000));

  const diagnostics = receipt.diagnostics ?? [];
  if (diagnostics.length) {
    lines.push('', 'Diagnostics:');
    for (const d of diagnostics.slice(0, MAX_DIAGNOSTICS)) {
      let line = `- [${d.code}] ${d.message}`;
      if (d.supportedFixes?.length) line += `\n  supported fixes: ${d.supportedFixes.join('; ')}`;
      if (d.evidence && Object.keys(d.evidence).length) line += `\n  evidence: ${compact(d.evidence)}`;
      lines.push(line);
    }
    if (diagnostics.length > MAX_DIAGNOSTICS) lines.push(`- ...and ${diagnostics.length - MAX_DIAGNOSTICS} more`);
  }

  for (const check of (receipt.checks ?? []).filter((c) => !c.ok)) {
    lines.push(`- failed check "${check.name}": ${compact(check.details ?? [])}`);
  }
  for (const issue of (receipt.composition?.issues ?? []).slice(0, MAX_DIAGNOSTICS)) {
    lines.push(`- composition ${issue.severity ?? 'issue'}: ${compact(issue, 600)}`);
  }

  lines.push(
    '',
    'Change only what these diagnostics name; keep all other content, ids, and wording.',
    'Never delete a meaningful relationship or its label to pass validation: move components, widen gaps, or change sides instead.',
    'If two relationships join the same pair of nodes, merge them into one relationship with a combined label.',
    'Return only the complete corrected JSON specification.',
  );
  return lines.join('\n');
}

/** Turn a failing visual-check receipt into a repair instruction with concrete numbers. */
export function buildVisualRepairMessage(receipt, spec) {
  const lines = [
    'The specification validates, but the delivered HTML failed the browser check at desktop sizes.',
    'The whole page must fit on one screen (no scrolling) at 1440x900, 1600x1000, 1920x1080, and 2048x1320.',
    '',
  ];
  for (const d of (receipt.diagnostics ?? []).slice(0, MAX_DIAGNOSTICS)) {
    lines.push(`- [${d.code}] ${d.message}${d.evidence ? ` evidence: ${compact(d.evidence, 300)}` : ''}`);
  }

  const overflowRatios = (receipt.containment?.viewports ?? [])
    .filter((v) => v.overflowY && v.scrollHeight > 0)
    .map((v) => v.innerHeight / v.scrollHeight);
  if (overflowRatios.length) {
    const ratio = Math.min(...overflowRatios);
    const viewBox = spec.meta?.viewBox;
    lines.push(
      '',
      `The page is too tall: it needs to shrink to about ${Math.round(ratio * 100)}% of its current height relative to its width.`,
      viewBox
        ? `Current meta.viewBox is [${viewBox.join(', ')}]. Make it wider and/or shorter so height/width drops by that factor, and move content up to remove empty space.`
        : 'meta.viewBox is not set, so a tall default canvas is used. Set meta.viewBox explicitly to a wide, short canvas that just contains the content.',
    );
    if (spec.diagram_type === 'sequence' && Array.isArray(spec.messages)) {
      const lastY = Math.max(...spec.messages.map((m) => m.y).filter(Number.isFinite));
      if (Number.isFinite(lastY)) {
        lines.push(
          `For this sequence diagram the last message is at y=${lastY} and lifelines end 65px above the viewBox bottom, ` +
            `so a viewBox of about [1080, ${Math.max(480, Math.ceil((lastY + 120) / 10) * 10)}] fits.`,
        );
      }
    }
    lines.push('Keep fewer or shorter cards if they add height. Do not shrink text or delete meaningful nodes or relationships.');
  }
  lines.push('', 'Return only the complete corrected JSON specification.');
  return lines.join('\n');
}

export function buildClassifyMessages(request) {
  return [
    {
      role: 'system',
      content:
        'Classify a diagram request into exactly one Archify diagram type. Answer with a single word from: ' +
        'architecture (components, services, infrastructure), workflow (processes, approvals, CI/CD, runbooks), ' +
        'sequence (API call chains, request/response order), dataflow (pipelines, ETL, lineage), ' +
        'lifecycle (states and status transitions). ' +
        'If the request explicitly names a kind of diagram in any language, that choice wins: ' +
        'architecture/構成図/架构图, workflow/flowchart/フローチャート/流程图, sequence/シーケンス図/时序图, ' +
        'data flow/データフロー図/数据流图, state diagram/状態遷移図/状态图 = lifecycle.',
    },
    { role: 'user', content: request },
  ];
}

/** Pick the diagram type directly from pasted Mermaid source, if any. */
export function mermaidType(request) {
  if (/^\s*sequenceDiagram\b/m.test(request)) return 'sequence';
  if (/^\s*stateDiagram(-v2)?\b/m.test(request)) return 'lifecycle';
  if (/^\s*(flowchart|graph)\s+(TB|TD|BT|RL|LR)\b/m.test(request)) return 'workflow';
  return null;
}

const NAMED_TYPES = [
  ['lifecycle', /状態遷移図|ステートマシン|状态图|状态机|state[- ](machine|diagram)|lifecycle diagram/i],
  ['sequence', /シーケンス図|时序图|序列图|sequence diagram/i],
  ['dataflow', /データフロー図|数据流图|data[- ]?flow diagram/i],
  ['workflow', /フローチャート|ワークフロー図|流程图|工作流图|flow ?chart|workflow diagram/i],
  ['architecture', /構成図|アーキテクチャー?図|架构图|架構圖|architecture diagram/i],
];

/** Pick the diagram type when the request names it explicitly ("構成図", "sequence diagram"...). */
export function namedType(request) {
  const hits = NAMED_TYPES.map(([type, pattern]) => ({ type, index: request.search(pattern) })).filter((h) => h.index !== -1);
  hits.sort((a, b) => a.index - b.index);
  return hits[0]?.type ?? null;
}

export function parseTypeAnswer(text) {
  const cleaned = stripReasoning(text).toLowerCase();
  let best = null;
  for (const type of DIAGRAM_TYPES) {
    const index = cleaned.indexOf(type);
    if (index !== -1 && (best === null || index < best.index)) best = { type, index };
  }
  return best?.type ?? null;
}

export function stripReasoning(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
}

/** Scan for a balanced {...} starting at `start`, respecting JSON strings. */
function balancedObjectAt(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function tryParse(candidate) {
  for (const text of [candidate, candidate.replace(/,(\s*[}\]])/g, '$1')]) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // try the next repair
    }
  }
  return null;
}

/** Extract the specification object from a model answer (fenced, bare, or wrapped in prose). */
export function extractJsonObject(answer) {
  const text = stripReasoning(answer);
  const candidates = [];
  for (const match of text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) candidates.push(match[1]);
  for (let i = text.indexOf('{'); i !== -1 && candidates.length < 12; i = text.indexOf('{', i + 1)) {
    const block = balancedObjectAt(text, i);
    if (block) {
      candidates.push(block);
      i += block.length - 1;
    }
  }
  const parsed = candidates
    .map(tryParse)
    .filter(Boolean)
    .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
  if (!parsed.length) throw new Error('The model answer did not contain a parseable JSON object.');
  return parsed.find((value) => value.diagram_type) ?? parsed[0];
}
