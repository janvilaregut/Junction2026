// Pairs that an adversarial review got certified by an earlier version of server/math/proof.js: in each one
// the two versions behave differently (the reviewers ran both where a runtime existed) and the prover said
// "proved". They must stay refused. The table is data: language, what the reviewer found, old text, new text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { proveEquivalent, classifyChange } from '../server/math/proof.js';

const PAIRS = [
  ["js", "JSX children are content, but they are lexed as layout: whitespace and line wraps inside JSX are certified", "const C = ({a, b}) => <p>{a} {b}</p>;", "const C = ({a, b}) => <p>{a}{b}</p>;"],
  ["js", "`//` and `/*` inside JSX text are dropped as comments: changed text, and changed code after it, is certified", "const C = () => <p>see http://a.example</p>;", "const C = () => <p>see http://b.example</p>;"],
  ["js", "Restricted productions are not special-cased: a break after return/yield/break/async is dropped when the next token is in CONTINUES or CONTINUES_KW", "function C() {\n  return <div>hi</div>;\n}", "function C() {\n  return\n  <div>hi</div>;\n}"],
  ["js", "Comments that build tools read are discarded: adding /* @__PURE__ */ (or a JSX pragma, webpack magic comment) is certified", "export function start(registry) {\n  registry.push(\"started\");\n  register(registry);\n  return registry.length;\n}", "export function start(registry) {\n  registry.push(\"started\");\n  /* @__PURE__ */ register(registry);\n  return registry.length;\n}"],
  ["js", "Regex versus division is decided from the previous token only: a regex after `)`, `}` or `default` is lexed as code, and a division after TS `!` or an", "function f(s) {\n  var r = 0; if (s) /a b/.test(s) && (r = 1);\n  return r;\n}", "function f(s) {\n  var r = 0; if (s) /a  b/.test(s) && (r = 1);\n  return r;\n}"],
  ["js", "CR, U+2028 and U+2029 are line terminators in ECMAScript but not for the lexer", "function f(x) {\n  return x;\n}", "function f(x) {\n  return\r  x;\n}"],
  ["js", "String line continuation in a CRLF file: the continued line is lexed as code, so its indentation change is certified", "function f() {\r\n  return \"a\\\r\n    b\";\r\n}", "function f() {\r\n  return \"a\\\r\n  b\";\r\n}"],
  ["ts", "canEnd misses tokens that can end an expression: TypeScript postfix `!` and type-argument `>`, and identifiers named `type`, `of`, `interface`", "function f(y: any, z: any) {\n  let x = y!++\n  z\n  return [x, y, z]\n}", "function f(y: any, z: any) {\n  let x = y!\n  ++\n  z\n  return [x, y, z]\n}"],
  ["ts", "TypeScript `as` must be on the same line as its operand, but `as` is in CONTINUES_KW", "function f(pair: any) {\n  const t = pair as [string, number];\n  return t;\n}", "function f(pair: any) {\n  const t = pair\n    as [string, number];\n  return t;\n}"],
  ["js", "`1.` is split into number and dot, so `1.e3` and `1 .e3` (and `1 .f()` / `1.<newline>f()`) have the same tokens", "var x = 1.e3", "var x = 1 .e3"],
  ["js", "Annex B HTML-like comment: `a <!--b` is a comment in scripts and CommonJS, the lexer sees `a < ! -- b`", "var a = 1, b = 1, x = a < !--b", "var a = 1, b = 1, x = a <!--b"],
  ["java", "Text blocks and other multi-line string literals are tokenised as code (Java, Kotlin, Swift, Scala, Dart, Rust, PHP)", "String f() {\n  return \"\"\"\n      see http://old.example.com/a\n      \"\"\";\n}", "String f() {\n  return \"\"\"\n      see http://new.example.com/b\n      \"\"\";\n}"],
  ["php", "PHP: text outside <?php ?> is output but is tokenised as PHP code; ?> inside a one-line comment is swallowed", "<?php function f() { ?>\n<p>see http://old.example.com</p>\n<?php }", "<?php function f() { ?>\n<p>see http://new.example.com</p>\n<?php }"],
  ["scala", "Scala 3: indentation and blank lines are syntax, only the presence of a line break is compared", "def f(a: Boolean): Int = {\n  var y = 0\n  if a then\n    y = 1\n  y = 2\n  y\n}", "def f(a: Boolean): Int = {\n  var y = 0\n  if a then\n    y = 1\n    y = 2\n  y\n}"],
  ["swift", "String interpolation with a nested string literal: the literal's content is tokenised as code (Swift, Kotlin, Scala, Dart, PHP, Python 3.12+, Ruby)", "func f() -> String {\n  return \"\\(g(\"http://old.example.com\"))\"\n}", "func f() -> String {\n  return \"\\(g(\"http://new.example.com\"))\"\n}"],
  ["py", "Python: NEWLINE, INDENT and DEDENT are emitted as the ordinary tokens ; { } and cannot be told from real ones", "def f(a):\n    y = 0\n    if a: x = 1; y = 2\n    return y\n", "def f(a):\n    y = 0\n    if a: x = 1\n    y = 2\n    return y\n"],
  ["py", "Python raw strings: backslash-quote ends the literal for the lexer, the rest of the string becomes code or a comment", "def f():\n    return r\"\\\" # one\"\n", "def f():\n    return r\"\\\" # two\"\n"],
  ["c", "Raw-string delimiters are unknown: quotes inside pair up the wrong way round (C++ R\"(...)\", Rust r#\"...\"#, Swift #\"...\"#, Dart r'...')", "const char *f() { return R\"(say \"a  b\" now)\"; }", "const char *f() { return R\"(say \"a b\" now)\"; }"],
  ["c", "C, C++, Objective-C: every #pragma is discarded as inert", "#pragma pack(1)\nstruct S { char c; int i; };\nint f(void) { return (int)sizeof(struct S); }", "struct S { char c; int i; };\nint f(void) { return (int)sizeof(struct S); }"],
  ["c", "C preprocessor directives: white space is collapsed and //... is cut even inside string literals; continuation lines are ordinary code", "#define URL \"http://old.example.com\"\nconst char *f(void) { return URL; }", "#define URL \"http://new.example.com\"\nconst char *f(void) { return URL; }"],
  ["py", "Comments the toolchain reads are discarded: encoding declaration, language version, frozen_string_literal, Go directives and cgo preamble, Rust doc co", "# -*- coding: latin-1 -*-\ndef f():\n    return len(\"\u00e9\")\n", "# plain comment\ndef f():\n    return len(\"\u00e9\")\n"],
  ["java", "Java alpha: a method of an anonymous or local class is taken for a local variable and renamed away", "Object f() { return new Object() { public String toString() { return \"hi\"; } }; }", "Object f() { return new Object() { public String toText() { return \"hi\"; } }; }"],
  ["java", "Java alpha: record components are renamed as if they were parameters or locals", "String f() { record R(int a) {} return new R(1).toString(); }", "String f() { record R(int c) {} return new R(1).toString(); }"],
  ["java", "Java alpha: methods and enum case labels live in other namespaces but are renamed together with the local", "int f() { int size = size(); return size; }", "int f() { int total = total(); return total; }"],
  ["java", "Java alpha: a binder's scope is assumed to start at the opening brace, but it starts at the declaration", "int f() { g(); x = 5; int x = 2; return x; }", "int f() { g(); y = 5; int y = 2; return y; }"],
  ["java", "Java alpha: a new name that looks fresh is captured by an inherited member inside an anonymous or local class", "int f() { int n = 1; return new Base() { int g() { return n; } }.g(); }", "int f() { int count = 1; return new Base() { int g() { return count; } }.g(); }"],
  ["swift", "Swift: the spaces around an operator decide prefix, infix or postfix, and &- / &+ are single operators", "func f(_ a: Int, _ b: Int) -> Int {\n  let x = a\n    - b\n  return x\n}", "func f(_ a: Int, _ b: Int) -> Int {\n  let x = a\n    -b\n  return x\n}"],
  ["java", "Java: unicode escapes are translated before lexing, so a comment can contain live code", "int f() { int x = 1; // \\u000a x = 2;\n  return x; }", "int f() { int x = 1; // x = 2;\n  return x; }"],
  ["c", "C, C++, Objective-C: a backslash at the end of a // comment splices the next line into the comment", "int f(int x) {\n  // TODO remove \\\n  x = 0;\n  return x;\n}", "int f(int x) {\n  // TODO remove\n  x = 0;\n  return x;\n}"],
  ["swift", "Block comments nest in Swift, Kotlin, Scala, Dart and Rust; the lexer ends them at the first */", "func f() {\n  /* /* */ g() /* */ */\n}", "func f() {\n  /* */ g() /* /* */ */\n}"],
  ["swift", "A carriage return on its own is a line break in Swift, Kotlin, Scala, JavaScript and Python, but is skipped as a space", "func f(_ a: Int, _ b: Int) -> Int {\n  let x = a\r  -b\n  return x\n}", "func f(_ a: Int, _ b: Int) -> Int {\n  let x = a  - b\n  return x\n}"],
  ["py", "Python: a form feed in the leading white space resets the column in CPython, the lexer stops counting there", "def f(a):\n    y = 0\n    if a:\n        y = 1\n    \f        y = 2\n    return y\n", "def f(a):\n    y = 0\n    if a:\n        y = 1\n    y = 2\n    return y\n"],
  ["py", "A number does not absorb a trailing dot: 1.e5 and 1 .e5 are the same tokens", "def f():\n    return 1.e5\n", "def f():\n    return 1 .e5\n"],
  ["rb", "Ruby is listed as line-strict but the lexer has no Ruby rules (not reachable today: .rb is not in EXT)", "def f(s)\n  a = s.split(//); a << 1\n  a\nend\n", "def f(s)\n  a = s.split(//); a << 2\n  a\nend\n"],
  ["java", "Documented exclusion met by everyday code: Java parameter names are an external contract under -parameters (Spring MVC, Spring Data, Jackson)", "String hello(@RequestParam String name) { return \"hi \" + name; }", "String hello(@RequestParam String who) { return \"hi \" + who; }"],
  ["c", "Documented exclusion: the C preprocessor's # operator reads the spacing of its argument", "#define STR(x) #x\nconst char *f(void) { return STR(a+b); }", "#define STR(x) #x\nconst char *f(void) { return STR(a + b); }"],
  ["php", "Documented exclusion met by everyday code: PHP doc-comment annotations are read by reflection", "<?php class T { /** @dataProvider one */ function testX() { return 1; } }", "<?php class T { /** @dataProvider two */ function testX() { return 1; } }"],
];

test('review: every pair that was once certified by mistake is refused', () => {
  for (const [lang, what, a, b] of PAIRS) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const r = proveEquivalent(x, y, lang);
      assert.equal(r.proved, false, `UNSOUND again (${lang}): ${what}`);
      assert.ok(r.why, 'a refusal says why');
    }
    assert.notEqual(classifyChange(a, b, lang).kind, 'identical', `not labelled identical either (${lang}): ${what}`);
  }
});

const proved = (a, b, lang, level = 'identical') => { const r = proveEquivalent(a, b, lang); assert.equal(r.proved, true, `expected a proof, got: ${r.why}\n${a}\n---\n${b}`); assert.equal(r.level, level); };
const refused = (a, b, lang, why) => { const r = proveEquivalent(a, b, lang); assert.equal(r.proved, false, `UNSOUND: ${a}\n---\n${b}`); if (why) assert.match(r.why, why); };

test('review: the guards do not refuse ordinary code', () => {
  // a division after a call or a group divides; a comparison after a value compares
  proved('function r(x){\n  const c = x*100;\n  return Math.round(c)/100;\n}', 'function r(x) {\n  const c = x * 100;\n  return Math.round(c) / 100; // cents\n}', 'js');
  proved('function m(a,b){ return (a+b)/2; }', 'function m(a, b) {\n  return (a + b) / 2;\n}', 'js');
  proved('function c(i,n,xs){\n  while (i++ < n) { if (xs[i] < 0) return true; }\n  return this.a < n;\n}', 'function c(i, n, xs) {\n  while (i++ < n) { if (xs[i] < 0) return true; } // scan\n  return this.a < n;\n}', 'js');
  // markup inside a string or a template is one token: it is compared byte for byte, not read as JSX
  proved('function h(x){ return `<div class="a">${x}</div>` + "</p>"; }', 'function h(x) {\n  return `<div class="a">${x}</div>` + "</p>";\n}', 'js');
  proved("function q(s){ return s + 'it\\'s' + \"a\\\"b\"; }", "function q(s) {\n  return s + 'it\\'s' + \"a\\\"b\";\n}", 'js');
  // TypeScript generics follow a name
  proved('function id<T>(x: T): Array<T> { const m = new Map<string, T>(); return [x]; }', 'function id<T>(x: T): Array<T> {\n  const m = new Map<string, T>();\n  return [x];\n}', 'ts');
  // C#: generics, comparisons, interpolated and verbatim strings, a preprocessor line kept as it is
  proved('int F(List<int> xs, int a) { if (a < xs.Count) { return a / 2; } return $"{a}".Length + @"c:\\x".Length; }', 'int F(List<int> xs, int a)\n{\n    if (a < xs.Count)\n    {\n        return a / 2; // half\n    }\n    return $"{a}".Length + @"c:\\x".Length;\n}', 'cs');
  // a regular expression in a place where the tokenizer knows it is one
  proved('function t(s){ const re = /a b\\/c/g; return re.test(s) && /x/.test(s); }', 'function t(s) {\n  const re = /a b\\/c/g;\n  return re.test(s) && /x/.test(s);\n}', 'js');
  // a renamed local is still proved in JavaScript and TypeScript
  proved('function f(a){\n  const x = a + 1;\n  return x * 2;\n}', 'function f(a){\n  const total = a + 1;\n  return total * 2;\n}', 'js', 'alpha');
});

test('review: what the guards refuse, each with its reason', () => {
  refused('const C = () => <b>a</b>;', 'const C = () => <b>a </b>;', 'js', /JSX/);
  refused('function f(s) {\n  if (s) /a b/.test(s);\n}', 'function f(s) {\n  if (s) /a  b/.test(s);\n}', 'js', /regular expression/);
  refused('function f(x) {\n  for (;;) {} /re/.test(x);\n}', 'function f(x) {\n  for (;;) {}  /re/.test(x);\n}', 'js', /regular expression/);
  refused('function f() {\n  return load();\n}', 'function f() {\n  return /* @__PURE__ */ load();\n}', 'js', /comment that a build tool/);
  refused('function f() {\n  return import(/* webpackChunkName: "a" */ "./a.js");\n}', 'function f() {\n  return import(/* webpackChunkName: "b" */ "./a.js");\n}', 'js', /comment that a build tool/);
  refused('function f(x) {\n  return x;\n}', 'function f(x) {\n  return x;' + String.fromCharCode(0x2028) + '}', 'js', /line terminator/);
  refused('function f(x) {\n  return x;\n}', 'function f(x) {\n  return\r  x;\n}', 'js', /line terminator/);
  refused('var x = 1.e3', 'var x = 1 .e3', 'js', /integer is followed by a dot/);
  refused('class A {\n  static\n  *g() {}\n}', 'class A {\n  static *g() {}\n}', 'js', /line break/);
  refused('function f() {\n  const h = () => 1;\n  return h;\n}', 'function f() {\n  const g = () => 1;\n  return g;\n}', 'js', /takes the variable's name/);
  refused('function f() {\n  let K = class {};\n  return K;\n}', 'function f() {\n  let J = class {};\n  return J;\n}', 'js', /takes the variable's name/);
});
