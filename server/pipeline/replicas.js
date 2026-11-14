// Level 3: independent re-derivations. Each agent gets the requirement (and the original prompt when
// provenance exists) and a blind copy of the base commit. It never sees the PR.
import fs from 'node:fs';
import path from 'node:path';
import { run, tail } from '../util.js';
import { clis, agentEnv } from '../llm.js';
import { parseDiff } from '../git.js';
import { blindCopy, copyPatch } from './sandbox.js';

// Preferred order when the user does not pick: spread over different model families first.
const PREFER = ['deepseek', 'glm', 'minimax', 'nemotron', 'mimo', 'longcat', 'iceman', 'flint', 'inkling', 'beam', 'big-pickle'];
const pretty = (id) => id.replace(/-free$/, '').replace(/[-_]/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

let modelCache = { at: 0, list: [] };
async function opencodeModels() {
  if (Date.now() - modelCache.at < 5 * 60_000 && modelCache.list.length) return modelCache.list;
  const r = await run('opencode', ['models'], { timeout: 30_000, env: agentEnv() });
  const list = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /^opencode\/[\w.-]+$/.test(l));
  modelCache = { at: Date.now(), list };
  return list;
}

/**
 * Agents we can drive without interaction, discovered from the CLIs that are installed and logged in.
 * Test hook: KATSE_FAKE_AGENTS=<dir> replaces them with one "agent" per <id>.patch file in that folder,
 * which simply applies the patch. It exists to test the pipeline without spending model quota.
 */
export async function availableAgents() {
  const fake = process.env.KATSE_FAKE_AGENTS;
  if (fake) {
    return fs.readdirSync(fake).filter((f) => f.endsWith('.patch')).sort()
      .map((f) => ({ id: f.replace(/\.patch$/, ''), cli: 'fake', model: path.join(fake, f), label: `Parche ${f.replace(/\.patch$/, '')}` }));
  }
  const have = await clis();
  const agents = [];
  if (have.opencode) {
    for (const m of await opencodeModels()) {
      const id = m.split('/')[1].replace(/-free$/, '');
      agents.push({ id, cli: 'opencode', model: m, label: pretty(id) });
    }
    const rank = (a) => { const i = PREFER.findIndex((p) => a.id.startsWith(p)); return i < 0 ? PREFER.length : i; };
    agents.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }
  if (have.claude) {
    agents.unshift(
      { id: 'claude-sonnet', cli: 'claude', model: 'sonnet', label: 'Claude Sonnet' },
      { id: 'claude-haiku', cli: 'claude', model: 'haiku', label: 'Claude Haiku' },
    );
    agents.push({ id: 'claude-opus', cli: 'claude', model: 'opus', label: 'Claude Opus' });
  }
  return agents;
}

export function buildPrompt({ requirement, provenance, toolchain }) {
  const req = requirement?.title
    ? `REQUIREMENT ${requirement.id}: ${requirement.title}\n\n${(requirement.body || '').slice(0, 12_000)}`
    : 'REQUIREMENT: (no issue text available)';
  const prov = provenance?.prompt
    ? `\n\nORIGINAL INSTRUCTION GIVEN TO THE AUTHOR OF THE CHANGE:\n${provenance.prompt.slice(0, 8000)}`
    : '';
  const tests = toolchain?.testProjects?.length
    ? `\nYou can build and test with: dotnet build ${toolchain.testProjects[0]} && dotnet test ${toolchain.testProjects[0]} --no-build`
    : '';
  return `You are implementing a change in the repository in the current directory. Work only inside it.

${req}${prov}

Rules:
- Make the smallest change that fully satisfies the requirement. Do not touch unrelated code.
- Change the product code, not only the tests. Add or update automated tests that would fail without your change.
- Do not commit, create branches, push, or use the network.
- Do not ask questions. Where the requirement leaves something open, choose the most conservative option.
- Leave no scratch or exploration files behind.${tests}

When you finish, reply with exactly two short sections:
SUMMARY: what you changed.
DECISIONS: every choice you had to make that the requirement does not settle (or "none").`;
}

function agentCommand(agent, prompt) {
  if (agent.cli === 'fake') return { cmd: 'git', args: ['apply', '--whitespace=nowarn', agent.model] };
  if (agent.cli === 'claude') {
    return {
      cmd: 'claude',
      args: [
        '-p', prompt,
        '--model', agent.model,
        '--permission-mode', 'acceptEdits',
        '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(dotnet build:*),Bash(dotnet test:*),Bash(git diff:*),Bash(git status:*),Bash(ls:*)',
        '--disallowedTools', 'WebFetch,WebSearch',
        '--output-format', 'json',
      ],
    };
  }
  return { cmd: 'opencode', args: ['run', '--auto', '--standalone', '-m', agent.model, prompt] };
}

const SANDBOX = '/usr/bin/sandbox-exec';
export const sandboxAvailable = () => process.platform === 'darwin' && fs.existsSync(SANDBOX);

/**
 * Wrap an agent command in the macOS sandbox so it cannot read or write the forbidden folders
 * (the user's repository, other runs, and this tool's own files, which describe the PR).
 * Its own working copy stays fully accessible. Returns the command unchanged where no sandbox exists.
 */
export function confine({ cmd, args }, dir, forbidden) {
  if (!sandboxAvailable()) return { cmd, args, confined: false };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const q = (p) => `"${real(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const deny = forbidden.map((p) => `(subpath ${q(p)})`).join(' ');
  const profile = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* ${deny})`,
    `(allow file-read-metadata ${deny})`,
    `(allow file-read* file-write* (subpath ${q(dir)}))`,
  ].join('\n');
  return { cmd: SANDBOX, args: ['-p', profile, cmd, ...args], confined: true };
}

const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Why an agent's output means it did not finish, or null when it looks complete. */
function failureOf(agent, r) {
  if (r.timedOut) return 'se agotó el tiempo';
  const text = clean(r.stdout + '\n' + r.stderr);
  if (agent.cli === 'claude') {
    try { const j = JSON.parse(r.stdout); if (j.is_error) return String(j.result || 'error').slice(0, 160); } catch { /* not JSON */ }
  }
  const m = text.split('\n').reverse().find((l) => /^\s*Error:/i.test(l));
  if (m && /limit|quota|rate|credit|auth|login|subscribe|unavailable|overloaded|timeout/i.test(m)) return m.trim().replace(/^Error:\s*/i, '').slice(0, 160);
  if (r.code !== 0) return `el agente terminó con código ${r.code}`;
  return null;
}

/** A tiny request before the real work, so an agent without quota or login is dropped up front. */
export async function preflight(agent) {
  if (agent.cli === 'fake') return { ok: true };
  const args = agent.cli === 'claude'
    ? ['-p', 'Reply with exactly: OK', '--model', agent.model, '--output-format', 'json']
    : ['run', '--standalone', '-m', agent.model, 'Reply with exactly: OK'];
  const r = await run(agent.cli, args, { cwd: fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'replica-pf-')), timeout: 90_000, env: agentEnv() });
  const why = failureOf(agent, r);
  return why ? { ok: false, why } : { ok: true };
}

function parseAgentOutput(agent, stdout) {
  let text = stdout;
  let cost = null;
  if (agent.cli === 'claude') {
    try { const j = JSON.parse(stdout); text = j.result || ''; cost = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null; } catch { /* plain text */ }
  }
  const t = clean(text);
  const summary = t.match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*DECISIONS:|$)/i)?.[1]?.trim() || tail(t.trim(), 600);
  const decisions = t.match(/DECISIONS:\s*([\s\S]*)$/i)?.[1]?.trim() || '';
  return { summary: summary.slice(0, 1500), decisions: decisions.slice(0, 1500), cost };
}

/**
 * Run one replica. Resolves with its parsed diff and the agent's own notes.
 * `finished` says the agent ended normally; whether its work is a valid derivation is decided later
 * by building it and running its own tests. The notes are the agent's claims, never evidence.
 */
export async function runReplica({ repo, baseSha, dir, agent, prompt, timeoutMs, artifacts, forbidden = [] }) {
  await blindCopy(repo, dir, baseSha);
  const { cmd, args, confined } = confine(agentCommand(agent, prompt), dir, [repo, ...forbidden]);
  const r = await run(cmd, args, { cwd: dir, timeout: timeoutMs, env: agentEnv() });
  const patch = await copyPatch(dir);
  const files = parseDiff(patch).filter((f) => !/(^|\/)(bin|obj|node_modules|\.replica-trx)\//.test(f.path));
  fs.writeFileSync(path.join(artifacts, `replica-${agent.id}.patch`), patch);
  fs.writeFileSync(path.join(artifacts, `replica-${agent.id}.log`), tail(clean(r.stdout + '\n' + r.stderr), 60_000));
  const notes = agent.cli === 'fake' ? { summary: 'Parche aplicado (agente de prueba).', decisions: '', cost: null } : parseAgentOutput(agent, r.stdout);
  const changed = files.reduce((n, f) => n + f.add + f.del, 0);
  const why = failureOf(agent, r);
  const status = why ? `incompleta: ${why}` : changed ? 'terminada' : 'sin cambios';
  return {
    id: agent.id, label: agent.label, model: agent.model, cli: agent.cli, dir, confined,
    finished: !why && changed > 0, ok: false, status,
    ms: r.ms, files, patchFile: `replica-${agent.id}.patch`, logFile: `replica-${agent.id}.log`,
    lines: changed, ...notes,
  };
}
