// What git history says about the files a pull request touches, and how scattered the change is.
//
// Nothing in this module is a proof and nothing in it reads code. It returns counts taken from one `git log`
// and two closed-form statistics of a diff. That numbers like these go together with defects is an empirical
// finding of the studies below, made on other projects; the engine may use them to decide what a person or an
// agent looks at first, never to clear a change.
//
// Basis
//   Kamei, Shihab, Adams, Hassan, Mockus, Sinha and Ubayashi (2013), "A Large-Scale Empirical Study of
//     Just-in-Time Quality Assurance", IEEE Transactions on Software Engineering 39(6). Fourteen measures of one
//     change: diffusion NS, ND, NF, Entropy; size LA, LD, LT; purpose FIX; history NDEV, AGE, NUC; experience
//     EXP, REXP, SEXP. Implemented here as that paper defines them: NS, ND, NF, Entropy, LA, LD (changeEntropy)
//     and NDEV, AGE, NUC (changeHistory), the last three inside the window of history that was read. Not
//     implemented: LT (the caller already holds the file) and EXP, REXP, SEXP (experience of the author).
//   Hassan (2009), "Predicting Faults Using the Complexity of Code Changes", ICSE. Shannon's entropy over the
//     share of modifications each file receives, as a measure of how scattered changes are. Hassan applies it
//     to the changes of a period; Kamei et al. apply the same formula to one change with the share of modified
//     lines, and that is the form computed here.
//   Nagappan and Ball (2005), "Use of Relative Code Churn Measures to Predict System Defect Density", ICSE.
//     Their result: churn measures taken RELATIVE to size predict defect density better than absolute ones.
//     `churn` below is absolute (lines added plus deleted as git counts them, a modified line being one of
//     each), so divide it by the file's line count before comparing files.
//   Mockus and Weiss (2000), "Predicting Risk of Software Changes", Bell Labs Technical Journal 5(2). Predicts
//     the risk of a change from properties of the change itself: how many subsystems, modules and files it
//     touches, its size, whether it is a fix. Kamei et al. build on these measures.
//   Mockus and Votta (2000), "Identifying Reasons for Software Changes Using Historic Databases", ICSM. Reading
//     the purpose of a change (corrective or not) from the words of its description. Kamei et al. search the log
//     for "bug", "fix", "defect", "patch" and defect ids, citing Kim, Whitehead and Zhang (2008), "Classifying
//     Software Changes: Clean or Buggy?", IEEE TSE 34(2). The word list used here is ours, see FIX_WORDS.
//   Hyndman and Fan (1996), "Sample Quantiles in Statistical Packages", The American Statistician 50(4).
//     Definition 2 of the sample quantile, used by repoBaseline.
import fs from 'node:fs';
import path from 'node:path';
import { gitRaw } from './repo.js';

const DAY = 86_400;      // seconds
const RECENT_DAYS = 90;

/**
 * Words that mark a commit as corrective when one of them is a whole word of its subject, in any case.
 * A HEURISTIC, not a classification: "bugfix", "fixing" and "bugs" are missed, "patch version" and "Revert the
 * fix" are false hits, and a fix whose subject says none of these words (or says it in another language) is not
 * counted. Report it as "subject mentions a fix".
 */
export const FIX_WORDS = ['fix', 'fixes', 'fixed', 'bug', 'defect', 'patch', 'hotfix', 'regression', 'fault', 'crash'];
// "Whole word" means no letter, mark, digit or underscore on either side, in any alphabet. JavaScript's \b only
// knows ASCII letters, so it finds "fix" inside "Präfix" and "préfix". Han, Hiragana and Katakana are written
// without spaces between words, so a neighbour in those scripts does not make the word part of a longer one.
const WORD_CHAR = '(?![\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}])[\\p{L}\\p{M}\\p{N}_]';
const FIX_RE = new RegExp(`(?<!${WORD_CHAR})(?:${FIX_WORDS.join('|')})(?!${WORD_CHAR})`, 'iu');
export const isFixSubject = (subject) => FIX_RE.test(String(subject ?? ''));

// One record per commit: \x01 sha \x1f parents \x1f committer time \x1f author e-mail \x1f subject. With -z the
// record and every numstat entry end in NUL and paths are printed verbatim, so no path needs unquoting.
const FORMAT = '--format=%x01%H%x1f%P%x1f%ct%x1f%ae%x1f%s';
// Author identities stay inside the module as small integers: the results carry counts, never an e-mail.
const DEVS = new WeakMap(); // result Map -> Map<path, Set<int>>

const days = (seconds) => Math.round((Math.max(0, seconds) / DAY) * 100) / 100;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const pathOf = (x) => (typeof x === 'string' ? x : x && typeof x.path === 'string' ? x.path : null);
const NO_HISTORY = { commits: 0, authors: 0, fixes: 0, fixRatio: 0, churn: 0, ageDays: 0, sinceDays: 0, recent: 0, lastCommit: null };

/**
 * Parse the output of `git log -z --numstat --no-renames FORMAT` (newest first, the first record being the ref).
 * Exported for the tests; callers use fileHistoryStats. At most `maxCommits` records are used; one more record in
 * the input sets window.truncated. `cut` is the set of commits whose parents are missing (a shallow clone): git
 * prints their whole tree as added, which is not a change anyone made, so their entries are skipped.
 * Returns the Map described at fileHistoryStats.
 */
export function parseLog(raw, maxCommits = Infinity, cut = null) {
  const acc = new Map(), devIds = new Map();
  let read = 0, merges = 0, truncated = false, refTime = 0, tip = null, oldest = Infinity, cur = null;
  for (let chunk of String(raw).split('\0')) {
    if (chunk.charCodeAt(0) === 10) chunk = chunk.slice(1); // the first numstat entry of a commit follows a line break
    if (chunk.charCodeAt(0) === 1) {
      if (read >= maxCommits) { truncated = true; break; }
      const f = chunk.split('\x1f'), t = Number(f[2]) || 0, mail = (f[3] || '').toLowerCase();
      if (!devIds.has(mail)) devIds.set(mail, devIds.size);
      cur = { sha: f[0].slice(1), t, dev: devIds.get(mail), fix: isFixSubject(f.slice(4).join('\x1f')) };
      if (!read) { refTime = t; tip = cur.sha; }
      read++;
      if (cut?.has(cur.sha)) cur.skip = true;
      if ((f[1] || '').includes(' ')) merges++; // two parents: git log prints no diff for it, so it touches no path
      if (t < oldest) oldest = t;
      continue;
    }
    if (!cur || cur.skip) continue;
    const t1 = chunk.indexOf('\t'), t2 = chunk.indexOf('\t', t1 + 1);
    if (t1 < 0 || t2 < 0) continue;
    // A binary file is reported as "-\t-": the commit counts, its lines cannot.
    const lines = (Number(chunk.slice(0, t1)) || 0) + (Number(chunk.slice(t1 + 1, t2)) || 0), file = chunk.slice(t2 + 1);
    let a = acc.get(file);
    if (!a) acc.set(file, a = { commits: 0, fixes: 0, churn: 0, recent: 0, first: cur.t, last: cur.t, lastSha: cur.sha, devs: new Set() });
    a.commits++; a.churn += lines; a.devs.add(cur.dev);
    if (cur.fix) a.fixes++;
    if (refTime - cur.t <= RECENT_DAYS * DAY) a.recent++;
    // Earliest and latest by committer time, not by position: git's default order follows dates, and clocks can be skewed.
    if (cur.t < a.first) a.first = cur.t;
    if (cur.t > a.last) { a.last = cur.t; a.lastSha = cur.sha; }
  }
  const out = new Map(), devs = new Map();
  for (const [file, a] of acc) {
    out.set(file, {
      commits: a.commits, authors: a.devs.size, fixes: a.fixes, fixRatio: a.fixes / a.commits, churn: a.churn,
      ageDays: days(refTime - a.first), sinceDays: days(refTime - a.last), recent: a.recent, lastCommit: a.lastSha,
    });
    devs.set(file, a.devs);
  }
  out.window = {
    commits: read, truncated: truncated || !!cut, from: read ? iso(oldest) : null, to: read ? iso(refTime) : null, spanDays: read ? days(refTime - oldest) : 0,
    tip, merges, shallow: !!cut, maxCommits: Number.isFinite(maxCommits) ? maxCommits : null,
  };
  DEVS.set(out, devs);
  return out;
}

// A shallow clone has its history cut by git itself and `git log` cannot tell: the cut commits look like roots.
// The file `shallow` in the common git directory lists them. Returns that set, or null when the clone is complete
// or the layout is not recognised.
function shallowCommits(repo) {
  try {
    for (let dir = path.resolve(repo); ; dir = path.dirname(dir)) {
      let gitDir = null;
      const dot = path.join(dir, '.git'), st = fs.statSync(dot, { throwIfNoEntry: false });
      if (st?.isDirectory()) gitDir = dot;
      else if (st?.isFile()) { // a worktree or a submodule: ".git" is a pointer
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
        if (m) gitDir = path.resolve(dir, m[1].trim());
      } else if (fs.existsSync(path.join(dir, 'HEAD')) && fs.existsSync(path.join(dir, 'objects'))) gitDir = dir; // bare
      if (gitDir) {
        const common = path.join(gitDir, 'commondir');
        if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
        const file = path.join(gitDir, 'shallow');
        return fs.existsSync(file) ? new Set(fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean)) : null;
      }
      if (path.dirname(dir) === dir) return null;
    }
  } catch { return null; }
}

/**
 * History of EVERY path changed in the last `maxCommits` commits reachable from `ref`, from a single `git log`.
 *
 * Returns Map<path, FileHistory>, newest path first, with a property `window`:
 *   FileHistory = {
 *     commits     commits of the window that change the path (how often it changes). This is the per-file count
 *                 of prior changes; it is NOT Kamei's NUC, which changeHistory computes.
 *     authors     distinct author e-mails among those commits, compared in lower case
 *     fixes       how many of those commits have a subject with one of FIX_WORDS (a keyword heuristic)
 *     fixRatio    fixes / commits
 *     churn       lines added + lines deleted over those commits (absolute churn). A change to a file git treats
 *                 as binary adds 0: binary by content, or marked so (-diff, binary) by the .gitattributes
 *                 committed at `ref`
 *     ageDays     days from the earliest of those commits to `ref`
 *     sinceDays   days from the latest of those commits to `ref`
 *     recent      how many of those commits fall in the 90 days up to `ref` (inclusive)
 *     lastCommit  sha of the latest of those commits
 *   }
 *   window = { commits (read, merges included), truncated (the history of `ref` is longer than what was read),
 *              from, to (ISO dates of the oldest commit read and of `ref`), spanDays (days between them),
 *              tip (sha of `ref`), merges (how many of the commits read are merges), shallow, maxCommits }
 *
 * Every date is a committer date and every interval is measured to the committer date of `ref`, never to the wall
 * clock, and the git options are pinned against the user's configuration and the checked-out branch, so the same
 * objects and ref give the same numbers. Two things outside the objects can still move them: attribute files that
 * are not committed (.git/info/attributes, core.attributesFile) and, with a git older than 2.40, the
 * .gitattributes of the working tree; both only change which files count as binary, that is `churn`.
 * `ref` must name ONE commit (a branch, tag, sha, "main~3"); ranges and exclusions ("a..b", "^a") are rejected.
 * Pass the merge base as `ref` and the pull request itself is not counted: only commits reachable from `ref` are
 * read. Days are rounded to 2 decimals and never negative.
 *
 * Establishes: exact counts over the commits that were read. In a shallow clone the commits where git cut the
 * history are read but their diff is unknown, so they change no path here.
 * Does not establish:
 *   - anything beyond the window. When window.truncated is true (more history than maxCommits, or a shallow
 *     clone) commits, authors, fixes and churn are lower bounds for the whole history and ageDays is a lower
 *     bound of the file's age. sinceDays stays exact for a path that appears; recent is exact only when the
 *     window reaches back more than 90 days (window.spanDays > 90), otherwise it too is a lower bound. Even then
 *     it assumes honest committer dates: git reads newest date first, so a commit dated before its own parent
 *     can keep that parent, and what lies behind it, out of a truncated window although their dates are recent.
 *   - history across a rename. Renames are not followed (--no-renames): a renamed file starts again at the
 *     rename, with its whole content counted as churn there.
 *   - what a merge commit changed by itself. git log prints no diff for merges, so a conflict resolution or
 *     an edit made inside a merge is invisible here. Merges still use up places in the window (window.merges).
 *   - who a person is. One person with two e-mails is two authors and a bot is an author.
 * Rejects when git fails (unknown ref, not a repository).
 * Cost: one git process, which spends its time counting lines (about 250 ms for 1500 commits on a C# repository
 * of 3300 commits); parsing takes a few milliseconds. A second process runs only when git refuses the first.
 */
export async function fileHistoryStats(repo, ref, { maxCommits = 1500 } = {}) {
  const name = String(ref ?? '');
  // One commit, never an option and never a set of commits: with "a..b", "^a" or "a^!" git would log something
  // else than the history of a ref, and a window that looks complete would mark old files as new.
  if (!name || /^[-^]|\.\.|\^[@!]$|\^-\d*$/.test(name)) throw new Error(`history: not a ref: ${JSON.stringify(ref)}`);
  const max = maxCommits === Infinity ? Infinity : Number.isFinite(maxCommits) && maxCommits >= 1 ? Math.floor(maxCommits) : 1500;
  // Pinned so the numbers do not depend on the user's git configuration or on what is checked out: no rename
  // detection, no external or textconv drivers (they run programs), one diff algorithm, no signature output mixed
  // into the records, the root commit's files always listed (log.showRoot), git's own order of the files
  // (diff.orderFile; /dev/null is git's documented way to cancel it).
  const args = ['-z', '--numstat', '--no-renames', '--root', '-O/dev/null', '--no-color', '--no-ext-diff', '--no-textconv', '--diff-algorithm=myers', '--no-show-signature', '--encoding=UTF-8', FORMAT];
  if (max !== Infinity) args.push('-n', String(max + 1)); // one more than asked: its presence is what "truncated" means
  args.push(name, '--');
  // Two more pins that old versions of git do not know. --attr-source (git 2.40): which files count as binary is
  // decided by .gitattributes, and git reads it from the WORKING TREE, so the churn of a file marked "-diff" would
  // change with the branch that happens to be checked out; this reads the attributes committed at ref instead.
  // --no-relative (git 2.28): with diff.relative set and `repo` a subdirectory, git drops every path outside it.
  // When git refuses the options the log runs without them (an unknown ref fails both times and rejects below).
  let raw;
  try { raw = await gitRaw(repo, [`--attr-source=${name}`, 'log', '--no-relative', ...args]); } catch { raw = await gitRaw(repo, ['log', ...args]); }
  return parseLog(raw.toString('utf8'), max, shallowCommits(repo));
}

/**
 * The entries of `all` (a result of fileHistoryStats) for `paths`, in the order given. A path is a string or an
 * object with `path` and optionally `oldPath`, as server/git.js diff() returns: a path with no history of its own
 * takes the history of its `oldPath` and is marked `renamedFrom`.
 *
 * A path with no commit in the window gets zeros and `new`. The zeros are placeholders, not measurements (check
 * `commits === 0` before reading ageDays or sinceDays). `new` only says what is known:
 *   true   the window holds the whole history, so no commit other than a merge ever touched the path; or `tree`
 *          (the paths that exist at ref, e.g. loadSources(repo, ref).tree) was given and does not contain it, so
 *          the file does not exist at ref (it may still have existed and been deleted before the window)
 *   false  `tree` was given and contains it: an existing file that the window never saw change
 *   null   unknown: the window is truncated and no `tree` was given
 * `tree` is trusted to be complete. loadSources and listFiles of server/math/repo.js leave out symbolic links and
 * submodules, so with their tree a link or submodule that exists at ref and did not change in the window is
 * reported `new: true`; pass the output of `git ls-tree -r --name-only` when those matter.
 */
export function selectHistory(all, paths, { tree = null } = {}) {
  const exists = tree ? new Set([...tree].map(pathOf)) : null;
  const w = all.window, devs = DEVS.get(all), out = new Map(), sub = new Map();
  for (const item of paths || []) {
    const p = pathOf(item), old = item && typeof item === 'object' && typeof item.oldPath === 'string' && item.oldPath !== p ? item.oldPath : null;
    if (p === null || out.has(p)) continue;
    const src = all.has(p) ? p : old !== null && all.has(old) ? old : null;
    if (src === null) {
      const known = exists && (exists.has(p) || (old !== null && exists.has(old)));
      out.set(p, { ...NO_HISTORY, new: exists ? !known : w && !w.truncated ? true : null });
      continue;
    }
    out.set(p, src === p ? { ...all.get(p) } : { ...all.get(old), renamedFrom: old });
    if (devs?.has(src)) sub.set(p, devs.get(src));
  }
  out.window = w;
  if (devs) DEVS.set(out, sub);
  return out;
}

/**
 * History of the files a pull request touches: Map<path, FileHistory> with the same `window` property.
 * One `git log` from `ref`; see fileHistoryStats for the fields and their limits and selectHistory for `paths`,
 * `tree` and the `new` mark. A caller that also needs the baseline should call fileHistoryStats once and
 * selectHistory on its result, which costs one git process instead of two.
 */
export async function historyFeatures(repo, ref, paths, { maxCommits = 1500, tree = null } = {}) {
  return selectHistory(await fileHistoryStats(repo, ref, { maxCommits }), paths, { tree });
}

/**
 * The three history measures of Kamei et al. (2013) for a change that touches `paths`, from a result of
 * fileHistoryStats or historyFeatures:
 *   ndev  developers that changed the touched files before: the size of the UNION over the files (their example:
 *         A changed by x, B and C by x and y gives 2). null when `hist` was not built by this module.
 *   age   mean over the files of the days since each was last changed (their example: 3, 5 and 4 days give 4).
 *         null when no file has history.
 *   nuc   distinct last changes of the files (their example: A last changed in one commit, B and C in another, gives 2)
 *   files, withHistory   how many distinct paths were given and how many of them have a commit in the window
 * Limits: files without a commit in the window are left out of all three, so with a truncated window `ndev` is a
 * lower bound and `age` leaves out exactly the files that have been quiet the longest. Time is measured to the
 * commit date of ref, not to the date of the pull request. A file the pull request renames is found only in a
 * result of selectHistory or historyFeatures that was given its { path, oldPath }; looked up by its new name in
 * a result of fileHistoryStats it has no history and is left out.
 */
export function changeHistory(hist, paths) {
  const devs = DEVS.get(hist), union = new Set(), last = new Set(), seen = new Set();
  let withHistory = 0, since = 0;
  for (const item of paths || []) {
    const p = pathOf(item);
    if (p === null || seen.has(p)) continue;
    seen.add(p);
    const f = hist.get(p);
    if (!f || !f.commits) continue;
    withHistory++; since += f.sinceDays; last.add(f.lastCommit);
    for (const d of devs?.get(p) || []) union.add(d);
  }
  return { files: seen.size, withHistory, ndev: devs ? union.size : null, age: withHistory ? Math.round((since / withHistory) * 100) / 100 : null, nuc: last.size };
}

const count = (x) => (Number.isFinite(+x) && +x > 0 ? Math.floor(+x) : 0);
const round6 = (x) => Math.round(x * 1e6) / 1e6 || 0; // "|| 0" turns -0 into 0

/**
 * How scattered a change is. `files` is [{ path, add, del }] (server/git.js diff() output fits).
 *
 *   bits        H = -sum p_i log2 p_i, where p_i is the share of the changed lines (added + deleted) that fall in
 *               file i. Files with no changed lines (binary, pure rename, mode change) are left out of the sum.
 *               0 when everything is in one file, log2(n) when n files share the lines equally.
 *   normalized  H / log2(n), n = `counted`, in [0, 1]; 0 when n < 2. Kamei et al. normalise by the maximum entropy
 *               "to account for differences in the number of files across changes".
 *   counted     n: files with at least one changed line
 *   files       distinct paths given (Kamei NF)
 *   dirs        distinct directories (ND)
 *   subsystems  distinct top-level directories (NS: "the root directory name"); files at the root count as one
 *   linesAdded, linesDeleted   (LA, LD)
 * bits and normalized are rounded to 6 decimals. Worked example of Kamei et al.: 30, 20 and 10 lines give 1.46.
 *
 * Establishes: the value of a formula on the diff. Does not establish that the change is risky: a rename across
 * twenty files scores high and a one-line bug scores 0.
 */
export function changeEntropy(files) {
  const lines = new Map();
  let linesAdded = 0, linesDeleted = 0;
  for (const f of files || []) {
    const p = f && typeof f.path === 'string' ? f.path : null;
    if (p === null) continue;
    const add = count(f.add), del = count(f.del);
    linesAdded += add; linesDeleted += del;
    lines.set(p, (lines.get(p) || 0) + add + del); // the same path twice is one file
  }
  const dirs = new Set(), subsystems = new Set(), total = linesAdded + linesDeleted;
  let n = 0, h = 0;
  for (const [p, k] of lines) {
    const slash = p.indexOf('/');
    dirs.add(p.slice(0, Math.max(0, p.lastIndexOf('/'))));
    subsystems.add(slash < 0 ? '' : p.slice(0, slash));
    if (!k) continue;
    n++; h -= (k / total) * Math.log2(k / total);
  }
  return {
    bits: round6(h), normalized: n > 1 ? Math.min(1, round6(h / Math.log2(n))) : 0,
    files: lines.size, counted: n, dirs: dirs.size, subsystems: subsystems.size, linesAdded, linesDeleted,
  };
}

// Sample quantile for p = num/den, Hyndman and Fan (1996) definition 2: the inverse of the empirical distribution
// function, averaging the two neighbours where it jumps. It gives the usual median and keeps this guarantee:
// a value above the result is strictly above at least a share p of the sample. The index is computed in
// integers because 0.9 * 70 is not 63 in floating point.
function quantile(sorted, num, den) {
  const n = sorted.length, k = n * num;
  if (!n) return null;
  if (k % den) return sorted[Math.ceil(k / den) - 1];
  const i = k / den;
  return i >= n ? sorted[n - 1] : (sorted[i - 1] + sorted[i]) / 2;
}

const population = (hist, filter) => {
  const rows = [];
  for (const [p, f] of hist) if (f.commits > 0 && (!filter || filter(p, f))) rows.push(f);
  return rows;
};

/**
 * Distribution of commits, authors and fixRatio across the paths of `hist` (a result of fileHistoryStats) that
 * have history: { files, commits: { median, p90 }, authors: { median, p90 }, fixRatio: { median, p90 } }.
 * `filter(path, fileHistory)` narrows the population, e.g. to the paths that still exist at ref
 * (`filter: (p) => alive.has(p)` with the tree of loadSources) or to files with at least three commits.
 * With nothing in the population every median and p90 is null.
 *
 * What a caller may say: a file whose value is ABOVE p90 has a higher value than at least 90% of the population
 * (and above the median, than at least half). The population is the paths changed at least once in the window,
 * deleted files included unless filtered out; files that exist but did not change in the window are not in it,
 * so "of the files that changed in the last N commits" is the honest wording, not "of all files".
 * fixRatio is a ratio of small counts: one fix in a file's only commit is 1, so its p90 is often 1.
 */
export function repoBaseline(hist, { filter = null } = {}) {
  const rows = population(hist, filter);
  const dist = (key) => {
    const v = rows.map((f) => f[key]).sort((a, b) => a - b);
    return { median: quantile(v, 1, 2), p90: quantile(v, 9, 10) };
  };
  return { files: rows.length, commits: dist('commits'), authors: dist('authors'), fixRatio: dist('fixRatio') };
}

/**
 * The share (0..1) of the same population whose `key` (commits, authors, fixRatio, churn, ...) is strictly below
 * `value`: the exact number behind "changes more often than 87% of the files that changed in this window".
 * null when the population is empty.
 */
export function shareBelow(hist, key, value, { filter = null } = {}) {
  const rows = population(hist, filter);
  let below = 0;
  for (const f of rows) if (f[key] < value) below++;
  return rows.length ? below / rows.length : null;
}
