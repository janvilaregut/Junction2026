// Principles: the engineering practices one changed function can be held to without a model, each with an
// exact definition, a source and a three-state answer. This is what "Prove it" on a node shows.
//
//   pass       the check ran and the function meets it (for a measurement: under the limit, or the change did
//              not make it worse). It "passes this check"; it is not proved correct.
//   warn       it does not meet it, and that is worth a person's attention
//   fail       a blocking fact: a dangerous API, a secret, a broken contract
//   inherited  over a limit, but it already was before this change: context, not something the PR did
//   na         the principle does not apply here (with the reason)
//
// Only `equivalence` is a proof (proof.js). Facts are true or false on the tokens or the dependency graph.
// Measurements compare a number with a published limit. A function's gate is the minimum over its principles
// in Kleene's three-valued order (FAIL < UNCERTAIN < PASS, not-applicable counts as PASS; Kleene 1938, as in
// quality gates): one confirmed failure stands even when other evidence is missing.
//
// Which principles are here, and which are not, comes from the Quality Lab experiments (branch quality-lab):
//   kept     size (strongest bug predictor, r = 0.33, 12/12 repositories), complexity and nesting shown as a
//            limit for maintainability, parameters and flag arguments, error-handling anti-patterns,
//            duplication (clone pairs co-change with odds ratio 5.2, so a copy is a second place to fix), static
//            test reachability, dangerous APIs and secrets, sync-over-async hazards
//   left out PageRank and in-degree as risk (no association, r = 0.004), magic numbers and naming as gates (no
//            association with fixes), the maintainability index.
// Detection is deterministic; finding no dangerous call is not evidence that the code is safe.
import { matchBrackets } from './lex.js';

export const PRINCIPLES = [
  { id: 'equivalence', group: 'proof', name: 'Same behaviour', how: 'Token streams compared with comments and layout dropped; locals checked for a one-to-one renaming.', basis: 'Equal token streams, or a consistent renaming of local variables, compile to the same program (proof.js; Barendregt 1984).' },
  { id: 'contract', group: 'fact', name: 'Contract intact', how: "Every import resolved and every call's argument count matched against the dependency graph.", basis: 'Imports resolve, call arities match, nothing removed is still called, no test was deleted or disabled (checks.js).' },
  { id: 'api', group: 'fact', name: 'Public API stable', how: "The declaration's tokens compared before and after the change.", basis: 'Token comparison of the declaration before and after. Callers outside the repository cannot be seen.' },
  { id: 'guards', group: 'fact', name: 'Guards kept', how: 'Lines that throw or assert counted on the removed and the added lines of the diff.', basis: 'Lines that throw or assert, counted on the removed and added lines of the diff (fail fast).' },
  { id: 'errors', group: 'fact', name: 'Errors not swallowed', how: 'Tokens scanned for empty catch blocks, catch-alls without rethrow and `throw ex;`.', basis: 'Empty catch blocks, catch-all without rethrow and `throw ex;` (CA1031, CA2200; de Pádua & Shang 2017).' },
  { id: 'secure', group: 'fact', name: 'No dangerous APIs or secrets', how: 'Calls matched against a CWE list; string literals tested for secrets by pattern and Shannon entropy.', basis: 'Known insecure calls mapped to CWE (CA2300, CA5350, CA5359, CA2100…) and hard-coded secrets by pattern and Shannon entropy.' },
  { id: 'async', group: 'fact', name: 'No blocking on async', how: 'Tokens scanned for .Result, .Wait(), async void and lock on a public object.', basis: 'Sync-over-async (.Result, .Wait(), GetResult()), async void outside event handlers, lock on a public object, async callbacks in forEach (VSTHRD002, CA2002).' },
  { id: 'stakes', group: 'fact', name: 'Low stakes', how: 'Name, file and body matched against money, access and crypto vocabulary (sensitivity.js), then a decision model where available.', basis: 'Functions where a silent bug is expensive (money, access control, cryptography, data loss) are never cleared by measurements alone: a person or the agents look at them.' },
  { id: 'tested', group: 'fact', name: 'Reached by a test', info: true, how: 'Callers followed backwards through the dependency graph until a test is found.', basis: 'Some test reaches the function through the static dependency graph (after Chianti, Ren et al. 2004). Reaching is not asserting.' },
  { id: 'asserts', group: 'fact', name: 'Test can fail', how: 'Calls that can fail the test (assert, expect, verify…) counted in its body.', basis: 'A test with no assert, expect or verify call cannot fail, so it proves nothing.' },
  { id: 'used', group: 'fact', name: 'Used (no dead code)', how: 'References to its name counted across the whole repository.', basis: 'A new private function that nothing in the repository refers to by name (YAGNI). Reflection and frameworks are not seen.' },
  { id: 'simple', group: 'measure', name: 'Simple (KISS)', how: 'Independent paths (McCabe), cognitive score (Sonar) and deepest nesting counted on the tokens. Limits 10 · 15 · 4.', basis: 'Cyclomatic ≤ 10 (McCabe 1976), cognitive ≤ 15 (SonarSource S3776), nesting ≤ 4 (ESLint max-depth). Shown next to the size: once size is known, complexity predicts no extra bugs (Quality Lab E4), so it is a limit for readers, read as complex for its size.' },
  { id: 'small', group: 'measure', name: 'Small function', how: 'Lines that carry code counted. Limit 47, the band calibrated on 25 C# libraries.', basis: 'At most 47 lines: the high band calibrated on 25 C# libraries (Alves et al. 2010 method, Quality Lab E0: 32 / 47 / 75); above 75 is very high. Size is the strongest predictor of bug fixes measured (r = 0.33, 12 of 12 repositories).' },
  { id: 'interface', group: 'measure', name: 'Small interface', how: 'Parameters counted (limit 4); boolean parameters checked for switching behaviour.', basis: 'At most 4 parameters (SIG bands 3/4/5 calibrated in Quality Lab E0) and no boolean flag argument that switches behaviour (Fowler; Quality Lab E10).' },
  { id: 'dry', group: 'measure', name: 'Written once (DRY)', how: 'Winnowing fingerprints of its tokens compared with every function in the repository.', basis: 'Copies found by winnowing fingerprints (Schleimer et al. 2003). Editing one copy and not its siblings is the robust risk: classes of 3+ copies get partial updates 86% of the time against 45% for pairs, and copies co-change with odds ratio 5.2 (Quality Lab E7).' },
];
const BY_ID = new Map(PRINCIPLES.map((p) => [p.id, p]));
const RANK = { fail: 0, warn: 1, pass: 2, inherited: 2, na: 2 }; // Kleene order; inherited and n/a do not block

// ── Token scans ───────────────────────────────────────────────────────────────────────────────────────
const flat = (toks) => toks.map((t) => t.v).join(' '); // comments are not tokens: a pattern in a comment is not code

/** Error-handling anti-patterns on one function's tokens: { empty, catchAll, throwEx } counts. */
export function errorPatterns(toks, lang) {
  const out = { empty: 0, catchAll: 0, throwEx: 0 };
  if (!toks.length) return out;
  const m = matchBrackets(toks), close = (i) => (m[i] > i ? m[i] : -1);
  for (let i = 0; i < toks.length; i++) {
    const v = toks[i].v;
    if (lang === 'py' && v === 'except' && toks[i].k === 'kw') {
      let j = i + 1; const bare = toks[j]?.v === ':';
      while (j < toks.length && toks[j].v !== '{') j++;
      if (j >= toks.length) continue;
      const end = close(j), body = end > j ? toks.slice(j + 1, end).filter((t) => t.v !== ';') : [];
      if (body.length === 0 || (body.length === 1 && body[0].v === 'pass')) out.empty++;
      else if (bare && !body.some((t) => t.v === 'raise')) out.catchAll++;
      continue;
    }
    if (v !== 'catch' || toks[i].k !== 'kw') continue;
    let j = i + 1, type = '', varName = null;
    if (toks[j]?.v === '(') {
      const e = close(j) > 0 ? close(j) : j; const inside = toks.slice(j + 1, e);
      if (lang === 'cs' || lang === 'java') { type = inside.length ? inside[0].v : ''; if (inside.length >= 2 && inside[inside.length - 1].k === 'id') varName = inside[inside.length - 1].v; }
      else if (inside.length === 1) varName = inside[0].v;
      j = e + 1;
    }
    if (toks[j]?.v === 'when' && toks[j + 1]?.v === '(') j = (close(j + 1) > 0 ? close(j + 1) : j + 1) + 1; // a filtered catch is deliberate
    if (toks[j]?.v !== '{') continue;
    const end = close(j) > 0 ? close(j) : j, body = toks.slice(j + 1, end);
    if (end === j) continue;
    if (!body.length) { out.empty++; continue; }
    const rethrows = body.some((t, k) => t.v === 'throw' && (body[k + 1]?.v === ';' || body[k + 1]?.v === 'new'));
    if (lang === 'cs' && varName) for (let k = 0; k < body.length - 2; k++) if (body[k].v === 'throw' && body[k + 1].v === varName && body[k + 2].v === ';') out.throwEx++;
    const general = lang === 'cs' ? (!type || /^(System\.)?Exception$/.test(type)) : lang === 'java' ? /^(Exception|Throwable)$/.test(type) : false;
    if (general && !rethrows && !body.some((t) => t.v === 'throw')) out.catchAll++;
  }
  return out;
}

// (id, language set or null for all, pattern over the flattened tokens, CWE, message)
const DANGEROUS = [
  ['deserializer', ['cs'], /\b(BinaryFormatter|SoapFormatter|NetDataContractSerializer|LosFormatter|ObjectStateFormatter)\b/, 'CWE-502', 'insecure deserializer'],
  ['typename', ['cs'], /TypeNameHandling \. (All|Auto|Objects|Arrays)\b/, 'CWE-502', 'TypeNameHandling enables type confusion'],
  ['weak-hash', ['cs', 'java'], /\b(MD5|SHA1)(CryptoServiceProvider|Managed|Cng)? (\. Create \(|\()/, 'CWE-328', 'weak hash (MD5/SHA-1)'],
  ['weak-cipher', ['cs', 'java'], /\b(DES|TripleDES|RC2)(CryptoServiceProvider)? (\. Create \(|\()|CipherMode \. ECB/, 'CWE-327', 'broken cipher or ECB mode'],
  ['tls-off', ['cs'], /(ServerCertificateValidationCallback|RemoteCertificateValidationCallback|ServerCertificateCustomValidationCallback)[^;]*=> true/, 'CWE-295', 'certificate validation disabled'],
  ['xxe', ['cs'], /DtdProcessing \. Parse|XmlResolver = new XmlUrlResolver/, 'CWE-611', 'XML external entities enabled'],
  ['sql-concat', ['cs'], /\b(SqlCommand|ExecuteSqlRaw|FromSqlRaw|ExecuteSqlCommand|CommandText)\b[^;]*(\+ [A-Za-z_]|\$")/, 'CWE-89', 'SQL built by concatenation'],
  ['process', ['cs'], /Process \. Start \( (?!")/, 'CWE-78', 'process started with non-literal input'],
  ['eval', ['js', 'ts'], /(^| )eval \(|new Function \(/, 'CWE-95', 'eval of a string'],
  ['exec', ['js', 'ts'], /\b(exec|execSync) \( (`[^`]*\$\{|[^)'"`]*\+)/, 'CWE-78', 'shell command built from input'],
  ['html', ['js', 'ts'], /\. (innerHTML|outerHTML) =(?!=) (?!['"`][^'"`$]*['"`]( ;|$))/, 'CWE-79', 'HTML written from a value'],
  ['js-hash', ['js', 'ts'], /createHash \( ['"](md5|sha1)['"]/, 'CWE-328', 'weak hash (MD5/SHA-1)'],
  ['js-tls', ['js', 'ts'], /rejectUnauthorized : false/, 'CWE-295', 'certificate validation disabled'],
  ['js-sql', ['js', 'ts'], /\b(query|execute|raw) \( (`[^`]*\$\{|['"][^'"]*['"] \+)/, 'CWE-89', 'SQL built by concatenation'],
  ['pickle', ['py'], /\b(pickle|cPickle|marshal) \. loads? \(|yaml \. load \((?![^)]*Loader)/, 'CWE-502', 'unsafe deserialization'],
  ['py-shell', ['py'], /shell = True|os \. system \(/, 'CWE-78', 'shell command'],
  ['py-hash', ['py'], /hashlib \. (md5|sha1) \(/, 'CWE-328', 'weak hash (MD5/SHA-1)'],
  ['py-tls', ['py'], /verify = False/, 'CWE-295', 'certificate validation disabled'],
  ['py-eval', ['py'], /(^| )(eval|exec) \(/, 'CWE-95', 'eval of a string'],
];
const SECRET = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'], [/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'], [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bsk_live_[A-Za-z0-9]{20,}/, 'Stripe live key'], [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'JSON web token'],
  [/AccountKey=[A-Za-z0-9+/=]{40,}/, 'Azure storage key'], [/(?:password|pwd)\s*=\s*[^;'"\s]{6,}/i, 'password in a connection string'],
];
const SECRET_CONTEXT = /(password|passwd|pwd|secret|token|api_?key|apikey|access_?key|private_?key|credential)/i;
const shannon = (s) => { const c = new Map(); for (const ch of s) c.set(ch, (c.get(ch) || 0) + 1); let h = 0; for (const n of c.values()) h -= (n / s.length) * Math.log2(n / s.length); return h; };

/** Dangerous calls and secrets in one function: a list of { id, cwe, what } (one per distinct hit). */
export function securityHits(toks, lang) {
  const hits = [], src = flat(toks);
  for (const [id, langs, re, cwe, what] of DANGEROUS) if ((!langs || langs.includes(lang)) && re.test(src)) hits.push({ id, cwe, what });
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; if (t.k !== 'str') continue;
    const s = t.v.replace(/^[@$]*["'`]+|["'`]+$/g, '');
    const known = SECRET.find(([re]) => re.test(s));
    if (known) { hits.push({ id: 'secret', cwe: 'CWE-798', what: `hard-coded ${known[1]}`, key: s.slice(0, 6) }); continue; }
    const ctx = toks.slice(Math.max(0, i - 6), i).some((x) => x.k === 'id' && SECRET_CONTEXT.test(x.v));
    for (const m of s.matchAll(/[A-Za-z0-9+/=_-]{20,}/g)) {
      const tok = m[0], h = shannon(tok);
      if (/^[A-Za-z_]+$/.test(tok) || /^[a-z0-9_-]+$/.test(tok) && !/\d/.test(tok)) continue; // words and identifiers
      if (h > 4.5 || (ctx && h > 3.5 && tok.length >= 16)) { hits.push({ id: 'secret', cwe: 'CWE-798', what: `high-entropy string${ctx ? ' next to a credential name' : ''} (${h.toFixed(1)} bits/char)`, key: tok.slice(0, 6) }); break; }
    }
  }
  return hits;
}

/** Async and locking hazards: a list of { id, what }. */
export function asyncHits(toks, lang, sym) {
  const hits = [], src = flat(toks);
  if (lang === 'cs') {
    if (/\. Result\b(?! [(=])/.test(src)) hits.push({ id: 'result', what: 'blocks on a Task with .Result' });
    if (/\. Wait \( \)/.test(src)) hits.push({ id: 'wait', what: 'blocks on a Task with .Wait()' });
    if (/GetAwaiter \( \) \. GetResult \( \)/.test(src)) hits.push({ id: 'getresult', what: 'blocks with GetAwaiter().GetResult()' });
    if (/\block \( (this \)|typeof \(|")/.test(src)) hits.push({ id: 'lock', what: 'locks on a public object' });
    const head = sym ? flat(toks.slice(0, Math.max(0, sym.bodyA - sym.a))) : '';
    if (/\basync void\b/.test(head) && !/EventArgs\b/.test(head)) hits.push({ id: 'async-void', what: 'async void outside an event handler: its exceptions crash the process' });
  } else if (lang === 'js' || lang === 'ts') {
    if (/\. forEach \( async\b/.test(src)) hits.push({ id: 'foreach-async', what: 'async callback in forEach: nothing awaits it' });
  } else if (lang === 'py') {
    if (/time \. sleep \(/.test(src) && sym && toks.slice(0, Math.max(0, sym.bodyA - sym.a)).some((t) => t.v === 'async')) hits.push({ id: 'sleep', what: 'time.sleep inside a coroutine blocks the loop' });
  }
  return hits;
}

/** Statements of at least 10 tokens that appear 3 or more times in one function (micro-clones, Quality Lab DRY). */
export function repeatedStatements(toks) {
  const seen = new Map(); let cur = [];
  const flush = () => { if (cur.length >= 10) { const k = cur.join(' '); seen.set(k, (seen.get(k) || 0) + 1); } cur = []; };
  for (const t of toks) { if (t.v === ';' || t.v === '{' || t.v === '}') { cur.push(t.v); flush(); } else cur.push(t.v); }
  flush();
  return [...seen].filter(([, n]) => n >= 3).map(([text, n]) => ({ text, n }));
}

/** Boolean parameters that are tested in a condition: they switch what the function does. */
export function flagArguments(toks, sym, lang) {
  if (!sym || !['cs', 'java', 'ts', 'kt', 'swift', 'go', 'c'].includes(lang)) return null;
  const head = toks.slice(0, Math.max(0, sym.bodyA - sym.a)), names = new Set();
  for (let i = 0; i < head.length - 1; i++) {
    const v = head[i].v;
    if ((v === 'bool' || v === 'boolean' || v === 'Boolean') && head[i + 1].k === 'id') names.add(head[i + 1].v); // C#, Java, C: type before name
    if ((v === 'boolean' || v === 'Bool' || v === 'bool') && head[i - 1]?.v === ':' && head[i - 2]?.k === 'id') names.add(head[i - 2].v); // TS, Kotlin, Swift: name: type
  }
  if (!names.size) return [];
  const body = toks.slice(Math.max(0, sym.bodyA - sym.a)), used = new Set(), mb = matchBrackets(body);
  for (let i = 0; i < body.length; i++) {
    if ((body[i].v === 'if' || body[i].v === 'while') && body[i + 1]?.v === '(') { const e = mb[i + 1] > i + 1 ? mb[i + 1] : i + 1; for (let k = i + 2; k < e; k++) if (names.has(body[k].v)) used.add(body[k].v); }
    if (body[i].v === '?' && names.has(body[i - 1]?.v)) used.add(body[i - 1].v);
  }
  return [...used];
}

// ── The principles of one unit ───────────────────────────────────────────────────────────────────────
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MEASURE_LIMITS = { cyclomatic: [10, 20], cognitive: [15, 25], nesting: [4, 6], loc: [47, 75], params: [4, 5] };
const tokensOf = (F, s) => (F && s ? F.tokens.slice(s.a, s.b).filter((t) => t.k !== 'nl') : []);

/**
 * principles(u) → [{ id, group, name, state, value, detail, basis }]
 * u is a unit of index.js after its measurements (proof, metrics, clones, centrality, tests, findings).
 */
export function principles(u) {
  if (u.declarations || u.kind === 'type' || u.status === 'removed') return null;
  const out = [], H = u._H, B = u._B, hs = u._h, bs = u._b, lang = u.lang;
  const proved = !!u.proof?.proved, isNew = !bs;
  const put = (id, state, value, detail = '') => { const P = BY_ID.get(id); out.push({ id, group: P.group, name: P.name, state, value, detail, how: P.how, basis: P.basis, ...(P.info ? { info: true } : {}) }); };
  const ht = tokensOf(H, hs), bt = tokensOf(B, bs);
  const findings = u.findings || [];

  // Proof
  if (proved) put('equivalence', 'pass', u.proof.level === 'alpha' ? 'only locals renamed' : 'same tokens', u.proof.claim || '');
  else put('equivalence', 'na', isNew ? 'new function' : 'behaviour changed', isNew ? 'There is no earlier version to be equivalent to.' : 'The edit changes what the function does, so no equivalence proof applies. The other principles still do.');

  // Facts from the deterministic checks
  const bad = findings.filter((f) => f.severity === 'bad' && !['guard-removed', 'signature-changed', 'dynamic-lookup', 'proof-withdrawn'].includes(f.id));
  // A warning from the checks that no principle below names still stands against the change.
  const loose = findings.filter((f) => f.severity === 'warn' && !['guard-removed', 'signature-changed'].includes(f.id) && !(f.id === 'proof-withdrawn' && !proved));
  put('contract', bad.length ? 'fail' : loose.length ? 'warn' : 'pass', bad.length ? bad[0].title : loose.length ? loose[0].title : 'imports, calls and tests check out', bad.length ? bad.map((f) => f.detail || f.title).slice(0, 2).join(' ') : loose.length ? loose.map((f) => f.detail || f.title).slice(0, 2).join(' ') : 'Every import resolves, every call has a matching arity, nothing removed is still used.');
  if (u.exported && !u.isTest) {
    const sig = findings.find((f) => f.id === 'signature-changed');
    put('api', sig ? 'warn' : 'pass', sig ? 'signature changed' : isNew ? 'new public member' : 'signature unchanged', sig ? sig.detail : isNew ? 'Adds to the public surface; nothing existing changed.' : 'The declaration has the same tokens before and after.');
  } else put('api', 'na', u.isTest ? 'test' : 'not public', 'Only callers inside the repository, and the graph sees them.');
  if (!u.isTest) {
    const g = findings.find((f) => f.id === 'guard-removed');
    put('guards', g ? 'warn' : 'pass', g ? g.title.toLowerCase() : isNew ? 'nothing removed' : 'none removed', g ? g.detail : 'No line that throws or asserts was removed without a replacement.');
  }

  // Facts on the tokens: only what this change introduced counts against it
  const eh = errorPatterns(ht, lang), eb = errorPatterns(bt, lang);
  const newEmpty = Math.max(0, eh.empty - eb.empty), newAll = Math.max(0, eh.catchAll - eb.catchAll), newThrow = Math.max(0, eh.throwEx - eb.throwEx);
  if (newEmpty || newThrow) put('errors', 'warn', [newEmpty && plural(newEmpty, 'empty catch'), newThrow && '`throw ex;` resets the stack'].filter(Boolean).join(' · '), newEmpty ? 'A catch block with nothing in it hides the failure: the caller never learns something went wrong.' : '`throw ex;` replaces the original stack trace; `throw;` keeps it.');
  else if (newAll) put('errors', 'warn', 'catch-all without rethrow', 'It catches every exception, including the ones it cannot handle, and does not rethrow.');
  else put('errors', eh.empty + eh.catchAll + eh.throwEx ? 'inherited' : 'pass', eh.empty + eh.catchAll + eh.throwEx ? 'pattern already there' : 'no swallowed errors', eh.empty + eh.catchAll + eh.throwEx ? 'The anti-pattern was in the function before this change.' : 'No empty catch, no catch-all without rethrow, no `throw ex;`.');

  const sh = securityHits(ht, lang), sb = securityHits(bt, lang);
  const before = new Set(sb.map((x) => x.id + (x.key || ''))), added = sh.filter((x) => !before.has(x.id + (x.key || '')));
  if (added.length) put('secure', 'fail', `${added[0].what} (${added[0].cwe})`, `Introduced by this change: ${added.map((x) => `${x.what} (${x.cwe})`).join('; ')}.`);
  else put('secure', sh.length ? 'inherited' : 'pass', sh.length ? `${sh[0].what}, already there` : 'none found', sh.length ? 'The pattern was there before this change.' : 'No known insecure call and no hard-coded secret. Finding none is not evidence that the code is safe.');

  const ah = asyncHits(ht, lang, hs), ab = new Set(asyncHits(bt, lang, bs).map((x) => x.id)), newAsync = ah.filter((x) => !ab.has(x.id));
  if (!['cs', 'js', 'ts', 'py'].includes(lang)) put('async', 'na', 'not checked for this language', '');
  else if (newAsync.length) put('async', 'warn', newAsync[0].what, newAsync.map((x) => x.what).join('; ') + '.');
  else put('async', ah.length ? 'inherited' : 'pass', ah.length ? 'hazard already there' : 'no blocking on async', ah.length ? `${ah[0].what}: already in the function before.` : 'No sync-over-async, no async void, no lock on a public object.');

  // Stakes: where a silent bug is expensive, measurements never clear a change on their own. A proof still holds.
  if (!u.isTest) {
    const crit = u.sensitive?.level === 'critical';
    if (proved) put('stakes', 'na', 'behaviour unchanged', 'The proof holds whatever the domain.');
    else put('stakes', crit ? 'warn' : 'pass', crit ? `${u.sensitive.label || 'sensitive'}: a person or the agents look` : u.sensitive?.level === 'elevated' ? `${u.sensitive.label || 'elevated'}, not critical` : 'no money, access or crypto', crit ? `${u.sensitive.why || u.sensitive.label || 'A sensitive domain'}. A silent bug here is expensive, so passing every measurement is not enough to clear it.` : 'Nothing in its name, file or body points to money, access control, cryptography or data loss.');
  }

  // Facts on the dependency graph
  if (u.isTest) put('asserts', u.assertions || u.helper ? 'pass' : 'warn', u.helper ? 'test support code' : plural(u.assertions || 0, 'check'), u.assertions ? 'Calls that can fail the test: assert, expect, verify…' : u.helper ? 'Runs only under test.' : 'A test with no call that can fail it proves nothing.');
  else if (proved) put('tested', 'na', 'behaviour unchanged', 'Nothing new to test: the proof says the function behaves as before.');
  else if (u.tests || u.centrality) {
    const t = u.tests || {};
    put('tested', t.changed || t.reachedBy ? 'pass' : 'warn', t.changed ? `${plural(t.changed, 'new test')} ${t.changed === 1 ? 'reaches' : 'reach'} it` : t.reachedBy ? `${plural(t.reachedBy, 'test')} ${t.reachedBy === 1 ? 'reaches' : 'reach'} it` : 'no test reaches it', t.changed || t.reachedBy ? 'A test can reach this function through the dependency graph. Reaching is not asserting.' : 'No test reaches it through the static dependency graph. A test that drives it through a framework or reflection is not seen.');
  } else put('tested', 'na', 'graph unavailable', '');
  const c = u.centrality;
  if (!u.isTest && isNew && !proved && !u.exported && c && ['function', 'method'].includes(u.kind) && !/^(main|Main|On[A-Z]\w*|handle[A-Z]\w*|constructor|ngOnInit|render)$/.test(u.name) && !(hs?.modifiers || []).some((m) => m === 'override')) {
    const unused = !(c.fanIn > 0) && !(c.dependents > 0) && !(c.unlinked > 0);
    put('used', unused ? 'warn' : 'pass', unused ? 'nothing calls it' : `${plural(c.fanIn || c.dependents || 1, 'caller')}`, unused ? 'A new private function that nothing in the repository refers to by name: dead on arrival, or wired through something the graph cannot see.' : 'Something in the repository refers to it.');
  }

  // Measurements: count against the change only when it crossed the limit or made it worse
  const m = u.metrics?.after, b = u.metrics?.before;
  const measure = (id, rows) => {
    if (!m) return put(id, 'na', 'not measured', '');
    const over = rows.filter((r) => r.v > r.lim[0]);
    const size = id === 'simple' && m.loc ? ` in ${m.loc} lines` : '';
    if (!over.length) return put(id, 'pass', rows.map((r) => `${r.label} ${r.v}`).join(' · ') + size, 'Under every limit.');
    const grew = over.filter((r) => isNew || r.was == null || r.v > r.was);
    if (!grew.length) return put(id, 'inherited', over.map((r) => `${r.label} ${r.v}`).join(' · ') + size, 'Over the limit, but it already was before this change and did not grow.');
    const worst = grew.find((r) => r.v > r.lim[1]) || grew[0];
    put(id, 'warn', grew.map((r) => `${r.label} ${r.was != null && !isNew ? `${r.was} → ` : ''}${r.v}`).join(' · ') + size, `${worst.label} ${worst.v} is over the limit of ${worst.lim[0]}${worst.v > worst.lim[1] ? ` and the very-high band (${worst.lim[1]})` : ''}${isNew ? '' : ', and this change made it worse'}${size ? ': complex for its size' : ''}.`);
  };
  if (!proved || m) {
    const row = (label, k, v, was) => ({ label, v, was, lim: MEASURE_LIMITS[k] });
    measure('simple', m ? [row('cyclomatic', 'cyclomatic', m.cyclomatic, b?.cyclomatic), row('cognitive', 'cognitive', m.cognitive, b?.cognitive), row('nesting', 'nesting', m.nesting, b?.nesting)] : []);
    measure('small', m ? [row('lines', 'loc', m.loc, b?.loc)] : []);
    const flags = flagArguments(ht, hs, lang), flagsBefore = flagArguments(bt, bs, lang) || [];
    const p = hs?.params ?? 0, pb = bs?.params;
    const newFlags = (flags || []).filter((f) => !flagsBefore.includes(f));
    if (p > MEASURE_LIMITS.params[0] && (isNew || pb == null || p > pb)) put('interface', 'warn', `${plural(p, 'parameter')}${pb != null && !isNew ? ` (was ${pb})` : ''}`, `More than ${MEASURE_LIMITS.params[0]} parameters: each one is a dimension a caller can get wrong.`);
    else if (newFlags.length) put('interface', 'warn', `flag argument ${newFlags[0]}`, `The boolean parameter ${newFlags.join(', ')} switches what the function does: two functions in one.`);
    else put('interface', p > MEASURE_LIMITS.params[0] ? 'inherited' : 'pass', plural(p, 'parameter'), p > MEASURE_LIMITS.params[0] ? 'Already this many before the change.' : 'Few parameters, no flag argument switching behaviour.');
  }
  if (u.isTest) { put('dry', 'na', 'test', 'Tests repeat their setup on purpose; the co-change evidence for copies is about product code.'); return out; }
  const reps = repeatedStatements(ht), repsBefore = new Map(repeatedStatements(bt).map((r) => [r.text, r.n]));
  const newReps = reps.filter((r) => r.n > (repsBefore.get(r.text) || 0));
  const cc = u.cloneClass, missed = cc ? cc.siblings.filter((x) => !x.edited) : [];
  if (missed.length) put('dry', 'warn', `edited 1 of ${cc.members} copies`, `This function has ${cc.members - 1 === 1 ? 'a copy' : `${cc.members - 1} copies`} elsewhere and this change edits it but not ${missed.slice(0, 3).map((x) => `${x.name || 'a copy'} (${x.where})`).join(', ')}${missed.length > 3 ? ` and ${missed.length - 3} more` : ''}. ${cc.members >= 3 ? 'Classes of three or more copies end up updated inconsistently 86% of the time.' : 'A fix in one copy usually belongs in the other.'}`);
  else if (newReps.length) put('dry', 'warn', `same statement ${newReps[0].n}×`, `This change repeats one statement ${newReps[0].n} times in the function (${newReps[0].text.slice(0, 70)}${newReps[0].text.length > 70 ? '…' : ''}): one change of mind means ${newReps[0].n} edits.`);
  else if (u.clones && u.clones.coverage >= 0.15) put('dry', 'warn', `${Math.round(u.clones.coverage * 100)}% copies ${u.clones.where || 'existing code'}`, `This change copies ${u.clones.name || 'existing code'}${u.clones.inPr ? ', written in this same pull request' : ''} (${u.clones.tokens || '?'} tokens, house style already set aside). Copies are changed together 5 times more often: a fix in one must be repeated in the other.`);
  else if (hs && hs.bodyB - hs.bodyA < 40) put('dry', 'na', 'too short to compare', 'Functions under 40 tokens are not fingerprinted.');
  else put('dry', 'pass', u.clones ? `${Math.round(u.clones.coverage * 100)}% shared, under 15%` : 'no copy introduced', u.clones ? `A small part matches ${u.clones.name || 'other code'}; under the 15% limit.` : 'No run of tokens copied from elsewhere in the repository or this pull request (code written the same way in 10+ places is house style and not counted).');

  return out;
}

/** The Kleene gate of a principle list: { state: pass|warn|fail, passed, applicable, failing[] }.
 *  Informative principles (reached by a test) are shown but do not count: reaching is not asserting. */
export function gate(list) {
  if (!list) return null;
  const applicable = list.filter((p) => p.state !== 'na' && !p.info);
  const worst = applicable.reduce((w, p) => Math.min(w, RANK[p.state]), 2);
  return { state: ['fail', 'warn', 'pass'][worst], passed: applicable.filter((p) => p.state === 'pass' || p.state === 'inherited').length, applicable: applicable.length, failing: applicable.filter((p) => p.state === 'fail' || p.state === 'warn').map((p) => p.id) };
}

/**
 * The colour a node gets once its principles are known.
 *   lower   a failed blocking fact (dangerous API, secret) makes it risky; any other unmet principle makes a green
 *           node amber, with the principle named.
 *   clear   a node the risk model left amber turns pale green ("cleared") when EVERY criterion it is held to ran
 *           and passed: the Kleene minimum is PASS (a check that could not run is n/a or uncertain, never a pass),
 *           the stakes are not critical and the exposure is not high. This is the structural certificate of the
 *           Quality Lab (all deterministic checks pass, no limit crossed by this change). It is NOT a proof that the
 *           new behaviour is right: the claim says so, and only proof.js may say "proved".
 */
export function applyGate(u) {
  const g = u.principleGate; if (!g) return;
  if (g.state === 'pass') {
    if (u.verdict === 'uncertain' && g.applicable >= 6 && !(u.likelihood >= 0.6) && u.sensitive?.level !== 'critical' && !(u.findings || []).some((f) => f.severity === 'bad')) {
      const t = u.principles.find((p) => p.id === 'tested');
      const tests = t?.state === 'pass' ? ` ${t.value[0].toUpperCase()}${t.value.slice(1)}.` : ' No test reaches it yet.';
      Object.assign(u, { verdict: 'cleared', tone: 'ok', claim: `Meets all ${g.applicable} criteria it is held to, each measured on the code.${tests} Not a proof that the new behaviour is right.`, priority: Math.min(u.priority || 0, 0.1 * (u.impact || 0.3)) });
    }
    return;
  }
  const failing = u.principles.filter((p) => !p.info && (p.state === 'fail' || p.state === 'warn'));
  const first = failing[0];
  const text = `Misses ${failing.length === 1 ? 'one criterion' : `${failing.length} criteria`}: ${failing.map((p) => p.name).join(', ')}. ${first.detail}`;
  if (g.state === 'fail' && u.verdict !== 'risky') Object.assign(u, { verdict: 'risky', tone: 'bad', claim: text, priority: Math.max(u.priority || 0, 0.6 * (u.impact || 0.3)) });
  else if (g.state === 'warn' && (u.verdict === 'cleared' || u.verdict === 'proved')) Object.assign(u, { verdict: 'uncertain', tone: 'warn', claim: text, priority: Math.max(u.priority || 0, 0.3 * (u.impact || 0.3)) });
  else if (u.verdict === 'uncertain' && !(u.sensitive?.level === 'critical' && failing.length === 1 && first.id === 'stakes')) Object.assign(u, { claim: text });
}
