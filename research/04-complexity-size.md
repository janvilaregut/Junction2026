# 04 — Complexity and size metrics (KISS, small functions, few parameters, shallow nesting)

Scope: formal definitions, exact counting rules for C# (implemented with tree-sitter), thresholds, how each value can be placed on lines for the heatmap, and the empirical evidence (effect sizes), including the size-confounding problem.

Verification legend: every reference in Section 13 says how it was checked. Anything not checked against a primary or authoritative source is marked **[unverified]**. Numbers attributed to a paper were read in that paper's text, unless the text says "via [n]" (a secondary source).

Date of research: 2026-11-14. Web search budget ran out late in the session. Some primary sources (Alves 2010 thresholds, Ferreira 2012, Lanza & Marinescu tables, Herraiz & Hassan 2010) could therefore not be opened and are marked accordingly.

---

## 0. Executive summary (what to implement)

| Practice | Metric (per method-like unit) | Default gate | Primary justification | Evidence quality |
|---|---|---|---|---|
| KISS / control-flow simplicity | Cognitive Complexity (CogC), Campbell spec v1.7 | > 15 | SonarC# S3776 default 15 [6]; PMD 15 [15] | Moderate. Meta-analysis r = 0.54 with comprehension time, r = −0.29 with ratings [17]. Not better than McCabe or LOC once compared head-to-head [18][19]. Threshold 15 itself is **not** validated [17]. |
| Testability / branching | McCabe cyclomatic complexity v(G) (decision count + 1) | > 10 | McCabe/NIST [2]; SonarC# S1541 = 10 [6]; PMD 10 [15] (MS CA1502 = 25 [12]; lizard 15 [14]) | Strongly size-correlated (Java methods: Spearman ρ = 0.80 with SLOC [26]). |
| Shallow nesting | Max nesting depth of `if/switch/for/foreach/while/do/try` | > 3 | SonarC# S134 = 3 [6]; PMD `AvoidDeeplyNestedIfStmts` = 3 [15] | Weak direct evidence. Nesting is a large part of CogC. Nested block depth correlated with student code-tracing performance (via [17]). |
| Small functions | SLOC (distinct non-comment, non-blank lines of the unit) | > 80 lines (S138 [6]); NCSS > 60 (PMD [15]) | Tool defaults | Size is the most robust predictor of effort and defects. Other metrics' validity is largely explained by size [29][30][35]. |
| Few parameters | Number of formal parameters | > 7 | SonarC# S107 = 7 [6] (PMD 10 [15]) | Weak: τ ≈ −0.13 with actual understandability [21]. |
| (informational only) | Halstead volume, Maintainability Index (VS 0–100) | MI < 10 red, 10–19 yellow [10][13] | Microsoft | Poor. Calibrated on 1990s HP C/Pascal data [32]. Ranked 4 equivalent systems opposite to real maintenance effort (ρ = −0.6, n = 4) [35]. Do **not** gate on MI. |

**The non-negotiable methodological caveat:** complexity metrics correlate strongly with size. Any claim that a complexity metric "adds" information must be tested *controlling for SLOC*, with a partial correlation or a size-adjusted regression [29][30]. On our target repository (MessagePack-CSharp `src/`, 2,060 units, Section 9.3), Spearman ρ with SLOC is 0.79 for CC, 0.81 for CogC and 0.83 for nesting, and ρ(CC, CogC) = 0.94.

---

## 1. Unit of measurement in C# (tree-sitter-c-sharp 0.23.5)

Node types below were enumerated from the installed grammar (`tree_sitter_c_sharp` 0.23.5, 215 named node kinds). Parse shapes were confirmed by parsing test files [16].

**Units (rows in the per-method report):**

- `method_declaration`, `constructor_declaration`, `destructor_declaration`, `operator_declaration`, `conversion_operator_declaration`, `accessor_declaration` (get/set/init/add/remove)
- `property_declaration` / `indexer_declaration` that have an `arrow_expression_clause` (expression-bodied). SonarC# measures expression-bodied properties with a lower threshold (CogC property threshold = 3 [6]).
- `local_function_statement` **only if it has the `static` modifier**. Non-static local functions, `lambda_expression` and `anonymous_method_expression` belong to the enclosing unit. This matches sonar-dotnet: lambdas and non-static local functions increase nesting, while static local functions are measured separately [4][5]. It also matches Microsoft's rule that anonymous-method metrics are "associated with the member that declares the method" [9].
- Top-level statements (`global_statement`) form one pseudo-unit per file (SonarC# does the same [6]). MessagePack-CSharp library code has none.

**Grammar facts that matter for counting** (verified by parse dumps):

- There is **no `else_clause` node**. `if_statement` has fields `condition`, `consequence` and `alternative`, and `else` is an anonymous token. An **else-if** is an `if_statement` that is the `alternative` field of a parent `if_statement`.
- There are **no `case_switch_label` nodes**. Each `switch_section` holds anonymous `case` or `default` tokens followed by a pattern (`constant_pattern`, `declaration_pattern`, …), an optional `when_clause`, and then statements. `case 1: case 2: return 3;` parses as **two** `switch_section`s, the first with no statements.
- `binary_expression` has an `operator` field whose token type is `&&`, `||`, `??`, etc. `??=` is an `assignment_expression` with `operator` `??=`.
- `?.` is `conditional_access_expression` (anonymous `?` + `member_binding_expression`). Nullable types are `nullable_type`, a separate node, so tree-sitter avoids lizard's `int?` false positive (Section 2.3).
- Pattern combinators are `and_pattern`, `or_pattern` (with an `operator` field) and `negated_pattern`. Switch expressions are `switch_expression` > `switch_expression_arm`, with the default arm `_` parsed as a `discard`.
- Exceptions: `try_statement`, `catch_clause` (optional `catch_declaration`, optional `catch_filter_clause` = `when (...)`), and `finally_clause`.
- Loops: `for_statement`, `foreach_statement` (also covers deconstructing `foreach (var (a, b) in …)`), `while_statement`, `do_statement`. Jumps: `goto_statement`, `break_statement`, `continue_statement`, `return_statement`, `yield_statement`, `throw_statement`, `throw_expression`.

**Pitfall: preprocessor directives.** On MessagePack-CSharp `src/` (190 files), tree-sitter produced ERROR nodes in **27 files**. Most errors sit next to `#if MESSAGEPACK_INTERNAL internal #else public #endif` modifier switches.

A line-preserving pre-pass helps. It evaluates `#if/#elif/#else/#endif` against a chosen symbol set, blanks inactive lines and directive lines, and so keeps line numbers intact for the heatmap. With it, ERROR files dropped to **16**, and only **40 of 2,060 units** contained an ERROR node. The remaining errors come from grammar gaps, such as assignment to a ref-returning call (`Unsafe.As<byte,T>(ref span[0]) = value;`), `ref partial struct`, and pointer casts.

**Recommendation:** run the pre-pass, compute metrics anyway, and flag units with `node.has_error` as "low-confidence" rather than silently dropping them.

---

## 2. McCabe cyclomatic complexity, v(G)

### 2.1 Definition

McCabe (1976) [1] defines v(G) = e − n + 2p over the control-flow graph (e edges, n nodes, p connected components). For one routine, the NIST report by Watson & McCabe [2] gives v(G) = e − n + 2, and §4.1 there gives the source-level shortcut:

- "If all decisions are binary and there are p binary decision predicates, v(G) = p + 1." [2]
- A multiway decision adds "one less than the number of edges out of the decision node". [2]
- Boolean operators "add either one or nothing … depending on whether they have short-circuit evaluation semantics". C `&&` adds one, while a full-evaluation `and` adds nothing. [2]
- Switch: the contribution is "exactly the number of case-labeled statements". Several labels on the same statement form **one** outcome edge. Counting each label separately is a consistent alternative "but that is not the typical usage". [2]

Microsoft documents its variant as "the number of edges − the number of nodes + 1" (CA1502) [12]. In practice it computes 1 + decisions (Section 2.3).

### 2.2 Thresholds

- **10**: "The original limit of 10 as proposed by McCabe has significant supporting evidence, but limits as high as 15 have been used successfully as well. Limits over 10 should be reserved for projects that have several operational advantages…" (NIST 500-235 §2.5 [2], quoted verbatim by Microsoft [11]). NIST also recommends exempting a module that consists of a single multiway decision with trivial branches [2].
- Tool defaults: SonarC# S1541 = 10 [6]; PMD `methodReportLevel` = 10, with bands 1–4 low, 5–7 moderate, 8–10 high, 11+ very high [15]; lizard warns at CCN > 15 (observed default output of lizard 1.26.0) [14]; Microsoft CA1502 = 25 [12].

### 2.3 What each tool counts in C# (verified)

| Construct | NIST/McCabe [2] | Microsoft Roslyn metrics [7] | SonarC# metric [5] | lizard 1.26.0 (observed) [14] |
|---|---|---|---|---|
| base value | 1 | 1 per body (Block/MethodBody/ConstructorBody); 0 is forced to 1 | +1 per method/ctor/accessor/operator | 1 |
| `if` (incl. else-if) | +1 | +1 (`Conditional`) | +1 | +1 |
| `else` | 0 | 0 | 0 | 0 |
| `?:` ternary | +1 | +1 (`Conditional`) | +1 | +1 (`?` token) |
| `for` / `while` / `do` | +1 | +1 (`Loop`) | +1 | +1 (`for`, `while`; `do…while` via its `while`) |
| `foreach` | +1 | +1 (`Loop`) | +1 | **0** (foreach-only method observed CCN 1) |
| `case` | +1 per case-labeled statement | +1 per `CaseClause` (each label; `default` probably also, since IOperation's default clause is a CaseClause **[inference, not tested]**) | +1 per `case` label | +1 per `case` |
| switch expression arm | n/a (1976) | 0 | +1 per arm (incl. `_`) | 0 |
| `&&` / `\|\|` | +1 each (short-circuit) | +1 each; also non-short-circuit `&`/`\|` on bool | +1 each | +1 each |
| `??` | (short-circuit → +1 by NIST logic) | +1 (`Coalesce`) | +1 | +1 |
| `??=` | — | 0 | +1 | 0 |
| `?.` | — | +1 (`ConditionalAccess`) | +1 | +1 |
| `and` / `or` patterns | — | 0 | +1 | 0 |
| `catch` | (implicit edge) | 0 | **0** | +1 |
| `goto`, `return`, `throw` | 0 | 0 | 0 | 0 |
| lambdas | — | counted in enclosing member (non-legacy mode); excluded in legacy mode | contents counted in parent; static local functions separate | separate function |
| nullable type `int?` | — | — | — | **+1 false positive** when inside a body (observed) |

**Conclusion:** no two tools agree for modern C#. We must publish our own rule set and keep it fixed.

### 2.4 Recommended rule set (tree-sitter, "decision count + 1")

v(G)(unit) = 1 + Σ over nodes inside the unit (excluding nested static local functions), with:

| tree-sitter node | increment | anchor token (for the heatmap) |
|---|---|---|
| `if_statement` (including else-if) | +1 | `if` keyword line |
| `conditional_expression` | +1 | `?` |
| `for_statement`, `foreach_statement`, `while_statement`, `do_statement` | +1 | loop keyword (`while` of `do…while` is acceptable) |
| `switch_section`: each anonymous `case` child | +1 per `case` label (tool-compatible; NIST-strict variant: +1 per non-empty section with ≥1 `case`) | `case` |
| `switch_expression_arm` whose pattern is not `discard` | +1 | `=>` |
| `when_clause` (case guard) | +1 | `when` |
| `catch_clause` | +1 | `catch` |
| `catch_filter_clause` | +1 | `when` |
| `binary_expression` with operator `&&`, `\|\|`, `??` | +1 | operator token |
| `assignment_expression` with operator `??=` | +1 | `??=` |
| `conditional_access_expression` | +1 | `?` |
| `and_pattern`, `or_pattern` | +1 | `and`/`or` |
| `goto`/`break`/`continue`/`return`/`throw`, `else`, `default`, `finally` | 0 | — |

Rationale: every row creates an extra outgoing edge in the control-flow graph, so the rule set follows NIST's "be consistent with the flow graph" advice [2]. `catch` is counted because an exception edge is a real branch (lizard counts it; Sonar and Microsoft do not). Unlike Sonar, we do not count the discard arm, because it is the default outcome, in the same way as `default:`. Ship a "Sonar-compatible" flag if comparability with SonarQube numbers matters.

### 2.5 Known criticisms

- Strongly size-correlated (Section 9). Shepperd's 1988 critique is cited by Landman et al. [25] **[not read]**.
- Treats a 20-case `switch` like a 20-deep `else-if` chain. This is why NIST proposes the switch exemption [2] and why Cognitive Complexity charges a switch only once [3].

---

## 3. Cognitive Complexity (Campbell, SonarSource), spec v1.7 (29 Aug 2023)

### 3.1 Rules (from the whitepaper [3])

The whitepaper gives three basic rules:

1. Ignore structures that shorthand multiple statements into one: the method itself and null-coalescing (`??`, `?.`).
2. Add +1 for each break in the linear flow.
3. Add more when flow-breaking structures are nested.

It also defines four increment types:

- **Structural**: +1, and these structures are subject to the nesting increment. They are `if`, ternary, `switch`, `for`, `foreach`, `while`, `do while` and `catch`.
- **Nesting**: + the current nesting level, applied to structural structures.
- **Hybrid**: +1 with no nesting increment, but they increase the nesting level. They are `else if` and `else`.
- **Fundamental**: +1 that is never nested. These are:
  - each **sequence** of like binary logical operators;
  - `goto` (and multi-level `break`/`continue` to a label or number);
  - each method in a recursion cycle.

Appendix B (normative list) [3]:

- **B1 Increments:** `if`, `else if`, `else`, ternary; `switch`; `for`, `foreach`; `while`, `do while`; `catch`; `goto LABEL`, `break LABEL`, `continue LABEL`, `break NUMBER`, `continue NUMBER`; sequences of binary logical operators; each method in a recursion cycle.
- **B2 Nesting level increases for:** `if`, `else if`, `else`, ternary; `switch`; `for`, `foreach`; `while`, `do while`; `catch`; nested methods and method-like structures such as lambdas.
- **B3 Nesting increments apply to:** `if`, ternary; `switch`; `for`, `foreach`; `while`, `do while`; `catch`.

Further details:

- A `switch` and all its cases together get **one** structural increment.
- A `catch` gets one increment whatever the number of exception types. `try` and `finally` are ignored.
- Early `return` and plain `break`/`continue` are free.
- Mixed operators: `a && b && c && d` costs +1, while `a || b && c || d` is harder. Each change of operator in the sequence costs +1, and negated or parenthesised sub-expressions start a new sequence. The whitepaper example `if (a && !(b && c))` gives +1 (if), +1, +1.
- Lambdas and nested methods get no structural increment but raise the nesting level.
- `#if` counts as an `if`.

### 3.2 How sonar-dotnet implements it for C# (verified from source [4])

- `if` (not under `else`), `?:`, `switch` statement, **switch expression**, `for`, `foreach`, `while`, `do` and `catch` each get +1 + nesting and raise the nesting level. `else` gets +1. An `if` whose parent is an `ElseClause` gets no increment.
- `&&`/`||`: +1 unless the left operand is the same operator kind. A same-kind right operand is ignored. `and`/`or` **patterns** are treated the same way.
- Direct recursion: +1 when the method calls itself with a matching name and argument count (indirect recursion is not detected).
- Lambdas (simple and parenthesised) and non-static local functions only raise nesting.
- `??` and `?.` are not counted. `ForEachVariableStatement` (deconstructing foreach) is **not** counted, which looks like an omission.
- `goto` gets +1 **+ nesting** in sonar-dotnet, while the spec says fundamental (+1 only).
- The whole `if` node, condition included, is visited one level deeper. So a ternary inside an `if` condition costs +2 at top level.
- Defaults: S3776 threshold **15** for methods, **3** for property accessors and expression-bodied properties [6].

### 3.3 Recommended C# rule set (tree-sitter)

| tree-sitter construct | increment | nesting effect |
|---|---|---|
| `if_statement`, not else-if | +1 + N | body at N+1 |
| `if_statement` that is the `alternative` of an `if_statement` (else-if) | +1 (hybrid) | its body at the chain's N+1 |
| `alternative` that is a `block`/statement (plain `else`) | +1 (hybrid) | body at N+1 |
| `conditional_expression` | +1 + N | children at N+1 |
| `switch_statement`, `switch_expression` | +1 + N (once; sections and arms free) | children at N+1 |
| `for_statement`, `foreach_statement`, `while_statement`, `do_statement` | +1 + N | children at N+1 |
| `catch_clause` | +1 + N | children at N+1 |
| `try_statement`, `finally_clause`, `using_statement`, `lock_statement` | 0 | none |
| `lambda_expression`, `anonymous_method_expression`, non-static `local_function_statement` | 0 | children at N+1 |
| maximal tree of `binary_expression` with `&&`/`\|\|` (not crossing `parenthesized_expression` or `!`) | +1 per run of identical operators in **in-order** (source) order | none |
| maximal tree of `and_pattern`/`or_pattern` | same rule (as sonar-dotnet) | none |
| `goto_statement` (incl. `goto case`) | +1 (spec). Sonar-compatible flag: +1 + N | none |
| invocation of the unit's own name (`identifier` callee) | +1 once per unit (direct recursion) | none |
| `??`, `??=`, `?.`, `break`, `continue`, `return`, `throw` | 0 | none |
| `preproc_if` | spec says +1. **Recommend 0** for MessagePack-CSharp, because `#if` is used for build-target switching, not logic. If kept, report it separately. | none |

The "in-order runs" rule implements the whitepaper's "increments for each new sequence of like operators" [3]. It differs from sonar-dotnet on inputs like `a || b && c || d`: the spec reading gives 3 and sonar-dotnet gives 2. Pick one, document it, and keep it.

### 3.4 Self-check (prototype, tree-sitter 0.23.5)

The prototype algorithm (Appendix A) reproduces the whitepaper's worked examples, translated to C#:

- `getWords` (switch with 3 cases + default): CogC = 1 and CC = 4, as in the paper.
- `sumOfPrimes` (labelled `continue` replaced by `goto`): CogC = 7 and CC = 4, as in the paper.
- `myMethod` (try / if / for / while / catch / if): CogC = 9, as in the paper.
- The lambda example gives CogC = 2, as in the paper.
- `if (a && b && c || d || e && f)` gives 1 + 3, and `a && !(b && c)` gives 2, matching the paper's annotations.
- `if / else if { if } / else` gives CogC = 5 (1 + 1 + 2 + 1).

### 3.5 Evidence

- **Muñoz Barón, Wyrich & Wagner (ESEM 2020) [17].** Meta-analysis of 10 studies, 427 snippets and about 24,000 evaluations. SonarQube computed the metric. Random-effects correlations:
  - comprehension **time**: r = **0.54**, 95% CI [0.24, 0.75], 9 studies, 327 snippets, I² = 85%;
  - **correctness**: r = **−0.13**, [−0.45, 0.21], 6 studies, 269 snippets, which is mixed and non-significant;
  - subjective **ratings**: r = **−0.29**, [−0.49, −0.06], 4 studies, 203 snippets;
  - **physiological** (fMRI, 1 study, 12 snippets): r = 0.00;
  - **composite** time + correctness: r = **0.40**, [0.11, 0.62].
  - Crucially, "almost all" snippets had low CogC, and only two studies had snippets above 15. The authors therefore give "no recommendation for a meaningful threshold".
  - The study did **not** control for size.
- **Lavazza, Abualkishik, Liu & Morasca (JSS 2023) [18].** Reused the same kind of datasets and built Support Vector Regression models. "Cognitive Complexity" correlates with understandability "approximately as much as traditional measures":
  - against McCabe: negligible difference in 23 of 29 cases;
  - against logical LOC: negligible difference in 20 of 29 cases;
  - LLOC and Halstead measures "appeared to perform marginally better".
  - Conclusion: no evidence that CogC is "a significant improvement over previously proposed measures".
- **Lavazza, Morasca & Gatto (EMSE 2023) [19].** 32 methods, 3 Master's students, understandability measured as time to complete a maintenance task correctly. Single-measure neural-network models had MR (mean absolute residual over the mean) of 26.9–31.9%. The best was McCabe (26.9%). The largest effect, CogC vs McCabe, was Vargha–Delaney A = 0.57, marginally favouring McCabe. Adding measures did not help.
- **Esposito et al. (arXiv 2303.07722, preprint) [20].** 216 early-career developers rated 12 Java classes. Both CC and CogC were "modest predictors" of perceived understandability, and neither predicted perceived severity.
- **On our target repository:** ρ(CC, CogC) = 0.94 across 2,060 units, and 0.83 after partialling out SLOC (Section 9.3). In this codebase CogC is largely a re-weighting of the same decisions.

---

## 4. Nesting depth

**Definition (recommended, = SonarC# S134 set [6]).** The depth of a node is the number of enclosing `if_statement` (excluding else-if links), `switch_statement`, `for_statement`, `foreach_statement`, `while_statement`, `do_statement` and `try_statement` ancestors within the unit. The unit's value is the maximum depth reached by any control structure (the outermost one has depth 1). sonar-dotnet explicitly skips an `if` whose parent is an `ElseClause` [6]. `catch` does not add a level beyond its `try`.

**Variants to choose from deliberately:**

- PMD `AvoidDeeplyNestedIfStmts` counts `if` only (problemDepth 3) [15].
- Cognitive Complexity's nesting level adds `else`, ternaries, `catch` and lambdas (B2) [3].
- Lanza & Marinescu's MAXNESTING is used in their "Brain Method" strategy **[unverified]**.

**Threshold:** > 3, matching SonarC# S134 max 3 and PMD 3 [6][15]. No empirical derivation was found for 3 specifically.

**Heatmap:** depth of each line = depth of the innermost structure containing it. This is the natural per-line signal, and indentation is a close proxy.

**Evidence:**

- Via [17], Kasto & Whalley found nested block depth (and CC) correlated significantly with student performance on code-tracing exam questions, but not on "explain in plain English" questions.
- Ajami, Woodbridge & Feitelson (EMSE 2019; 220 professional programmers) found that "for loops are significantly harder than ifs" and that syntactic structure is "not necessarily the most important factor" [24]. This supports weighting constructs differently, but it gives no numeric nesting threshold.
- In MessagePack-CSharp, ρ(nesting, SLOC) = 0.83 (Section 9.3).

---

## 5. Method length (size)

**Definitions** (state which one is used, because they differ by up to 2×):

- **LOC**: physical lines of the unit's span, from the first token of its modifiers or attributes to the closing `}` or `;`.
- **SLOC** (recommended): distinct physical lines that contain at least one non-comment token of the unit. Blank and comment-only lines are excluded. sonar-dotnet S138 computes "distinct lines touched by the method's tokens" in the same way [6].
- **NCSS**: number of statements, ignoring comments and blank lines (PMD) [15]. In tree-sitter, count nodes whose type ends in `_statement` (excluding `block`, `empty_statement` and `labeled_statement` wrappers) plus `local_declaration_statement`.
- **Microsoft "Lines of Executable code"**: approximate number of operations from IOperation [9]. Its MI uses `EffectiveLinesOfCode` = executable lines (+1 if a symbol initializer exists) [8]. tree-sitter cannot reproduce this exactly.
- **lizard NLOC**: lines of code without comments.

**Thresholds:**

| Tool | Threshold | Applies to |
|---|---|---|
| SonarC# S138 [6] | max 80 lines | method |
| PMD NcssCount [15] | 60 statements | method |
| PMD NcssCount [15] | 1500 statements | class |
| lizard default [14] | length 1000, NLOC 1,000,000 | function (effectively off) |

No threshold in this list was derived empirically. Benchmark-derived bands exist from Software Improvement Group (SIG) work (Alves et al. [37]), but the concrete values could not be verified (Section 10).

**Evidence:**

- Size is consistently the strongest single correlate of effort and defects in the studies below:
  - Sjøberg et al. [35]: Spearman ρ(LOC, maintenance hours) = **1.0** over 4 functionally equivalent systems;
  - Gil & Lalouche [30]: metric validity is explained by size correlation.
- Size is weak for *snippet understandability*. Via [17], LOC had the weakest correlation with fMRI concentration measures in Peitek et al. In [21], no metric exceeded weak correlations.

---

## 6. Parameter count

**Definition:** the number of `parameter` children of the unit's `parameter_list`.

- An extension method's `this` parameter, `params` arrays, and `ref`/`out`/`in` parameters each count as 1.
- Type parameters (`type_parameter_list`) do not count.
- Primary-constructor parameters belong to the type declaration. Report them on the type, not on any method.
- Exclusions in SonarC# S107 [6]:
  - overrides and interface implementations, because the signature is not under the author's control;
  - extern and P/Invoke methods;
  - parameters injected by dependency-injection attributes.
  - Implement the first two at least: tree-sitter can see the `override` modifier and explicit interface specifiers. Implicit interface implementations need semantic information, so report them as "possibly constrained".

**Thresholds:** SonarC# S107 max **7** [6]; PMD ExcessiveParameterList **10** [15].

**Evidence:**

- In Scalabrino et al. (63 developers, 444 evaluations, 50 Java/Android methods), the "number of parameters negatively correlates with AU (τ ≈ −0.13)", where AU = actual understandability, and interviewed developers echoed it [21]. This is weak but in the expected direction.
- In MessagePack-CSharp the parameter count is only moderately size-correlated (ρ = 0.37 with SLOC), so it carries more independent information than CC or CogC do.

---

## 7. Halstead metrics

### Definitions (as stated in the Radon documentation [34]; originally Halstead 1977 [36] [primary not read])

| Symbol / measure | Definition |
|---|---|
| η1, η2 | distinct operators, distinct operands |
| N1, N2 | total operators, total operands |
| vocabulary η | η1 + η2 |
| length N | N1 + N2 |
| calculated length | η1·log2 η1 + η2·log2 η2 |
| **volume** V | N·log2 η |
| difficulty D | (η1/2)·(N2/η2) |
| effort E | D·V |
| time T | E/18 s |
| bugs B | V/3000 |

### Microsoft's implementation (Roslyn, IOperation-based [8])

- **Operands** are symbol references (locals, parameters, members) and constants.
- **Operators** are binary and unary operators, invocations, object creation, assignments, conversions, `return` with a value, and similar operations.
- Volume = Length × max(0, log2(Vocabulary)).

### Recommended tree-sitter convention

| Category | Counts as one | Notes |
|---|---|---|
| Operands | each leaf `identifier`; each literal node (`integer_literal`, `real_literal`, `character_literal`, `string_literal`, `verbatim_string_literal`, `raw_string_literal`, `boolean_literal`, `null_literal`, `interpolated_string_expression`); each `predefined_type` | Literals and interpolated strings count as one operand each. |
| Operators | each anonymous leaf token (keywords, operator punctuation) | For paired delimiters `()`, `[]`, `{}`, `<>`, count only the opener. Exclude `;` and `,`. |

The convention differs from Microsoft's, so values will not match Visual Studio. That is acceptable only if Halstead is informational. MI depends on ln V, so small convention differences barely move it.

**Caution:** Halstead volume is near-linear in token count, so it is essentially a size measure.

---

## 8. Maintainability Index (MI)

### 8.1 Formulas (verified)

- **Original three-metric form** (as stated by Microsoft [10] and Radon [34]): MI = 171 − 5.2·ln(V) − 0.23·G − 16.2·ln(LOC).
- **Coleman, Ash, Lowther & Oman (IEEE Computer 1994) [32].** Their four-metric polynomial is: MI = 171 − 5.2·ln(aveVol) − 0.23·aveV(g′) − 16.2·ln(aveLOC) + 50·sin(√(2.46·perCM)).
  - aveV(g′) is the average *extended* cyclomatic complexity per module; perCM is the percentage of comments.
  - Read from the scanned postprint, so "2.46" depends on OCR. Radon/SEI write √(2.4·C) [34].
  - Calibration: "approximately 50 regression models" over "40 complexity metrics", fit to HP engineers' subjective maintainability ratings (an abridged AFOTEC instrument).
  - Example application: a 236,000-line C system of 714 files.
  - Bands: > 85 highly maintainable, 65–85 moderate, < 65 "difficult to maintain", described as "only a good 'rule of thumb'".
- **Visual Studio / .NET (0–100):** MI = MAX(0, (171 − 5.2·ln(Halstead Volume) − 0.23·CC − 16.2·ln(LOC))·100/171) [10].
  - Thresholds: 0–9 red, 10–19 yellow, 20–100 green. Microsoft chose them to be "conservative", splitting the range "80-20 to keep the noise level low" [10].
  - Rule CA1505 fires below **10** by default [13].
  - Roslyn's method MI uses Halstead volume from IOperation and *effective executable lines*, and clamps the log terms at 0 [8].

### 8.2 Criticisms (verified)

- **van Deursen (2014) [33]:**
  - no justification for the coefficients;
  - derived from a small set of small, old C and Pascal programs with weak statistics;
  - tools never recalibrated the coefficients;
  - averaging hides power-law risk;
  - the thresholds are unexplained;
  - "metrics are largely correlated with size", so average LOC per module would be simpler.
  - Recommendation: lines of code are "likely more useful and easier to interpret".
- **Sjøberg, Anda & Mockus (ESEM 2012) [35].** Four functionally equivalent Java web systems were built independently by four companies (€18k–€61k). Six developers then performed three maintenance tasks on them.
  - The metrics "were not mutually consistent".
  - "Only system size and low cohesion were strongly associated with increased maintenance effort".
  - Spearman: LOC vs hours = 1.0; 1/MI vs hours = −0.6, so MI pointed the wrong way (n = 4 systems, so it is anecdotal statistically).
  - Conclusion: "the simplest metric of size was the best predictor of maintainability".
  - The paper is ESEM 2012. "Sjøberg et al. 2013" in the task brief probably refers to a follow-up **[not checked]**.

### 8.3 Recommendation

Compute MI (VS formula) only for **comparability with Visual Studio dashboards**, and label it "informational". Never use it as a certification gate. If shown, display it next to a size-only baseline.

---

## 9. The size-confounding problem

### 9.1 Evidence

- **El Emam, Benlarbi, Goel & Rai (IEEE TSE 27(7):630–650, 2001) [29].** "none of these studies allow for the potentially confounding effect of class size. We demonstrate a strong size confounding effect and question the results of previous object-oriented metrics validation studies." The study used a C++ telecommunications framework (174 classes per Landman's literature table [26]) with the Chidamber–Kemerer and Lorenz–Kidd metrics and field-failure fault-proneness. Before controlling for size, the results resembled earlier studies.
  - The commonly cited outcome, that after size control the associations disappeared, is **[unverified]**: the abstract text available to me ends before it.
- **Gil & Lalouche (EMSE 22:2585–2611, 2017) [30].**
  - 26 metrics, including CK.
  - "the validity of a metric can be explained by its correlation to the size of the code artifact": validity is predicted from size correlation with R² up to about 0.97.
  - Size-controlled metrics "tend to eliminate their predictive capabilities".
  - Conclusion: size is the only "unique" valid metric.
- **Landman, Serebrenik, Bouwers & Vinju (JSEP 28(7):589–618, 2016) [26]; ICSME 2014 version [25].** Literature (33 papers, 1979–2014) mostly reports CC–SLOC R² > 0.5, ranging 0.60–0.95 per the 2014 slides [25]. On **17.6 M Java methods** and **6.3 M C functions**:

  | Corpus | Pearson R² | R² after log transform | Spearman ρ |
  |---|---|---|---|
  | Java (17.6 M methods) | 0.40 | 0.68 | 0.80 |
  | C (6.3 M functions) | 0.44 | 0.71 | 0.83 |

  - The correlation **weakens** for larger methods. Java methods with ≥ 9 SLOC: R² 0.34, log R² 0.38, ρ 0.60. This contradicts Herraiz & Hassan.
  - 50% of Java methods have 1–3 SLOC, which drives the overall correlation.
  - Aggregating to files raises R² and explains the literature's "strong" claims.
  - Conclusion: CC is "not strong enough" to be redundant with SLOC at method level.
- **Herraiz & Hassan, "Beyond lines of code: do we need more complexity metrics?" (Making Software, ch. 8, 2010) [27], via [26]:** ArchLinux C files, log–log R² 0.59, rising to 0.69 after excluding header files. **[primary not read]**
- **Jay et al. (JSEA 2009) [28], via [26]:** 2,200 SourceForge projects, log–log R² 0.78 (0.87–0.97 with repeated-median regression). **[primary not read]**

### 9.2 Implications for the certifier

1. **Always report SLOC next to every complexity value**, and never present CC, CogC or nesting as independent of size.
2. **Separate "large" from "convoluted".** Fit a conditional quantile model of CogC (and CC, nesting) on log(SLOC) on the human baseline. Flag a unit when it is above the baseline's conditional 90th percentile *for its size* ("complex for its size"), and flag absolute size separately.
   - Do not use naive density ratios such as CC/SLOC. They are unstable for the 1–3-line units that dominate corpora [26].
3. **Validation must beat size.** For any outcome Y (bug-fix touch, review finding, revert, human rating), report:
   - ρ(M, Y) **and** the partial Spearman ρ(M, Y | SLOC);
   - **or** compare logistic models Y ~ log SLOC vs Y ~ log SLOC + M with a likelihood-ratio test and ΔAUC (DeLong).
   - A metric that adds nothing over size should be shown as "size-redundant" in the report. This is the El Emam methodology [29] and the Gil–Lalouche criterion [30].
4. **Collinearity:** do not sum CC and CogC into a score. They are about 0.94 rank-correlated here, so pick CogC for KISS and keep CC for testability.

### 9.3 Measured on the target repository (our prototype, Appendix A)

MessagePack-CSharp `workspace/messagepack-csharp/src` at commit `32258fdb` (2025-03-01), excluding tests, benchmark and sandbox. After the line-preserving `#if` pre-pass: 190 files, **2,060 units**, 40 units containing ERROR nodes.

| Metric | p50 | p70 | p80 | p90 | p95 | p99 | max | Spearman ρ with SLOC | share over default gate |
|---|---|---|---|---|---|---|---|---|---|
| CC | 1 | 2 | 3 | 5 | 7 | 17 | 229 | **0.79** (Pearson 0.85) | 2.48% > 10 |
| CogC | 0 | 2 | 3 | 5 | 8 | 23.4 | 470 | **0.81** (Pearson 0.73) | 1.70% > 15 |
| Nesting | 0 | 1 | 1 | 2 | 2 | 4 | 9 | **0.83** | 1.17% > 3 |
| Params | 1 | 2 | 3 | 3 | 4 | 6 | 11 | 0.37 | 0.49% > 7 |
| SLOC | 7 | 12 | 17 | 28 | 38 | 94 | 593 | — | 1.46% > 80 |

Further results:

- Restricted to units with SLOC ≥ 10 (n = 810), ρ(CC, SLOC) = 0.72 and ρ(CogC, SLOC) = 0.67.
- ρ(CC, CogC) = 0.94. Partial (rank-residualised on SLOC): ρ(CC, CogC | SLOC) = 0.83 and ρ(nesting, CogC | SLOC) = 0.75.

These are descriptive numbers from one repository with our own counting rules. They are not literature values.

---

## 10. Threshold derivation

### Sources

- **Alves, Ypma & Visser (ICSM 2010) [37]** (verified via abstract). The method pools measurements from a benchmark of **100** object-oriented systems, both proprietary and open source. It "respects the metrics' distributions and scales", resists outliers, and was used for the SIG maintainability model.
  - Commonly reported procedure: weight each unit by its LOC, aggregate across systems, and read thresholds at the 70%, 80% and 90% quantiles to obtain low/moderate/high/very-high risk bands. The commonly cited McCabe bands are 6/8/14. **[unverified: paper body not opened]**
- **Oliveira, Valente & Lima (CSMR-WCRE 2014, pp. 254–263) [39]** (verified via abstract). *Relative* thresholds for heavy-tailed metrics: "most" entities must satisfy M ≤ k, and a long tail is tolerated. The thresholds were extracted from a corpus of **106** systems.
  - The exact form "p% of entities must have M ≤ k" and how (p, k) are chosen is **[unverified detail]**.
- **Ferreira et al. (JSS 85(2):244–257, 2012) [38]** (metadata verified). Thresholds for OO metrics are derived from fitted distributions as typical/regular/bad ranges. The concrete values are **[unverified]**, and they are class-level, so less relevant here.
- **Lanza & Marinescu, *Object-Oriented Metrics in Practice* (Springer 2006) [40].** Statistical thresholds from Java and C++ projects: LOW = mean − sd, AVERAGE = mean, HIGH = mean + sd, VERY HIGH = HIGH × 1.5 **[unverified]**. Plus "generally accepted meaning" thresholds.
  - Verified through PMD's source, which cites the book's pages: WMC VERY HIGH = **47**, FEW = **2–5**, TCC "one third is a low value" [15].
  - Frequently quoted method-level Java values (CYCLO/LOC 0.16/0.20/0.24/0.36; LOC/method 7/10/13/19.5; NOM/class 4/7/10/15) are **[unverified, from memory — check the book before use]**.

### Recommended procedure for the certifier (combines both families)

1. **Absolute gates (published defaults):** CogC > 15, CC > 10, nesting > 3, params > 7, SLOC > 80. These are explainable and tool-comparable.
2. **Baseline-relative gates.** Use the human-written baseline (MessagePack-CSharp at the PR's base commit) and set risk bands at the baseline's p80/p90/p95 (Section 9.3).
   - Unweighted here: CC 3/5/7, CogC 3/5/8, nesting 1/2/2, params 3/3/4, SLOC 17/28/38.
   - Alternatively use SLOC-weighted quantiles as in Alves. State which one is used.
3. **Statistical decision for a PR.** If k of the n new or changed units in an agent PR exceed the baseline p90, test against Binomial(n, 0.10). Also report the size-conditional exceedance (Section 9.2 item 2) so that a PR is not penalised merely for adding a large but simple method.
4. **Re-derive thresholds whenever the counting rules change.** The tool comparison in Section 2.3 shows that the counting choices move the numbers.

---

## 11. Evidence summary (effect sizes)

| Study | Data | Finding (effect size) |
|---|---|---|
| Muñoz Barón et al. 2020 [17] | 10 studies, 427 snippets, ~24k evaluations | CogC vs time r = 0.54; vs ratings r = −0.29; vs correctness r = −0.13 (n.s.); vs fMRI r = 0.00; composite r = 0.40; no threshold validation |
| Lavazza et al. 2023 JSS [18] | reused published understandability datasets | CogC ≈ McCabe (negligible difference in 23/29 cases) and ≈ LLOC (20/29); not an improvement |
| Lavazza, Morasca, Gatto 2023 EMSE [19] | 32 methods, 3 subjects | Best single predictor McCabe, MR 26.9%; CogC vs McCabe A = 0.57; ~30% error |
| Scalabrino et al. TSE 2021 [21] | 50 methods, 63 developers, 444 evaluations, 121 metrics | No metric beyond weak correlation (max \|τ\| ≈ 0.16); params τ ≈ −0.13; best combined-model AUC ≈ 0.72 but "far from … practical" |
| Esposito et al. preprint [20] | 216 early-career developers, 12 classes | CC and CogC "modest predictors" |
| Ajami et al. 2019 [24] | 220 professional programmers | loops harder than ifs; syntax not the dominant factor |
| Landman et al. 2016 [26] | 17.6 M Java methods; 6.3 M C functions | CC–SLOC: R² 0.40/0.44; log R² 0.68/0.71; ρ 0.80/0.83 |
| Gil & Lalouche 2017 [30] | 26 metrics | metric validity predicted by size correlation (R² ≈ 0.97); size-controlled metrics lose power |
| El Emam et al. 2001 [29] | C++ telecom framework | "strong size confounding effect" |
| Sjøberg et al. 2012 [35] | 4 equivalent systems, 6 developers | ρ(LOC, effort) = 1.0; ρ(1/MI, effort) = −0.6 (n = 4) |
| Coleman et al. 1994 [32] | HP industrial C systems | MI fitted to engineers' subjective ratings; 85/65 bands are a "rule of thumb" |
| This repository (prototype) | MessagePack-CSharp src, 2,060 units | ρ with SLOC: CC 0.79, CogC 0.81, nesting 0.83, params 0.37 |

**Honest bottom line:**

- Control-flow metrics are reasonable *explainable* proxies. CogC correlates moderately with comprehension time, but it is not demonstrably better than McCabe or LOC, and little survives once size is controlled.
- None of the common thresholds (10, 15, 3, 7, 80) is empirically derived for C# or for agent-written code. They are conventions, and the certifier should present them as such, alongside the baseline-relative bands.

---

## 12. Implementation notes for the heatmap

| Signal | Per-line value | Line it attaches to |
|---|---|---|
| CC | increments from Section 2.4 | anchor token's line |
| CogC | each increment's value (1 + nesting where applicable) | anchor token's line (`if`/`?`/`switch`/loop keyword/`catch`/`else`/operator/`goto`) |
| Nesting | depth of the innermost enclosing structure | every line |
| SLOC, params | unit-level values | unit's signature line, or spread uniformly over the unit's span |

- **Units with parse errors** (`has_error`) are marked low-confidence. **Parse after the line-preserving `#if` pre-pass** (Section 1).
- **lizard** is already installed in `.venv` (1.26.0). It is useful as a cross-check, but its C# CCN omits `foreach` and miscounts `int?` (Section 2.3), so do not use it as the source of truth.

---

## Appendix A — Prototype algorithm (Python, tree-sitter 0.26 bindings, tree-sitter-c-sharp 0.23.5)

Tested on the whitepaper examples (Section 3.4) and on MessagePack-CSharp (Section 9.3).

```python
import tree_sitter_c_sharp as tscs
from tree_sitter import Language, Parser
LANG = Language(tscs.language())
UNIT = {"method_declaration","constructor_declaration","destructor_declaration","operator_declaration",
        "conversion_operator_declaration","accessor_declaration","local_function_statement"}
NESTED_FUNC = {"lambda_expression","anonymous_method_expression","local_function_statement"}
LOOPS = {"for_statement","foreach_statement","while_statement","do_statement"}

def op(n):  o = n.child_by_field_name("operator");  return o.type if o else None
def is_static_local(n):
    return n.type == "local_function_statement" and any(c.type == "modifier" and c.text == b"static" for c in n.children)
def is_unit(n): return n.type in UNIT and (n.type != "local_function_statement" or is_static_local(n))
def is_else_if(n):
    p = n.parent
    return n.type == "if_statement" and p is not None and p.type == "if_statement" \
        and p.child_by_field_name("alternative") is not None and p.child_by_field_name("alternative").id == n.id

def cyclomatic(fn):
    cc = 1
    def walk(n):
        nonlocal cc
        if n.id != fn.id and is_static_local(n): return
        t = n.type
        if t in LOOPS or t in ("if_statement","conditional_expression","catch_clause","when_clause",
                               "catch_filter_clause","conditional_access_expression"): cc += 1
        elif t == "switch_expression_arm" and not (n.named_children and n.named_children[0].type == "discard"): cc += 1
        elif t == "switch_section": cc += sum(1 for c in n.children if c.type == "case")
        elif t == "binary_expression" and op(n) in ("&&","||","??"): cc += 1
        elif t == "assignment_expression" and op(n) == "??=": cc += 1
        elif t in ("and_pattern","or_pattern"): cc += 1
        for c in n.children: walk(c)
    walk(fn); return cc

def cognitive(fn):
    total, seen = 0, set()
    nm = fn.child_by_field_name("name"); fname = nm.text.decode() if nm else None
    def logical_runs(n, kinds, is_op, key):
        seq = []
        def flat(m):
            if m is None or not is_op(m): return
            seen.add(m.id); flat(m.child_by_field_name("left")); seq.append(key(m)); flat(m.child_by_field_name("right"))
        flat(n); return sum(1 for i, k in enumerate(seq) if i == 0 or seq[i-1] != k)
    def walk(n, N):
        nonlocal total
        t = n.type
        if n.id != fn.id and is_static_local(n): return
        if n.id != fn.id and t in NESTED_FUNC:                      # B2: nesting only
            for c in n.children: walk(c, N + 1)
            return
        if t == "if_statement":
            total += 1 if is_else_if(n) else 1 + N                  # hybrid vs structural+nesting
            walk(n.child_by_field_name("condition"), N)
            walk(n.child_by_field_name("consequence"), N + 1)
            alt = n.child_by_field_name("alternative")
            if alt is not None:
                if alt.type == "if_statement": walk(alt, N)        # else-if keeps chain level
                else: total += 1; walk(alt, N + 1)                 # plain else: hybrid
            return
        if t in LOOPS or t in ("switch_statement","switch_expression","catch_clause","conditional_expression"):
            total += 1 + N
            for c in n.children: walk(c, N + 1)
            return
        if t == "goto_statement": total += 1                        # spec: fundamental
        if t == "binary_expression" and op(n) in ("&&","||") and n.id not in seen:
            total += logical_runs(n, None, lambda m: m.type == "binary_expression" and op(m) in ("&&","||"), op)
        if t in ("and_pattern","or_pattern") and n.id not in seen:
            total += logical_runs(n, None, lambda m: m.type in ("and_pattern","or_pattern"), lambda m: m.type)
        if t == "invocation_expression" and fname:
            f = n.child_by_field_name("function")
            if f is not None and f.type == "identifier" and f.text.decode() == fname: total += 1  # direct recursion
        for c in n.children: walk(c, N)
    body = fn.child_by_field_name("body"); walk(body if body is not None else fn, 0)
    return total

NEST = LOOPS | {"if_statement","switch_statement","try_statement"}   # SonarC# S134 set
def max_nesting(fn):
    best = 0
    def walk(n, d):
        nonlocal best
        if n.id != fn.id and is_static_local(n): return
        if n.type in NEST and not is_else_if(n): d += 1; best = max(best, d)
        for c in n.children: walk(c, d)
    walk(fn, 0); return best

def params(fn):
    pl = fn.child_by_field_name("parameters")
    return 0 if pl is None else sum(1 for c in pl.named_children if c.type == "parameter")

def sloc(fn):
    lines = set()
    def walk(n):
        if n.type == "comment": return
        if n.child_count == 0: lines.update(range(n.start_point[0], n.end_point[0] + 1))
        for c in n.children: walk(c)
    walk(fn); return len(lines)
```

Known simplifications:

- Recursion detection is name-based, so overloads with the same name produce false positives.
- Indirect recursion is not detected.
- The `if` condition is walked at the outer nesting level. sonar-dotnet walks it one level deeper (Section 3.2).
- Expression-bodied properties and indexers are not yet treated as units.

---

## 13. References (with verification status)

1. T. J. McCabe, "A Complexity Measure," *IEEE TSE* SE-2(4):308–320, Dec 1976. DOI 10.1109/TSE.1976.233837. *Metadata verified (Crossref). Content taken via [2] and [3]; the original PDF could not be fetched.*
2. A. H. Watson, T. J. McCabe, *Structured Testing: A Testing Methodology Using the Cyclomatic Complexity Metric*, NIST SP 500-235, 1996. https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication500-235.pdf. *Verified (full text): §2.2, §2.5, §4.1–4.2.*
3. G. A. Campbell, *Cognitive Complexity — a new way of measuring understandability*, SonarSource whitepaper v1.7, 29 Aug 2023 (first version 2017). https://www.sonarsource.com/docs/CognitiveComplexity.pdf. *Verified (full text incl. Appendices A–C, change log).*
4. SonarSource, sonar-dotnet, `CSharpCognitiveComplexityMetric.cs`. https://github.com/SonarSource/sonar-dotnet/blob/master/analyzers/src/SonarAnalyzer.CSharp/Metrics/CSharpCognitiveComplexityMetric.cs. *Verified (source read via fetch, master on 2026-11-14).*
5. SonarSource, sonar-dotnet, `CSharpCyclomaticComplexityMetric.cs`. https://github.com/SonarSource/sonar-dotnet/blob/master/analyzers/src/SonarAnalyzer.CSharp/Metrics/CSharpCyclomaticComplexityMetric.cs. *Verified (source).*
6. SonarSource, sonar-dotnet rule defaults. *Verified (source constants).*
   - `CognitiveComplexityBase.cs`: S3776, `DefaultThreshold = 15`, `DefaultPropertyThreshold = 3`.
   - `Rules/FunctionComplexity.cs`: S1541, `DefaultValueMaximum = 10`.
   - `FunctionNestingDepthBase.cs`: S134, max 3. The C# walker counts if/for/foreach/while/do/switch/try and skips else-if.
   - `TooManyParametersBase.cs`: S107, max 7, with exclusions.
   - `MethodsShouldNotHaveTooManyLinesBase.cs`: S138, max 80, distinct token lines.
   - `ExpressionComplexityBase.cs`: S1067, max 3.
   - All under https://github.com/SonarSource/sonar-dotnet/tree/master/analyzers/src (SonarAnalyzer.Core/Rules and SonarAnalyzer.CSharp/Rules).
7. .NET Roslyn analyzers, `MetricsHelper.cs` (cyclomatic complexity via IOperation). https://source.dot.net/Microsoft.CodeAnalysis.AnalyzerUtilities/src/roslyn/src/RoslynAnalyzers/Utilities/Compiler/CodeMetrics/MetricsHelper.cs.html. *Verified (source).*
8. .NET Roslyn analyzers, `ComputationalComplexityMetrics.cs` and `CodeAnalysisMetricData.MethodMetricData.cs` (Halstead, effective LOC, MI). https://source.dot.net/Microsoft.CodeAnalysis.AnalyzerUtilities/src/roslyn/src/RoslynAnalyzers/Utilities/Compiler/CodeMetrics/ComputationalComplexityMetrics.cs.html. *Verified (source).*
9. Microsoft Learn, "Code metrics values." https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-values. *Verified.*
10. Microsoft Learn, "Code metrics – Maintainability index range and meaning." https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning. *Verified.*
11. Microsoft Learn, "Code metrics – Cyclomatic complexity." https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-cyclomatic-complexity. *Verified (quotes NIST and NASA SATC).*
12. Microsoft Learn, "CA1502: Avoid excessive complexity." https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1502. *Verified (default 25).*
13. Microsoft Learn, "CA1505: Avoid unmaintainable code." https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1505. *Verified (default MI < 10).*
14. T. Yin, *lizard* 1.26.0, `lizard_languages/csharp.py`. https://github.com/terryyin/lizard. *Verified locally:* the installed package source was read and its behaviour observed on test files in this environment.
15. PMD, Java design rules and `GodClassRule.java`. https://pmd.github.io/pmd/pmd_rules_java_design.html and https://github.com/pmd/pmd/blob/main/pmd-java/src/main/java/net/sourceforge/pmd/lang/java/rule/design/GodClassRule.java. *Verified.*
    - Rule defaults: CognitiveComplexity 15; CyclomaticComplexity 10 (method) / 80 (class); NcssCount 60 / 1500; ExcessiveParameterList 10; AvoidDeeplyNestedIfStmts 3; NPath 200.
    - Lanza–Marinescu constants: WMC 47, FEW 2–5, TCC 1/3.
16. tree-sitter-c-sharp 0.23.5 (Python wheel `tree_sitter_c_sharp`). https://github.com/tree-sitter/tree-sitter-c-sharp. *Verified locally:* node kinds enumerated and parse shapes dumped.
17. M. Muñoz Barón, M. Wyrich, S. Wagner, "An Empirical Validation of Cognitive Complexity as a Measure of Source Code Understandability," ESEM 2020. DOI 10.1145/3382494.3410636; arXiv:2007.12520 (https://arxiv.org/abs/2007.12520). *Verified (full text, forest plots).*
18. L. Lavazza, A. Z. Abualkishik, G. Liu, S. Morasca, "An empirical evaluation of the 'Cognitive Complexity' measure as a predictor of code understandability," *JSS* 197:111561, 2023. DOI 10.1016/j.jss.2022.111561; preprint https://osf.io/2mbwe/. *Verified (Crossref metadata + preprint full text).*
19. L. Lavazza, S. Morasca, M. Gatto, "An empirical study on software understandability and its dependence on code characteristics," *EMSE* 28:155, 2023. DOI 10.1007/s10664-023-10396-7. *Verified (publisher page text).*
20. M. Esposito, A. Janes, T. Kilamo, V. Lenarduzzi, "Early Career Developers' Perceptions of Code Understandability. A Study of Complexity Metrics," arXiv:2303.07722 (v2 2024). https://arxiv.org/abs/2303.07722. *Verified (abstract). Preprint, not peer-reviewed as listed.*
21. S. Scalabrino, G. Bavota, C. Vendome, M. Linares-Vásquez, D. Poshyvanyk, R. Oliveto, "Automatically Assessing Code Understandability," *IEEE TSE* (online 2019; issue 2021). DOI 10.1109/TSE.2019.2901468; author PDF https://www.cs.wm.edu/~denys/pubs/TSE'19-Understandability.pdf. *Verified (full text). Volume/pages not verified.*
22. S. Scalabrino et al., "Automatically assessing code understandability: how far are we?" ASE 2017, pp. 417–427. DOI 10.1109/ASE.2017.8115654. https://www.cs.wm.edu/~denys/pubs/ASE'17-Readability.pdf. *Metadata from bibliographic listing; superseded by [21].*
23. O. Trockman et al., "Automatically assessing code understandability reanalyzed: combined metrics matter," MSR 2018. *[unverified primary]; results via [21] (AUC 0.64) and [17].*
24. S. Ajami, Y. Woodbridge, D. G. Feitelson, "Syntax, predicates, idioms — what really affects code complexity?" *EMSE* 24:287–328, 2019. DOI 10.1007/s10664-018-9628-3. *Verified (abstract only).*
25. D. Landman, A. Serebrenik, J. J. Vinju, "Empirical analysis of the relationship between CC and SLOC in a large corpus of Java methods," ICSME 2014, pp. 221–230. https://ir.cwi.nl/pub/22662/; slides https://www.cwi.nl/documents/195307/CWI-Scientific-Landman.pdf. *Verified (repository record + slides; DOI not checked).*
26. D. Landman, A. Serebrenik, E. Bouwers, J. J. Vinju, "Empirical analysis of the relationship between CC and SLOC in a large corpus of Java methods and C functions," *J. Softw. Evol. Process* 28(7):589–618, 2016. DOI 10.1002/smr.1760; https://ir.cwi.nl/pub/23938/JOEP8339.pdf. *Verified (full text, Tables I, IV, V).*
27. I. Herraiz, A. E. Hassan, "Beyond Lines of Code: Do We Need More Complexity Metrics?" in *Making Software*, O'Reilly, 2010, ch. 8, pp. 126–141. *[primary not read]; results via [26].*
28. G. Jay et al., "Cyclomatic complexity and lines of code: empirical evidence of a stable linear relationship," *JSEA* 2(3):137–143, 2009. *[primary not read]; results via [26].*
29. K. El Emam, S. Benlarbi, N. Goel, S. N. Rai, "The confounding effect of class size on the validity of object-oriented metrics," *IEEE TSE* 27(7):630–650, 2001. DOI 10.1109/32.935855. *Metadata verified (Crossref). Abstract partially verified (OpenAlex; ends mid-abstract). Post-control result [unverified].*
30. Y. Gil, G. Lalouche, "On the correlation between size and metric validity," *EMSE* 22:2585–2611, 2017. DOI 10.1007/s10664-017-9513-5. *Verified (publisher abstract); data repository github.com/GalLalouche/validity_independence (not inspected).*
31. P. Oman, J. Hagemeister, "Metrics for assessing a software system's maintainability," ICSM 1992. DOI 10.1109/ICSM.1992.242525. *Cited by [33][34]; primary not read.*
32. D. Coleman, D. Ash, B. Lowther, P. Oman, "Using Metrics to Evaluate Software System Maintainability," *IEEE Computer* 27(8):44–49, 1994. DOI 10.1109/2.303623; postprint http://www.ecs.csun.edu/~rlingard/comp589/ColemanPaper.pdf. *Verified (full text, OCR of scan).*
33. A. van Deursen, "Think Twice Before Using the 'Maintainability Index'," blog, 29 Aug 2014. https://avandeursen.com/2014/08/29/think-twice-before-using-the-maintainability-index/. *Verified.*
34. Radon documentation, "Introduction to Code Metrics" (Halstead and MI variants). https://radon.readthedocs.io/en/latest/intro.html. *Verified.*
35. D. I. K. Sjøberg, B. Anda, A. Mockus, "Questioning software maintenance metrics: a comparative case study," ESEM 2012, pp. 107–110. DOI 10.1145/2372251.2372269; postprint https://www.mn.uio.no/ifi/personer/vit/dagsj/sjoberg.anda.mockus.esem.2012.pdf. *Verified (full text incl. Table 2).*
36. M. H. Halstead, *Elements of Software Science*, Elsevier North-Holland, 1977. *[primary not read]; formulas via [34].*
37. T. L. Alves, C. Ypma, J. Visser, "Deriving metric thresholds from benchmark data," ICSM 2010, pp. 1–10. DOI 10.1109/ICSM.2010.5609747. *Metadata + abstract verified (Crossref/OpenAlex). Procedure details and the 6/8/14 values are [unverified].*
38. K. A. M. Ferreira, M. A. S. Bigonha, R. S. Bigonha, L. F. O. Mendes, H. C. Almeida, "Identifying thresholds for object-oriented software metrics," *JSS* 85(2):244–257, 2012. DOI 10.1016/j.jss.2011.05.044. *Metadata verified (OpenAlex); content [unverified].*
39. P. Oliveira, M. T. Valente, F. P. Lima, "Extracting relative thresholds for source code metrics," CSMR-WCRE 2014, pp. 254–263. DOI 10.1109/CSMR-WCRE.2014.6747177. *Metadata + abstract verified (Crossref/OpenAlex).*
40. M. Lanza, R. Marinescu, *Object-Oriented Metrics in Practice*, Springer, 2006. *Book not consulted. Three constants verified via PMD source [15]; all other values [unverified].*
41. M. Shepperd, "A critique of cyclomatic complexity as a software metric," *Software Engineering Journal* 3(2), 1988. *Cited in [25]; not read.*
42. N. Peitek et al. (fMRI study of code-metric correlations). *[unverified primary]; summarised via [17].*
43. N. Kasto, J. Whalley (code-metric correlations with exam performance). *[unverified primary]; summarised via [17].*
44. L. Rosenberg, T. Hammer, J. Shaw, "Software Metrics and Reliability," ISSRE 1998 (NASA SATC). *Quoted via [11]; not read.*
45. MessagePack-CSharp, local clone `workspace/messagepack-csharp`, commit `32258fdb` (2025-03-01). *Measured by us with the Appendix A prototype; scripts kept only in the session scratchpad.*
