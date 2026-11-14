# 08 — Existing tools, repos, scoring formulas and code-quality heatmaps

Survey for an AI-free, mathematically defined C# code-quality certifier (Python + tree-sitter, no LLMs) targeting MessagePack-CSharp and agent-written PRs.
Date: 2026-11-14. Every number below is either quoted from the cited source `[n]` or measured by us in this worktree (marked **[measured]**). Anything that could not be checked is marked **[unverified]**. Sections labelled "Proposal" are our design, not facts from a source.

Note on method: the shared web-search budget ran out partway through. The rest of the work used direct fetches of known URLs and local experiments, so a few topics (Understand, CodeMR, Designite for C#, Devpost criteria, the SonarQube treemap) are only covered lightly and are marked **[unverified]**.

---

## 0. Key takeaways

1. **No existing open-source tool gives us full, correct C# metrics from tree-sitter.** rust-code-analysis does not support C# [9]. lizard supports C# with a token-based heuristic, but our tests found real counting bugs (see §2.1). qlty uses tree-sitter-c-sharp, but it maps only `method_declaration` as a function and `switch_expression` as a switch [13]. **Writing our own tree-sitter walker is justified.** For the rule definitions we should copy the semantics of **sonar-dotnet** (cognitive complexity, S107, S138, S134, S1067) and **Roslyn Metrics** (CC, MI, Halstead), because both are reference implementations for C# that we can cite.
2. **We have three grading models with public formulas to borrow from:**
   - **Hyperstyle**: per-subcategory thresholds, and the final grade is the **minimum** over subcategories (EXCELLENT/GOOD/MODERATE/BAD) [20–24].
   - **SIG 2007**: risk profiles. Each unit gets a risk band, LOC is summed per band, and a table of maximum percentages gives the rating (++…--) [27].
   - **Technical-debt ratio → A–E/F** (SonarQube [6], qlty [12], NDepend [17]).
   A certifier that is transparent and explainable can combine SIG risk profiles (per practice) with a Hyperstyle min-aggregation (overall).
3. **Outputs:** JSON (canonical), **SARIF 2.1.0** (GitHub code scanning), and a static HTML heatmap.
   - SARIF's `result.kind` enum includes **`pass`** as well as `fail` [29], so we can record where a practice holds, not only where it fails.
   - GitHub's docs do not say how `kind` is handled [28]. Upload only failures to GitHub, and keep the full pass/fail SARIF for our own HTML.
4. **The tree-sitter C# parser works for modern C#, with known gaps.** With tree-sitter 0.26.1 and tree-sitter-c-sharp 0.23.5 (ABI 15) **[measured]**:
   - **Parses:** records, file-scoped namespaces, primary constructors, collection expressions, list patterns, raw strings and `and`/`or` patterns.
   - **Fails on:** C# 14 extension blocks and null-conditional assignment, pointer-deref casts `*(T*)p`, and assignment to ref-returning calls `M(ref x) = v`.
   - **MessagePack corpus:** 34 of 681 `.cs` files (27 of 190 under `src/`) contain ERROR/MISSING nodes. A trivial "keep first `#if` branch" preprocessor brings that down to 20 files.

---

## 1. Tool → metrics → algorithm → reuse value

| Tool | C# support | Metrics | Algorithm (verified details) | Reuse value for us |
|---|---|---|---|---|
| **lizard** 1.26.0 [1][2][3] | Yes (token-based reader, `.cs`) | NLOC, CCN, token count, parameter count, length; extensions: `cognitive`, `NS` (nesting), `halstead`, `duplicate`, `wordcount` | CCN = 1 + count of condition tokens. C# set: `if for while catch && \|\| case ? ??` [2]. Defaults: CCN warn > 15, length > 1000, args > 100 [3]. CogC threshold "15 by default" [4]. | **Medium.** Useful as a cross-check baseline and for `-Eduplicate`. Do **not** use it as ground truth: no `foreach`, no switch-expression arms, counts `int?` (§2.1). |
| **radon** [5] | No (Python only) | CC, MI (4 variants), Halstead, raw LOC | Formulas in §2.2 | **High for formulas** (MI/Halstead definitions to cite), none as a tool. |
| **Roslyn Metrics** (`Microsoft.CodeAnalysis.Metrics`, `msbuild /t:Metrics`) [7][8][30–33] | Native (needs a buildable project) | MaintainabilityIndex, CyclomaticComplexity, ClassCoupling, DepthOfInheritance, SourceLines, ExecutableLines | CC = 1 + count of non-implicit `CaseClause, Coalesce, Conditional, ConditionalAccess, Loop`, short-circuit `&&`/`\|\|`, bool `&`/`\|` [31]. MI = `max(0, (171 − 5.2 ln V − 0.23 CC − 16.2 ln LOC)·100/171)` [7]. Halstead from IOperations [32]. | **High as a definition and oracle.** Mirror its CC rules in tree-sitter. Optionally run it in CI to validate our numbers (needs .NET; see memory note on `~/.dotnet`). |
| **SonarQube / sonar-dotnet** [6][14–16][34–37] | Native (Roslyn analyzers) | Cognitive complexity S3776, cyclomatic S1541, method lines S138, parameters S107, expression complexity S1067, nesting S134, duplication, debt ratio | Thresholds: S3776 15 (property 3), S1541 10, S138 80, S107 7, S1067 3, S134 3 (source constants). Debt ratio and A–E rating in §3.2. | **Very high.** Industry-recognised rule IDs and thresholds to cite per practice. The C# cognitive-complexity algorithm can be ported to tree-sitter (§2.4). |
| **qlty** (Code Climate successor) [10–13] | Yes (tree-sitter-c-sharp) | Cognitive complexity, smells (boolean logic, nesting, params, returns, file complexity, function complexity, identical/similar code), TDR grade | Smell defaults in §2.5. Duplication uses AST nodes ≥ 50 [11]. TDR → A–F [10]. | **High.** Proof that a tree-sitter-based C# smells engine is viable. Reuse the default thresholds and the TDR grading. The licence is BSL (Fair Source) [12]: borrow ideas, not code. |
| **PMD CPD** [18] | Yes (`--language cs`) | Duplicated token sequences | Karp-Rabin string matching. `--minimum-tokens` is required (docs use 100). C# options: `--ignore-annotations`, `--ignore-usings`, `--ignore-literal-sequences` | **Medium.** A citable clone definition. Our Python version is Rabin–Karp over tree-sitter leaf tokens. |
| **jscpd** (Rust rewrite, v5) [19][19b] | C# in `--similarity` / `--semantic` lists; exact-mode C# coverage not confirmed | Clones: exact, renamed, similar (gap/AST), semantic | Rabin-Karp rolling hash. Defaults min-tokens 50, min-lines 5, mode `mild` [19b]. AST similarity is the Jaccard index of normalised subtree fingerprints, default ratio 0.8, min-nodes 20 [19b]. Reporters include `sarif` [19]. | **High (algorithm).** The Jaccard-of-subtree-fingerprints near-miss clone detection is easy to reimplement on tree-sitter. Skip `--semantic` (embedding model, so not AI-free). |
| **DesigniteJava** [25][26] | Java only (C# version is a separate commercial tool **[unverified]**) | 17 design smells, 10 implementation smells, 13 metrics (LOC, CC, PC, NOF, NOPF, NOM, NOPM, WMC, NC, DIT, LCOM, FANIN, FANOUT) | Explicit thresholds in `ThresholdsDTO.java` (§2.7) | **High for thresholds.** It is open (Apache-2.0) and its smell thresholds can be cited. |
| **NDepend** [17] | Native .NET (commercial) | Debt, annual interest, debt ratio, rating, breaking point; CQLinq rules | Debt rating A < 5 % … E ≥ 50 %. 18 man-days per 1000 logical LOC. Example rule CC > 10 gives debt 3 min per point [17] | **Medium.** Its "debt + interest + breaking point" framing helps explain ROI to judges. |
| **rust-code-analysis** (Mozilla) [9][9b] | **No C#** (C, C++, Java, JS, Python, Rust, TS, Mozilla variants) | ABC, BLANK, CC, CLOC, COGNITIVE, HALSTEAD, LLOC, MI, NARGS, NEXITS, NOM, NPA, NPM, PLOC, SLOC, WMC | tree-sitter based (Rust) | **Medium (design).** Its metric catalogue is a good checklist to copy for our C# walker. |
| **Semgrep** [38] | C# "Generally available" in Semgrep Code, "170+ Pro rules" | Pattern rules (security/correctness) | AST pattern matching | **Low–medium.** Pro rules are not AI-free-auditable in our pipeline. We could write a few custom YAML rules, but tree-sitter queries do the same job. |
| **CodeScene** [39–41] | Yes (commercial) | Code Health 1–10 ("25+ factors"), hotspots | Hotspots = high change frequency and low Code Health. KPI = LoC-weighted average of file scores [39]. Thresholds not public on the pages we read | **Medium (concepts).** Biomarker names (Bumpy Road, Brain Method, Complex Conditional…), the **change frequency × health** hotspot idea, and the Code Red evidence [41]. |
| **Codacy** [42] | Yes | Grade A–F = "weighted average" of issues, complexity, duplication, coverage | Weights and cutoffs not published on the FAQ page | **Low.** Formula not public. |
| **CodeCharta** (MaibornWolff) [43] | Via imports (SonarQube, tokei, git log, CSV…) | Any metric mapped to area/height/colour | 3D code city, BSD-3-Clause | **Medium.** Could import our CSV to get a 3D city for free. |
| **Hyperstyle** (JetBrains Research) [20–24] | No C# (Python, Java, Kotlin, JS, Go) | Aggregates linters into five categories and a 4-level grade | Grade = min over rule grades. Thresholds in §3.1 | **Very high (grading model).** |
| **PyTA / PythonTA** [44] | No | Beginner-friendly checks built on pylint, pycodestyle and mypy | No grade documented | Low (education context only). |
| **Understand (SciTools), CodeMR** | Both claim C# **[unverified]** | Metric suites **[unverified]** | Not checked | Low. Commercial, and not needed. |

---

## 2. Per-tool details

### 2.1 lizard: C# reader and empirical behaviour

- **Source.** `lizard_languages/csharp.py` defines `_control_flow_keywords = {'if','for','while','catch'}`, `_logical_operators = {'&&','||'}`, `_case_keywords = {'case'}` and `_ternary_operators = {'?','??'}`. The tokenizer adds `??` as one token. Expression-bodied members (`=>`) are treated as functions. Primary-constructor parameters are skipped. Records are tracked as class scopes [2].
- **CLI defaults** (`lizard_core/options.py`): `-C/--CCN` 15, `-L/--length` 1000, `-a/--arguments` 100. `-m` (modified CCN) counts a switch as 1. `-E` accepts `cpre, wordcount, outside, EIgnoreAssert, NS, halstead, cognitive`. Output options are `--xml`, `--csv`, `-H` (HTML) and `--checkstyle` [3].
- **Measured** on lizard 1.26.0 with `analyze_source_code("a.cs", …)`, one method per case:

| Construct | lizard CCN | Expected (Roslyn rules [31]) | Verdict |
|---|---|---|---|
| plain method | 1 | 1 | ok |
| `if` | 2 | 2 | ok |
| `foreach` | **1** | 2 (Loop) | **bug: `foreach` is not in the keyword set** |
| `do … while` | 2 | 2 | ok |
| `s?.Length` | 2 | 2 (ConditionalAccess) | ok, by accident (`?` token) |
| `int? x = null;` | **2** | 1 | **false positive (`?` in a nullable type)** |
| `x ?? 0` | 2 | 2 (Coalesce) | ok |
| `b ? 1 : 0` | 2 | 2 | ok |
| switch expression, 3 arms | **1** | 4 (3 case clauses + 1) **[unverified for switch-expression arms in Roslyn]** | **gap: `=>` arms not counted** |
| `x is > 0 and < 10 or 42` | 1 | Roslyn only counts bool binary operators [31], so patterns likely 1 **[unverified]**. Sonar S1067 counts `and`/`or` patterns [36] | gap relative to Sonar |
| `try/catch` | 2 | 1 (Roslyn ignores catch [31]). Lizard and Sonar cognitive count it | definition difference |
| lambda / local function containing `if` | 2, folded into the enclosing method | Roslyn assigns anonymous methods to the declaring member [8] | consistent |
| `switch` with 2 `case` + `default` | 3 | 3 | ok |

**Conclusion:** lizard's C# numbers are biased (they miss `foreach` and switch expressions and over-count nullable types). MessagePack uses `foreach` and `int?` heavily, so comparing against lizard would mislead. Use it only as a sanity baseline.

### 2.2 radon formulas (definitions to cite) [5]

- **CC** = decisions + 1. Python constructs: `if`, `elif`, `for`, `while`, `except`, `with`, `assert`, comprehension, `and`/`or` each +1. `else` and `finally` +0.
- **Halstead.** η1/η2 = distinct operators/operands, N1/N2 = totals.
  - Vocabulary η = η1 + η2; Length N = N1 + N2; N̂ = η1 log2 η1 + η2 log2 η2.
  - **V = N log2 η**; **D = (η1/2)(N2/η2)**; **E = D·V**; T = E/18 s; B = V/3000.
- **Maintainability Index.** V = Halstead volume, G = CC, L = SLOC, C = comment % in radians:
  - Original: `MI = 171 − 5.2 ln V − 0.23 G − 16.2 ln L`
  - SEI: `MI = 171 − 5.2 log2 V − 0.23 G − 16.2 log2 L + 50 sin(√(2.4 C))`
  - Visual Studio: `MI = max[0, 100 (171 − 5.2 ln V − 0.23 G − 16.2 ln L)/171]`
  - radon: the VS form plus the `50 sin(√(2.4 C))` comment term. Radon itself calls MI "still a very experimental metric".

### 2.3 Roslyn Metrics (Microsoft.CodeAnalysis.Metrics)

- **MI.** The formula and its rebasing to 0–100 are given above [7]. Colour bands [7]: **0–9 red (low), 10–19 yellow (moderate), 20–100 green (good)**. In code, `NormalizeAndRoundMaintainabilityIndex` computes `max(0, mi)/171*100` and rounds [31].
- **CC.** +1 per `Block`/method-body/constructor-body. Then +1 for each non-implicit `CaseClause, Coalesce, Conditional, ConditionalAccess, Loop`, for `ConditionalAnd`/`ConditionalOr`, and for bool `And`/`Or`. **Catch clauses are not counted** [31]. CA1502 docs describe this as "adding 1 to … branches (such as if, while, and do)" and "case statements in a switch" [30].
- **Halstead in Roslyn.**
  - Operators: binary/unary/compound kinds, member references, initializers, case clauses, assignments, conversions, await, `is`, return/yield with value, and similar.
  - Operands: symbol references and constants.
  - `Volume = Length · max(0, log2(Vocabulary))`. Implicit operations are skipped [32].
- **Analyzer thresholds** (defaults; all disabled by default in .NET 10):
  - **CA1502** CC > 25 [30]
  - **CA1505** MI < 10 [33]
  - **CA1506** class coupling > 95 for types, > 40 for other symbols [34]
  - **CA1501** inheritance depth ≥ 5 [35]
  - All configurable via `CodeMetricsConfig.txt`, e.g. `CA1502(Type): 4` [30].
- **Output.** `msbuild /t:Metrics` produces `<CodeMetricsReport>` XML with `<Metric Name="MaintainabilityIndex|CyclomaticComplexity|ClassCoupling|DepthOfInheritance|SourceLines|ExecutableLines" Value=…/>` per Assembly/Namespace/NamedType/Method, including `File` and `Line` attributes on members [8].
- **Reuse.** Copy the CC rules exactly into the tree-sitter walker so our "Roslyn-compatible CC" can be checked against `Metrics.exe` on MessagePack.

### 2.4 SonarQube C# (sonar-dotnet) rules: thresholds from source

| Rule | Title | Default | Source |
|---|---|---|---|
| S3776 | Cognitive Complexity of methods should not be too high | `threshold` 15, `propertyThreshold` 3. Remediation "Linear with offset", 1 min per point over the threshold, offset 5 min | [14][14b] |
| S1541 | Methods/properties should not be too complex (cyclomatic) | `maximumFunctionComplexityThreshold` 10 | [15] |
| S138 | Methods should not have too many lines | `max` 80 (lines with tokens; comments and blank lines are effectively not counted) | [36b] |
| S107 | Too many parameters | `max` 7 (excludes extern and DI-forwarded parameters; primary constructors handled) | [36a] |
| S1067 | Expression complexity | `max` 3 conditional operators. Counts `&&`, `\|\|`, `?:`, `??=`, pattern `and`/`or`. **`??` is not counted** | [36] |
| S134 | Nesting depth of control flow | `maximumNestingLevel` 3. Nesting nodes: `if` (not `else if`), `for`, `foreach`, `while`, `do`, `switch`, `try` | [37] |

**S3776 C# cognitive complexity algorithm** (`CSharpCognitiveComplexityMetric.cs` [16]), to port onto tree-sitter nodes:

- **+1 plus the current nesting level** for each of: `if_statement` (except an `if` that is the direct child of an `else`), `conditional_expression`, `switch_statement`, `switch_expression`, `for_statement`, `foreach_statement`, `while_statement`, `do_statement`, `catch_clause`, `goto_statement`.
- **+1 with no nesting penalty** for `else`.
- **Nesting level increases** inside all of the above, and also inside `lambda_expression` and `local_function_statement`. Lambdas and local functions add no increment themselves.
- **Logical operators:** +1 for each `&&` or `||` whose left operand is not the same operator kind. So `a && b && c` scores +1 and `a && b || c` scores +2. Pattern `and`/`or` follow the same rule.
- **Recursion:** +1 once per method that calls itself with the same argument count.
- Units analysed: methods, constructors, destructors, operators, field initialisers, and only expression-bodied properties/accessors (against `propertyThreshold`) [14b].

**Sonar quality model** [6]:

- `sqale_debt_ratio = technical debt / (cost to develop one line × LOC)`, with a default of **30 min per line**.
- Maintainability rating: **A ≤ 5 %, B ≥ 5 % to < 10 %, C ≥ 10 % to < 20 %, D ≥ 20 % to < 50 %, E ≥ 50 %**.
- Reliability and security ratings: A = 0 issues, then B/C/D/E = at least one minor/major/critical/blocker issue.
- Duplication for non-Java languages: ≥ **100 successive duplicated tokens** spread over ≥ **10 LOC**. That C# falls under the "non-Java" rule is our inference.
- The default of 15 for S3776 was chosen empirically ("Ten seemed to be a 'noisy' threshold") per a SonarSource community post **[unverified: search snippet only]**.

### 2.5 qlty (formerly Code Climate)

- **Smells defaults** [11]: `boolean_logic` 5, `nested_control_flow` 5, `function_parameters` 5, `return_statements` 6, `file_complexity` 50, `function_complexity` 15, `identical_code` 12 lines, `similar_code` 12 lines. Duplication `nodes_threshold` is 50 AST children nodes.
- **Grades** [10]:
  - Project TDR = debt / rewrite effort, with rewrite effort estimated by **Basic COCOMO** (person-months).
  - Grades: **A < 5 %, B 5–10 %, C 10–20 %, D 20–50 %, F ≥ 50 %**.
  - File/directory grades use "a logarithmic function of total Technical Debt"; the thresholds are not published.
  - Coverage grades: A ≥ 90, B 80–90, C 70–80, D 60–70, F < 60.
- **Complexity** = cognitive complexity, citing Campbell's SonarSource white paper. Loops, conditionals, catch, switch, sequences of logical operators, recursion and label jumps add complexity. Safe navigation (`&.`) does not [12b].
- **C# mapping in source** (`qlty-analysis/src/lang/csharp.rs` [13]):
  - if = `if_statement`; switch = `switch_expression` only; case = `switch_section`
  - loops = `for/foreach/while/do_statement`; except = `catch_clause`
  - jumps = `break/continue/goto_statement`; return = `return_statement`
  - booleans = `&&`, `||` (short-circuit list also includes `??`)
  - functions = **`method_declaration` only**; fields = `field_declaration`, `property_declaration`
  - **Gaps:** constructors, local functions, accessors and lambdas are not treated as functions, and `switch_statement` is not mapped as a switch.
- **Code Climate classic GPA (0–4):** the old docs now redirect to qlty, so the original formula could not be fetched **[unverified]**.

### 2.6 Clone detection: CPD and jscpd

- **CPD** [18]: Karp-Rabin. `--minimum-tokens` is mandatory (examples use 100). For C#, `--ignore-annotations` (attributes), `--ignore-usings` and `--ignore-literal-sequences` are available. Formats: text, xml, csv, csv_with_linecount_per_file, vs, markdown.
- **jscpd v5** [19][19b]:
  - Rolling-hash Rabin-Karp; defaults min-tokens **50**, min-lines **5**, mode `mild`.
  - Clone classes: exact, renamed (`--ignore-identifiers` / `--ignore-literals`), similar (gap merging or AST Jaccard), and semantic (embeddings; experimental; **not AI-free**).
  - AST similarity: normalise each function's tree (locals, params, fields and literals become markers; called names and operators kept), fingerprint every subtree, then score = |A∩B|/|A∪B|, default 0.8, min-nodes 20.
  - 15 reporters including `sarif`, `json`, `html` and `codeclimate`.
- **SIG duplication** [27]: % of code in blocks of **≥ 6 identical lines**, ignoring leading whitespace.

### 2.7 DesigniteJava thresholds (`ThresholdsDTO.java`) [26]

| Field | Default |
|---|---|
| complexCondition | 3 |
| complexMethod | 8 |
| longIdentifier | 30 |
| longMethod | 100 |
| longParameterList | 5 |
| longStatement | 120 |
| imperativeAbstractionLargeNumOfLines | 50 |
| multifacetedAbstractionLargeLCOM | 0.8 |
| multifacetedAbstractionManyFields / ManyMethods | 7 / 7 |
| unnecessaryAbstractionFewFields | 5 |
| deepHierarchy / wideHierarchy | 6 / 10 |
| brokenModularizationLargeFieldSet | 5 |
| hubLikeModularizationLargeFanIn / FanOut | 20 / 20 |
| insufficientModularizationLargePublicInterface | 20 |
| insufficientModularizationLargeNumOfMethods | 30 |
| insufficientModularizationHighComplexity | 100 |

Catalogue [25]:
- **Design smells:** Imperative / Multifaceted / Unnecessary / Unutilized Abstraction; Deficient / Unexploited Encapsulation; Broken / Cyclic-Dependent / Insufficient / Hub-like Modularization; Broken / Cyclic / Deep / Missing / Multipath / Rebellious / Wide Hierarchy.
- **Implementation smells:** Abstract Function Call From Constructor, Complex Conditional, Complex Method, Empty catch clause, Long Identifier, Long Method, Long Parameter List, Long Statement, Magic Number, Missing default.

Most implementation smells can be detected purely syntactically with tree-sitter. Design smells need cross-file symbol resolution, which is approximate without Roslyn.

### 2.8 NDepend debt model [17]

- Severity comes from annual interest: Low < 2 min/yr, Medium < 20 min, Major < 2 h, Critical < 10 h, Blocker > 10 h.
- Debt ratio = debt / rewrite effort, with a default of 18 man-days per 1000 logical LOC. Rating A < 5 %, B 5–10 %, C 10–20 %, D 20–50 %, E ≥ 50 %.
- Breaking point = debt / annual interest.
- Example CQLinq rule: `CyclomaticComplexity > 10`, Debt = 3·(CC − 10) minutes, interest 10 min/yr if 100 % covered, else 120.

### 2.9 CodeScene

- Code Health is "an aggregated metric based on 25+ factors". Files are Green/Yellow/Red, and KPIs are LoC-weighted averages; rule weights are configurable in JSON [39].
- The scale runs 1–10 ("Ten indicates very maintainable code") [40]. **Band cutoffs were not on the pages we fetched [unverified]**.
- Factors named [39]:
  - Module: Low Cohesion (LCOM4), Brain Class, Developer Congestion, LoC.
  - Function: Brain Method, DRY violations, Complex Method, Primitive Obsession, Large Method.
  - Implementation: Nested Complexity, Bumpy Road, Complex Conditional, Large/Duplicated Assertion Blocks.
- Hotspots start from "files with high change frequency and low Code Health". The map shows folders as nested circles, and redder means lower health [39b].
- **Evidence for judges (Code Red, Tornhill & Borg, TechDebt 2022)** [41]: across 39 proprietary codebases, low-quality code had "15 times more defects", needed "124% more time in development" and showed "9 times longer maximum cycle times".

---

## 3. Grading formulas

### 3.1 Hyperstyle (JetBrains Research / Hyperskill, SIGCSE 2022) [20–24]

- **Categories.** CODE_STYLE, BEST_PRACTICES, ERROR_PRONE, COMPLEXITY, INFO [21]. The paper adds that minor issues (INFO) do not reduce the grade [20].
- **Grade.** `Quality = min(rule.quality for rule in rules)` with BAD = 0, MODERATE = 1, GOOD = 2, EXCELLENT = 3 (`model.py`) [24].
- **Rules.** 15 rules [23]: ErrorProne, BestPractices, Complexity, CyclomaticComplexity, BooleanExpression, FunctionLength, InheritanceDepth, MethodNumber, Coupling, Response, WeightedMethods, Cohesion, Maintainability, CodeStyle, LineLength.

Thresholds (Java column unless noted; all comparisons strict `>`):

| Rule | BAD if > | MODERATE if > | GOOD if > | else | Source |
|---|---|---|---|---|---|
| Cyclomatic complexity (per function) | Java 14, Python 10, Kotlin 12 | Java 13, Py 9, Kt 11 | (none) | EXCELLENT | [22a] |
| Function length (lines) | Java/Kt/JS/Go 69, Python 49 | (none) | (none) | EXCELLENT | [22b] |
| Boolean expression length (operators) | 6 (Kotlin 9) | 5 (Kt 7) | 3 (Kt 5) | EXCELLENT | [22c] |
| Error-prone issues (count) | 0 (any issue → BAD) | (none) | (none) | EXCELLENT | [22d] |
| Best-practice issues per file | (none) | 4 | 1 | EXCELLENT | [22e] |
| Maintainability "lack" (100 − MI-like) | 90 | 80 | 50 (Go 70) | EXCELLENT | [22f] |
| Code-style ratio (style-affected lines / (lines − 4); Python uses lines) | Java 0.23, Py 0.35, Kt 0.16 | 0.17 (Kt 0.07) | 0 | EXCELLENT; also BAD if style lines > 10 (Py 5) | [22g] |
| Line-length ratio | 0.07 | 0.05 | 0.035 | EXCELLENT. Note: a code bug overwrites BAD with MODERATE | [22h] |

- **Repeat-offence penalty** (`penalty.py`) [22i]:
  - k = Σ category_weight × previous occurrences, over issues present both before and now. Normalised as **k/(k+n)**, where n = number of current issues.
  - Drop 0/1/2/3 levels for normalised values < 0.5 / < 0.7 / < 0.9 / ≥ 0.9.
- **Threshold tuning.** Thresholds were set by three experts, lowered for complexity and error-proneness for student code, and validated on about one million solutions [20].

**Why it fits us:** it is explainable and monotone, with one bad dimension capping the grade. It is not compensatory, so an agent cannot hide a security or error-prone issue behind good style.

### 3.2 Technical-debt-ratio grading (Sonar / qlty / NDepend)

`TDR = Σ remediation_minutes / (LOC × minutes_per_LOC)`

| Source | minutes_per_LOC / rewrite effort | A | B | C | D | E/F |
|---|---|---|---|---|---|---|
| SonarQube [6] | 30 min/LOC | ≤ 5 % | 5–10 % | 10–20 % | 20–50 % | E ≥ 50 % |
| qlty [10] | Basic COCOMO | < 5 % | 5–10 % | 10–20 % | 20–50 % | F ≥ 50 % |
| NDepend [17] | 18 man-days / 1000 LLOC | < 5 % | 5–10 % | 10–20 % | 20–50 % | E ≥ 50 % |

Remediation functions are per rule. For example, S3776 costs 5 min + 1 min per point over 15 [14], and NDepend's CC rule costs 3 min per point over 10 [17].

### 3.3 SIG maintainability model (Heitlager, Kuipers, Visser, QUATIC 2007) [27]

- **Scale:** ++ / + / o / − / −−.
- **Unit complexity risk bands** (SEI): CC 1–10 simple, low risk; 11–20 moderate risk; 21–50 high risk; > 50 untestable, very high risk.
- **Risk profile** = % of LOC in units of each band. Complexity rating uses maximum relative LOC:

| rank | moderate | high | very high |
|---|---|---|---|
| ++ | 25 % | 0 % | 0 % |
| + | 30 % | 5 % | 0 % |
| o | 40 % | 10 % | 0 % |
| − | 50 % | 15 % | 5 % |
| −− | (otherwise) | | |

- **Unit size** uses the same scheme with different thresholds, which the 2007 paper does not list [27]. The later "Guidance for producers" PDF has them, but its fonts were not text-extractable **[unverified]**.
- **Duplication:** ++ 0–3 %, + 3–5 %, o 5–10 %, − 10–20 %, −− 20–100 % (blocks of ≥ 6 lines).
- **Volume (Java KLOC / man-years):** ++ 0–66 / 0–8; + 66–246 / 8–30; o 246–665 / 30–80; − 655–1,310 / 80–160; −− > 1,310 / > 160. The paper's table prints 655 in the − row even though the o row ends at 665; we reproduce it as printed.
- **Unit test coverage:** ++ 95–100 %, + 80–95 %, o 60–80 %, − 20–60 %, −− 0–20 %.
- **Aggregation:** properties map to ISO 9126 sub-characteristics (analysability, changeability, stability, testability). Each sub-characteristic score is the **weighted average of the relevant property scores, with equal weights by default** (Fig. 3). Cell positions were reconstructed from extracted text; verify against the PDF.
- **2026 SIG model changes** [27b]: **Volume removed** from the rating, and aggregation changed from arithmetic mean to a **power mean** ("less sensitive to a single outlier").
- **Better Code Hub** (SIG's 10-guideline pass/fail service) has retired and been replaced by Sigrid [27c]. Its ten guidelines are from the book *Building Maintainable Software*: short units, simple units, write code once, small unit interfaces, separate concerns, loose coupling, balanced components, small codebase, automated tests, clean code. Their numeric pass thresholds could not be fetched (O'Reilly returned 403) **[unverified]**.

### 3.4 Proposal: per-practice score and overall grade for our certifier

This is our design, built from the verified building blocks above.

1. **Per unit u** (method, constructor, accessor, local function, lambda body), compute the measurable metrics from tree-sitter: CC (Roslyn rules), cognitive complexity (Sonar rules), LOC, parameter count, nesting depth, boolean-operator count.
2. **Per practice p**, assign each unit a SIG-style risk band from cited thresholds. Example for cognitive complexity: ≤ 15 ok (S3776). Bands above 15 are our own choice and must be documented.
3. **Practice score (0–100):**
   - Risk-profile practices: `score_p = 100 × (1 − Σ_b w_b × LOC_share_b)`, or map the SIG table to ++…−− and then to 5..1.
   - Count practices (error-prone, empty catch, magic numbers): use a Hyperstyle-style ratio per KLOC.
4. **Overall certificate:** Hyperstyle **min** over practice grades (non-compensatory). Alongside it, report the SIG 2026-style **power mean** `M_p = (Σ s_i^p / n)^(1/p)`. Choosing p < 1 penalises low outliers; the value of p is ours to choose.
5. **PR mode:** compute the delta (head − base) per practice, and mark only units touched by the diff. Each finding carries `baselineState` = new / unchanged / updated / absent, following SARIF [29].

---

## 4. tree-sitter C#: packages, API, node types, gaps

### 4.1 Packages and API

- **`tree-sitter-c-sharp` on PyPI** [46]: latest **0.23.5 (Apr 14, 2026)**, Python ≥ 3.9. The `pyproject.toml` extra is `core = ["tree-sitter~=0.22"]` [47].
- **`tree-sitter` (py-tree-sitter)** [48]: **0.26.1 (Nov 9, 2026)**, Python ≥ 3.10. Usage:
  ```python
  import tree_sitter_c_sharp as tscs
  from tree_sitter import Language, Parser, Query, QueryCursor
  CS = Language(tscs.language()); parser = Parser(CS)
  tree = parser.parse(src_bytes)
  caps = QueryCursor(Query(CS, "(method_declaration name: (identifier) @n)")).captures(tree.root_node)
  ```
- **[measured]** In this worktree, `.venv` has tree-sitter 0.26.1 + tree-sitter-c-sharp 0.23.5, `Language.abi_version == 15`, and lizard 1.26.0.
- **Grammar README** [45]: "supports C# 1 through 14.0" except that `async`/`var`/`await` cannot be identifiers everywhere and file-based-app directives (`#:package` etc.) are not recognised. The PyPI 0.23.5 build does **not** parse C# 14 extension blocks or null-conditional assignment **[measured]**, so the release lags the README.

### 4.2 Node types (verified in grammar.js [45b] and our parse output)

- **Types:** `class_declaration`, `struct_declaration`, `interface_declaration`, `enum_declaration`, `record_declaration`. Record structs are the same node with a `struct` token. No dedicated primary-constructor node exists: a `parameter_list` child sits on the class/struct/record, and records add `primary_constructor_base_type`.
- **Members:** `method_declaration` (fields `returns`, `name`, `type_parameters`, `parameters`, `body`), `constructor_declaration`, `destructor_declaration`, `operator_declaration`, `conversion_operator_declaration`, `property_declaration`, `accessor_declaration`, `field_declaration`, `local_function_statement`, `lambda_expression`, `anonymous_method_expression`.
- **Control flow:** `if_statement`, `switch_statement`, `switch_section`, `switch_expression`, `switch_expression_arm`, `when_clause`, `for_statement`, `foreach_statement`, `while_statement`, `do_statement`, `try_statement`, `catch_clause`, `catch_filter_clause`, `finally_clause`, `goto_statement`, `break_statement`, `continue_statement`, `return_statement`, `throw_statement`, `using_statement`, `lock_statement`.
- **Expressions:** `conditional_expression`, `binary_expression` (operator child `&&`, `||`, `??`…), `conditional_access_expression`, `is_pattern_expression`, `and_pattern`, `or_pattern`, `relational_pattern`, `list_pattern`, `declaration_pattern`, `constant_pattern`, `collection_expression`, `raw_string_literal`.
- **Namespaces:** `namespace_declaration`, `file_scoped_namespace_declaration`.
- **Trivia:** `comment` (extra; both `//` and `/* */`). Preprocessor: `preproc_if`/`preproc_elif`/`preproc_else`, `preproc_region`/`preproc_endregion`, `preproc_pragma`, `preproc_nullable`, `preproc_define`, and others.

### 4.3 Modern-syntax smoke test [measured]

**Parses with 0 errors:** file-scoped namespace, `record` / `readonly record struct` with positional parameters, primary-constructor class, collection expression `[1, 2, ..b]`, switch expression with `when`, list pattern `[1, .., > 3]`, raw string `"""…"""`, `required`/`init`, `and`/`or` patterns, static abstract interface members, local function and lambda, `?.` / `??`, `fixed` / `stackalloc`, `ref struct` with `ref` field, and C# 14 `field` keyword.

**Fails** (has_error): C# 14 `extension(string s) { … }` blocks and `c?.X = 1;`.

### 4.4 MessagePack-CSharp corpus parse [measured]

- 681 `.cs` files. **34** contain ERROR/MISSING nodes, 27 of 190 under `src/`. 607 files start with a UTF-8 BOM, which is not the cause: stripping it changes nothing.
- Blanking `#elif`/`#else` branches while keeping line numbers (a "keep first branch" preprocessor) drops this to **20** files.
- Remaining root causes, from the smallest ERROR node per file:
  - **Pointer deref of a cast:** `*(uint*)p`, `*(float*)&x`, `*(int*)(pDst + 0) = …`. About 10 files (LZ4, FarmHash, UnsafeMemory, Primitives readers/writers).
  - **Assignment to a ref-returning call:** `Unsafe.Add(ref output, i) = true;`, `Unsafe.As<byte,T>(ref span[0]) = value;`, `original.PrivateFieldAccessor() = 3;`.
  - `internal ref partial struct SequenceReader<T>`.
  - LINQ `select (INamedTypeSymbol)x` cast after `select`.
  - `sandbox/TestData.InvalidSyntax` (intentionally invalid).
- **Mitigation:**
  - Report a per-file `parse_confidence = 1 − error_bytes/file_bytes`.
  - Exclude ERROR subtrees from metrics, but keep the enclosing unit's metrics where the unit node itself parsed.
  - Preprocess `#if` by keeping the first branch.
  - Never fail the certificate because of parser gaps; list them in an "analysis limitations" section.

### 4.5 Suggested tree-sitter → metric mapping

| Metric | Nodes |
|---|---|
| Roslyn-compatible CC (+1 each) | `if_statement`, `conditional_expression`, `for/foreach/while/do_statement`, `switch_section` labels (`case`, but not `default`, per Roslyn CaseClause semantics **[unverified for default]**), `switch_expression_arm` (except a discard `_` arm **[our choice]**), `binary_expression[op ∈ &&, \|\|, ??]`, `conditional_access_expression`, plus `??=` **[our choice]**. Exclude `catch_clause` for Roslyn parity, and count it in cognitive complexity. |
| Sonar cognitive complexity | §2.4 list. Nesting via ancestors among the nesting kinds + `lambda_expression` + `local_function_statement`. `else` detected as the `alternative` field of `if_statement`. |
| Nesting depth (S134) | Ancestors among `if` (not `else if`), `for`, `foreach`, `while`, `do`, `switch_statement`, `try_statement` |
| Parameters (S107) | Named children of `parameters` (`parameter_list`) |
| LOC (S138) | Distinct rows covered by non-comment leaf tokens inside `body` |
| Expression complexity (S1067) | Count of `&&`, `\|\|`, `?:`, `??=`, `and_pattern`, `or_pattern` inside one top-level expression. `??` excluded |
| Halstead | Operators = anonymous leaf tokens that are operators or keywords; operands = `identifier` and literal leaves. Note the SIG paper's warning: "no consensual definition of what constitutes an operator or an operand in a language such as Java or C#" [27] |
| Empty catch, missing default, magic number | `catch_clause` with an empty `block`; `switch_statement` without `default`; numeric literal outside `const`/`enum`/±0,1 |

---

## 5. Visualisations

| Visual | How it encodes quality | Source | Use for us |
|---|---|---|---|
| CodeScene hotspot map | Nested circles (folders contain files). Red = low Code Health. Hotspot = high change frequency and low health | [39b] | Circle packing via d3-hierarchy `pack()`. Size = LOC, colour = worst practice score, outline = git churn |
| CodeCharta code city | Each file is a building. The user picks area, height and colour metrics (LoC, complexity, commits, authors…) | [43] | Free 3D city from our CSV export |
| CodeCity (Wettel) | Classes are buildings, packages are districts. Metrics drive building properties | [44b] | Inspiration only (Smalltalk/Moose) |
| SonarQube treemap | Rectangle area = size, colour = a rating or metric **[unverified]** | (none) | Squarified treemap per file/namespace |
| Line-level heatmap | GitHub-style gutter annotations; SARIF regions → per-line colour | [28][29] | **Main deliverable**: per practice, colour each line by the state of the smallest unit that contains it |

**Proposal: HTML heatmap design** (single static file, no server):

- **Left:** namespace/file tree with per-practice mini bars.
- **Centre:** source view where each line's background = `hsl(…)` of the selected practice's unit score. A practice selector covers complexity, size, nesting, params, duplication, error-prone and naming.
- **Gutter:** icons for fail findings. Hover shows the rule ID (e.g. `S3776`), measured value vs threshold, the increments ("+1 if (nesting 2) at L42"), and the source citation.
- **Top:** practice score cards and the overall grade, both min-aggregated and power-mean.
- **Diff mode:** greys out untouched lines in PR mode.

Embed the JSON in a `<script type="application/json">` block so the page works offline.

---

## 6. Output formats

### 6.1 JSON (canonical, versioned)

```json
{
  "schema": "qlab.report/1",
  "tool": {"name": "qlab", "version": "x.y", "parser": {"tree-sitter": "0.26.1", "tree-sitter-c-sharp": "0.23.5", "abi": 15}},
  "target": {"repo": "...", "commit": "...", "base": "...", "mode": "full|pr"},
  "practices": [{"id": "cognitive-complexity", "refs": ["S3776"], "threshold": 15,
                  "score": 87.5, "grade": "GOOD", "risk_profile": {"low": 0.81, "moderate": 0.12, "high": 0.05, "very_high": 0.02}}],
  "units": [{"file": "src/...cs", "kind": "method_declaration", "name": "Foo.Bar", "start": [10,5], "end": [60,6],
             "metrics": {"cc": 7, "cognitive": 12, "loc": 48, "params": 3, "nesting": 2},
             "increments": [{"line": 14, "rule": "if", "delta": 2, "nesting": 1}]}],
  "findings": [{"practice": "cognitive-complexity", "kind": "fail", "level": "warning", "file": "...", "region": {"startLine": 10, "endLine": 60},
                "value": 22, "threshold": 15, "message": "..."}],
  "limitations": [{"file": "...", "parse_confidence": 0.97, "reason": "pointer-deref cast not supported by tree-sitter-c-sharp 0.23.5"}],
  "grade": {"overall": "MODERATE", "aggregation": "min", "power_mean": {"p": 0.5, "value": 71.2}}
}
```

### 6.2 SARIF 2.1.0

The `result` object [29]:
- `kind` ∈ {notApplicable, **pass**, **fail**, review, open, informational}, default fail.
- `level` ∈ {none, note, warning, error}, default warning.
- `rank` ∈ [−1, 100], which can carry the score.
- `baselineState` ∈ {new, unchanged, updated, absent}, for PR deltas.
- `properties` is a free property bag with `tags`.
- `region`: startLine, startColumn, endLine, endColumn (endColumn is "the column number of the character following the end"), and `snippet`.

GitHub code scanning [28]:
- **Only 2.1.0.** Results need `message.text`, `locations`, and `partialFingerprints.primaryLocationLineHash`. The `upload-sarif` action can compute the fingerprint; the API cannot.
- Rule `id` is required. Recommended: `help.markdown`, `properties.precision` (very-high/high/medium/low) and `properties.problem.severity` (error/warning/recommendation). `defaultConfiguration.level` ∈ note/warning/error. Up to 20 tags (10 displayed).
- **Limits:** 10 MB gzip per file, 20 runs per file, 25,000 results per run (only the top 5,000 by severity are shown), 25,000 rules, 1,000 locations per result (100 kept).
- The docs do not say how `kind: pass` is shown. Upload a failures-only SARIF to GitHub, and keep `report.full.sarif` with pass results for our heatmap.

**Proposal: field mapping.**
- One `reportingDescriptor` per practice, with `id` = our practice id and `properties.tags` = [`maintainability`, `S3776`, `SIG-unit-complexity`]. `help.markdown` explains the formula and cites its source.
- One `result` per unit × practice. `kind` is pass/fail. `level` is none for pass, warning for over-threshold, error for the very-high band. `rank` = unit score.
- `properties`: `{value, threshold, band, increments[]}`.

### 6.3 Other

- **Checkstyle XML / Code Climate JSON:** lizard emits checkstyle [3] and jscpd has a `codeclimate` reporter [19]. These are optional and only matter for CI integrations.
- **CSV:** for CodeCharta import [43].

---

## 7. Hackathon and education judging of code quality

- **MLH** organiser guide: it lists no recommended judging criteria and does not mention code quality. Code is mentioned only for cheating checks and follow-up [49].
- **Devpost:** its default criteria could not be verified (the help URL returned 404) **[unverified]**.
- **Hyperstyle** (SIGCSE 2022) is the best-documented automated code-quality grader in education. It runs on JetBrains Academy / Hyperskill, and its thresholds were validated on about 1 M submissions [20]. A follow-up paper on submission quality (arXiv 2301.11158) appeared in search results; title only, not read **[unverified content]**.
- **PythonTA** (University of Toronto) builds on pylint, pycodestyle and mypy to give beginner-friendly feedback. The pages we read document no grade [44].
- **Implication for the pitch:** hackathons generally do not score code quality mechanically, so a reproducible, cited, deterministic certificate stands out. We should cite the sources (Sonar/Roslyn/SIG/Hyperstyle) inline in the HTML so judges can audit every number.

---

## 8. References

1. lizard README. https://github.com/terryyin/lizard
2. lizard C# reader. https://raw.githubusercontent.com/terryyin/lizard/master/lizard_languages/csharp.py
3. lizard options. https://raw.githubusercontent.com/terryyin/lizard/master/lizard_core/options.py
4. lizard extensions doc. https://github.com/terryyin/lizard/blob/master/docs/extensions-and-warnings.rst
   - 4b. lizard C# tests. https://raw.githubusercontent.com/terryyin/lizard/master/test/test_languages/testCsharp.py
5. radon docs (intro: CC, MI, Halstead). https://radon.readthedocs.io/en/latest/intro.html
6. SonarQube metrics definitions. https://docs.sonarsource.com/sonarqube-server/user-guide/code-metrics/metrics-definition
7. Visual Studio, Maintainability index range and meaning. https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning
8. Visual Studio, Generate code metrics (CLI, XML format); Code metrics values. https://learn.microsoft.com/en-us/visualstudio/code-quality/how-to-generate-code-metrics-data and https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-values
9. rust-code-analysis languages. https://mozilla.github.io/rust-code-analysis/languages.html
   - 9b. rust-code-analysis metrics. https://mozilla.github.io/rust-code-analysis/metrics.html
   - Repo and paper (SoftwareX 12, 2020). https://github.com/mozilla/rust-code-analysis
10. qlty maintainability metrics and grades. https://docs.qlty.sh/cloud/maintainability/metrics
11. qlty.toml smells defaults. https://docs.qlty.sh/cli/qlty-toml
12. qlty CLI README (languages, licence). https://github.com/qltysh/qlty
    - 12b. qlty complexity. https://docs.qlty.sh/complexity
    - 12c. qlty code smells. https://docs.qlty.sh/code-smells
13. qlty C# tree-sitter mapping. https://raw.githubusercontent.com/qltysh/qlty/main/qlty-analysis/src/lang/csharp.rs
14. sonar-dotnet S3776 metadata. https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/rspec/cs/S3776.json
    - 14b. CognitiveComplexityBase (thresholds 15/3). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.Core/Rules/CognitiveComplexityBase.cs
    - C# rule (nodes analysed). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.CSharp/Rules/CognitiveComplexity.cs
15. sonar-dotnet S1541 FunctionComplexity (10). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.CSharp/Rules/FunctionComplexity.cs
16. sonar-dotnet C# cognitive complexity walker. https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.CSharp/Metrics/CSharpCognitiveComplexityMetric.cs
17. NDepend technical debt. https://www.ndepend.com/docs/technical-debt
18. PMD CPD docs. https://pmd.github.io/pmd/pmd_userdocs_cpd.html
19. jscpd README. https://github.com/kucherenko/jscpd
    - 19b. jscpd Rust CLI reference. https://github.com/kucherenko/jscpd/blob/master/docs/rust.md
20. Birillo et al., "Hyperstyle: A Tool for Assessing the Code Quality of Solutions to Programming Assignments", SIGCSE 2022. https://ar5iv.labs.arxiv.org/html/2112.02963 (arXiv 2112.02963)
21. Hyperstyle README. https://github.com/hyperskill/hyperstyle
22. Hyperstyle rule sources (`hyperstyle/src/python/review/quality/rules/`):
    - a. cyclomatic_complexity_scoring.py
    - b. function_length_scoring.py
    - c. boolean_length_scoring.py
    - d. error_prone_scoring.py
    - e. best_practices_scoring.py
    - f. maintainability_scoring.py
    - g. code_style_scoring.py
    - h. line_len_scoring.py
    - i. `../penalty.py`
    - All under https://raw.githubusercontent.com/hyperskill/hyperstyle/main/hyperstyle/src/python/review/quality/rules/
23. Hyperstyle evaluate_quality.py. https://raw.githubusercontent.com/hyperskill/hyperstyle/main/hyperstyle/src/python/review/quality/evaluate_quality.py
24. Hyperstyle model.py (min aggregation, 0–3 mapping). https://raw.githubusercontent.com/hyperskill/hyperstyle/main/hyperstyle/src/python/review/quality/model.py
25. DesigniteJava README. https://github.com/tushartushar/DesigniteJava
26. DesigniteJava ThresholdsDTO.java. https://raw.githubusercontent.com/tushartushar/DesigniteJava/master/src/Designite/smells/ThresholdsDTO.java
27. Heitlager, Kuipers, Visser, "A Practical Model for Measuring Maintainability", QUATIC 2007. https://softwareimprovementgroup.com/wp-content/uploads/APracticalModelForMeasuringMaintainability.pdf (text extracted locally)
    - 27b. SIG 2026 model changes. https://raw.githubusercontent.com/Software-Improvement-Group/sigridci/main/docs/reference/quality-model-documents/2026-model-changes.md
    - SIG quality model index. https://raw.githubusercontent.com/Software-Improvement-Group/sigridci/main/docs/reference/sig-quality-models.md
    - 27c. Better Code Hub retirement notice. https://bettercodehub.com/
28. GitHub, SARIF support for code scanning. https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
29. OASIS SARIF 2.1.0 JSON schema. https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json
30. CA1502. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1502
31. Roslyn MetricsHelper.cs (CC kinds, MI normalisation). https://raw.githubusercontent.com/dotnet/roslyn/main/src/RoslynAnalyzers/Utilities/Compiler/CodeMetrics/MetricsHelper.cs
32. Roslyn ComputationalComplexityMetrics.cs (Halstead). https://raw.githubusercontent.com/dotnet/roslyn/main/src/RoslynAnalyzers/Utilities/Compiler/CodeMetrics/ComputationalComplexityMetrics.cs
33. CA1505. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1505
34. CA1506. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1506
35. CA1501. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1501
36. sonar-dotnet ExpressionComplexityBase (S1067 = 3) and C# ExpressionComplexity.cs. https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.Core/Rules/ExpressionComplexityBase.cs and https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.CSharp/Rules/ExpressionComplexity.cs
    - 36a. TooManyParametersBase (S107 = 7). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.Core/Rules/TooManyParametersBase.cs
    - 36b. MethodsShouldNotHaveTooManyLinesBase (S138 = 80). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.Core/Rules/MethodsShouldNotHaveTooManyLinesBase.cs
37. sonar-dotnet FunctionNestingDepthBase (S134 = 3) and C# walker. https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.Core/Rules/FunctionNestingDepthBase.cs
38. Semgrep supported languages. https://docs.semgrep.dev/supported-languages
39. CodeScene Code Health guide. https://codescene.io/docs/guides/technical/code-health.html
    - 39b. CodeScene Hotspots guide. https://codescene.io/docs/guides/technical/hotspots.html
40. CodeScene Code Health product page. https://codescene.com/product/code-health
41. Tornhill & Borg, "Code Red: The Business Impact of Code Quality", TechDebt 2022. https://arxiv.org/abs/2203.04374
42. Codacy metrics FAQ. https://docs.codacy.com/faq/code-analysis/which-metrics-does-codacy-calculate/
43. CodeCharta. https://github.com/MaibornWolff/codecharta
44. PythonTA docs. https://www.cs.toronto.edu/~david/pyta/ and repo https://github.com/pyta-uoft/pyta
    - 44b. CodeCity (Wettel). https://wettel.github.io/codecity.html
45. tree-sitter-c-sharp README. https://github.com/tree-sitter/tree-sitter-c-sharp
    - 45b. grammar.js. https://raw.githubusercontent.com/tree-sitter/tree-sitter-c-sharp/master/grammar.js
46. tree-sitter-c-sharp on PyPI. https://pypi.org/project/tree-sitter-c-sharp/
47. tree-sitter-c-sharp pyproject.toml. https://raw.githubusercontent.com/tree-sitter/tree-sitter-c-sharp/master/pyproject.toml
48. py-tree-sitter on PyPI. https://pypi.org/project/tree-sitter/
49. MLH organiser guide, judging plan. https://guide.mlh.com/general-information/judging-and-submissions/judging-plan

**Local experiment scripts** (scratchpad, not part of the repo): `ts_smoke.py`, `ts_corpus.py`, `ts_err.py`, `ts_pp.py`, `lizard_cs.py` under `/private/tmp/claude-501/-Users-meulencv--claude-spares-spare-xg9XFS/df5376e9-0494-49c9-aebe-d3dd39b1dad1/scratchpad/scripts/`. They were run with `.venv/bin/python -I` against `corpus/messagepack-csharp`.
