// Structural metrics: every expected value below was counted by hand from the definitions in
// server/math/complexity.js; the trailing comments show the increments (cyclomatic decisions are marked d1, d2…,
// cognitive increments +n). The Java and JavaScript examples are the ones printed in G. Ann Campbell,
// "Cognitive Complexity" (SonarSource, version 1.7), with the totals the paper gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../server/math/lex.js';
import { parseFile } from '../server/math/symbols.js';
import { metrics, compare, rate, THRESHOLDS } from '../server/math/complexity.js';

const m = (src, lang) => metrics(tokenize(src, lang), lang);
/** Asserts the four structural numbers of a snippet at once. */
const expect = (src, lang, want) => {
  const got = m(src, lang), pick = {};
  for (const k of Object.keys(want)) pick[k] = got[k];
  assert.deepEqual(pick, want);
};

// ---------------------------------------------------------------------------------------------------------
// The examples of the paper
// ---------------------------------------------------------------------------------------------------------

const SUM_OF_PRIMES = `int sumOfPrimes(int max) {
  int total = 0;
  OUT: for (int i = 1; i <= max; ++i) {   // d1  +1
    for (int j = 2; j < i; ++j) {         // d2  +2
      if (i % j == 0) {                   // d3  +3
        continue OUT;                     //     +1
      }
    }
    total += i;
  }
  return total;
}`;
const GET_WORDS = `String getWords(int number) {
    switch (number) {                     //     +1
      case 1:                             // d1
        return "one";
      case 2:                             // d2
        return "a couple";
      case 3:                             // d3
        return "a few";
      default:
        return "lots";
    }
  }`;

test('paper: sumOfPrimes and getWords have the same cyclomatic number and different cognitive complexity', () => {
  expect(SUM_OF_PRIMES, 'java', { cyclomatic: 4, cognitive: 7, nesting: 3, returns: 1 });
  expect(GET_WORDS, 'java', { cyclomatic: 4, cognitive: 1, nesting: 1, returns: 4 });
});

test('paper: try does not nest, catch does; a lambda nests without an increment of its own', () => {
  expect(`void myMethod () {
  try {
    if (condition1) {                     // d1  +1
      for (int i = 0; i < 10; i++) {      // d2  +2 (nesting=1)
        while (condition2) { work(); }    // d3  +3 (nesting=2)
      }
    }
  } catch (ExcepType1 | ExcepType2 e) {   // d4  +1
    if (condition2) { work(); }           // d5  +2 (nesting=1)
  }
}`, 'java', { cyclomatic: 6, cognitive: 9, nesting: 4 }); // depth: try > if > for > while
  expect(`void myMethod2 () {
  Runnable r = () -> {                    //     +0 (but nesting level is now 1)
    if (condition1) { work(); }           // d1  +2 (nesting=1)
  };
}`, 'java', { cyclomatic: 2, cognitive: 2, nesting: 1 });
});

test('paper: one increment per sequence of like logical operators', () => {
  expect('void f() { if (a && b && c || d || e && f) { x(); } }', 'java', { cyclomatic: 7, cognitive: 4 }); // if +1, && +1, || +1, && +1; six decisions
  expect('void f() { if (a && !(b && c)) { x(); } }', 'java', { cyclomatic: 4, cognitive: 3 }); // if +1, && +1, the negated group +1
  expect('boolean f() { return a && b && c && d; }', 'java', { cyclomatic: 4, cognitive: 1 });
  expect('boolean f() { return a || b && c || d; }', 'java', { cyclomatic: 4, cognitive: 3 });
});

test('paper: overriddenSymbolFrom is 19', () => {
  expect(`@Nullable
private MethodJavaSymbol overriddenSymbolFrom(ClassJavaType classType) {
  if (classType.isUnknown()) {                                   // d1  +1
    return Symbols.unknownMethodSymbol;
  }
  boolean unknownFound = false;
  List<JavaSymbol> symbols = classType.getSymbol().members().lookup(name);
  for (JavaSymbol overrideSymbol : symbols) {                    // d2  +1
    if (overrideSymbol.isKind(JavaSymbol.MTH)                    // d3  +2 (nesting = 1)
        && !overrideSymbol.isStatic()) {                         // d4  +1
      MethodJavaSymbol methodJavaSymbol = (MethodJavaSymbol)overrideSymbol;
      if (canOverride(methodJavaSymbol)) {                       // d5  +3 (nesting = 2)
        Boolean overriding = checkOverridingParameters(methodJavaSymbol,
            classType);
        if (overriding == null) {                                // d6  +4 (nesting = 3)
          if (!unknownFound) {                                   // d7  +5 (nesting = 4)
            unknownFound = true;
          }
        } else if (overriding) {                                 // d8  +1
          return methodJavaSymbol;
        }
      }
    }
  }
  if (unknownFound) {                                            // d9  +1
    return Symbols.unknownMethodSymbol;
  }
  return null;
}`, 'java', { cyclomatic: 10, cognitive: 19, nesting: 5, returns: 4 });
});

test('paper: addVersion is 35 (synchronized and the inner try add nothing)', () => {
  expect(`private void addVersion(final Entry entry, final Transaction txn)
throws PersistitInterruptedException, RollbackException {
  final TransactionIndex ti = _persistit.getTransactionIndex();
  while (true) {                                                 // d1  +1
    try {
      synchronized (this) {
        if (frst != null) {                                      // d2  +2 (nesting = 1)
          if (frst.getVersion() > entry.getVersion()) {          // d3  +3 (nesting = 2)
            throw new RollbackException();
          }
          if (txn.isActive()) {                                  // d4  +3 (nesting = 2)
            for                                                  // d5  +4 (nesting = 3)
                (Entry e = frst; e != null; e = e.getPrevious()) {
              final long version = e.getVersion();
              final long depends = ti.wwDependency(version,
                  txn.getTransactionStatus(), 0);
              if (depends == TIMED_OUT) {                        // d6  +5 (nesting = 4)
                throw new WWRetryException(version);
              }
              if (depends != 0                                   // d7  +5 (nesting = 4)
                  && depends != ABORTED) {                       // d8  +1
                throw new RollbackException();
              }
            }
          }
        }
        entry.setPrevious(frst);
        frst = entry;
        break;
      }
    } catch (final WWRetryException re) {                        // d9  +2 (nesting = 1)
      try {
        final long depends = _persistit.getTransactionIndex()
            .wwDependency(re.getVersionHandle(),txn.getTransactionStatus(),
            SharedResource.DEFAULT_MAX_WAIT_TIME);
        if (depends != 0                                         // d10 +3 (nesting = 2)
            && depends != ABORTED) {                             // d11 +1
          throw new RollbackException();
        }
      } catch (final InterruptedException ie) {                  // d12 +3 (nesting = 2)
        throw new PersistitInterruptedException(ie);
      }
    } catch (final InterruptedException ie) {                    // d13 +2 (nesting = 1)
      throw new PersistitInterruptedException(ie);
    }
  }
}`, 'java', { cyclomatic: 14, cognitive: 35, nesting: 6, returns: 6 }); // depth: while > try > if > if > for > if
});

test('paper: toRegexp is 20 (else and else if are flat, the conditional operator is structural)', () => {
  expect(`private static String toRegexp(String antPattern,
    String directorySeparator) {
  final String escapedDirectorySeparator = '\\\\' + directorySeparator;
  final StringBuilder sb = new StringBuilder(antPattern.length());
  sb.append('^');
  int i = antPattern.startsWith("/") ||                          // d1  +1
      antPattern.startsWith("\\\\") ? 1 : 0;                      // d2  +1
  while (i < antPattern.length()) {                              // d3  +1
    final char ch = antPattern.charAt(i);
    if (SPECIAL_CHARS.indexOf(ch) != -1) {                       // d4  +2 (nesting = 1)
      sb.append('\\\\').append(ch);
    } else if (ch == '*') {                                      // d5  +1
      if (i + 1 < antPattern.length()                            // d6  +3 (nesting = 2)
          && antPattern.charAt(i + 1) == '*') {                  // d7  +1
        if (i + 2 < antPattern.length()                          // d8  +4 (nesting = 3)
            && isSlash(antPattern.charAt(i + 2))) {              // d9  +1
          sb.append("(?:.*")
              .append(escapedDirectorySeparator).append("|)");
          i += 2;
        } else {                                                 //     +1
          sb.append(".*");
          i += 1;
        }
      } else {                                                   //     +1
        sb.append("[^").append(escapedDirectorySeparator).append("]*?");
      }
    } else if (ch == '?') {                                      // d10 +1
      sb.append("[^").append(escapedDirectorySeparator).append("]");
    } else if (isSlash(ch)) {                                    // d11 +1
      sb.append(escapedDirectorySeparator);
    } else {                                                     //     +1
      sb.append(ch);
    }
    i++;
  }
  sb.append('$');
  return sb.toString();
}`, 'java', { cyclomatic: 12, cognitive: 20, nesting: 4 });
});

test('paper: the YUI save method is 20 (nested callbacks, a conditional operator among arguments)', () => {
  expect(`var model = { save: function (options, callback) {
  var self = this;
  if (typeof options === 'function') {                  // d1 +1
    callback = options;
    options  = {};
  }
  options || (options = {});                            // d2 +1
  self._validate(self.toJSON(), function (err) {
    if (err) {                                          // d3 +2 (nesting = 1)
      callback && callback.call(null, err);             // d4 +1
      return;
    }
    self.sync(self.isNew() ? 'create' : 'update',       // d5 +2 (nesting = 1)
        options, function (err, response) {
      var facade = {
            options : options,
            response: response
          },
      parsed;
      if (err) {                                        // d6 +3 (nesting = 2)
        facade.error = err;
        facade.src   = 'save';
        self.fire(EVT_ERROR, facade);
      } else {                                          //    +1
        if (!self._saveEvent) {                         // d7 +4 (nesting = 3)
          self._saveEvent = self.publish(EVT_SAVE, {
            preventable: false
          });
        }
        if (response) {                                 // d8 +4 (nesting = 3)
          parsed = facade.parsed = self._parse(response);
          self.setAttrs(parsed, options);
        }
        self.changed = {};
        self.fire(EVT_SAVE, facade);
      }
      callback && callback.apply(null, arguments);      // d9 +1
    });
  });
  return self;
} };`, 'js', { cyclomatic: 10, cognitive: 20, nesting: 2, returns: 2 });
});

test('paper exceptions that are NOT applied: Python decorators and JavaScript wrapper functions', () => {
  // The paper scores a_decorator 1 by ignoring the wrapper; here the nested function always nests: 2.
  expect(`def a_decorator(a, b):
    def inner(func):
        if condition:          # d1  +1 structure, +1 nesting
            print(b)
        func()
    return inner
`, 'py', { cyclomatic: 2, cognitive: 2 });
  // The paper's own counter-example, where the exception does not apply either: 2 in both.
  expect(`def not_a_decorator(a, b):
    my_var = a*b
    def inner(func):
        if condition:          # d1  +1 structure, +1 nesting
            print(b)
        func()
    return inner
`, 'py', { cyclomatic: 2, cognitive: 2 });
});

// ---------------------------------------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------------------------------------

test('C#: nullable types, null-conditional access and null-coalescing are not conditional operators', () => {
  expect(`public int? Find(int? a, string? b = null, List<int?> xs = null) {
    int? r = a ?? 0;                      // d1 (??)
    var n = b?.Length ?? xs?[0];          // d2 (??); ?. and ?[ are not counted
    r ??= 1;                              // d3 (??=)
    return a.HasValue ? r : null;         // d4  +1
}`, 'cs', { cyclomatic: 5, cognitive: 1, nesting: 0, returns: 1 });
  // Every `?` here is a type marker or an access: no decision at all.
  expect('int?[] F(Dictionary<string, int?>? d, (int, int)? t, object o) { int? n = o as int?; var k = d?.Count; var z = t?.Item1; return null; }', 'cs', { cyclomatic: 1, cognitive: 0 });
  expect('T? First<T>(IList<T?> xs) where T : class { return xs.Count > 0 ? xs[0] : null; }', 'cs', { cyclomatic: 2, cognitive: 1 });
  expect('int? P => _a?[0] ?? (b ? 1 : 2);', 'cs', { cyclomatic: 3, cognitive: 1 }); // ?? and the conditional
  expect('object Mk(bool c) { return c ? new Dictionary<string, int>() : null; }', 'cs', { cyclomatic: 2, cognitive: 1 }); // the comma is between generic arguments
  expect('Func<int, int> Pick(bool up) { return up ? x => x + 1 : x => x - 1; }', 'cs', { cyclomatic: 2, cognitive: 1 });
  expect('string S(bool a) { return $"{(a ? 1 : 2)} of {a}"; }', 'cs', { cyclomatic: 2, cognitive: 1 }); // inside an interpolation hole
  expect('string S(int[] a) { return $"{a?[0]:N2} and {(a != null ? 1 : 2)}"; }', 'cs', { cyclomatic: 2, cognitive: 1 }); // `:N2` is a format, not the `:` of a conditional
  expect('int N(int[] a, int i) { return a?[i] ?? (i > 0 ? a?[0] ?? 1 : 2); }', 'cs', { cyclomatic: 4, cognitive: 1 }); // two ??, one conditional
});

test('C#: conditional operators as they are written in real code', () => {
  // Each line has exactly one conditional operator (d1, +1); the shapes come from messagepack-csharp.
  expect('bool[] A(int size) { return size == 0 ? [] : new bool[size]; }', 'cs', { cyclomatic: 2, cognitive: 1 }); // collection expression
  expect('string U => this.Owner is null ? this.Name : $"{this.Owner.Name}_{this.Name}";', 'cs', { cyclomatic: 2, cognitive: 1 }); // interpolated operand
  expect('string V(bool p) { string s = p ? $"{a}." : string.Empty; return s; }', 'cs', { cyclomatic: 2, cognitive: 1 });
  expect('static E<T> Create<T>(params T[] values) where T : IEquatable<T> => values is { Length: > 0 } ? new(values) : E<T>.Empty;', 'cs', { cyclomatic: 2, cognitive: 1 }); // after a pattern
  expect('int W(object v) { return v is string ? 1 : 2; }', 'cs', { cyclomatic: 2, cognitive: 1 }); // a type test, not `string?`
  expect('void X(bool required, int? from) { var y = required ? from : null; }', 'cs', { cyclomatic: 2, cognitive: 1 }); // contextual keyword as a name
});

test('C#: do-while is one decision and one loop', () => {
  expect('void F(int n) { do { n--; } while (n > 0); }', 'cs', { cyclomatic: 2, cognitive: 1, nesting: 1 });
  // do +1, the inner while +2; the closing `while (c)` belongs to the do.
  expect('void F() { do { while (a) b(); } while (c); }', 'cs', { cyclomatic: 3, cognitive: 3, nesting: 2 });
});

test('C#: switch with fall-through, pattern labels and a when guard', () => {
  expect(`string Kind(object o) {
    switch (o) {                          //     +1
        case 1:                           // d1
        case 2:                           // d2
            return "small";
        case int n when n > 100:          // d3, d4 (when)
            return "big";
        case string s:                    // d5
            return s;
        default:
            return "?";
    }
}`, 'cs', { cyclomatic: 6, cognitive: 1, nesting: 1, returns: 4 });
});

test('C#: switch expression counts its arms except the discard', () => {
  // arms `1 =>` d1 and `> 5 and < 9 =>` d2, `and` d3; `_ =>` is the default. Cognitive: switch +1, `and` +1.
  expect('static string Name(int x) => x switch { 1 => "one", > 5 and < 9 => "mid", _ => "other" };', 'cs', { cyclomatic: 4, cognitive: 2, nesting: 1 });
  // A guard on an arm is a further decision: `0 =>` d1, `1 when` d2 d3.
  expect('static int Sign(int x) => x switch { 0 => 0, 1 when y > 0 => 1, _ => -1 };', 'cs', { cyclomatic: 4, cognitive: 1 });
  // A discard with a guard decides once: `_` matches everything, only the guard branches. `0 =>` d1, `when` d2.
  expect('static int Sign(int x) => x switch { 0 => 0, _ when x > 0 => 1, _ => -1 };', 'cs', { cyclomatic: 3, cognitive: 1 });
});

test('C#: nested lambdas raise the nesting level, the outermost function does not', () => {
  expect(`void G(List<int> xs) {
    xs.ForEach(x => {                              // nesting level 1
        if (x > 0) {                               // d1  +2
            ys.Where(y => y > x ? true : false);   // d2  +4: lambda 1, if 2, lambda 3
        }
    });
}`, 'cs', { cyclomatic: 3, cognitive: 6, nesting: 1 });
  expect(`int Outer(int a) {
    int Local(int b) { if (b > 0) return 1; return 0; }   // d1  +2 (local function: nesting 1)
    return Local(a);
}`, 'cs', { cyclomatic: 2, cognitive: 2, nesting: 1, returns: 3 });
  // An object initializer is not a function: only the lambda nests. if = +2.
  expect('void M() { var o = new Foo(1) { Handler = y => { if (y) Z(); } }; }', 'cs', { cyclomatic: 2, cognitive: 2, nesting: 1 });
  // Accessors are the outermost functions of a property: conditional +1, if +1.
  expect('public int Count { get { return _n > 0 ? _n : 0; } set { if (value < 0) throw new E(); _n = value; } }', 'cs', { cyclomatic: 3, cognitive: 2, nesting: 1, returns: 2 });
});

test('C#: try / catch / finally with an exception filter', () => {
  expect(`void H() {
    try { A(); }
    catch (IOException e) when (e.Message != null && retry) { B(); }   // d1 catch, d2 when, d3 &&   +1 catch, +1 &&
    catch (Exception) { if (x) throw; }                                // d4 catch, d5 if            +1 catch, +2 if
    finally { C(); }
}`, 'cs', { cyclomatic: 6, cognitive: 5, nesting: 2, returns: 1 });
  expect('int T() { try { return 1; } finally { Done(); } }', 'cs', { cyclomatic: 1, cognitive: 0, nesting: 1, returns: 1 });
});

test('C#: goto, single-statement bodies, using and lock', () => {
  expect('void J(int n) { retry: if (n > 0) { n--; goto retry; } }', 'cs', { cyclomatic: 2, cognitive: 2, nesting: 1 }); // if +1, goto +1
  expect(`int K(int[] xs) {
    foreach (var x in xs)             // d1  +1
        if (x > 0) return 1;          // d2  +2
        else if (x < 0) return -1;    // d3  +1
        else continue;                //     +1
    return 0;
}`, 'cs', { cyclomatic: 4, cognitive: 5, nesting: 2, returns: 3 });
  expect('void L() { using (var s = Open()) { lock (gate) { if (s != null) s.Go(); } } }', 'cs', { cyclomatic: 2, cognitive: 1, nesting: 1 });
});

// ---------------------------------------------------------------------------------------------------------
// JavaScript and TypeScript
// ---------------------------------------------------------------------------------------------------------

test('TypeScript: optional members, optional chaining and nullish coalescing', () => {
  expect(`function pick(a?: number, b?: { c?: string[] }): string | undefined {
  const x = b?.c?.[0] ?? 'none';      // d1 (??)
  const y = a ? String(a) : x;        // d2  +1
  return y;
}`, 'ts', { cyclomatic: 3, cognitive: 1, nesting: 0 });
  expect('const f = (o?: { g?(): void; h?: number }, ...r: [string, number?]) => o?.g?.();', 'ts', { cyclomatic: 1, cognitive: 0 });
  expect('function d(x) { x ??= 1; x ||= 2; x &&= 3; return x; }', 'js', { cyclomatic: 4, cognitive: 0 }); // three short-circuit assignments
});

test('JavaScript: conditional operators nest in each other', () => {
  expect('const g = (a, b) => a ? b ? 1 : 2 : 3;', 'js', { cyclomatic: 3, cognitive: 3 }); // +1, then +2 inside it
  expect('const g = (a, b) => a ? 1 : b ? 2 : 3;', 'js', { cyclomatic: 3, cognitive: 3 });
  expect('const s = (n) => `${n > 1 ? "many" : "one"} item`;', 'js', { cyclomatic: 2, cognitive: 1 });
});

test('JavaScript: runs of logical operators follow reading order through grouping parentheses', () => {
  expect('const f = (a, b) => a && b || a === 0;', 'js', { cyclomatic: 3, cognitive: 2 });
  expect('function p(a, b, c, d) { return a || (b && c) || d; }', 'js', { cyclomatic: 4, cognitive: 3 }); // ||, &&, ||
  expect('function p(a, b, c, d) { return a && f(b || c) && d; }', 'js', { cyclomatic: 4, cognitive: 2 }); // the argument is its own expression
  expect('function p(a, b, c, d) { g(a && b, c && d); }', 'js', { cyclomatic: 3, cognitive: 2 }); // two arguments, two runs
});

test('JavaScript: a member called catch or finally is not a keyword', () => {
  // conditional d1, +2 because it sits in a nested arrow function; `.catch` and `.finally` are method names.
  expect('function load(u) { return fetch(u).then((r) => r.ok ? r.json() : null).catch(() => null).finally(done); }', 'js', { cyclomatic: 2, cognitive: 2, nesting: 0 });
});

test('JavaScript: contextual keywords used as names, keywords used as object keys', () => {
  expect('const p = (from, of) => ({ x: from ? from.x : 0, y: of ? of.y : 0 });', 'js', { cyclomatic: 3, cognitive: 2 });
  expect('const o = (id, c) => ({ for: id, if: c, default: 1, while: 2 });', 'js', { cyclomatic: 1, cognitive: 0, nesting: 0 });
});

test('JavaScript: try / catch / finally inside a loop', () => {
  expect(`async function run(tasks) {
  for (const t of tasks) {                              // d1  +1
    try { await t(); }
    catch { if (!t.optional) throw new Error('x'); }    // d2 catch +2, d3 if +3
    finally { done(t); }
  }
}`, 'js', { cyclomatic: 4, cognitive: 6, nesting: 3, returns: 1 }); // depth: for > try > if
});

test('JavaScript: switch with fall-through and a block in a case', () => {
  expect(`function kind(c) {
  switch (c) {                //     +1
    case 'a':                 // d1
    case 'b':                 // d2
      return 1;
    case 'c': {               // d3
      if (x) return 2;        // d4  +2
      break;
    }
    default:
      return 0;
  }
}`, 'js', { cyclomatic: 5, cognitive: 3, nesting: 2, returns: 3 });
});

test('JavaScript: labelled jump, do-while and statements without semicolons', () => {
  expect(`function sumOfPrimes(max) {
  let total = 0
  OUT: for (let i = 1; i <= max; ++i) {     // +1
    for (let j = 2; j < i; ++j) {           // +2
      if (i % j == 0) continue OUT          // +3, +1
    }
    total += i
  }
  return total
}`, 'js', { cyclomatic: 4, cognitive: 7, nesting: 3 });
  expect('function w(x) { do x++; while (x < 3); return x; }', 'js', { cyclomatic: 2, cognitive: 1, nesting: 1 });
  // The line break ends `return 1`, so the arrow function is not inside the if: +1, then +2 in the nested function.
  expect(`function f(a) {
  if (a) return 1
  const g = () => {
    if (a > 1) return 2
  }
  return g()
}`, 'js', { cyclomatic: 3, cognitive: 3, nesting: 1, returns: 3 });
});

test('TypeScript: the body after a return-type annotation is found', () => {
  expect(`export const mk = async <T,>(xs: T[]): Promise<{ ok: boolean }> => {
  for (const x of xs) { if (!x) return { ok: false }; }     // d1 +1, d2 +2
  return { ok: true };
};`, 'ts', { cyclomatic: 3, cognitive: 3, nesting: 2 });
  expect(`function outer(): number {
  function inner(v: number): number { if (v) { return 1; } return 0; }   // nested function: +2
  return inner(1);
}`, 'ts', { cyclomatic: 2, cognitive: 2, nesting: 1 });
});

// ---------------------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------------------

test('Python: if / elif / else with and / or', () => {
  expect(`def f(x, y):
    if x and y or x > 3:      # d1 if, d2 and, d3 or   +1, +1, +1
        return 1
    elif x:                   # d4                     +1
        return 2
    else:                     #                        +1
        return 3
`, 'py', { cyclomatic: 5, cognitive: 5, nesting: 1, returns: 3 });
});

test('Python: comprehensions decide but are shorthand; a conditional expression is a conditional operator', () => {
  expect(`def g(xs):
    ys = [x for x in xs if x > 0]      # d1 for, d2 if; no cognitive increment
    return ys[0] if ys else None       # d3  +1
`, 'py', { cyclomatic: 4, cognitive: 1, nesting: 0 });
});

test('Python: try / except / else / finally and the else of a loop', () => {
  expect(`def h(items):
    for it in items:                       # d1  +1
        try:
            use(it)
        except ValueError:                 # d2  +2
            continue
        except (KeyError, OSError) as e:   # d3  +2
            raise
        else:                              #     +1
            ok(it)
        finally:
            done()
    else:                                  #     +1
        return None
    return 1
`, 'py', { cyclomatic: 4, cognitive: 7, nesting: 2, returns: 3 });
});

test('Python: nested def and lambda raise the nesting level', () => {
  expect(`def outer(xs):
    def inner(x):
        if x:                              # d1  +2
            return 1
        return 0
    key = lambda v: v if v else 0          # d2  +2 (conditional expression inside a lambda)
    return sorted(map(inner, xs), key=key)
`, 'py', { cyclomatic: 3, cognitive: 4, nesting: 1 });
});

test('Python: match counts as a switch, case _ as its default, a guard as a decision', () => {
  expect(`def kind(p):
    match p:                       #     +1
        case 0:                    # d1
            return "zero"
        case [x, y] if x > y:      # d2, d3 (guard)
            return "desc"
        case _:
            return "other"
`, 'py', { cyclomatic: 4, cognitive: 1, nesting: 1, returns: 3 });
  // `match` and `case` used as plain names are not statements.
  expect('def n(case, match):\n    match = case.match(1)\n    return match\n', 'py', { cyclomatic: 1, cognitive: 0, nesting: 0 });
});

test('Python: one-line suites, while and with', () => {
  expect(`def w(n):
    while n > 0:               # d1  +1
        if n % 2: n -= 1       # d2  +2
        else: n //= 2          #     +1
    return n
`, 'py', { cyclomatic: 3, cognitive: 4, nesting: 2 });
  expect(`async def r(path):
    async with open(path) as f:
        async for line in f:       # d1  +1
            if not line: break     # d2  +2
`, 'py', { cyclomatic: 3, cognitive: 3, nesting: 2 }); // with does not nest
});

// ---------------------------------------------------------------------------------------------------------
// Size measures
// ---------------------------------------------------------------------------------------------------------

test('Halstead and the maintainability index on a function small enough to count by hand', () => {
  // int add ( int a , int b ) { return a + b ; }
  // operators: int int int ( , ) { return + ; }   N1 = 11, distinct n1 = 9
  // operands:  add a b a b                        N2 = 5,  distinct n2 = 3
  const r = m('int add(int a, int b) { return a + b; }', 'cs');
  assert.deepEqual(r.halstead, {
    n1: 9, n2: 3, N1: 11, N2: 5, vocabulary: 12, length: 16,
    volume: 57.36, // 16 * log2(12) = 16 * 3.58496
    difficulty: 7.5, // (9 / 2) * (5 / 3)
    effort: 430.2, // 7.5 * 57.3594
  });
  assert.equal(r.loc, 1);
  assert.equal(r.ntokens, 16);
  assert.equal(r.cyclomatic, 1);
  // 100 * (171 - 5.2 ln 57.3594 - 0.23 * 1 - 16.2 ln 1) / 171 = 100 * (171 - 21.0566 - 0.23) / 171
  assert.equal(r.maintainability, 87.55);
});

test('loc counts lines that hold a token; returns counts return, throw and raise', () => {
  const r = m('function f(a) {\n  // only a comment\n\n  if (!a) throw new Error("x"); /* trailing */\n  return a;\n}\n', 'js');
  assert.equal(r.loc, 4);
  assert.equal(r.returns, 2);
  assert.equal(m('def f(x):\n    if not x:\n        raise ValueError()\n    return x\n', 'py').returns, 2);
  assert.equal(m('def f(x):\n    """doc"""\n\n    # note\n    return x\n', 'py').loc, 3);
});

test('degenerate input is defined: no tokens, one token, unbalanced brackets', () => {
  const zero = { n1: 0, n2: 0, N1: 0, N2: 0, vocabulary: 0, length: 0, volume: 0, difficulty: 0, effort: 0 };
  // MI with V and LOC taken as 1 under the logarithm: 100 * (171 - 0.23) / 171 = 99.87
  assert.deepEqual(metrics([], 'js'), { loc: 0, ntokens: 0, cyclomatic: 1, cognitive: 0, nesting: 0, returns: 0, halstead: zero, maintainability: 99.87 });
  assert.deepEqual(metrics(null, 'js').halstead, zero);
  const one = m('x', 'js');
  assert.deepEqual(one.halstead, { n1: 0, n2: 1, N1: 0, N2: 1, vocabulary: 1, length: 1, volume: 0, difficulty: 0, effort: 0 });
  assert.equal(m(';', 'js').halstead.difficulty, 0); // no operand: the quotient N2 / n2 is not taken
  for (const src of ['if (a { b', '} else { ) ? : ]', 'a ? b', 'case default: => =>', 'do while (', 'x => { if (']) {
    for (const lang of ['cs', 'js', 'ts', 'py', 'java', 'go', 'rs', 'kt', 'swift', 'php', undefined]) {
      const r = m(src, lang);
      assert.ok(r.cyclomatic >= 1 && r.cognitive >= 0 && r.nesting >= 0 && Number.isFinite(r.maintainability), `${lang}: ${src}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// Slices, deltas and ratings
// ---------------------------------------------------------------------------------------------------------

test('a declaration slice from symbols.js, its body alone and a whole type', () => {
  const file = parseFile('class A {\n  int F(bool a) { if (a) return 1; return 0; }\n  int G(List<bool> xs) { xs.ForEach(x => { if (x) Y(); }); return 0; }\n}\n', 'A.cs');
  const f = file.symbols.find((s) => s.name === 'F'), g = file.symbols.find((s) => s.name === 'G'), a = file.symbols.find((s) => s.name === 'A');
  const decl = (s) => metrics(file.tokens.slice(s.a, s.b), file.lang), body = (s) => metrics(file.tokens.slice(s.bodyA, s.bodyB), file.lang);
  assert.deepEqual([decl(f).cyclomatic, decl(f).cognitive], [2, 1]);
  assert.deepEqual([decl(g).cyclomatic, decl(g).cognitive], [2, 2]); // the if is inside a lambda: +2
  // A body alone is read as being inside its function, so the lambda still nests.
  assert.deepEqual([body(g).cyclomatic, body(g).cognitive], [2, 2]);
  // A type is the sum of its members: decisions add up (1 + 1, plus one) and each member starts at level 0.
  assert.deepEqual([decl(a).cyclomatic, decl(a).cognitive], [3, 3]);
});

test('line-break tokens do not change any number', () => {
  const src = 'function f(a, b) {\n  if (a && b) {\n    return a ? 1 : 2\n  }\n  return 0\n}\n';
  assert.deepEqual(metrics(tokenize(src, 'js', { nl: true }), 'js'), metrics(tokenize(src, 'js'), 'js'));
});

test('compare gives after minus before, and treats a missing side as nothing', () => {
  const before = m('int f(int a) { return a; }', 'cs');
  const after = m('int f(int a) {\n  if (a > 0 && a < 9) return 1;\n  return a;\n}', 'cs');
  const d = compare(before, after);
  assert.equal(d.added, false);
  assert.equal(d.removed, false);
  assert.deepEqual([d.cyclomatic, d.cognitive, d.nesting, d.returns, d.loc], [2, 2, 1, 1, 3]);
  assert.equal(d.ntokens, after.ntokens - before.ntokens);
  assert.equal(d.halstead.N1, after.halstead.N1 - before.halstead.N1);
  assert.ok(d.halstead.volume > 0 && d.maintainability < 0);
  assert.deepEqual(compare(after, after), { added: false, removed: false, loc: 0, ntokens: 0, cyclomatic: 0, cognitive: 0, nesting: 0, returns: 0, halstead: { n1: 0, n2: 0, N1: 0, N2: 0, vocabulary: 0, length: 0, volume: 0, difficulty: 0, effort: 0 }, maintainability: 0 });
  const fresh = compare(null, after);
  assert.equal(fresh.added, true);
  assert.equal(fresh.cyclomatic, after.cyclomatic);
  assert.equal(fresh.halstead.volume, after.halstead.volume);
  assert.equal(fresh.maintainability, null); // there is no index of nothing to subtract from
  const gone = compare(before, null);
  assert.equal(gone.removed, true);
  assert.equal(gone.loc, -before.loc);
});

test('rate places each number against its threshold: above warn is warn, above bad is bad', () => {
  assert.deepEqual(THRESHOLDS, { cyclomatic: { warn: 10, bad: 20 }, cognitive: { warn: 15, bad: 30 }, nesting: { warn: 4, bad: 6 }, loc: { warn: 60, bad: 150 }, params: { warn: 5, bad: 8 } });
  const r = rate({ cyclomatic: 10, cognitive: 16, nesting: 7, loc: 151, returns: 3 }, 6);
  assert.deepEqual(r.map((x) => [x.id, x.value, x.warn, x.bad, x.tone]), [
    ['cyclomatic', 10, 10, 20, 'ok'], // McCabe's limit is 10 inclusive
    ['cognitive', 16, 15, 30, 'warn'],
    ['nesting', 7, 4, 6, 'bad'],
    ['loc', 151, 60, 150, 'bad'],
    ['params', 6, 5, 8, 'warn'],
  ]);
  assert.ok(r.every((x) => typeof x.label === 'string' && x.label.length > 0));
  assert.deepEqual(rate(m('int f() { return 1; }', 'cs')).map((x) => x.tone), ['ok', 'ok', 'ok', 'ok', 'ok']); // params omitted: 0
  assert.equal(rate({ cyclomatic: 21, cognitive: 31, nesting: 5, loc: 61 }, 9).map((x) => x.tone).join(), 'bad,bad,warn,warn,bad');
});

test('the result is deterministic', () => {
  const src = 'int F(int a) { for (var i = 0; i < a; i++) { if (i % 2 == 0 || a > 3) a--; } return a > 0 ? a : 0; }';
  assert.deepEqual(m(src, 'cs'), m(src, 'cs'));
  // 48 tokens; decisions for, if, ||, ?: ; cognitive for +1, if +2, || +1, ?: +1; depth for > if.
  const { halstead, maintainability, ...rest } = m(src, 'cs');
  assert.deepEqual(rest, { loc: 1, ntokens: 48, cyclomatic: 5, cognitive: 5, nesting: 2, returns: 1 });
  assert.equal(halstead.length, 48);
  assert.ok(maintainability > 0 && maintainability < 100);
});

// ---------------------------------------------------------------------------------------------------------
// Counterexamples found by the adversarial review. Each one was a miscount; the expected values are counted
// by hand (d = decision, +n = cognitive increment).
// ---------------------------------------------------------------------------------------------------------

test('review, C#: an attribute target is not a return; yield return is not an exit, yield break is', () => {
  assert.equal(m('[return: NotNullIfNotNull("x")] string? F(string? x) { return x; }', 'cs').returns, 1);
  assert.equal(m('[method: Foo] [return: Bar] [field: Baz] int F([param: Qux] int a) { return a; }', 'cs').returns, 1);
  // foreach d1, if d2; exits: `yield break` and `throw`
  const it = m('IEnumerable<int> F() { foreach (var x in xs) { if (x > 0) yield return x; else yield break; } throw new E(); }', 'cs');
  assert.deepEqual([it.cyclomatic, it.returns], [3, 2]);
});

test('review, C#: when, and, or are contextual keywords; as names they decide nothing', () => {
  expect('void F(DateTime when) { Schedule(when); var t = when.Ticks; x = when; }', 'cs', { cyclomatic: 1, cognitive: 0 });
  expect('void F(Expr and, Expr or) { var x = Combine(and, or); or = and; }', 'cs', { cyclomatic: 1, cognitive: 0 });
  // only the conditional operator: d1, +1
  expect('DateTime F(DateTime when, int or, int and) { var x = when > DateTime.Now ? when : DateTime.Now; return x.AddDays(or + and); }', 'cs', { cyclomatic: 2, cognitive: 1 });
  // the real guards still count: case d1 when d2, catch d3 when d4; switch +1, catch +1
  expect('void F(object o) { switch (o) { case int n when n > 0: break; } try { G(); } catch (E e) when (e.X) { } }', 'cs', { cyclomatic: 5, cognitive: 2 });
  expect('void F() { try { G(); } catch when (Flag) { } }', 'cs', { cyclomatic: 3, cognitive: 1 });
});

test('review, C#: the combinators of a pattern are runs of their own and do not break a run of && or ||', () => {
  // && d1, or d2, && d3. One run of && (+1) around the pattern, one run of or (+1).
  expect('bool F(object o, bool a, bool c) => a && o is int or long && c;', 'cs', { cyclomatic: 4, cognitive: 2 });
  // or d1, || d2, and d3, or d4: or +1, || +1, and +1, or +1
  expect('bool F(object o, object p) => o is int or long || p is > 5 and < 9 or 0;', 'cs', { cyclomatic: 5, cognitive: 4 });
});

test('review, C#: conditional operators the classifier used to miss or to misplace', () => {
  expect('int F(object x) { return x is List<int> ? 1 : 2; }', 'cs', { cyclomatic: 2, cognitive: 1 });
  expect('int F(object o) => o is Dictionary<string, List<int>> ? 1 : o is System.Collections.Generic.List<int?> ? 2 : 3;', 'cs', { cyclomatic: 3, cognitive: 3 });
  expect('void F() { List<int>? a = null; Dictionary<string, List<int>>? b = null; var c = x as List<int>; }', 'cs', { cyclomatic: 1, cognitive: 0 });
  // a postfix `!` ends an operand
  expect('int F(Foo x) { return x.Ok! ? 1 : 2; }', 'cs', { cyclomatic: 2, cognitive: 1 });
  expect('function f(a: any) { return a! ? 1 : 2; }', 'ts', { cyclomatic: 2, cognitive: 1 });
  // `p ? [`: an index when no `:` is left for it, a conditional over a collection expression otherwise.
  // ? d1, && d2 d3: the conditional +1 and ONE run of && (+1); the `?` of `a?[i]` must not split the run.
  expect('bool F(bool c) => c ? x && a?[i] && y : z;', 'cs', { cyclomatic: 4, cognitive: 2 });
  expect('int F(bool c1, bool c2) => c1 ? c2 ? a?[i] : b : d;', 'cs', { cyclomatic: 3, cognitive: 3 }); // +1, +2
  expect('int F(bool c) => c ? a?[0] ?? 1 : b?[1] ?? 2;', 'cs', { cyclomatic: 4, cognitive: 1 });
  expect('int[] F(int n, int[] xs) => n == 0 ? [] : n == 1 ? [1] : xs;', 'cs', { cyclomatic: 3, cognitive: 3 });
  // the `:` of a case label is never the `:` of a conditional: case d1, when d2; switch +1
  expect('int F(object o) { switch (o) { case int[] a when a?[0] > 1: return 1; default: return 0; } }', 'cs', { cyclomatic: 3, cognitive: 1 });
  // a conditional inside a guard is one: case d1, when d2, ? d3; switch +1, conditional +2 (inside the switch)
  expect('int F(object o) { switch (o) { case Foo f when (f.A ? x : y): return 1; default: return 0; } }', 'cs', { cyclomatic: 4, cognitive: 3 });
});

test('review: a nullable type, an index or a parenthesized operand inside a run does not split it', () => {
  expect('bool F() { return a && b?[0] && c; }', 'cs', { cyclomatic: 3, cognitive: 1 });
  expect('bool F() { return a && x is List<int?> && b; }', 'cs', { cyclomatic: 3, cognitive: 1 });
  // && d1 d2, ? d3: one run (+1) and the conditional (+1). SonarSource flattens `x && (…) && y` the same way.
  expect('bool F() { return x && (c ? a : b) && y; }', 'cs', { cyclomatic: 4, cognitive: 2 });
  expect('function f() { return x && (c ? a : b) && y; }', 'js', { cyclomatic: 4, cognitive: 2 });
  expect('function f() { return x && (a ?? b) && y; }', 'js', { cyclomatic: 4, cognitive: 1 });
  // a group before the arrow of an arm: arm d1, when d2, && d3 d4; switch +1, one run +1
  expect('int F(int k) => k switch { 1 when a && (b && c) => 1, _ => 0 };', 'cs', { cyclomatic: 5, cognitive: 2 });
  // without semicolons a line break ends the statement and the run: two runs
  expect('function f(a, b) {\n  a && a()\n  b && b()\n}', 'js', { cyclomatic: 3, cognitive: 2 });
  // the group ends its line: the next line is another statement, the run is still one
  expect('function f(a, b, c, d) {\n  const x = (a && b) && (c && d)\n  return x\n}', 'js', { cyclomatic: 4, cognitive: 1 });
});

test('review, C#: a type with a primary constructor is not a function around its members', () => {
  // the conditional of the expression-bodied member is at level 0: +1
  expect('public record R(int A, string? B = null) { public int C => A > 0 ? A : -A; }', 'cs', { cyclomatic: 2, cognitive: 1 });
  // C: +1. M: the lambda is nested in M, its conditional +2.
  expect('public sealed class Foo<T>(int a, Bar? b = null) : Base<T>(a), IFoo where T : class { public int C => a > 0 ? a : -a; void M() { xs.Select(x => x ? 1 : 2); } }', 'cs', { cyclomatic: 3, cognitive: 3 });
  // a generic method with the same constraint is still a function: the lambda nests, +2
  expect('void F<T>(T x) where T : class { xs.Select(y => y ? 1 : 2); }', 'cs', { cyclomatic: 2, cognitive: 2 });
  expect('class A extends mixin(B) { m() { return xs.map(x => x ? 1 : 2); } }', 'js', { cyclomatic: 2, cognitive: 2 });
});

test('review, JavaScript: methods named with a keyword are declarations, a catch clause follows a try block', () => {
  const p = m('class P { then(f) { return this; } catch(f) { return this.then(null, f); } finally(f) { return this; } }', 'js');
  assert.deepEqual([p.cyclomatic, p.cognitive, p.returns], [1, 0, 3]);
  const o = m('const o = { catch(f) { return 1; }, delete(k) { return 2; }, return() { return 3; } };', 'js');
  assert.deepEqual([o.cyclomatic, o.cognitive, o.returns], [1, 0, 3]);
  expect('class A { static of(x) { return new A(x); } get if() { return 1; } set for(v) { this.v = v; } }', 'js', { cyclomatic: 1, cognitive: 0, nesting: 0 });
  expect('class P<T> { then(f: F): P<T> { return this; } catch(f: F): P<T> { return this.then(f); } }', 'ts', { cyclomatic: 1, cognitive: 0 });
  // the clause itself: catch d1, +1
  expect('function f() { try { a(); } catch (e) { b(); } finally { c(); } }', 'js', { cyclomatic: 2, cognitive: 1, nesting: 1 });
  expect('function f() { try { a(); } catch { b(); } }', 'js', { cyclomatic: 2, cognitive: 1, nesting: 1 });
});

test('review, TypeScript: a conditional type selects a type, not a path', () => {
  expect('type U<T> = T extends Promise<infer R> ? R : T extends (infer E)[] ? E : never;', 'ts', { cyclomatic: 1, cognitive: 0 });
  // only the conditional operator in the body: d1, +1
  expect('function f<T>(x: T): T extends string ? number : boolean { return (x ? 1 : true) as any; }', 'ts', { cyclomatic: 2, cognitive: 1 });
});

test('review, Python: case as a variable, a statement that ends with a dict, nested conditional expressions', () => {
  expect('def f(case):\n    case.run()\n    case[0] = 1\n    case += 1\n    return case\n', 'py', { cyclomatic: 1, cognitive: 0 });
  // The lexer gives no `;` after `d = {"a": 1}`; the loop after it must still be a statement.
  // for d1 +1, if d2 +2, while d3 +1
  const src = 'def f():\n    d = {"a": 1}\n    for k in d:\n        if k:\n            return k\n    s = {1, 2}\n    while s:\n        s.pop()\n';
  expect(src, 'py', { cyclomatic: 4, cognitive: 4, nesting: 2 });
  assert.equal(m(src, 'py').ntokens, tokenize(src, 'py').length); // the repair is internal: the count is of the tokens given
  expect('def f(x):\n    if x:\n        d = {"a": 1}\n    else:\n        d = {}\n    return d\n', 'py', { cyclomatic: 2, cognitive: 2, nesting: 1 });
  // The first operand is written before its `if`: the inner conditional is nested in the outer one, +1 and +2.
  expect('def f(a, b, c, d, e):\n    return (a if b else c) if d else e\n', 'py', { cyclomatic: 3, cognitive: 3 });
  // …also when the operand holds an `in` test: if d1 d2, or d3; +1, +2, one run of or +1
  expect('def f(a, b, c, d, e, x, y):\n    return (a if b else c) or x in y if d else e\n', 'py', { cyclomatic: 4, cognitive: 4 });
  // a group right after `if`: if d1, and d2 d3; if +1, ONE run +1
  expect('def f(a, b, c):\n    if (a and b) and c:\n        return 1\n', 'py', { cyclomatic: 4, cognitive: 2 });
});

test('review: a chain of two thousand conditional operators is counted, in linear time', () => {
  // cyclomatic 1 + 2000; cognitive: the i-th is nested in i - 1 others, so 1 + 2 + … + 2000
  expect('var r = ' + 'a ? b : '.repeat(2000) + 'c;', 'js', { cyclomatic: 2001, cognitive: 2001000 });
});

// ---------------------------------------------------------------------------------------------------------
// Real functions, counted by hand from the source of the repositories the engine is run on.
// ---------------------------------------------------------------------------------------------------------

test('real C#: MessagePackWriter.GetEncodedLength (nested switch expressions)', () => {
  // outer arm `>= 0` d1 (the discard is free), inner arms 4 + 4: d2..d9. switch +1, two nested switches +2 each.
  expect(`public static int GetEncodedLength(long value)
        {
            return value switch
            {
                >= 0 => value switch
                {
                    <= MessagePackRange.MaxFixPositiveInt => 1,
                    <= byte.MaxValue => 2,
                    <= ushort.MaxValue => 3,
                    <= uint.MaxValue => 5,
                    _ => 9,
                },
                _ => value switch
                {
                    >= MessagePackRange.MinFixNegativeInt => 1,
                    >= sbyte.MinValue => 2,
                    >= short.MinValue => 3,
                    >= int.MinValue => 5,
                    _ => 9,
                },
            };
        }`, 'cs', { cyclomatic: 10, cognitive: 5, nesting: 2, returns: 1 });
});

test('real C#: FormatterDescriptor.TryCreate (nullable types, ?., ??, lambdas, chained conditionals in an initializer)', () => {
  expect(`public static bool TryCreate(INamedTypeSymbol type, [NotNullWhen(true)] out FormatterDescriptor? formatter)
    {
        if (type.IsAbstract)                                                                  // d1  +1
        {
            formatter = null;
            return false;
        }

        var formattedTypes =
            AnalyzerUtilities.SearchTypeForFormatterImplementations(type)
            .Select(i => new FormattableType(i, type.ContainingAssembly))
            .ToImmutableHashSet();
        if (formattedTypes.IsEmpty)                                                           // d2  +1
        {
            formatter = null;
            return false;
        }

        IFieldSymbol? instanceField = type.GetMembers("Instance").OfType<IFieldSymbol>()
            .FirstOrDefault(m => m.IsStatic && m.DeclaredAccessibility == Accessibility.Public && m.IsReadOnly);   // d3 d4  +1
        IMethodSymbol? ctor = type.InstanceConstructors.FirstOrDefault(ctor => ctor.Parameters.Length == 0 && ctor.DeclaredAccessibility >= Accessibility.Internal);   // d5  +1
        string? instanceProvidingMember = instanceField?.Name ?? ctor?.Name ?? null;          // d6 d7
        QualifiedTypeName instanceTypeName = QualifiedTypeName.Create(instanceField?.Type ?? type);   // d8

        formatter = new FormatterDescriptor(new QualifiedNamedTypeName(type), instanceProvidingMember, instanceTypeName, formattedTypes)
        {
            InaccessibleDescriptor =
                CodeAnalysisUtilities.FindInaccessibleTypes(type).Any() ? MsgPack00xMessagePackAnalyzer.InaccessibleFormatterType :   // d9  +1
                instanceProvidingMember is null ? MsgPack00xMessagePackAnalyzer.InaccessibleFormatterInstance :                    // d10 +2
                null,
            ExcludeFromSourceGeneratedResolver =
                type.GetAttributes().Any(a => a.AttributeClass?.Name == Constants.ExcludeFormatterFromSourceGeneratedResolverAttributeName && a.AttributeClass?.ContainingNamespace.Name == Constants.AttributeNamespace),   // d11 +1
        };

        return true;
    }`, 'cs', { cyclomatic: 12, cognitive: 8, nesting: 1, returns: 3 });
});

test('real C#: ObjectFallbackEqualityComparer.GetHashCode (pattern tests, try inside if, exception filter)', () => {
  expect(`public int GetHashCode(object value)
            {
                if (value is null)                                                            // d1  +1
                {
                    return 0;
                }

                Type valueType = value.GetType();
                if (valueType == typeof(object))                                              // d2  +1
                {
                    return value.GetHashCode();
                }

                if (!equalityComparerCache.TryGetValue(valueType, out IEqualityComparer? equalityComparer))   // d3  +1
                {
                    try
                    {
                        equalityComparer = (IEqualityComparer)GetHashCollisionResistantEqualityComparerOpenGenericMethod.Value.MakeGenericMethod(valueType).Invoke(this.security, Array.Empty<object>())!;
                    }
                    catch (TargetInvocationException ex) when (ex.InnerException is not null)  // d4 d5  +2
                    {
                        ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
                        throw null!;
                    }

                    equalityComparerCache.TryAdd(valueType, equalityComparer);
                }

                return equalityComparer.GetHashCode(value);
            }`, 'cs', { cyclomatic: 6, cognitive: 5, nesting: 2, returns: 4 });
});

test('real JavaScript: addItem of the demo repository and userMessages of this one', () => {
  expect(`export function addItem(cart, { sku, name, price, qty = 1 }) {
  if (typeof sku !== 'string' || sku.trim() === '') {                 // d1 d2  +1 +1
    throw new TypeError('el sku es obligatorio');
  }
  assertAmount(price, 'el precio');
  assertQuantity(qty);

  const existing = cart.items.find((item) => item.sku === sku);
  const items = existing
    ? cart.items.map((item) =>                                        // d3  +1
        item.sku === sku ? { ...item, qty: item.qty + qty } : item,   // d4  +3 (in a conditional, in a lambda)
      )
    : [...cart.items, { sku, name: name ?? sku, price, qty }];        // d5

  return { ...cart, items };
}`, 'js', { cyclomatic: 6, cognitive: 6, nesting: 1, returns: 2 });
  expect(`export function userMessages(transcript) {
  try {
    const document = JSON.parse(transcript);
    if (Array.isArray(document.messages)) return document.messages.flatMap((m, i) => userMessages(JSON.stringify(m)).map(p => ({ ...p, pointer: \`/messages/\${i}\`, messageId: m.info?.id })));   // d1  +1
  } catch { /* JSONL */ }                                              // d2  +1
  return transcript.split(/\\r?\\n/).flatMap((line, index) => {
    try {
      const e = JSON.parse(line); const m = e.message || e;           // d3  +1
      if ((m.role || e.info?.role || e.type) !== 'user') return [];   // d4 d5 d6  +2 +1
      const content = m.content || e.parts || m.parts || m.text;      // d7 d8 d9  +1
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\\n') : '';   // d10 d11  +2 +3
      return text ? [{ text: redact(text), line: index + 1, role: 'user' }] : [];   // d12  +2
    } catch { return []; }                                            // d13  +2
  });
}`, 'js', { cyclomatic: 14, cognitive: 16, nesting: 2, returns: 5 });
});

test('review: the condition of a conditional operator is inside it (sonar-java nests the whole expression)', () => {
  // outer +1; the inner one stands in the condition of the outer: +2
  expect('int F() => (a ? b : c) ? d : e;', 'cs', { cyclomatic: 3, cognitive: 3 });
  // conditional +1; the `if` is in a lambda (level 1) inside the conditional (level 2): +3
  expect('function f() { return xs.some((x) => { if (x) { return 1; } return 0; }) ? d : e; }', 'js', { cyclomatic: 3, cognitive: 4, nesting: 1 });
  // outer +1, the conditional in the argument +2, one run of && +1
  expect('function f() { return g(a ? 1 : 2) && h ? d : e; }', 'js', { cyclomatic: 4, cognitive: 4 });
  // outer +1, the switch expression in its condition +2; arm d1, ? d2
  expect('int F() => (k switch { 1 => 2, _ => 3 }) > 2 ? d : e;', 'cs', { cyclomatic: 3, cognitive: 3, nesting: 1 });
  // a ? … +1; `(x ? y : z) ? c : d` is its second operand: +2; `x ? y : z` is the condition of that one: +3
  expect('function f() { return a ? b : (x ? y : z) ? c : d; }', 'js', { cyclomatic: 4, cognitive: 6 });
});

test('review, Python: a discard with a guard decides once', () => {
  // case 1 d1; `case _ if x > 0` only its guard d2; `case _` is the default. match +1.
  expect('def f(k, x):\n    match k:\n        case 1:\n            return 1\n        case _ if x > 0:\n            return 2\n        case _:\n            return 3\n', 'py', { cyclomatic: 3, cognitive: 1, nesting: 1 });
});
