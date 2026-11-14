#!/usr/bin/env node
// Katse attacks its own certificate.
// "Proved" must mean the edit cannot change behaviour, so this script tries to make the prover lie:
//   1. it takes real functions from a repository,
//   2. applies edits that DO change behaviour (a flipped operator, a changed constant, a deleted statement,
//      two swapped arguments, a renamed name that is not a local) and counts how many the prover certifies.
//      The answer must be 0: one is a bug in the prover.
//   3. applies edits that do NOT change behaviour (re-layout, comments, renaming a local to a fresh name) and
//      counts how many it certifies: that is how much reading the certificate saves.
// With 0 failures in n trials the exact 95% upper bound on the failure rate is 1 - 0.05^(1/n) (about 3/n):
// the number is printed with its n, never as "0%".
//
//   node scripts/math-selftest.js [path to a git repository] [ref]      (default: this repository, HEAD)
import path from 'node:path';
import { ROOT } from '../server/util.js';
import { loadSources } from '../server/math/repo.js';
import { parseFile } from '../server/math/symbols.js';
import { proveEquivalent } from '../server/math/proof.js';

const repo = path.resolve(process.argv[2] || ROOT), ref = process.argv[3] || 'HEAD';
const LANGS = new Set(['js', 'ts', 'cs', 'java']);
const { files } = await loadSources(repo, ref, { only: LANGS });

/** Tokens back to text: same tokens, same line structure. Both sides of every comparison are built this way. */
const text = (T) => { let s = '', line = T[0]?.l; for (const t of T) { s += (t.l !== line ? '\n' : ' ') + t.v; line = t.l; } return s; };
const FLIP = { '+': '-', '-': '+', '*': '/', '<': '<=', '<=': '<', '>': '>=', '>=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===', '&&': '||', '||': '&&', '++': '--', '--': '++', '+=': '-=', '-=': '+=' };
const WORD = { true: 'false', false: 'true', null: '0' };

function mutants(T) {
  const out = [];
  const clone = (f) => { const U = T.map((t) => ({ ...t })); return f(U) === false ? null : U; };
  for (let i = 1; i < T.length - 1; i++) {
    const t = T[i];
    if (t.k === 'op' && FLIP[t.v] && T[i - 1].k !== 'op') out.push(['operator', clone((U) => { U[i].v = FLIP[t.v]; })]);
    if (t.k === 'num') out.push(['constant', clone((U) => { U[i].v = /^\d+$/.test(t.v) ? String(Number(t.v) + 1) : t.v + '1'; })]);
    if (t.k === 'kw' && WORD[t.v]) out.push(['constant', clone((U) => { U[i].v = WORD[t.v]; U[i].k = WORD[t.v] === '0' ? 'num' : 'kw'; })]);
    if (t.k === 'str' && t.v.length > 2 && /^["']/.test(t.v)) out.push(['string', clone((U) => { U[i].v = t.v[0] + 'x' + t.v.slice(1); })]);
    if (t.k === 'op' && t.v === ';' && i > 4) { // delete the statement that ends here
      let j = i - 1; while (j > 0 && !(T[j].k === 'op' && (T[j].v === ';' || T[j].v === '{' || T[j].v === '}'))) j--;
      if (i - j > 2 && i - j < 40) out.push(['deleted statement', T.slice(0, j + 1).concat(T.slice(i + 1)).map((x) => ({ ...x }))]);
    }
    if (t.k === 'op' && t.v === ',' && T[i - 1].k === 'id' && T[i + 1].k === 'id' && T[i - 1].v !== T[i + 1].v && T[i - 2]?.v === '(' && T[i + 2]?.v === ')') out.push(['swapped arguments', clone((U) => { [U[i - 1].v, U[i + 1].v] = [U[i + 1].v, U[i - 1].v]; })]);
    if (t.k === 'id' && T[i - 1].v === '.' && T[i + 1].v === '(') out.push(['other method', clone((U) => { U[i].v = t.v + 'X'; })]);
  }
  // A renamed name that is certainly NOT a local variable: a function that is only ever called (never declared,
  // never a member), or a type that is only ever constructed. Renaming it calls something else.
  const ids = new Map(); T.forEach((t, i) => { if (t.k === 'id') ids.set(t.v, (ids.get(t.v) || []).concat(i)); });
  for (const [name, at] of ids) {
    const called = at.every((i) => T[i + 1]?.v === '(' && T[i - 1]?.k === 'op' && !['.', '?.', '::', '->', '>', ']', '?'].includes(T[i - 1].v) && i > 2);
    const constructed = at.every((i) => T[i - 1]?.v === 'new');
    if ((called || constructed) && at.length <= 6) out.push(['renamed non-local', clone((U) => { for (const i of at) U[i].v = name + '_other'; })]);
  }
  return out.filter((m) => m[1]);
}
function preserving(T, lang) {
  const out = [];
  out.push(['comment added', `/* reviewed */\n${text(T)}\n// end`]);
  out.push(['re-indented', text(T).split('\n').map((l) => '    ' + l.trim()).join('\n')]);
  out.push(['wrapped after commas', text(T).replace(/ , /g, ' ,\n      ')]);
  const js = lang === 'js' || lang === 'ts';
  for (let i = 1; i < T.length; i++) { // rename the first simply declared local to a fresh name
    const declared = js ? ['let', 'const'].includes(T[i - 1].v) : T[i - 1].v === 'var';
    if (T[i].k !== 'id' || !declared || T[i + 1]?.v !== '=') continue;
    const name = T[i].v, fresh = name + '_renamed';
    out.push(['local renamed', text(T.map((t) => (t.k === 'id' && t.v === name ? { ...t, v: fresh } : t)))]);
    break;
  }
  return out;
}

const tally = (o, k, f) => { o[k] = o[k] || { n: 0, proved: 0 }; o[k].n++; if (f) o[k].proved++; };
const changing = {}, keeping = {}, lies = [];
let functions = 0, n = 0, t0 = performance.now();
for (const f of files) {
  if (/(\.min\.|\.g\.cs$|\/Resources\/)/.test(f.path)) continue;
  const p = parseFile(f.text, f.path, f.lang);
  for (const s of p.symbols) {
    const T = p.tokens.slice(s.a, s.b);
    if (s.kind === 'type' || T.length < 14 || T.length > 500 || s.bodyB - s.bodyA < 8) continue;
    if (functions >= 900) break;
    functions++;
    const original = text(T);
    for (const [kind, U] of mutants(T).slice(0, 24)) {
      const r = proveEquivalent(original, text(U), f.lang); n++;
      tally(changing, kind, r.proved);
      if (r.proved) lies.push({ file: f.path, line: s.start, kind, level: r.level, claim: r.claim });
    }
    for (const [kind, variant] of preserving(T, f.lang)) tally(keeping, kind, proveEquivalent(original, variant, f.lang).proved);
  }
}
const ms = Math.round(performance.now() - t0), bound = n ? 1 - Math.pow(0.05, 1 / n) : 1;
console.log(`Katse · certificate self-test on ${path.basename(repo)} @ ${ref}`);
console.log(`${functions} functions, ${n} behaviour-changing edits, ${ms} ms\n`);
console.log('Edits that change behaviour            tried   certified');
for (const [k, v] of Object.entries(changing).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(36)} ${String(v.n).padStart(6)}   ${v.proved}`);
console.log(`\n  certified by mistake: ${lies.length} of ${n}   (95% upper bound on the rate: ${(bound * 100).toFixed(3)}%)`);
for (const l of lies.slice(0, 10)) console.log(`    UNSOUND ${l.file}:${l.line}  ${l.kind}  → ${l.level}: ${l.claim}`);
console.log('\nEdits that keep behaviour              tried   certified');
for (const [k, v] of Object.entries(keeping)) console.log(`  ${k.padEnd(36)} ${String(v.n).padStart(6)}   ${v.proved}  (${Math.round((100 * v.proved) / v.n)}%)`);
console.log('\nA certified edit is a proof; an edit that is not certified is simply sent on to the measurements and the agents.');
if (lies.length) process.exitCode = 1;
