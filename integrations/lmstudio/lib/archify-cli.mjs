// Thin wrapper around the real Archify CLI. The CLI stays the only authority
// for validation and delivery; this module just runs it and reads its receipts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIAGRAM_TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Locate the Archify Skill root (the directory holding bin/archify.mjs). */
export function resolveArchifyRoot(explicit) {
  const candidates = [
    explicit,
    process.env.ARCHIFY_ROOT,
    path.resolve(HERE, '../../../archify'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (existsSync(path.join(root, 'bin', 'archify.mjs'))) return root;
  }
  throw new Error(
    `Archify Skill root not found (tried: ${candidates.join(', ')}). ` +
      'Pass --archify-root or set ARCHIFY_ROOT to the directory containing bin/archify.mjs.',
  );
}

export function runArchify(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'bin', 'archify.mjs'), ...args], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runArchifyJson(root, args) {
  const { code, stdout, stderr } = await runArchify(root, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`archify ${args[0]} exited ${code} without a JSON receipt:\n${(stderr || stdout).trim()}`);
  }
}

export function validate(root, type, specPath, quality) {
  return runArchifyJson(root, ['validate', type, specPath, '--quality', quality, '--json']);
}

export function deliver(root, type, specPath, outPath, quality, { open = false } = {}) {
  const args = ['deliver', type, specPath, outPath, '--quality', quality, '--json'];
  if (open) args.push('--open');
  return runArchifyJson(root, args);
}

/** Browser evidence for a delivered HTML. status is "pass", "fail", or "skipped" (no Chrome). */
export function visualCheck(root, htmlPath) {
  return runArchifyJson(root, ['visual-check', htmlPath, '--json']);
}

export function guide(root, scenario) {
  return runArchifyJson(root, ['guide', scenario, '--json']);
}

/**
 * Reduce a validate receipt to pass/fail plus a comparable badness score.
 * Schema errors weigh far more than geometry issues so that a candidate that
 * parses and renders is always preferred over one that does not.
 */
export function assessReceipt(receipt, quality) {
  const diagnostics = Array.isArray(receipt?.diagnostics) ? receipt.diagnostics : [];
  const failedChecks = (receipt?.checks ?? []).filter((check) => !check.ok);
  const composition = receipt?.composition;
  const compositionErrors = composition?.summary?.errors ?? 0;
  const compositionWarnings = quality === 'showcase' ? composition?.summary?.warnings ?? 0 : 0;
  const errorDiagnostics = diagnostics.filter((d) => d.severity !== 'warning');
  const schemaErrors = errorDiagnostics.filter((d) => String(d.code).startsWith('schema/')).length;

  const pass =
    receipt?.ok === true &&
    failedChecks.length === 0 &&
    errorDiagnostics.length === 0 &&
    compositionErrors === 0 &&
    compositionWarnings === 0;

  if (pass) return { pass, score: 0, schemaErrors: 0 };
  const other = errorDiagnostics.length - schemaErrors + failedChecks.length + compositionErrors + compositionWarnings;
  return { pass, score: schemaErrors * 100 + Math.max(1, other), schemaErrors };
}
