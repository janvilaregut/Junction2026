// Principles of one changed function (server/math/principles.js): each scan on small token streams, and the gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../server/math/lex.js';
import { errorPatterns, securityHits, asyncHits, flagArguments, repeatedStatements, principles, gate, applyGate } from '../server/math/principles.js';
import { parseFile } from '../server/math/symbols.js';

const T = (src, lang) => tokenize(src, lang).filter((t) => t.k !== 'nl');

test('error handling: empty catch, catch-all without rethrow, throw ex', () => {
  assert.equal(errorPatterns(T('try { a(); } catch (Exception e) { }', 'cs'), 'cs').empty, 1);
  assert.equal(errorPatterns(T('try { a(); } catch (Exception e) { log(e); }', 'cs'), 'cs').catchAll, 1);
  assert.equal(errorPatterns(T('try { a(); } catch (Exception e) { log(e); throw; }', 'cs'), 'cs').catchAll, 0);
  assert.equal(errorPatterns(T('try { a(); } catch (Exception e) { throw e; }', 'cs'), 'cs').throwEx, 1);
  assert.equal(errorPatterns(T('try { a(); } catch (IOException e) when (e.HResult == 5) { }', 'cs'), 'cs').empty, 1);
  assert.equal(errorPatterns(T('try { a() } catch (e) { }', 'js'), 'js').empty, 1);
  assert.equal(errorPatterns(T('try { a() } catch (e) { report(e) }', 'js'), 'js').empty, 0);
  assert.equal(errorPatterns(T('try:\n    a()\nexcept:\n    pass\n', 'py'), 'py').empty, 1);
});

test('security: dangerous calls by language and secrets', () => {
  assert.deepEqual(securityHits(T('var f = new BinaryFormatter(); f.Deserialize(s);', 'cs'), 'cs').map((h) => h.cwe), ['CWE-502']);
  assert.deepEqual(securityHits(T('const h = crypto.createHash("md5")', 'js'), 'js').map((h) => h.cwe), ['CWE-328']);
  assert.deepEqual(securityHits(T('db.query(`select * from t where id = ${id}`)', 'js'), 'js').map((h) => h.cwe), ['CWE-89']);
  assert.deepEqual(securityHits(T('el.innerHTML = name', 'js'), 'js').map((h) => h.cwe), ['CWE-79']);
  assert.equal(securityHits(T('el.innerHTML = ""', 'js'), 'js').length, 0);
  assert.equal(securityHits(T('const key = "AKIAABCDEFGHIJKLMNOP"', 'js'), 'js')[0].cwe, 'CWE-798');
  assert.equal(securityHits(T('const apiKey = "q8ZtW3n1Lr7Xv0Pp2Kd9Ys5Hb4"', 'js'), 'js')[0].cwe, 'CWE-798');
  assert.equal(securityHits(T('const label = "Please enter your name here"', 'js'), 'js').length, 0);
  assert.equal(securityHits(T('// eval(x) in a comment\nreturn 1;', 'js'), 'js').length, 0);
});

test('async hazards and flag arguments', () => {
  assert.deepEqual(asyncHits(T('var x = task.Result; t.Wait();', 'cs'), 'cs').map((h) => h.id), ['result', 'wait']);
  assert.deepEqual(asyncHits(T('items.forEach(async (i) => { await save(i) })', 'js'), 'js').map((h) => h.id), ['foreach-async']);
  const src = 'class A { int F(int a, bool fast) { if (fast) return 1; return a; } }', toks = tokenize(src, 'cs');
  const sym = parseFile(src, 'a.cs', 'cs').symbols.find((s) => s.name === 'F');
  assert.deepEqual(flagArguments(toks.slice(sym.a, sym.b), sym, 'cs'), ['fast']);
});

test('micro-clones: one statement of 10+ tokens three times', () => {
  const s = 'if (!map.ContainsKey(key)) { throw new KeyNotFoundException(key); } ';
  assert.equal(repeatedStatements(T(`void F() { ${s}${s}${s} }`, 'cs')).length, 1);
  assert.equal(repeatedStatements(T(`void F() { ${s}${s} }`, 'cs')).length, 0);
});

test('the gate is Kleene: one fail stands, n/a does not block, and principles only lower the colour', () => {
  const list = [{ id: 'a', state: 'pass' }, { id: 'b', state: 'na' }, { id: 'c', state: 'inherited' }];
  assert.equal(gate(list).state, 'pass');
  assert.equal(gate([...list, { id: 'd', state: 'warn' }]).state, 'warn');
  assert.equal(gate([...list, { id: 'd', state: 'warn' }, { id: 'e', state: 'fail' }]).state, 'fail');
  const u = { verdict: 'cleared', impact: 0.2, principles: [{ id: 'dry', name: 'Written once (DRY)', state: 'warn', detail: 'copy' }] };
  u.principleGate = gate(u.principles); applyGate(u);
  assert.equal(u.verdict, 'uncertain'); assert.match(u.claim, /Written once/);
  const r = { verdict: 'risky', claim: 'x', principles: [{ id: 'dry', name: 'DRY', state: 'warn', detail: '' }] };
  r.principleGate = gate(r.principles); applyGate(r);
  assert.equal(r.verdict, 'risky'); assert.equal(r.claim, 'x');
});

test('principles of a unit: only what the change introduced counts against it', () => {
  const base = 'function f(a) {\n  try { run(a) } catch (e) { }\n  return a\n}\n';
  const head = 'function f(a) {\n  try { run(a) } catch (e) { }\n  return a + 1\n}\n';
  const B = parseFile(base, 'x.js', 'js'), H = parseFile(head, 'x.js', 'js');
  const u = { lang: 'js', kind: 'function', name: 'f', status: 'modified', _H: H, _B: B, _h: H.symbols[0], _b: B.symbols[0], findings: [], tests: { reachedBy: 1 }, centrality: { fanIn: 1 }, metrics: { after: { cyclomatic: 2, cognitive: 1, nesting: 1, loc: 4 }, before: { cyclomatic: 2, cognitive: 1, nesting: 1, loc: 4 } } };
  const ps = principles(u), by = Object.fromEntries(ps.map((p) => [p.id, p.state]));
  assert.equal(by.errors, 'inherited'); assert.equal(by.tested, 'pass'); assert.equal(by.secure, 'pass'); assert.equal(by.equivalence, 'na');
  assert.equal(gate(ps).state, 'pass');
});

test('DRY: editing one copy of a clone class but not its siblings is flagged, with the siblings named', () => {
  const src = 'function f(a) {\n  return a + 1\n}\n', F = parseFile(src, 'x.js', 'js');
  const u = { lang: 'js', kind: 'function', name: 'f', status: 'modified', _H: F, _B: F, _h: F.symbols[0], _b: F.symbols[0], findings: [], tests: { reachedBy: 1 }, centrality: { fanIn: 1 },
    cloneClass: { members: 3, siblings: [{ name: 'g', where: 'g.js:1', edited: false }, { name: 'h', where: 'h.js:1', edited: true }] } };
  const dry = principles(u).find((p) => p.id === 'dry');
  assert.equal(dry.state, 'warn'); assert.match(dry.detail, /g \(g\.js:1\)/); assert.doesNotMatch(dry.detail, /h \(h\.js/);
  u.cloneClass.siblings[0].edited = true;
  assert.equal(principles(u).find((p) => p.id === 'dry').state, 'na'); // every copy edited; this one is too short to fingerprint
});

test('the gate clears an amber node only when every criterion ran and passed, and never says proved', () => {
  const ok = ['contract', 'guards', 'errors', 'secure', 'async', 'stakes', 'simple', 'small', 'interface'].map((id) => ({ id, name: id, state: 'pass' }));
  const mk = (extra = {}, list = ok) => { const u = { verdict: 'uncertain', claim: 'x', likelihood: 0.3, impact: 0.2, findings: [], principles: [...list, { id: 'tested', name: 'Reached by a test', state: 'warn', value: 'no test reaches it', info: true }], ...extra }; u.principleGate = gate(u.principles); applyGate(u); return u; };
  const u = mk();
  assert.equal(u.principleGate.applicable, 9); // reaching by a test is shown, not counted
  assert.equal(u.verdict, 'cleared'); assert.match(u.claim, /Not a proof/); assert.doesNotMatch(u.claim, /proved/i);
  assert.equal(mk({ sensitive: { level: 'critical', label: 'Money' } }).verdict, 'uncertain');
  assert.equal(mk({ likelihood: 0.7 }).verdict, 'uncertain');
  assert.equal(mk({}, ok.slice(0, 4)).verdict, 'uncertain'); // too few checks ran to clear anything
  const w = mk({}, [...ok, { id: 'dry', name: 'Written once (DRY)', state: 'warn', detail: 'copy' }]);
  assert.equal(w.verdict, 'uncertain'); assert.match(w.claim, /Written once/);
});
