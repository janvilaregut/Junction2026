// Build and test adapters. Every adapter exposes the same two operations so the pipeline does not care
// whether the project is .NET, Node or Python:
//   build(cwd)                 → { ok, ms, log }
//   test(cwd, { names })       → { ok, ran, passed, failed, skipped, tests: [{ name, outcome }], ms, log, filtered }
import fs from 'node:fs';
import path from 'node:path';
import { run, tail, toolEnv } from '../util.js';
import { out } from '../git.js';

const sh = (cmd, cwd, timeout) => run('/bin/sh', ['-c', cmd], { cwd, timeout, env: toolEnv() });

function parseTrx(dir) {
  const tests = [];
  if (!fs.existsSync(dir)) return tests;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.trx')) continue;
    const xml = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
      const name = m[0].match(/\btestName="([^"]*)"/)?.[1];
      const outcome = m[0].match(/\boutcome="([^"]*)"/)?.[1];
      if (name) tests.push({ name: name.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), outcome });
    }
  }
  return tests;
}

function summarize(tests) {
  const passed = tests.filter((t) => t.outcome === 'Passed').length;
  const failed = tests.filter((t) => t.outcome === 'Failed').length;
  return { ran: passed + failed, passed, failed, skipped: tests.length - passed - failed };
}

async function dotnetToolchain(treePaths, changedPaths) {
  const csprojs = treePaths.filter((p) => p.endsWith('.csproj'));
  const isTestProj = (p) => /tests?\//i.test(p) || /Tests?\.csproj$/i.test(p);
  const owner = (file) => {
    let best = null;
    for (const p of csprojs) {
      const dir = path.dirname(p);
      if ((file === p || file.startsWith(dir + '/')) && (!best || dir.length > path.dirname(best).length)) best = p;
    }
    return best;
  };
  const projects = new Set();
  for (const f of changedPaths) {
    const proj = owner(f);
    if (!proj) continue;
    if (isTestProj(proj)) { projects.add(proj); continue; }
    // A source project: look for its conventional test project (<Name>.Tests).
    const name = path.basename(proj, '.csproj');
    const t = csprojs.find((p) => path.basename(p, '.csproj') === `${name}.Tests`);
    if (t) projects.add(t);
  }
  // Prefer unit-test projects that run without extra setup; cap the number to keep a run bounded.
  const testProjects = [...projects].slice(0, 3);
  const others = csprojs.filter((p) => isTestProj(p) && !testProjects.includes(p)).length;

  const short = (p) => path.basename(p, '.csproj');
  const tc = {
    kind: 'dotnet',
    testProjects,
    excluded: [],
    otherTestProjects: others,
    get describe() { return testProjects.length ? `dotnet · ${testProjects.map(short).join(', ')}` : 'dotnet · sin proyecto de test que se pueda ejecutar'; },
    /** Which test project a file belongs to (or null). */
    projectOf: (file) => owner(file),
    /** Drop projects the sandbox cannot build even without the PR, so they are reported as not checked instead of blamed on the change. */
    exclude(list, why) {
      for (const p of list) {
        const i = testProjects.indexOf(p);
        if (i >= 0) { testProjects.splice(i, 1); tc.excluded.push({ project: p, name: short(p), why }); }
      }
    },
    async build(cwd) {
      if (!testProjects.length) return { ok: true, ms: 0, log: 'Sin proyecto de test que compilar.', failed: [] };
      let log = '';
      let ms = 0;
      const failed = [];
      for (const p of [...testProjects]) {
        const r = await run('dotnet', ['build', p, '-v', 'q', '-nologo', '-clp:NoSummary'], { cwd, timeout: 20 * 60_000 });
        ms += r.ms;
        log += `$ dotnet build ${p}\n${tail(r.stdout + r.stderr, 6000)}\n`;
        if (r.code !== 0) failed.push(p);
      }
      return { ok: failed.length === 0, ms, log, failed };
    },
    async test(cwd, { names } = {}) {
      if (!testProjects.length) return { ok: false, ran: 0, passed: 0, failed: 0, skipped: 0, tests: [], ms: 0, log: '', filtered: false };
      const resDir = path.join(cwd, '.replica-trx');
      fs.rmSync(resDir, { recursive: true, force: true });
      let log = '';
      let ms = 0;
      for (const p of testProjects) {
        const args = ['test', p, '--no-build', '-v', 'q', '-nologo', '--results-directory', resDir, '--logger', `trx;LogFileName=${short(p)}.trx`];
        if (names?.length) args.push('--filter', names.map((n) => `FullyQualifiedName~${n}`).join('|'));
        const r = await run('dotnet', args, { cwd, timeout: 30 * 60_000 });
        ms += r.ms;
        log += `$ dotnet ${args.slice(0, 2).join(' ')}${names?.length ? ` --filter (${names.length} tests)` : ''}\n${tail(r.stdout + r.stderr, 6000)}\n`;
      }
      const tests = parseTrx(resDir);
      fs.rmSync(resDir, { recursive: true, force: true });
      const s = summarize(tests);
      return { ok: s.failed === 0 && s.ran > 0, ...s, tests, ms, log, filtered: !!names?.length };
    },
  };
  return tc;
}

function shellToolchain(kind, describe, buildCmd, testCmd, filterArg) {
  return {
    kind, describe, testProjects: [], excluded: [], otherTestProjects: 0, projectOf: () => null, exclude() {},
    async build(cwd) {
      if (!buildCmd) return { ok: true, ms: 0, log: 'Sin paso de compilación.' };
      const r = await sh(buildCmd, cwd, 20 * 60_000);
      return { ok: r.code === 0, ms: r.ms, log: `$ ${buildCmd}\n${tail(r.stdout + r.stderr, 6000)}` };
    },
    async test(cwd, { names } = {}) {
      const filtered = !!(names?.length && filterArg);
      const cmd = filtered ? `${testCmd} ${filterArg(names)}` : testCmd;
      const r = await sh(cmd, cwd, 30 * 60_000);
      const text = r.stdout + r.stderr;
      const num = (re) => Number(text.match(re)?.[1] || 0);
      const passed = num(/(\d+)\s+pass(?:ed|ing)?\b/i);
      const failed = num(/(\d+)\s+fail(?:ed|ing|ures)?\b/i);
      // Without a per-test report the exit code is the result; individual names are unknown.
      const tests = (names || []).map((n) => ({ name: n, outcome: r.code === 0 ? 'Passed' : 'Failed' }));
      return {
        ok: r.code === 0, ran: passed + failed || (r.code === 0 ? 1 : 1), passed: passed || (r.code === 0 ? 1 : 0),
        failed: failed || (r.code === 0 ? 0 : 1), skipped: 0, tests, ms: r.ms, log: `$ ${cmd}\n${tail(text, 6000)}`, filtered,
      };
    },
  };
}

/**
 * Pick the adapter for the tree at `sha`. A project can override both commands in its settings
 * (commands.build / commands.test), which always wins.
 */
export async function detectToolchain({ repo, sha, project, changedPaths }) {
  const treePaths = (await out(repo, ['ls-tree', '-r', '--name-only', sha], { timeout: 120_000 })).split('\n').filter(Boolean);
  const root = new Set(treePaths.filter((p) => !p.includes('/')));
  const has = (f) => root.has(f);
  if (project.commands?.test) {
    return shellToolchain('custom', `personalizado · ${project.commands.test}`, project.commands.build, project.commands.test, null);
  }
  if (has('global.json') || [...root].some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) {
    return dotnetToolchain(treePaths, changedPaths);
  }
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(await out(repo, ['show', `${sha}:package.json`])); } catch { /* unreadable */ }
    if (pkg.scripts?.test) {
      const install = has('package-lock.json') ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
      return shellToolchain('node', 'node · npm test', `${install}${pkg.scripts.build ? ' && npm run build' : ''}`, 'npm test --silent', null);
    }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('tox.ini')) {
    return shellToolchain('python', 'python · pytest', '', 'python3 -m pytest -q', (names) => `-k "${names.join(' or ')}"`);
  }
  return {
    kind: 'none', describe: 'sin tests detectados', testProjects: [], excluded: [], otherTestProjects: 0, projectOf: () => null, exclude() {},
    async build() { return { ok: true, ms: 0, log: 'No se ha detectado cómo compilar este proyecto.' }; },
    async test() { return { ok: false, ran: 0, passed: 0, failed: 0, skipped: 0, tests: [], ms: 0, log: 'No se ha detectado cómo pasar los tests.', filtered: false }; },
  };
}
