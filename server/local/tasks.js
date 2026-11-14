// Security tasks that run on the local model only: the code never leaves this machine.
import { chat } from './omlx.js';

const FINDINGS = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['clean', 'review', 'block'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['secret', 'injection', 'authz', 'crypto', 'pii', 'deserialization', 'path-traversal', 'other'] },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          line: { type: 'integer' },
          evidence: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['kind', 'severity', 'line', 'evidence', 'why', 'fix'],
      },
    },
  },
  required: ['verdict', 'summary', 'findings'],
};

const SYSTEM = [
  'You are a security reviewer. Report only real, exploitable problems in the code you are given; no style notes, no hypotheticals.',
  'Each finding cites the line number shown at the start of the line.',
  'In `evidence`, never repeat a secret in full: keep at most its first 4 characters and replace the rest with ****.',
  'verdict: "block" if any finding is high or critical, "review" if only low or medium, "clean" if there are none.',
].join('\n');

/** Mask anything that still looks like a long secret, in case the model ignored the instruction. */
const mask = (s) => String(s).replace(/[A-Za-z0-9_\-+/=]{16,}/g, (t) => (/\d/.test(t) && /[A-Za-z]/.test(t) ? `${t.slice(0, 4)}****` : t));

/**
 * Review a snippet, file or diff for security problems with the local model.
 * Returns { verdict, summary, findings: [{ kind, severity, line, evidence, why, fix }], ms, tps, model }.
 */
export async function scanCode(code, { lang = 'en', signal, model } = {}) {
  const numbered = String(code).split('\n').map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
  const language = lang === 'es' ? 'Spanish' : 'English';
  const r = await chat({
    system: SYSTEM,
    prompt: `Write summary, why and fix in ${language}.\n\nCode:\n${numbered}`,
    schema: FINDINGS,
    temperature: 0,
    maxTokens: 3000,
    signal,
    ...(model ? { model } : {}),
  });
  const findings = (r.data.findings || []).map((f) => ({ ...f, evidence: mask(f.evidence) }));
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  // The verdict follows the findings, not the model's own label.
  const verdict = findings.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'block' : findings.length ? 'review' : 'clean';
  return { verdict, summary: r.data.summary, findings, ms: r.ms, tps: r.tps, model: r.model };
}
