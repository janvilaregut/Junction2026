// Lexer for the mathematical checks. One pass, no dependencies, language-aware enough to be exact about
// what a compiler ignores (comments, layout) and what it does not. Everything downstream (symbols, metrics,
// clone fingerprints, n-gram entropy, equivalence proofs) works on these tokens, never on raw text.
//
// Token: { k, v, l }
//   k  'id' identifier · 'kw' keyword · 'num' number · 'str' string/char/template chunk/regex · 'op' operator
//      or punctuation · 'pp' preprocessor line that changes what is compiled · 'nl' line break (only with nl:true)
//   v  the exact text (strings keep their quotes)
//   l  1-based line
// Python has no braces, so its layout is turned into them: INDENT is '{', DEDENT is '}' and the end of a
// logical line is ';'. The rest of the engine then reads Python like any brace language.
import path from 'node:path';

const EXT = {
  '.cs': 'cs', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.py': 'py', '.java': 'java', '.go': 'go', '.kt': 'kt', '.kts': 'kt', '.rs': 'rs', '.swift': 'swift', '.php': 'php',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.cxx': 'c', '.hpp': 'c', '.hh': 'c', '.m': 'c', '.mm': 'c', '.dart': 'dart', '.scala': 'scala',
};
/** Language id for a path, or null when the engine does not read that kind of file as code. */
export const langOf = (p) => EXT[path.extname(String(p)).toLowerCase()] || null;
export const isJsLike = (lang) => lang === 'js' || lang === 'ts';

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
const COMMON = 'if else for while do switch case default break continue return throw try catch finally new this super class enum interface static public private protected void null true false const import';
const KW = {
  cs: words(`${COMMON} abstract as async await base bool byte char checked decimal delegate double event explicit extern fixed float foreach goto implicit in int internal is lock long namespace object operator out override params readonly record ref sbyte sealed short sizeof stackalloc string struct typeof uint ulong unchecked unsafe ushort using var virtual volatile when where yield get set init nameof partial required global dynamic not and or with file scoped`),
  js: words(`${COMMON} async await delete export extends from function get in instanceof let of set typeof undefined var with yield as`),
  ts: words(`${COMMON} async await delete export extends from function get in instanceof let of set typeof undefined var with yield as abstract any boolean declare implements keyof namespace module never number readonly string type unknown is infer override satisfies`),
  py: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False match case self'),
  java: words(`${COMMON} abstract assert boolean byte char double extends final float implements instanceof int long native package short strictfp synchronized throws transient volatile var record sealed permits yield`),
  go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'),
  kt: words(`${COMMON} as fun val var when object is in out by companion data sealed open override internal lateinit suspend inline typealias package init constructor where`),
  rs: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
  swift: words(`${COMMON} as associatedtype defer deinit extension fallthrough fileprivate func guard in init inout internal is let nil open operator protocol repeat rethrows self Self struct subscript throws typealias var where`),
  php: words(`${COMMON} abstract and array as callable clone declare echo elseif empty endfor endforeach endif endswitch endwhile extends final fn foreach function global implements include instanceof insteadof isset list match namespace or print readonly require static trait unset use var xor yield`),
  c: words(`${COMMON} auto bool char constexpr double extern float goto inline int long namespace noexcept nullptr operator register short signed sizeof struct template typedef typename union unsigned using virtual volatile delete friend explicit override final`),
  dart: words(`${COMMON} abstract as assert async await covariant deferred dynamic export extends extension external factory final get implements in is late library mixin on operator part required set show sync typedef var with yield`),
  scala: words(`${COMMON} abstract case def extends final forSome implicit lazy match object override package sealed trait type val var with yield given using then`),
};
export const keywordsOf = (lang) => KW[lang] || KW.c;

const OPS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '??=', '&&=', '||=', '<=>', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->', '::', '**', '<<', '>>', ':='];
const OP3 = new Set(OPS.filter((o) => o.length === 3)), OP2 = new Set(OPS.filter((o) => o.length === 2));
const isIdStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isDigit = (c) => c >= 48 && c <= 57;
const isIdPart = (c) => isIdStart(c) || isDigit(c);
// A '/' after one of these starts a regular expression in JavaScript, not a division.
const REGEX_AFTER_KW = words('return typeof instanceof in of new delete void throw case do else yield await');
// C# directives that do not change which tokens are compiled.
const INERT_PP = /^#\s*(region|endregion|pragma|nullable|line|warning|error)\b/;

/**
 * tokenize(text, lang, { nl }) → Token[]
 * `nl: true` also emits one 'nl' token per run of line breaks between two tokens (never inside a token), so a
 * caller can decide which line breaks matter (JavaScript's automatic semicolon insertion).
 */
export function tokenize(text, lang, opts = {}) {
  const s = String(text ?? ''), n = s.length, out = [], kw = keywordsOf(lang);
  const py = lang === 'py', js = isJsLike(lang), cs = lang === 'cs';
  const hashComment = py || lang === 'php' || lang === 'rb';
  let i = 0, line = 1, pendingNl = false;
  const indents = [0]; let paren = 0, atLineStart = true; // Python layout
  const tpl = []; // open template literals / interpolated strings: { brace: depth when the hole opened, close }
  let brace = 0;
  const push = (k, v, l) => {
    if (pendingNl) { if (opts.nl && out.length) out.push({ k: 'nl', v: '\n', l }); pendingNl = false; }
    out.push({ k, v, l });
  };
  const prevSig = () => { for (let j = out.length - 1; j >= 0; j--) if (out[j].k !== 'nl') return out[j]; return null; };

  /** Reads a quoted string starting at i (quote char q); returns the index after it. Honours escapes; stops at a line end for plain quotes. */
  const readQuoted = (q, multiline, raw) => {
    let j = i + 1;
    while (j < n) {
      const c = s[j];
      if (c === '\\' && !raw) { j += 2; continue; }
      if (c === q) { if (raw && s[j + 1] === q) { j += 2; continue; } return j + 1; } // "" inside a verbatim string
      if (c === '\n') { if (!multiline) return j; line++; }
      j++;
    }
    return n;
  };
  /** Template literal / interpolated string body from position j (just after the opening quote or a closing hole). */
  const readChunk = (j, close, startLine, raw, holeOpen = '${') => {
    const from = j;
    while (j < n) {
      const c = s[j];
      if (c === '\\' && !raw) { j += 2; continue; }
      if (c === '\n') line++;
      if (holeOpen === '${' ? (c === '$' && s[j + 1] === '{') : (c === '{' && s[j + 1] !== '{')) {
        push('str', s.slice(from, j), startLine);
        tpl.push({ brace, close, raw, holeOpen });
        brace++; i = j + holeOpen.length; push('op', holeOpen, line);
        return;
      }
      if (holeOpen === '{' && c === '{' && s[j + 1] === '{') { j += 2; continue; }
      if (holeOpen === '{' && c === '}' && s[j + 1] === '}') { j += 2; continue; }
      if (raw && c === close && s[j + 1] === close) { j += 2; continue; }
      if (c === close) { push('str', s.slice(from, j + 1), startLine); i = j + 1; return; }
      j++;
    }
    push('str', s.slice(from), startLine); i = n;
  };

  while (i < n) {
    const c = s[i], cc = s.charCodeAt(i);
    if (c === '\n') {
      line++; i++; pendingNl = true;
      if (py && paren === 0) { const p = prevSig(); if (p && !(p.k === 'op' && (p.v === ';' || p.v === '{' || p.v === '}'))) out.push({ k: 'op', v: ';', l: line - 1 }); atLineStart = true; }
      continue;
    }
    if (py && atLineStart && paren === 0) {
      let j = i, col = 0;
      while (j < n && (s[j] === ' ' || s[j] === '\t')) { col += s[j] === '\t' ? 8 - (col % 8) : 1; j++; }
      if (j >= n || s[j] === '\n' || s[j] === '#' || s[j] === '\r') { i = j; if (s[j] === '#') while (i < n && s[i] !== '\n') i++; continue; } // blank or comment line: no layout
      atLineStart = false; i = j;
      if (col > indents[indents.length - 1]) { // the line break after `def f():` opens the block, it does not end a statement
        const p = out[out.length - 1]; if (p && p.k === 'op' && p.v === ';') out.pop();
        indents.push(col); out.push({ k: 'op', v: '{', l: line });
      }
      else { const at = out.length ? out[out.length - 1].l : line; while (col < indents[indents.length - 1]) { indents.pop(); out.push({ k: 'op', v: '}', l: at }); } } // a block ends on its last line, not where the next one starts
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') { i++; continue; }
    if (py && c === '\\' && s[i + 1] === '\n') { i += 2; line++; continue; }

    // Comments
    if (c === '/' && s[i + 1] === '/' && !py) { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*' && !py) { const e = s.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; for (let j = i; j < end; j++) if (s[j] === '\n') { line++; pendingNl = true; } i = end; continue; }
    if (c === '#' && hashComment && !(lang === 'php' && s[i + 1] === '[')) { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '#' && (cs || lang === 'c')) {
      const p = prevSig(); let j = i; while (j < n && s[j] !== '\n') j++;
      if (!p || p.l !== line) { const dir = s.slice(i, j).trim(); if (!INERT_PP.test(dir)) push('pp', dir.replace(/\s+/g, ' ').replace(/\s*\/\/.*$/, ''), line); i = j; continue; }
    }

    // Strings
    if (py && (c === '"' || c === "'" || (/[rRbBfFuU]/.test(c) && /^[rRbBfFuU]{1,2}["']/.test(s.slice(i, i + 3))))) {
      let j = i; while (s[j] !== '"' && s[j] !== "'") j++;
      const raw = /r/i.test(s.slice(i, j)), q = s[j], l0 = line;
      if (s.startsWith(q.repeat(3), j)) { const e = s.indexOf(q.repeat(3), j + 3); const end = e < 0 ? n : e + 3; for (let k = j; k < end; k++) if (s[k] === '\n') line++; push('str', s.slice(i, end), l0); i = end; continue; }
      const save = i; i = j; const end = readQuoted(q, false, raw); push('str', s.slice(save, end), l0); i = end; continue;
    }
    if (cs && (c === '"' || ((c === '$' || c === '@') && /^(\$@|@\$|\$+|@)"/.test(s.slice(i, i + 4))))) {
      const m = s.slice(i, i + 8).match(/^(\$@|@\$|\$+|@)?("""+|")/), prefix = m[1] || '', l0 = line;
      const quotes = prefix.includes('@') ? '"' : m[2]; // @"""…" is a verbatim string that starts with an escaped quote, not a raw literal
      if (quotes.length >= 3) { // raw string literal: ends at the same run of quotes; holes are left inside the token
        const e = s.indexOf(quotes, i + prefix.length + quotes.length); const end = e < 0 ? n : e + quotes.length;
        for (let k = i; k < end; k++) if (s[k] === '\n') line++;
        push('str', s.slice(i, end), l0); i = end; continue;
      }
      const verbatim = prefix.includes('@');
      if (prefix.includes('$')) { push('str', prefix, l0); readChunk(i + prefix.length + 1, '"', l0, verbatim, '{'); continue; }
      const save = i; i += prefix.length; const end = readQuoted('"', verbatim, verbatim); push('str', s.slice(save, end), l0); i = end; continue;
    }
    if (c === '"' || (c === "'" && !py)) {
      // In Rust and C-like generics a lone quote can be a lifetime or a digit separator; a char literal closes within a few characters.
      if (c === "'" && (lang === 'rs' || lang === 'swift') && !/^'(\\.|[^'\\\n])'/.test(s.slice(i, i + 4))) { i++; continue; }
      const l0 = line, end = readQuoted(c, false, false); push('str', s.slice(i, end), l0); i = end; continue;
    }
    if (c === '`' && (js || lang === 'go' || lang === 'kt' || lang === 'dart' || lang === 'scala')) {
      if (!js) { const e = s.indexOf('`', i + 1); const end = e < 0 ? n : e + 1; const l0 = line; for (let k = i; k < end; k++) if (s[k] === '\n') line++; push('str', s.slice(i, end), l0); i = end; continue; }
      readChunk(i + 1, '`', line, false, '${'); continue;
    }
    // Regular expression literal (JavaScript)
    if (c === '/' && js) {
      const p = prevSig();
      const regex = !p || (p.k === 'op' && p.v !== ')' && p.v !== ']' && p.v !== '}' && p.v !== '++' && p.v !== '--') || (p.k === 'kw' && REGEX_AFTER_KW.has(p.v));
      if (regex) {
        let j = i + 1, cls = false, ok = false;
        while (j < n && s[j] !== '\n') { const d = s[j]; if (d === '\\') { j += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) { ok = true; break; } j++; }
        if (ok) { j++; while (j < n && isIdPart(s.charCodeAt(j))) j++; push('str', s.slice(i, j), line); i = j; continue; }
      }
    }

    // Numbers
    if (isDigit(cc) || (c === '.' && isDigit(s.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n) { const d = s.charCodeAt(j), ch = s[j]; if (isIdPart(d) || ch === '.' && isDigit(s.charCodeAt(j + 1)) || ((ch === '+' || ch === '-') && /[eEpP]/.test(s[j - 1]) && !/^0[xX]/.test(s.slice(i, i + 2)))) j++; else break; }
      push('num', s.slice(i, j), line); i = j; continue;
    }
    // Identifiers and keywords
    if (isIdStart(cc) || (c === '@' && cs && isIdStart(s.charCodeAt(i + 1))) || (c === '#' && js && isIdStart(s.charCodeAt(i + 1)))) {
      let j = i + 1; while (j < n && isIdPart(s.charCodeAt(j))) j++;
      const v = s.slice(i, j); push(kw.has(v) ? 'kw' : 'id', v, line); i = j; continue;
    }

    // Operators and punctuation
    if (c === '(' || c === '[') paren++;
    else if (c === ')' || c === ']') paren = Math.max(0, paren - 1);
    else if (c === '{') { brace++; if (py) paren++; }
    else if (c === '}') {
      const t = tpl[tpl.length - 1];
      if (t && brace - 1 === t.brace) { tpl.pop(); brace--; push('op', '}', line); readChunk(i + 1, t.close, line, t.raw, t.holeOpen); continue; }
      brace = Math.max(0, brace - 1); if (py) paren = Math.max(0, paren - 1);
    }
    const three = s.substr(i, 3), two = s.substr(i, 2);
    if (s.substr(i, 4) === '>>>=') { push('op', '>>>=', line); i += 4; continue; }
    if (OP3.has(three)) { push('op', three, line); i += 3; continue; }
    if (OP2.has(two) && !(two === '>>' && (cs || lang === 'java' || lang === 'ts' || lang === 'c' || lang === 'kt' || lang === 'rs' || lang === 'swift'))) { push('op', two, line); i += 2; continue; } // '>>' closes two generics as often as it shifts: keep it as two '>'
    push('op', c, line); i++;
  }
  if (py) {
    const p = prevSig(); if (p && !(p.k === 'op' && (p.v === ';' || p.v === '}'))) out.push({ k: 'op', v: ';', l: line });
    const at = out.length ? out[out.length - 1].l : line;
    while (indents.length > 1) { indents.pop(); out.push({ k: 'op', v: '}', l: at }); }
  }
  return out;
}

/** The token text a compiler sees, one string. Two sources with the same signature are the same program text. */
export const signature = (tokens) => tokens.map((t) => (t.k === 'nl' ? '\n' : t.v)).join('\u0001');

/** For every opening bracket the index of its partner, and back. -1 where a bracket has none. */
export function matchBrackets(tokens) {
  const m = new Int32Array(tokens.length).fill(-1), st = [];
  const OPEN = { '(': ')', '[': ']', '{': '}', '${': '}' };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]; if (t.k !== 'op') continue;
    if (OPEN[t.v]) st.push(i);
    else if (t.v === ')' || t.v === ']' || t.v === '}') {
      // Tolerate unbalanced input: close the nearest opener of the same kind.
      for (let j = st.length - 1; j >= 0; j--) if (OPEN[tokens[st[j]].v] === t.v) { m[st[j]] = i; m[i] = st[j]; st.length = j; break; }
    }
  }
  return m;
}
