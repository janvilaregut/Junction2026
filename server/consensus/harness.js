// A tiny coding harness: a Gemini model with file tools works inside its own git worktree until it calls finish().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, tail } from '../util.js';
import { generate } from './gemini.js';
import { LANG_NAME, langOf, strings } from './lang.js';

const MAX_STEPS = Number(process.env.KATSE_MAX_STEPS || 28);

const TOOLS = [
  { name: 'list_files', description: 'Lists the tracked files of the repository (or of a folder).', parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Relative folder; empty = root' } } } },
  { name: 'read_file', description: 'Reads a file with line numbers. For long files use start_line/end_line.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'search', description: 'Searches the repository for a text or regex (git grep). Returns file:line:text.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'edit_file', description: 'Replaces EXACTLY old_text (must appear exactly once) with new_text in an existing file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'write_file', description: 'Creates or overwrites a whole file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'run_tests', description: 'Runs the project test suite and returns the output.', parameters: { type: 'object', properties: {} } },
  { name: 'finish', description: 'Finish. Call this when the change is done (or if you decide no change is needed).', parameters: { type: 'object', properties: { summary: { type: 'string', description: 'What you changed and why, in 2-4 sentences' } }, required: ['summary'] } },
];

const SYSTEM = (lang) => `You are a software engineer working alone, unable to ask questions. You are given a requirement and a repository.
Implement the requirement with the minimal correct change, following the existing code style. Add or adjust tests if the project has them.
Use the tools: explore just enough, edit, run the tests if available and, when done, call finish.
If after reviewing the code you conclude no change is needed, call finish explaining why without editing anything.
Do not create note files or change things the requirement does not ask for.
Write the finish summary in ${LANG_NAME[lang]}.`;

/**
 * The test command, decided from the BASE commit (HEAD of the worktree, which the agent cannot move: it has no
 * shell and .git is off limits). Never from the working tree, because the agent can rewrite package.json.
 */
export function testCommand(dir) {
  const atBase = (file) => { try { return execFileSync('git', ['show', `HEAD:${file}`], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  try {
    const pkg = JSON.parse(atBase('package.json') || 'null');
    // Run the base's own script the way npm would (node_modules/.bin on PATH), without reading the working tree.
    if (pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return ['/bin/sh', ['-c', `PATH="$PWD/node_modules/.bin:$PATH"; ${pkg.scripts.test}`]];
  } catch { /* not node */ }
  if (atBase('pytest.ini') !== null || atBase('pyproject.toml') !== null) return ['python3', ['-m', 'pytest', '-q']];
  return null;
}

/**
 * Tests run code the agent wrote, so they run inside the macOS sandbox: no network (nothing can be sent out)
 * and no writes outside the agent's worktree and temp/cache folders (nothing of the user's can be touched).
 * Where there is no sandbox, tests are not run unless KATSE_UNSAFE_TESTS=1.
 */
export async function runTests(dir) {
  const base = testCommand(dir);
  if (!base) return 'This project has no test command I know how to run.';
  const cmd = confinedTests(base, dir);
  if (!cmd) return 'Tests are not run here: there is no sandbox on this system (set KATSE_UNSAFE_TESTS=1 to allow it).';
  const r = await run(cmd[0], cmd[1], { cwd: dir, timeout: 180_000 });
  return `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${tail(r.stdout + '\n' + r.stderr, 3500)}`;
}

const SANDBOX = '/usr/bin/sandbox-exec';
function confinedTests(cmd, dir) {
  if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX)) return process.env.KATSE_UNSAFE_TESTS === '1' ? cmd : null;
  const q = (p) => JSON.stringify(fs.realpathSync(p));
  const home = os.homedir();
  const writable = [dir, os.tmpdir(), '/private/tmp', '/private/var/folders', path.join(home, '.npm')].filter((p) => fs.existsSync(p));
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(allow network* (local unix-socket))',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  ].join('\n');
  return [SANDBOX, ['-p', profile, cmd[0], ...cmd[1]]];
}

const inside = (p, root) => p === root || p.startsWith(root + path.sep);

function safePath(dir, p) {
  const root = path.resolve(dir);
  const abs = path.resolve(root, String(p || '').replace(/^\/+/, ''));
  if (!inside(abs, root)) throw new Error('Path outside the repository');
  if (abs.split(path.sep).includes('.git')) throw new Error('Cannot touch .git');
  // Symlinks: the real location must stay inside the worktree too. For a path that does not exist yet,
  // check its deepest existing ancestor (lstat, so a dangling link counts as existing and is caught).
  let probe = abs;
  for (;;) {
    try { fs.lstatSync(probe); break; } catch { probe = path.dirname(probe); }
  }
  let real;
  try { real = fs.realpathSync(probe); } catch { throw new Error('Path goes through a broken symlink'); }
  const realRoot = fs.realpathSync(root);
  if (!inside(real, realRoot)) throw new Error('Path outside the repository');
  if (path.relative(realRoot, real).split(path.sep).includes('.git')) throw new Error('Cannot touch .git');
  return abs;
}

async function execTool(dir, name, args) {
  switch (name) {
    case 'list_files': {
      const r = await run('git', ['ls-files', '--', args.dir || '.'], { cwd: dir, timeout: 20_000 });
      const files = r.stdout.split('\n').filter(Boolean);
      return files.length > 400 ? files.slice(0, 400).join('\n') + `\n… (${files.length - 400} more)` : files.join('\n') || '(empty)';
    }
    case 'read_file': {
      const abs = safePath(dir, args.path);
      if (!fs.existsSync(abs)) return `${args.path} does not exist`;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const s = Math.max(1, args.start_line || 1);
      const e = Math.min(lines.length, args.end_line || s + 399);
      const body = lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n');
      return e < lines.length ? `${body}\n… (file has ${lines.length} lines; ask for more with start_line)` : body;
    }
    case 'search': {
      const r = await run('git', ['grep', '-n', '-I', '-E', '--', args.pattern], { cwd: dir, timeout: 20_000 });
      const out = r.stdout.split('\n').filter(Boolean);
      return out.length ? out.slice(0, 80).join('\n') + (out.length > 80 ? `\n… (${out.length - 80} more)` : '') : 'No results';
    }
    case 'edit_file': {
      const abs = safePath(dir, args.path);
      if (!fs.existsSync(abs)) return `${args.path} does not exist; use write_file to create it`;
      const src = fs.readFileSync(abs, 'utf8');
      const n = src.split(args.old_text).length - 1;
      if (n === 0) return 'old_text does not appear in the file. Read it again and copy the exact text.';
      if (n > 1) return `old_text appears ${n} times; include more context so it is unique.`;
      fs.writeFileSync(abs, src.replace(args.old_text, () => args.new_text));
      return 'Done';
    }
    case 'write_file': {
      const abs = safePath(dir, args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, args.content ?? '');
      return 'Done';
    }
    case 'run_tests':
      return runTests(dir);
    default:
      return `Unknown tool: ${name}`;
  }
}

const describe = (t, name, a) => ({
  list_files: () => t.explores(a.dir),
  read_file: () => t.reads(a.path),
  search: () => t.searches(String(a.pattern).slice(0, 40)),
  edit_file: () => t.edits(a.path),
  write_file: () => t.writes(a.path),
  run_tests: () => t.runsTests,
  finish: () => t.finishes,
}[name]?.() || name);

const statusOf = (name) => ({ read_file: 'reading', list_files: 'reading', search: 'reading', edit_file: 'writing', write_file: 'writing', run_tests: 'testing' }[name] || 'thinking');

/**
 * Run one agent to completion in `dir`. `onEvent({status, text})` reports activity.
 * Returns { summary, steps, testsRun }.
 */
export async function solve({ dir, requirement, hintFiles = [], gen, model, onEvent = () => {}, signal, lang = 'en' }) {
  lang = langOf(lang);
  const t = strings(lang);
  const tree = (await run('git', ['ls-files'], { cwd: dir, timeout: 20_000 })).stdout.split('\n').filter(Boolean);
  // Inline the likely-relevant files (and, for small repos, all source files) to save read round-trips.
  const TEXT = /\.(m?[jt]sx?|cjs|json|py|cs|go|rs|java|kt|rb|php|c|h|cpp|hpp|swift|md|toml|ya?ml|html|css)$/i;
  const budget = 60_000;
  let used = 0;
  const inlined = [];
  const candidates = [...hintFiles, ...(tree.length <= 60 ? tree.filter((f) => TEXT.test(f) && !/lock/.test(f)) : [])];
  for (const f of [...new Set(candidates)]) {
    const abs = path.join(dir, f);
    if (!fs.existsSync(abs) || fs.statSync(abs).size > 20_000) continue;
    const body = fs.readFileSync(abs, 'utf8');
    if (used + body.length > budget) continue;
    used += body.length;
    inlined.push(`### ${f}\n\`\`\`\n${body}\n\`\`\``);
  }
  const intro = [
    `## Requirement\n${requirement}`,
    `## Repository files (${tree.length})\n${tree.slice(0, 250).join('\n')}${tree.length > 250 ? '\n…' : ''}`,
    hintFiles.length ? `## Likely relevant files\n${hintFiles.join('\n')}` : '',
    inlined.length ? `## Current content (already read; no need to read it again)\n${inlined.join('\n\n')}` : '',
    testCommand(dir) ? 'There are tests: you can use run_tests.' : '',
    'You can call several tools in the same turn (for example, several edits at once).',
  ].filter(Boolean).join('\n\n');
  const contents = [{ role: 'user', parts: [{ text: intro }] }];
  let testsRun = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) throw new Error('cut off: out of time');
    onEvent({ status: 'thinking', text: step === 0 ? t.readsReq : t.thinks });
    const r = await generate({ model, contents, system: SYSTEM(lang), tools: TOOLS, gen, signal });
    contents.push(r.content);
    if (r.text?.trim()) onEvent({ status: 'thinking', text: r.text.trim().slice(0, 160) });
    if (!r.calls.length) {
      contents.push({ role: 'user', parts: [{ text: 'Keep using the tools. When you are done, call finish.' }] });
      continue;
    }
    const responses = [];
    for (const call of r.calls) {
      const args = call.args || {};
      if (call.name === 'finish') return { summary: args.summary || '', steps: step + 1, testsRun };
      if (signal?.aborted) throw new Error('cut off: out of time');
      onEvent({ status: statusOf(call.name), text: describe(t, call.name, args) });
      let result;
      try { result = await execTool(dir, call.name, args); } catch (e) { result = `Error: ${e.message}`; }
      if (call.name === 'run_tests') {
        testsRun++;
        onEvent({ status: 'testing', text: /^exit 0/.test(result) ? t.testsGreen : t.testsRed });
      }
      responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { result: String(result) } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { summary: t.outOfSteps, steps: MAX_STEPS, testsRun, exhausted: true };
}
