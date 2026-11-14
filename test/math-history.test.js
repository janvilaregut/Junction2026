import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  FIX_WORDS, changeEntropy, changeHistory, fileHistoryStats, historyFeatures, isFixSubject, parseLog, repoBaseline, selectHistory, shareBelow,
} from '../server/math/history.js';

// ---------------------------------------------------------------------------------------------------------------
// A throwaway repository with fixed dates. Every expected number below is worked out by hand from this table.
//
//   c1  2023-01-01 12:00Z  alice  Initial import              src/a.js +10, src/b.js +4, README.md +2
//   c2  2024-01-01 12:00Z  bob    Fix crash on empty cart     src/a.js +3 -1                  (written as 14:00+02:00)
//   c3  2024-04-01 12:00Z  carol  prefix the bugfix list      src/b.js +1 -1                  (91 days before the ref)
//   c4  2024-04-02 12:00Z  ALICE  HOTFIX: regression in totals src/a.js +2                    (exactly 90 days before)
//   c5s 2024-05-01 06:00Z  bob    Add guide                   docs/quick guide.md +5          (branch side, 61.25 days)
//   c5m 2024-05-02 12:00Z  alice  Docs: patch notes           README.md +1                    (60 days)
//   c6  2024-06-01 12:00Z  alice  Merge branch 'side'         merge of c5m and c5s, no diff of its own
//   c7  2024-07-01 12:00Z  bob    Remove b, add logo          src/b.js -4, assets/logo.bin (binary)      <- main, the ref
//   c8  2024-08-01 12:00Z  carol  Fix bug in a, add new       src/a.js +1, src/new.js +3                 <- pr
// ---------------------------------------------------------------------------------------------------------------
const MAIL = { alice: 'alice@example.com', ALICE: 'Alice@Example.COM', bob: 'bob@example.com', carol: 'carol@example.com' };
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');
let dir, shallowDir, home, sha, odd, oddSha;
const cleanEnv = (cfg) => ({ ...process.env, GIT_CONFIG_GLOBAL: path.join(cfg, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });

function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-history-')), cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-history-cfg-'));
  fs.writeFileSync(path.join(cfg, 'gitconfig'), ''); // an empty global configuration: the user's own must not reach these commits
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(cfg, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const git = (args, extra = {}) => execFileSync('git', args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' }).trim();
  const as = (who, date) => ({ GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: MAIL[who], GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: MAIL[who], GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
  const commit = (who, date, subject) => { git(['add', '-A']); git(['commit', '-q', '--no-gpg-sign', '-m', subject], as(who, date)); return git(['rev-parse', 'HEAD']); };
  const s = {};
  git(['init', '-q', '-b', 'main']);
  write('src/a.js', lines(10, 'a')); write('src/b.js', lines(4, 'b')); write('README.md', lines(2, 'readme'));
  s.c1 = commit('alice', '2023-01-01T12:00:00Z', 'Initial import');
  write('src/a.js', lines(10, 'a').replace('a 0\n', 'A zero\n') + lines(2, 'more'));
  s.c2 = commit('bob', '2024-01-01T14:00:00+02:00', 'Fix crash on empty cart');
  write('src/b.js', lines(4, 'b').replace('b 1\n', 'B one\n'));
  s.c3 = commit('carol', '2024-04-01T12:00:00Z', 'prefix the bugfix list');
  fs.appendFileSync(path.join(root, 'src/a.js'), lines(2, 'tail'));
  s.c4 = commit('ALICE', '2024-04-02T12:00:00Z', 'HOTFIX: regression in totals');
  git(['checkout', '-q', '-b', 'side']);
  write('docs/quick guide.md', lines(5, 'guide'));
  s.c5s = commit('bob', '2024-05-01T06:00:00Z', 'Add guide');
  git(['checkout', '-q', 'main']);
  fs.appendFileSync(path.join(root, 'README.md'), 'notes\n');
  s.c5m = commit('alice', '2024-05-02T12:00:00Z', 'Docs: patch notes');
  git(['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', "Merge branch 'side'", 'side'], as('alice', '2024-06-01T12:00:00Z'));
  s.c6 = git(['rev-parse', 'HEAD']);
  fs.rmSync(path.join(root, 'src/b.js'));
  write('assets/logo.bin', Buffer.from([0, 1, 2, 0, 255, 0, 10, 0]));
  s.c7 = commit('bob', '2024-07-01T12:00:00Z', 'Remove b, add logo');
  git(['checkout', '-q', '-b', 'pr']);
  fs.appendFileSync(path.join(root, 'src/a.js'), 'pr\n'); write('src/new.js', lines(3, 'new'));
  s.c8 = commit('carol', '2024-08-01T12:00:00Z', 'Fix bug in a, add new');
  git(['checkout', '-q', 'main']);
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-history-shallow-'));
  execFileSync('git', ['clone', '-q', '--depth', '2', '--branch', 'main', pathToFileURL(root).href, shallow], { env, encoding: 'utf8' });
  return { root, shallow, cfg, s };
}

// ---------------------------------------------------------------------------------------------------------------
// A second repository made to be hostile: names git would quote, a file that becomes a symbolic link, a change of
// mode only, a file the committed .gitattributes marks as not diffable, a merge that edits a file by itself, a
// local configuration that changes what `git log` prints, and a working tree whose .gitattributes is not the
// committed one. All by alice, one commit a day.
//
//   o1  2024-01-01  Initial import      root.txt +1, src/app.js +2, gen/data.js +2 (binary by attribute), .gitattributes +1,
//                                       -dash.txt, "dir with space/ñandú café.txt", "new\nline.txt", quote".txt, "tab\there.txt" +1 each
//   o2  2024-01-02  Präfix für Links    src/app.js becomes a symbolic link: +1 -2
//   o3  2024-01-03  Make root runnable  root.txt mode only: +0 -0
//   o4  2024-01-04  Fix data            gen/data.js +1, printed as "-\t-"            <- before
//   s1  2024-01-05  Add side            side.txt +1                                   <- side, branched from o3
//   o5  2024-01-06  Merge branch 'side' merge of o4 and s1 that ALSO appends a line to root.txt     <- main
// ---------------------------------------------------------------------------------------------------------------
const ODD = { accents: 'dir with space/\u00f1and\u00fa caf\u00e9.txt', tab: 'tab\there.txt', nl: 'new\nline.txt', quote: 'quote".txt', dash: '-dash.txt' };

function buildOdd(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-history-odd-')), env = cleanEnv(cfg);
  const git = (args, extra = {}) => execFileSync('git', args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const on = (day) => { const d = `2024-01-0${day}T12:00:00Z`; return { GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: MAIL.alice, GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: MAIL.alice, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }; };
  const write = (rel, content) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
  const commit = (day, subject) => { git(['add', '-A']); git(['commit', '-q', '--no-gpg-sign', '-m', subject], on(day)); return git(['rev-parse', 'HEAD']); };
  const s = {};
  git(['init', '-q', '-b', 'main']);
  write('root.txt', 'root\n'); write('src/app.js', lines(2, 'app')); write('gen/data.js', lines(2, 'data')); write('.gitattributes', 'gen/* -diff\n');
  for (const p of Object.values(ODD)) write(p, 'x\n');
  s.o1 = commit(1, 'Initial import');
  fs.rmSync(path.join(root, 'src/app.js')); fs.symlinkSync('../root.txt', path.join(root, 'src/app.js'));
  s.o2 = commit(2, 'Pr\u00e4fix f\u00fcr Links');
  fs.chmodSync(path.join(root, 'root.txt'), 0o755);
  s.o3 = commit(3, 'Make root runnable');
  git(['branch', 'side']);
  fs.appendFileSync(path.join(root, 'gen/data.js'), 'data 2\n');
  s.o4 = commit(4, 'Fix data');
  git(['branch', 'before']);
  git(['checkout', '-q', 'side']);
  write('side.txt', 'side\n');
  s.s1 = commit(5, 'Add side');
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '--no-commit', 'side'], on(6));
  fs.appendFileSync(path.join(root, 'root.txt'), 'edited inside the merge\n');
  s.o5 = commit(6, "Merge branch 'side'");
  // From here on nothing is committed. The repository's own configuration and working tree try to change the numbers.
  write('.git/order', 'tab*\nsrc/*\n');
  for (const [k, v] of [['log.showRoot', 'false'], ['diff.relative', 'true'], ['diff.orderFile', path.join(root, '.git/order')], ['diff.renames', 'copies'], ['diff.algorithm', 'patience'], ['log.showSignature', 'true']]) git(['config', k, v]);
  write('.gitattributes', '*.txt -diff\n'); // not committed: the ref still says gen/* -diff and nothing about *.txt
  return { root, s };
}

before(() => { const b = build(); dir = b.root; shallowDir = b.shallow; home = b.cfg; sha = b.s; const o = buildOdd(home); odd = o.root; oddSha = o.s; });
after(() => { for (const d of [dir, shallowDir, odd, home]) if (d) fs.rmSync(d, { recursive: true, force: true }); });

const expected = () => ({
  'assets/logo.bin': { commits: 1, authors: 1, fixes: 0, fixRatio: 0, churn: 0, ageDays: 0, sinceDays: 0, recent: 1, lastCommit: sha.c7 },
  'src/b.js': { commits: 3, authors: 3, fixes: 0, fixRatio: 0, churn: 10, ageDays: 547, sinceDays: 0, recent: 1, lastCommit: sha.c7 },
  'README.md': { commits: 2, authors: 1, fixes: 1, fixRatio: 0.5, churn: 3, ageDays: 547, sinceDays: 60, recent: 1, lastCommit: sha.c5m },
  'docs/quick guide.md': { commits: 1, authors: 1, fixes: 0, fixRatio: 0, churn: 5, ageDays: 61.25, sinceDays: 61.25, recent: 1, lastCommit: sha.c5s },
  'src/a.js': { commits: 3, authors: 2, fixes: 2, fixRatio: 2 / 3, churn: 16, ageDays: 547, sinceDays: 90, recent: 1, lastCommit: sha.c4 },
});
const ZERO = { commits: 0, authors: 0, fixes: 0, fixRatio: 0, churn: 0, ageDays: 0, sinceDays: 0, recent: 0, lastCommit: null };

test('fileHistoryStats: exact features of every path, newest path first', async () => {
  const all = await fileHistoryStats(dir, 'main');
  // src/a.js: c1 +10, c2 +3 -1, c4 +2 = 16 lines; alice and ALICE are one author; "Fix crash" and "HOTFIX" are fixes;
  //   2023-01-01 to 2024-07-01 = 365 + 182 = 547 days; c4 is exactly 90 days before the ref and counts as recent.
  // src/b.js: c1 +4, c3 +1 -1, c7 -4 = 10 lines; "bugfix" and "prefix" are not whole-word hits; c3 (91 days) is not recent.
  assert.deepEqual([...all], Object.entries(expected()));
  assert.deepEqual(all.window, {
    commits: 8, truncated: false, from: '2023-01-01T12:00:00.000Z', to: '2024-07-01T12:00:00.000Z', spanDays: 547, tip: sha.c7, merges: 1, shallow: false, maxCommits: 1500,
  });
});

test('historyFeatures: the given paths in the given order, the pull request itself is not counted', async () => {
  const h = await historyFeatures(dir, 'main', ['src/a.js', 'src/new.js', 'README.md', 'src/a.js']);
  assert.deepEqual([...h.keys()], ['src/a.js', 'src/new.js', 'README.md']);
  assert.deepEqual(h.get('src/a.js'), expected()['src/a.js']);
  assert.deepEqual(h.get('README.md'), expected()['README.md']);
  // A path with no history: zeros, and new is TRUE because the window holds the whole history.
  assert.deepEqual(h.get('src/new.js'), { ...ZERO, new: true });
  assert.equal(h.window.commits, 8);
  // From the head of the pull request the same paths have one more commit: the ref decides what is counted.
  const atPr = await historyFeatures(dir, 'pr', ['src/a.js', 'src/new.js']);
  assert.deepEqual(atPr.get('src/a.js'), { commits: 4, authors: 3, fixes: 3, fixRatio: 0.75, churn: 17, ageDays: 578, sinceDays: 0, recent: 1, lastCommit: sha.c8 });
  assert.deepEqual(atPr.get('src/new.js'), { commits: 1, authors: 1, fixes: 1, fixRatio: 1, churn: 3, ageDays: 0, sinceDays: 0, recent: 1, lastCommit: sha.c8 });
  assert.equal(atPr.window.to, '2024-08-01T12:00:00.000Z');
});

test('historyFeatures: same input, same output (nothing depends on the wall clock)', async () => {
  const a = await historyFeatures(dir, 'main', ['src/a.js', 'nope.txt']), b = await historyFeatures(dir, sha.c7, ['src/a.js', 'nope.txt']);
  assert.deepEqual([...a], [...b]);
  assert.deepEqual(a.window, b.window);
});

test('window: truncated exactly when the history is longer than maxCommits', async () => {
  // Newest first: c7, c6 (merge), c5m. The merge uses a place and touches nothing.
  const three = await fileHistoryStats(dir, 'main', { maxCommits: 3 });
  assert.deepEqual(three.window, { commits: 3, truncated: true, from: '2024-05-02T12:00:00.000Z', to: '2024-07-01T12:00:00.000Z', spanDays: 60, tip: sha.c7, merges: 1, shallow: false, maxCommits: 3 });
  assert.deepEqual([...three], [
    ['assets/logo.bin', { commits: 1, authors: 1, fixes: 0, fixRatio: 0, churn: 0, ageDays: 0, sinceDays: 0, recent: 1, lastCommit: sha.c7 }],
    ['src/b.js', { commits: 1, authors: 1, fixes: 0, fixRatio: 0, churn: 4, ageDays: 0, sinceDays: 0, recent: 1, lastCommit: sha.c7 }],
    ['README.md', { commits: 1, authors: 1, fixes: 1, fixRatio: 1, churn: 1, ageDays: 60, sinceDays: 60, recent: 1, lastCommit: sha.c5m }],
  ]);
  assert.equal((await fileHistoryStats(dir, 'main', { maxCommits: 7 })).window.truncated, true);
  const eight = await fileHistoryStats(dir, 'main', { maxCommits: 8 });
  assert.equal(eight.window.truncated, false);
  assert.equal(eight.window.commits, 8);
  const whole = await fileHistoryStats(dir, 'main', { maxCommits: Infinity });
  assert.deepEqual([whole.window.commits, whole.window.truncated, whole.window.maxCommits], [8, false, null]);
  // Nonsense limits fall back to the default instead of reading nothing.
  assert.equal((await fileHistoryStats(dir, 'main', { maxCommits: 0 })).window.maxCommits, 1500);
});

test('new is only claimed when it is known', async () => {
  // Truncated window, no tree: src/a.js exists and is old, src/new.js does not exist. The log cannot tell them apart.
  const blind = await historyFeatures(dir, 'main', ['src/a.js', 'src/new.js'], { maxCommits: 3 });
  assert.deepEqual(blind.get('src/a.js'), { ...ZERO, new: null });
  assert.deepEqual(blind.get('src/new.js'), { ...ZERO, new: null });
  // With the tree of the ref (strings or { path } objects, as loadSources returns) the answer is exact.
  const tree = ['README.md', { path: 'src/a.js' }, { path: 'assets/logo.bin' }];
  const seen = await historyFeatures(dir, 'main', ['src/a.js', 'src/new.js'], { maxCommits: 3, tree });
  assert.equal(seen.get('src/a.js').new, false);
  assert.equal(seen.get('src/new.js').new, true);
});

test('a shallow clone is reported as truncated: its history is cut by git, not complete', async () => {
  const h = await historyFeatures(shallowDir, 'main', ['src/a.js', 'src/b.js']);
  assert.equal(h.window.shallow, true);
  assert.equal(h.window.truncated, true);
  assert.equal(h.window.commits, 2);
  assert.equal(h.get('src/a.js').new, null);
  assert.equal(h.get('src/b.js').commits, 1);
  // c6 is where the clone is cut: git prints its whole tree as added. That is not a change, so nothing of it is counted.
  assert.deepEqual([...(await fileHistoryStats(shallowDir, 'main')).keys()], ['assets/logo.bin', 'src/b.js']);
  assert.equal((await fileHistoryStats(dir, 'main')).window.shallow, false);
});

test('a renamed file takes the history of its old path', async () => {
  const h = await historyFeatures(dir, 'main', [{ path: 'lib/a.js', oldPath: 'src/a.js' }, { path: 'README.md', oldPath: 'README.md' }, { path: 'x/y.js', oldPath: 'x/z.js' }]);
  assert.deepEqual(h.get('lib/a.js'), { ...expected()['src/a.js'], renamedFrom: 'src/a.js' });
  assert.deepEqual(h.get('README.md'), expected()['README.md']);
  assert.deepEqual(h.get('x/y.js'), { ...ZERO, new: true });
  assert.equal(changeHistory(h, ['lib/a.js']).ndev, 2);
});

test('selectHistory copies: changing a result does not change the source', async () => {
  const all = await fileHistoryStats(dir, 'main'), picked = selectHistory(all, ['src/a.js']);
  picked.get('src/a.js').commits = 99;
  assert.equal(all.get('src/a.js').commits, 3);
  assert.equal(picked.window, all.window);
  assert.equal(selectHistory(all, null).size, 0);
  assert.equal(selectHistory(all, [null, 7, {}]).size, 0);
});

test('a ref that is not a ref is rejected, and never read as an option', async () => {
  await assert.rejects(historyFeatures(dir, '--output=/tmp/x', ['src/a.js']), /not a ref/);
  await assert.rejects(historyFeatures(dir, '', []), /not a ref/);
  await assert.rejects(historyFeatures(dir, 'no-such-branch', []), /git log/);
});

// ---------------------------------------------------------------------------------------------------------------
// Against git itself. What git says about one path, asked with commands that share nothing with the module's single
// `git log`: rev-list picks the commits (no merges, no history simplification) and diff-tree counts each one's lines.
// ---------------------------------------------------------------------------------------------------------------
function byGit(repo, ref, p) {
  const run = (args, input) => execFileSync('git', ['--literal-pathspecs', `--attr-source=${ref}`, ...args], { cwd: repo, env: cleanEnv(home), encoding: 'utf8', input });
  const refTime = Number(run(['show', '-s', '--format=%ct', ref]));
  // "commit <sha>" then "<committer time> <author e-mail>" for each commit that changes the path.
  const rows = run(['rev-list', '--full-history', '--no-merges', '--format=%ct %ae', ref, '--', p]).split('\n').filter(Boolean);
  const shas = rows.filter((_, i) => i % 2 === 0).map((r) => r.slice(7)), meta = rows.filter((_, i) => i % 2 === 1).map((r) => r.split(' '));
  let churn = 0;
  for (const e of run(['diff-tree', '--stdin', '--root', '--no-commit-id', '--numstat', '--no-renames', '--no-relative', '-r', '-z', '--', p], shas.join('\n') + '\n').split('\0')) {
    const f = e.split('\t');
    if (f.length >= 3 && f.slice(2).join('\t') === p) churn += (Number(f[0]) || 0) + (Number(f[1]) || 0);
  }
  const times = meta.map((m) => Number(m[0])), d = (sec) => Math.round((sec / 86_400) * 100) / 100;
  return { commits: shas.length, authors: new Set(meta.map((m) => m[1].toLowerCase())).size, churn, ageDays: d(refTime - Math.min(...times)), sinceDays: d(refTime - Math.max(...times)) };
}

test('against git itself: every path of both repositories, at four refs, agrees with rev-list and diff-tree', async () => {
  let checked = 0;
  for (const [repo, ref] of [[dir, 'main'], [dir, 'pr'], [odd, 'main'], [odd, 'before']]) {
    const all = await fileHistoryStats(repo, ref);
    // Every path that ever existed on a non-merge commit of the ref, so a path the module lost would be noticed too.
    const everywhere = new Set(execFileSync('git', ['log', '--root', '--no-merges', '--no-renames', '--no-relative', '--name-only', '-z', '--format=', ref, '--'], { cwd: repo, env: cleanEnv(home), encoding: 'utf8' }).split('\0').map((x) => x.replace(/^\n+/, '')).filter(Boolean));
    assert.deepEqual([...all.keys()].sort(), [...everywhere].sort(), `${ref}: the same set of paths`);
    for (const [p, f] of all) {
      const { commits, authors, churn, ageDays, sinceDays } = f;
      assert.deepEqual({ commits, authors, churn, ageDays, sinceDays }, byGit(repo, ref, p), `${ref}: ${JSON.stringify(p)}`);
      checked++;
    }
  }
  assert.equal(checked, 5 + 6 + 10 + 9);
});

const one = (o1, extra = {}) => ({ commits: 1, authors: 1, fixes: 0, fixRatio: 0, churn: 1, ageDays: 5, sinceDays: 5, recent: 1, lastCommit: o1, ...extra });
const oddExpected = () => [
  ['side.txt', one(oddSha.s1, { ageDays: 1, sinceDays: 1 })],
  // Marked "-diff" by the .gitattributes committed at the ref: both commits count, their lines cannot ("-\t-").
  ['gen/data.js', { commits: 2, authors: 1, fixes: 1, fixRatio: 0.5, churn: 0, ageDays: 5, sinceDays: 2, recent: 2, lastCommit: oddSha.o4 }],
  // o1 +1 and o3 (mode only, +0 -0). The line the merge o5 appended is not seen: git log prints no diff for a merge.
  ['root.txt', { commits: 2, authors: 1, fixes: 0, fixRatio: 0, churn: 1, ageDays: 5, sinceDays: 3, recent: 2, lastCommit: oddSha.o3 }],
  // o1 +2, then file -> symbolic link is ONE entry (+1 -2), not a deletion plus a creation. "Präfix" is not a fix.
  ['src/app.js', { commits: 2, authors: 1, fixes: 0, fixRatio: 0, churn: 5, ageDays: 5, sinceDays: 4, recent: 2, lastCommit: oddSha.o2 }],
  [ODD.dash, one(oddSha.o1)], ['.gitattributes', one(oddSha.o1)], [ODD.accents, one(oddSha.o1)], [ODD.nl, one(oddSha.o1)], [ODD.quote, one(oddSha.o1)], [ODD.tab, one(oddSha.o1)],
];

test('hostile repository: names git would quote, a type change, a mode change, a file binary by attribute', async () => {
  const all = await fileHistoryStats(odd, 'main');
  assert.deepEqual([...all], oddExpected());
  assert.deepEqual(all.window, { commits: 6, truncated: false, from: '2024-01-01T12:00:00.000Z', to: '2024-01-06T12:00:00.000Z', spanDays: 5, tip: oddSha.o5, merges: 1, shallow: false, maxCommits: 1500 });
  // The names reach the caller exactly as git stores them, so a lookup by the caller's own string works.
  const h = await historyFeatures(odd, 'main', [ODD.accents, ODD.tab, ODD.nl, ODD.quote, ODD.dash, ODD.accents.normalize('NFD')]);
  for (const p of [ODD.accents, ODD.tab, ODD.nl, ODD.quote, ODD.dash]) assert.equal(h.get(p).commits, 1, JSON.stringify(p));
  // The same name in another Unicode normal form is another string, hence another path: no history, reported new.
  assert.equal(h.get(ODD.accents.normalize('NFD')).new, true);
});

test('the configuration of the repository and its checked-out files do not change the numbers', async () => {
  // buildOdd left behind: log.showRoot=false (git would hide the files of the root commit), diff.relative=true
  // (from a subdirectory git would drop every path outside it), diff.orderFile (another order of the files),
  // diff.renames, diff.algorithm, and an uncommitted .gitattributes that marks *.txt as binary and no longer gen/*.
  assert.equal(execFileSync('git', ['config', 'log.showRoot'], { cwd: odd, env: cleanEnv(home), encoding: 'utf8' }).trim(), 'false');
  assert.equal(fs.readFileSync(path.join(odd, '.gitattributes'), 'utf8'), '*.txt -diff\n');
  const fromRoot = await fileHistoryStats(odd, 'main'), fromSub = await fileHistoryStats(path.join(odd, 'src'), 'main');
  assert.deepEqual([...fromSub], [...fromRoot]);
  assert.deepEqual(fromSub.window, fromRoot.window);
  assert.equal(fromRoot.get(ODD.dash).commits, 1);     // only in the root commit: lost if log.showRoot were obeyed
  assert.equal(fromRoot.get('root.txt').churn, 1);     // 0 if the working tree's "*.txt -diff" were obeyed
  assert.equal(fromRoot.get('gen/data.js').churn, 0);  // 3 if the committed "gen/* -diff" were ignored
  // At o3 the committed .gitattributes is the same, at every ref the answer is the one of that ref's own tree.
  assert.equal((await fileHistoryStats(odd, oddSha.o3)).get('gen/data.js').churn, 0);
});

test('history does not follow a rename, whatever diff.renames says: the old path ends, the new one starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-history-rename-')), env = cleanEnv(home);
  const git = (args, date) => execFileSync('git', args, { cwd: root, env: { ...env, GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: MAIL.alice, GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: MAIL.alice, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'diff.renames', 'true']);
    fs.writeFileSync(path.join(root, 'old name.js'), lines(6, 'keep'));
    git(['add', '-A']); git(['commit', '-q', '--no-gpg-sign', '-m', 'Add'], '2024-03-01T12:00:00Z');
    git(['mv', 'old name.js', 'new name.js']);
    git(['commit', '-q', '--no-gpg-sign', '-m', 'Rename'], '2024-03-11T12:00:00Z');
    const all = await fileHistoryStats(root, 'main');
    // A pure rename of 6 lines: git reports 6 deleted there and 6 added here. Nobody wrote 12 lines; that is the limit.
    assert.deepEqual([...all].map(([p, f]) => [p, f.commits, f.churn, f.ageDays, f.sinceDays]), [['new name.js', 1, 6, 0, 0], ['old name.js', 2, 12, 10, 0]]);
    // The caller that knows the rename (the pull request's own) can ask for the old path's history under the new name.
    assert.equal(selectHistory(all, [{ path: 'newer.js', oldPath: 'new name.js' }]).get('newer.js').renamedFrom, 'new name.js');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a merge that edits a file by itself leaves no trace (a documented limit, stated here so it stays stated)', async () => {
  const all = await fileHistoryStats(odd, 'main');
  const atMain = execFileSync('git', ['show', 'main:root.txt'], { cwd: odd, env: cleanEnv(home), encoding: 'utf8' });
  assert.equal(atMain, 'root\nedited inside the merge\n'); // the edit is real
  assert.deepEqual([all.get('root.txt').commits, all.get('root.txt').churn, all.get('root.txt').lastCommit], [2, 1, oddSha.o3]); // and uncounted
  assert.equal(all.window.merges, 1);
});

test('only commits reachable from the ref are counted: a branch is invisible until it is merged', async () => {
  // `side` (s1) plays the pull request, `before` (o4) the target branch; their merge base is o3.
  const base = execFileSync('git', ['merge-base', 'before', 'side'], { cwd: odd, env: cleanEnv(home), encoding: 'utf8' }).trim();
  assert.equal(base, oddSha.o3);
  for (const ref of [base, 'before']) {
    const all = await fileHistoryStats(odd, ref);
    assert.equal(all.has('side.txt'), false, ref);
    assert.equal([...all.values()].some((f) => f.lastCommit === oddSha.s1), false, ref);
  }
  const atBase = await historyFeatures(odd, base, ['gen/data.js', 'side.txt']);
  assert.equal(atBase.get('gen/data.js').commits, 1);  // o4 comes after the merge base
  assert.deepEqual(atBase.get('side.txt'), { ...ZERO, new: true });
  assert.equal(atBase.window.commits, 3);
  // Once merged into main the same commit is history like any other.
  assert.equal((await fileHistoryStats(odd, 'main')).get('side.txt').lastCommit, oddSha.s1);
});

test('the ref must name one commit: a range would read as a complete history and mark old files as new', async () => {
  // Before this was rejected, "main~1..main" read one commit, reported truncated: false, and so src/a.js
  // (three commits, alive) came back as { commits: 0, new: true }.
  for (const bad of ['main~1..main', 'main...pr', '^main', 'main^!', 'main^@', 'main^-', 'main^-1', '..', '-n1']) await assert.rejects(historyFeatures(dir, bad, ['src/a.js']), /not a ref/, bad);
  // Expressions that name a single commit still work.
  for (const [ok, commits] of [['main~1', 7], ['main^', 7], ['main^{commit}', 8], ['main~1^2', 5], [sha.c7, 8], ['HEAD', 8]]) assert.equal((await fileHistoryStats(dir, ok)).window.commits, commits, ok);
});

test('a git too old for --attr-source: the log runs again without it and gives the same numbers', async () => {
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'katse-history-oldgit-')), calls = path.join(bin, 'calls');
  // A stand-in for git 2.39: it refuses the option the way git does and passes everything else on.
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${calls}'\ncase "$1" in --attr-source=*) echo "unknown option: $1" >&2; exit 129;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH, usual = await fileHistoryStats(dir, 'main');
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    const old = await fileHistoryStats(dir, 'main');
    assert.deepEqual([...old], [...usual]);
    assert.deepEqual(old.window, usual.window);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['--attr-source=main', 'log']);
    await assert.rejects(fileHistoryStats(dir, 'no-such-branch'), /git log/);
  } finally { process.env.PATH = saved; fs.rmSync(bin, { recursive: true, force: true }); }
});

test('changeHistory: NDEV, AGE and NUC as Kamei et al. define them', async () => {
  const all = await fileHistoryStats(dir, 'main');
  // a.js: alice, bob. b.js: alice, carol, bob. Union = 3. Last changed 90 and 0 days ago: mean 45. Last commits c4 and c7: 2.
  assert.deepEqual(changeHistory(all, ['src/a.js', 'src/b.js', 'src/new.js', 'src/a.js']), { files: 3, withHistory: 2, ndev: 3, age: 45, nuc: 2 });
  // b.js and the logo were both last changed by c7: one unique last change.
  assert.deepEqual(changeHistory(all, ['src/b.js', { path: 'assets/logo.bin' }]), { files: 2, withHistory: 2, ndev: 3, age: 0, nuc: 1 });
  assert.deepEqual(changeHistory(all, ['README.md', 'docs/quick guide.md']), { files: 2, withHistory: 2, ndev: 2, age: 60.63, nuc: 2 }); // (60 + 61.25) / 2 = 60.625
  // Nothing with history: a mean of nothing is null, not 0.
  assert.deepEqual(changeHistory(all, ['src/new.js']), { files: 1, withHistory: 0, ndev: 0, age: null, nuc: 0 });
  assert.deepEqual(changeHistory(all, []), { files: 0, withHistory: 0, ndev: 0, age: null, nuc: 0 });
  // The same answers from the subset historyFeatures returns.
  const h = await historyFeatures(dir, 'main', ['src/a.js', 'src/b.js', 'src/new.js']);
  assert.deepEqual(changeHistory(h, [...h.keys()]), { files: 3, withHistory: 2, ndev: 3, age: 45, nuc: 2 });
  // A map this module did not build has no author sets: ndev is unknown, not 0.
  const foreign = new Map([['f', { commits: 2, sinceDays: 4, lastCommit: 'abc' }]]);
  assert.deepEqual(changeHistory(foreign, ['f']), { files: 1, withHistory: 1, ndev: null, age: 4, nuc: 1 });
});

test('results carry counts only: no e-mail address leaves the module', async () => {
  const all = await fileHistoryStats(dir, 'main');
  const dump = JSON.stringify([[...all], all.window, changeHistory(all, [...all.keys()]), repoBaseline(all)]);
  assert.equal(/@|alice|bob|carol/i.test(dump), false);
});

// ---------------------------------------------------------------------------------------------------------------
// parseLog on hand-written input: names git would have to quote, a binary entry, a merge, skewed clocks.
// ---------------------------------------------------------------------------------------------------------------
const DAY = 86_400, T = 1_700_000_000;
const rec = (id, parents, t, mail, subject, entries = []) => `\x01${id}\x1f${parents}\x1f${t}\x1f${mail}\x1f${subject}\0${entries.length ? `\n${entries.map((e) => `${e}\0`).join('')}` : ''}`;
const RAW = [
  rec('c3', 'c2', T, 'A@x.org', 'fix: a subject\x1fwith a unit separator', ['3\t1\tdocs/guía rápida.md', '-\t-\timg/logo.png']),
  rec('c2', 'c1 c0', T - 10 * DAY, 'b@x.org', 'Merge branch'),
  rec('c1', 'c0', T - 100 * DAY, 'a@x.org', 'Add odd names', ['2\t0\todd\tname.txt', '5\t0\tdocs/guía rápida.md']),
  rec('c0', '', T + 5 * DAY, 'c@x.org', 'root with a clock five days ahead of the ref', ['1\t0\tskew.txt']),
].join('');

test('parseLog: verbatim paths, binary entries, merges, separators inside the subject', () => {
  const h = parseLog(RAW);
  assert.deepEqual([...h], [
    ['docs/guía rápida.md', { commits: 2, authors: 1, fixes: 1, fixRatio: 0.5, churn: 9, ageDays: 100, sinceDays: 0, recent: 1, lastCommit: 'c3' }],
    ['img/logo.png', { commits: 1, authors: 1, fixes: 1, fixRatio: 1, churn: 0, ageDays: 0, sinceDays: 0, recent: 1, lastCommit: 'c3' }],
    ['odd\tname.txt', { commits: 1, authors: 1, fixes: 0, fixRatio: 0, churn: 2, ageDays: 100, sinceDays: 100, recent: 0, lastCommit: 'c1' }],
    // A commit dated after the ref: intervals are never negative.
    ['skew.txt', { commits: 1, authors: 1, fixes: 0, fixRatio: 0, churn: 1, ageDays: 0, sinceDays: 0, recent: 1, lastCommit: 'c0' }],
  ]);
  assert.deepEqual(h.window, { commits: 4, truncated: false, from: new Date((T - 100 * DAY) * 1000).toISOString(), to: new Date(T * 1000).toISOString(), spanDays: 100, tip: 'c3', merges: 1, shallow: false, maxCommits: null });
});

test('parseLog: the record after the limit is dropped and sets truncated', () => {
  const h = parseLog(RAW, 2);
  assert.deepEqual([...h.keys()], ['docs/guía rápida.md', 'img/logo.png']);
  assert.equal(h.get('docs/guía rápida.md').commits, 1);
  assert.deepEqual([h.window.commits, h.window.truncated, h.window.merges, h.window.maxCommits], [2, true, 1, 2]);
  assert.equal(parseLog(RAW, 4).window.truncated, false);
});

test('parseLog: a commit whose parents are missing is read but its entries are not changes', () => {
  const h = parseLog(RAW, Infinity, new Set(['c1']));
  assert.deepEqual([...h.keys()], ['docs/guía rápida.md', 'img/logo.png', 'skew.txt']);
  assert.deepEqual(h.get('docs/guía rápida.md'), { commits: 1, authors: 1, fixes: 1, fixRatio: 1, churn: 4, ageDays: 0, sinceDays: 0, recent: 1, lastCommit: 'c3' });
  assert.deepEqual([h.window.commits, h.window.shallow, h.window.truncated], [4, true, true]);
});

test('parseLog: earliest and latest follow the dates, not the order of the records', () => {
  const raw = rec('r', 'p', T, 'a@x.org', 'ref') + rec('p', 'q', T - 3 * DAY, 'a@x.org', 'newer by position', ['1\t0\tf']) + rec('q', '', T - 1 * DAY, 'b@x.org', 'newer by date', ['1\t1\tf']);
  assert.deepEqual(parseLog(raw).get('f'), { commits: 2, authors: 2, fixes: 0, fixRatio: 0, churn: 3, ageDays: 3, sinceDays: 1, recent: 2, lastCommit: 'q' });
});

test('parseLog: empty input', () => {
  const h = parseLog('');
  assert.equal(h.size, 0);
  assert.deepEqual(h.window, { commits: 0, truncated: false, from: null, to: null, spanDays: 0, tip: null, merges: 0, shallow: false, maxCommits: null });
  assert.deepEqual(repoBaseline(h), { files: 0, commits: { median: null, p90: null }, authors: { median: null, p90: null }, fixRatio: { median: null, p90: null } });
  assert.deepEqual(selectHistory(h, ['a']).get('a'), { ...ZERO, new: true });
});

test('isFixSubject: whole words, any case, and the misses it is documented to have', () => {
  for (const s of ['Fix crash', 'fixes #12', 'FIXED it', 'a bug in the parser', 'hotfix', 'fix(scope): y', 'Regression in z', 'page fault handling', 'apply patch', 'known defect', 'bug-fix for x', 'Crash.']) assert.equal(isFixSubject(s), true, s);
  for (const s of ['prefix the bugfix list', 'Fixing typos', 'debugging helpers', 'patchwork', 'Add feature', 'fix_this later', 'bugs everywhere', '', null, undefined]) assert.equal(isFixSubject(s), false, String(s));
  assert.deepEqual(FIX_WORDS, ['fix', 'fixes', 'fixed', 'bug', 'defect', 'patch', 'hotfix', 'regression', 'fault', 'crash']);
});

test('isFixSubject: a whole word in any alphabet, not only between ASCII letters', () => {
  // With the ASCII-only \b each of these counted as a fix: the letter before or after "fix" is not ASCII.
  for (const s of ['Präfix für Links', 'préfix du module', 'Suffixé', 'übug', 'crashé', 'buǵ', 'преfix']) assert.equal(isFixSubject(s), false, s);
  // Punctuation and symbols outside ASCII still end a word, and scripts written without spaces do not hide one.
  for (const s of ['«fix» du parseur', 'fix—again', '→ bug', 'バグfix', '修正bug', 'исправлен bug']) assert.equal(isFixSubject(s), true, s);
});

// ---------------------------------------------------------------------------------------------------------------
// changeEntropy
// ---------------------------------------------------------------------------------------------------------------
const EMPTY = { bits: 0, normalized: 0, files: 0, counted: 0, dirs: 0, subsystems: 0, linesAdded: 0, linesDeleted: 0 };

test('changeEntropy: empty input', () => {
  assert.deepEqual(changeEntropy([]), EMPTY);
  assert.deepEqual(changeEntropy(undefined), EMPTY);
  assert.deepEqual(changeEntropy([null, {}, { add: 3, del: 1 }]), EMPTY);
});

test('changeEntropy: one file is 0 bits (and not -0)', () => {
  const e = changeEntropy([{ path: 'src/a.js', add: 7, del: 3 }]);
  assert.deepEqual(e, { bits: 0, normalized: 0, files: 1, counted: 1, dirs: 1, subsystems: 1, linesAdded: 7, linesDeleted: 3 });
  assert.ok(Object.is(e.bits, 0));
});

test('changeEntropy: two equal files are 1 bit', () => {
  assert.deepEqual(changeEntropy([{ path: 'src/a.js', add: 5, del: 0 }, { path: 'src/b.js', add: 2, del: 3 }]),
    { bits: 1, normalized: 1, files: 2, counted: 2, dirs: 1, subsystems: 1, linesAdded: 7, linesDeleted: 3 });
  // Lines are added + deleted: 3 + 1 against 0 + 4.
  assert.equal(changeEntropy([{ path: 'a', add: 3, del: 1 }, { path: 'b', add: 0, del: 4 }]).bits, 1);
});

test('changeEntropy: 50 / 25 / 25 is 1.5 bits', () => {
  // 0.5 * 1 + 0.25 * 2 + 0.25 * 2 = 1.5; normalised by log2(3) = 1.5849625 gives 0.946395.
  const e = changeEntropy([{ path: 'a/x.js', add: 50, del: 0 }, { path: 'b/y.js', add: 20, del: 5 }, { path: 'c/z.js', add: 0, del: 25 }]);
  assert.deepEqual(e, { bits: 1.5, normalized: 0.946395, files: 3, counted: 3, dirs: 3, subsystems: 3, linesAdded: 70, linesDeleted: 30 });
});

test('changeEntropy: the worked example of Kamei et al. (30, 20 and 10 lines give 1.46)', () => {
  // 1/2 * 1 + 1/3 * log2(3) + 1/6 * log2(6) = 0.5 + 0.528321 + 0.430827 = 1.459148; / 1.584963 = 0.92062.
  const e = changeEntropy([{ path: 'A', add: 30, del: 0 }, { path: 'B', add: 20, del: 0 }, { path: 'C', add: 10, del: 0 }]);
  assert.equal(e.bits, 1.459148);
  assert.equal(e.bits.toFixed(2), '1.46');
  assert.equal(e.normalized, 0.92062);
});

test('changeEntropy: n equal files reach the maximum log2(n) and normalise to exactly 1', () => {
  for (const [n, bits] of [[3, 1.584963], [4, 2], [5, 2.321928], [7, 2.807355], [8, 3], [100, 6.643856]]) {
    const e = changeEntropy(Array.from({ length: n }, (_, i) => ({ path: `d${i}/f.js`, add: 3, del: 0 })));
    assert.equal(e.bits, bits, `n = ${n}`);
    assert.equal(e.normalized, 1, `n = ${n}`);
    assert.equal(e.dirs, n);
  }
});

test('changeEntropy: a lopsided change is close to 0', () => {
  // 1023 lines and 1 line: (1/1024) * 10 + (1023/1024) * log2(1024/1023) = 0.009766 + 0.001408 = 0.011174.
  const e = changeEntropy([{ path: 'big.js', add: 1000, del: 23 }, { path: 'tiny.js', add: 1, del: 0 }]);
  assert.equal(e.bits, 0.011174);
  assert.equal(e.normalized, 0.011174);
});

test('changeEntropy: extremely lopsided changes stay finite, non-negative and small', () => {
  // N = 1,000,001 lines, one of them elsewhere: log2(N)/N + ((N-1)/N) * log2(N/(N-1)) = 0.00001993 + 0.00000144 = 0.00002137.
  const e = changeEntropy([{ path: 'gen/big.cs', add: 600_000, del: 400_000 }, { path: 'src/one.cs', add: 0, del: 1 }]);
  assert.deepEqual(e, { bits: 0.000021, normalized: 0.000021, files: 2, counted: 2, dirs: 2, subsystems: 2, linesAdded: 600_000, linesDeleted: 400_001 });
  // Below the sixth decimal the entropy prints as 0, but `counted` still says two files carried lines.
  const tiny = changeEntropy([{ path: 'a', add: 1e12, del: 0 }, { path: 'b', add: 1, del: 0 }]);
  assert.deepEqual([tiny.bits, tiny.normalized, tiny.counted], [0, 0, 2]);
  assert.ok(Object.is(tiny.bits, 0));
});

test('changeEntropy: against the formula written another way, for 200 fixed pseudo-random changes', () => {
  let seed = 2024;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648); // fixed sequence, no Math.random
  for (let round = 0; round < 200; round++) {
    const n = 1 + (next() % 12), files = Array.from({ length: n }, (_, i) => ({ path: `d${next() % 4}/f${i}.js`, add: next() % 50, del: next() % 7 === 0 ? 0 : next() % 20 }));
    const k = files.map((f) => f.add + f.del).filter(Boolean), total = k.reduce((a, b) => a + b, 0);
    // H = log2(T) - (1/T) * sum k_i log2(k_i): the same quantity without ever forming a share p_i.
    const h = k.length ? Math.log2(total) - k.reduce((a, x) => a + x * Math.log2(x), 0) / total : 0;
    const e = changeEntropy(files);
    assert.ok(Math.abs(e.bits - h) < 1e-6, `round ${round}: ${e.bits} against ${h}`);
    assert.equal(e.counted, k.length);
    assert.ok(e.bits >= 0 && e.bits <= Math.log2(Math.max(1, k.length)) + 1e-6);
    assert.ok(e.normalized >= 0 && e.normalized <= 1);
    // Shares do not change when every count is multiplied by the same number.
    assert.equal(changeEntropy(files.map((f) => ({ ...f, add: f.add * 7, del: f.del * 7 }))).bits, e.bits);
  }
});

test('changeEntropy: files with no changed lines are counted as files but left out of the entropy', () => {
  const e = changeEntropy([{ path: 'src/a.js', add: 10, del: 0 }, { path: 'src/b.js', add: 0, del: 10 }, { path: 'img/logo.png', add: 0, del: 0 }, { path: 'moved/c.js' }]);
  assert.deepEqual(e, { bits: 1, normalized: 1, files: 4, counted: 2, dirs: 3, subsystems: 3, linesAdded: 10, linesDeleted: 10 });
  // Only files without lines: nothing to measure.
  assert.deepEqual(changeEntropy([{ path: 'a.png', add: 0, del: 0 }, { path: 'b.png', add: 0, del: 0 }]), { ...EMPTY, files: 2, dirs: 1, subsystems: 1 });
});

test('changeEntropy: directories (ND) and top-level directories (NS)', () => {
  const e = changeEntropy(['README.md', 'LICENSE', 'src/a.js', 'src/lib/b.js', 'src/lib/c.js', 'test/a.test.js'].map((p) => ({ path: p, add: 1, del: 0 })));
  // Directories: root, src, src/lib, test. Top level: root, src, test.
  assert.deepEqual([e.files, e.dirs, e.subsystems], [6, 4, 3]);
  // The example of Kamei et al.: one file, subsystem org.eclipse.jdt.core.
  const k = changeEntropy([{ path: 'org.eclipse.jdt.core/jdom/org/eclipse/jdt/core/dom/Node.java', add: 4, del: 2 }, { path: 'org.eclipse.jdt.core/jdom/org/eclipse/jdt/core/dom/Other.java', add: 1, del: 0 }, { path: 'org.eclipse.jdt.ui/a/B.java', add: 1, del: 0 }]);
  assert.deepEqual([k.files, k.dirs, k.subsystems], [3, 2, 2]);
});

test('changeEntropy: the same path twice is one file; bad counts are read as 0', () => {
  const e = changeEntropy([{ path: 'a', add: 2, del: 0 }, { path: 'a', add: 0, del: 2 }, { path: 'b', add: '4', del: -9 }, { path: 'c', add: NaN, del: 'x' }, { path: 'd', add: 2.9, del: Infinity }]);
  // a: 4 lines, b: 4 lines, c: 0, d: 2 lines -> shares 0.4, 0.4, 0.2 -> 2 * 0.4 * log2(2.5) + 0.2 * log2(5) = 1.057542 + 0.464386.
  assert.deepEqual(e, { bits: 1.521928, normalized: 0.960230, files: 4, counted: 3, dirs: 1, subsystems: 1, linesAdded: 8, linesDeleted: 2 });
});

test('changeEntropy: the order of the files does not matter and the input is not modified', () => {
  const files = [{ path: 'x/a', add: 9, del: 1 }, { path: 'y/b', add: 3, del: 0 }, { path: 'z/c', add: 0, del: 40 }], copy = structuredClone(files);
  assert.deepEqual(changeEntropy(files), changeEntropy([...files].reverse()));
  assert.deepEqual(files, copy);
});

// ---------------------------------------------------------------------------------------------------------------
// repoBaseline and shareBelow
// ---------------------------------------------------------------------------------------------------------------
const histOf = (commits) => new Map(commits.map((c, i) => [`f${i}`, { commits: c, authors: Math.min(c, 3), fixRatio: c ? (i % 2) / 2 : 0 }]));

test('repoBaseline: the throwaway repository', async () => {
  const all = await fileHistoryStats(dir, 'main');
  // commits 1 1 2 3 3, authors 1 1 1 2 3, fixRatio 0 0 0 0.5 0.667. n = 5: the median is the 3rd, p90 the 5th (ceil(4.5)).
  assert.deepEqual(repoBaseline(all), { files: 5, commits: { median: 2, p90: 3 }, authors: { median: 1, p90: 3 }, fixRatio: { median: 0, p90: 2 / 3 } });
  assert.equal(shareBelow(all, 'commits', 3), 0.6);
  assert.equal(shareBelow(all, 'commits', 4), 1);
  assert.equal(shareBelow(all, 'commits', 1), 0);
  assert.equal(shareBelow(all, 'churn', 10), 0.6); // 0, 3 and 5 are below 10; 10 and 16 are not
  // Only the files that still exist at the ref: src/b.js was deleted by c7.
  const alive = repoBaseline(all, { filter: (p) => p !== 'src/b.js' });
  assert.deepEqual(alive, { files: 4, commits: { median: 1.5, p90: 3 }, authors: { median: 1, p90: 2 }, fixRatio: { median: 0.25, p90: 2 / 3 } }); // 0 0 0.5 0.667
  assert.deepEqual(repoBaseline(all, { filter: (p, f) => f.commits >= 3 }).files, 2);
});

test('repoBaseline: median and p90 by hand (Hyndman and Fan definition 2)', () => {
  assert.deepEqual(repoBaseline(histOf([4, 1, 3, 2])).commits, { median: 2.5, p90: 4 });        // n*0.9 = 3.6 -> 4th
  assert.deepEqual(repoBaseline(histOf([7])).commits, { median: 7, p90: 7 });
  assert.deepEqual(repoBaseline(histOf([1, 2])).commits, { median: 1.5, p90: 2 });
  assert.deepEqual(repoBaseline(histOf([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).commits, { median: 5.5, p90: 9.5 }); // n*0.9 = 9 exactly: mean of 9th and 10th
  assert.deepEqual(repoBaseline(histOf(Array.from({ length: 20 }, (_, i) => i + 1))).commits, { median: 10.5, p90: 18.5 });
  // 0.9 * 70 is 62.99999999999999 in floating point; the exact product is 63, so the answer is the mean of the 63rd and 64th.
  assert.deepEqual(repoBaseline(histOf(Array.from({ length: 70 }, (_, i) => i + 1))).commits, { median: 35.5, p90: 63.5 });
  // Paths without history are not part of the population.
  assert.deepEqual(repoBaseline(histOf([0, 0, 5, 0, 1])), { files: 2, commits: { median: 3, p90: 5 }, authors: { median: 2, p90: 3 }, fixRatio: { median: 0, p90: 0 } });
  assert.deepEqual(repoBaseline(new Map()), { files: 0, commits: { median: null, p90: null }, authors: { median: null, p90: null }, fixRatio: { median: null, p90: null } });
  assert.equal(shareBelow(new Map(), 'commits', 3), null);
});

test('repoBaseline: a value above p90 is above at least 90% of the files, above the median at least half', () => {
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648); // fixed sequence, no Math.random
  for (let n = 1; n <= 60; n++) {
    const h = histOf(Array.from({ length: n }, () => 1 + (next() % 9)));
    const { median, p90 } = repoBaseline(h).commits;
    for (let x = 1; x <= 11; x++) {
      if (x > p90) assert.ok(shareBelow(h, 'commits', x) >= 0.9, `n=${n} x=${x} p90=${p90}`);
      if (x > median) assert.ok(shareBelow(h, 'commits', x) >= 0.5, `n=${n} x=${x} median=${median}`);
    }
  }
});
