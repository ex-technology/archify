// Generate -> validate -> deliver -> browser-check -> repair loop driven by a local LM Studio model.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assessReceipt, deliver, DIAGRAM_TYPES, guide, validate, visualCheck } from './archify-cli.mjs';
import {
  buildClassifyMessages,
  buildCreateMessage,
  buildEditMessage,
  buildRepairMessage,
  buildSystemPrompt,
  buildVisualRepairMessage,
  extractJsonObject,
  mermaidType,
  namedType,
  parseTypeAnswer,
} from './prompts.mjs';

const NOT_JSON_FEEDBACK =
  'Your answer did not contain a valid JSON object. Reply with only the complete JSON specification in a single ```json fence.';

/**
 * Decide the diagram type: Mermaid header > explicitly named kind > Archify guide (confident)
 * > ask the model > guide fallback. (--type and --edit bypass this entirely.)
 */
export async function detectType({ client, model, archifyRoot, request, log }) {
  const explicit = mermaidType(request) ?? namedType(request);
  if (explicit) return explicit;

  let recommendation = null;
  try {
    const result = await guide(archifyRoot, request);
    recommendation = result.recommendation?.type ?? null;
    if (recommendation && result.confidence !== 'low') return recommendation;
  } catch {
    // guide is a hint only
  }

  log('Asking the model to choose a diagram type...');
  const { content } = await client.chat({ model, messages: buildClassifyMessages(request), temperature: 0 });
  return parseTypeAnswer(content) ?? recommendation ?? 'architecture';
}

/**
 * Deterministic constants the model sometimes forgets, and a quality profile that
 * matches the one actually validated; everything else stays model-authored.
 */
function normalizeSpec(spec, type, quality) {
  if (spec.diagram_type === undefined) spec.diagram_type = type;
  if (spec.schema_version === undefined) spec.schema_version = type === 'workflow' ? 2 : 1;
  if (spec.meta && typeof spec.meta === 'object') spec.meta.quality_profile = quality;
  return spec;
}

function defaultOutputPath(type) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return path.resolve('archify-out', `${type}-${stamp}.html`);
}

const toJson = (spec) => JSON.stringify(spec, null, 2) + '\n';

const blockingDiagnostics = (receipt) => (receipt?.diagnostics ?? []).filter((d) => d.severity !== 'warning');

export async function generateDiagram(options) {
  const {
    client,
    archifyRoot,
    request,
    fromSpec,
    quality = 'showcase',
    maxRepairs = 4,
    temperature = 0.2,
    maxTokens,
    open = false,
    allowFallback = true,
    visual = true,
    log = () => {},
    onProgress,
  } = options;

  const model = (await client.pickModel(options.model)).id;
  log(`Model: ${model}`);

  const existing = fromSpec ? JSON.parse(readFileSync(fromSpec, 'utf8')) : null;
  const type = existing?.diagram_type ?? options.type ?? (await detectType({ client, model, archifyRoot, request, log }));
  if (!DIAGRAM_TYPES.includes(type)) throw new Error(`Unsupported diagram type "${type}"`);
  log(`Diagram type: ${type}`);

  const htmlPath = path.resolve(
    options.out ?? (fromSpec ? fromSpec.replace(/\.json$/i, '') + '.html' : defaultOutputPath(type)),
  );
  const base = htmlPath.replace(/\.html?$/i, '');
  const specPath = `${base}.json`;
  const candidatePath = `${base}.candidate.json`;
  const rejectedPath = `${base}.rejected.json`;
  mkdirSync(path.dirname(htmlPath), { recursive: true });

  // Only a specification that passed validation is ever written to specPath/htmlPath,
  // so an --edit source is never replaced by an invalid result.
  const deliverSpec = (spec, profile, deliverOptions) => {
    writeFileSync(specPath, toJson(spec));
    return deliver(archifyRoot, type, specPath, htmlPath, profile, deliverOptions);
  };

  /** Score a candidate: 0 = accepted, (0,1) = valid but fails the browser check, >= 1 = invalid. */
  async function evaluate(spec) {
    writeFileSync(candidatePath, toJson(spec));
    const receipt = await validate(archifyRoot, type, candidatePath, quality);
    const assessment = assessReceipt(receipt, quality);
    if (!assessment.pass) {
      log(`  validation failed (issue score ${assessment.score})`);
      return { spec, receipt, validated: false, pass: false, score: assessment.score, feedback: buildRepairMessage(receipt, quality) };
    }
    log('  validation passed');
    if (!visual) return { spec, receipt, validated: true, pass: true, score: 0 };

    const delivered = await deliverSpec(spec, quality);
    if (!delivered.ok) {
      log('  delivery failed');
      return { spec, receipt: delivered, validated: false, pass: false, score: 1, feedback: `Archify delivery failed:\n${delivered.error}` };
    }
    const browser = await visualCheck(archifyRoot, htmlPath);
    if (browser.status !== 'fail') {
      log(`  browser check ${browser.status}`);
      return { spec, receipt, browser, validated: true, pass: true, score: 0 };
    }
    const issues = Math.max(1, blockingDiagnostics(browser).length);
    log(`  browser check failed (${issues} issue${issues === 1 ? '' : 's'})`);
    return {
      spec,
      receipt,
      browser,
      validated: true,
      pass: false,
      score: Math.min(0.99, issues / 100),
      feedback: buildVisualRepairMessage(browser, spec),
    };
  }

  const system = { role: 'system', content: buildSystemPrompt(archifyRoot, type) };
  const task = { role: 'user', content: existing ? buildEditMessage(request, existing) : buildCreateMessage(request) };
  let messages = [system, task];
  let best = null;
  let stalls = 0;

  try {
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      log(attempt === 0 ? 'Generating specification...' : `Repair round ${attempt}/${maxRepairs}...`);
      const answer = await client.chat({ model, messages, temperature, maxTokens, onProgress });
      if (answer.finishReason === 'length') log('  warning: the answer hit max tokens and may be truncated');

      let spec;
      try {
        spec = normalizeSpec(extractJsonObject(answer.content), type, quality);
      } catch {
        log('  answer contained no parseable JSON');
        const retryFrom = best ? JSON.stringify(best.spec) : answer.content;
        messages = [system, task, { role: 'assistant', content: retryFrom }, { role: 'user', content: NOT_JSON_FEEDBACK }];
        if (++stalls >= 2 && best) break;
        continue;
      }

      const result = await evaluate(spec);
      if (!best || result.score < best.score) {
        best = result;
        stalls = 0;
      } else {
        stalls++;
      }
      if (best.pass) break;
      // Two rounds without a new best: stop instead of thrashing (SKILL.md repair rule).
      if (stalls >= 2) {
        log('  no improvement in two rounds; stopping repairs');
        break;
      }
      messages = [
        system,
        task,
        { role: 'assistant', content: JSON.stringify(best.spec, null, 1) },
        { role: 'user', content: best.feedback },
      ];
    }
  } finally {
    rmSync(candidatePath, { force: true });
  }

  if (!best) throw new Error('The model never produced a parseable JSON specification.');

  let finalSpec = best.validated ? best.spec : null;
  let finalQuality = quality;
  let unresolvedShowcaseIssues;

  if (!finalSpec && quality === 'showcase' && allowFallback) {
    const standardSpec = structuredClone(best.spec);
    if (standardSpec.meta) standardSpec.meta.quality_profile = 'standard';
    writeFileSync(candidatePath, toJson(standardSpec));
    try {
      const standard = await validate(archifyRoot, type, candidatePath, 'standard');
      if (assessReceipt(standard, 'standard').pass) {
        finalSpec = standardSpec;
        finalQuality = 'standard';
        unresolvedShowcaseIssues = best.receipt.error ?? buildRepairMessage(best.receipt, 'showcase');
        log('  showcase checks still fail; delivering with the standard quality profile instead');
      }
    } finally {
      rmSync(candidatePath, { force: true });
    }
  }

  if (!finalSpec) {
    writeFileSync(rejectedPath, toJson(best.spec));
    return { ok: false, model, type, rejectedPath, message: best.feedback };
  }

  // Re-deliver the chosen specification so htmlPath always holds it, then re-check the
  // browser evidence so its receipt and screenshots describe exactly this artifact.
  rmSync(rejectedPath, { force: true });
  const receipt = await deliverSpec(finalSpec, finalQuality, { open });
  const browser = receipt.ok && visual ? await visualCheck(archifyRoot, htmlPath) : undefined;

  return {
    ok: receipt.ok === true,
    model,
    type,
    quality: finalQuality,
    specPath,
    htmlPath,
    receipt,
    browserCheck: browser?.status ?? 'not run',
    browserIssues: browser?.status === 'fail' ? blockingDiagnostics(browser).map((d) => d.message) : undefined,
    unresolvedShowcaseIssues,
    message: receipt.ok ? undefined : receipt.error,
  };
}
