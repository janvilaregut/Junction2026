# 10 — C#/.NET-specific measurable rules and a benchmark corpus for calibration

Retrieved: 2026-11-14. Scope: (A) exact, checkable C#/.NET quality rules and thresholds (Microsoft code metrics, CA/IDE analyzers, Framework Design Guidelines naming, StyleCop documentation rules, NDepend defaults), with notes on how each maps to a tree-sitter (syntax-only, no semantic model) implementation; (B) a calibration corpus of well-regarded C# libraries plus existing C# datasets usable for predictive-validity checks.

Conventions: every number below comes from a source I opened (reference numbers in brackets). Anything I could not open or confirm is marked **[unverified]**. "Syntactic" = computable from a tree-sitter CST alone; "needs semantics" = needs symbol/type resolution (Roslyn), so a tree-sitter tool can only approximate it.

---

## 0. TL;DR — the numbers worth hard-coding

| Rule / metric | Default threshold (source) | Fires when | Tree-sitter feasibility |
|---|---|---|---|
| Maintainability Index (VS) | red 0–9, yellow 10–19, green 20–100 [2] | — | Approximate (needs Halstead from IOperation; reproducible approx.) |
| CA1505 unmaintainable code | MI < 10 [6] | type/method/field/property/event MI < 10 | Approximate |
| CA1502 excessive complexity | CC > 25 per method [4] | method CC > 25 | Syntactic (good approximation) |
| CA1501 excessive inheritance | 5 [5] | type ≥ 5 levels deep, i.e. VS DIT ≥ 6 (System.* excluded) | Partially (same-repo hierarchy only; rule itself limits to same module) |
| CA1506 excessive class coupling | 95 types / 40 other symbols [7] | > threshold unique type refs | Needs semantics (approximate by distinct type identifiers) |
| NIST/McCabe CC guidance cited by VS docs | 10 (up to 15 "successfully used") [9] | — | Syntactic |
| VS docs class-coupling guidance (Shatnawi 2010) | CBO = 9 [10] | — | Approximate |
| NDepend ND1003 methods too big/complex | ILNestingDepth > 2 AND CC > 17 (non-async) [26] | — | Syntactic (nesting depth from CST) |
| NDepend ND1004 too many params | ≥ 8 parameters [26] | — | Syntactic |
| NDepend ND1000 type too big | > 200 LOC (logical, JustMyCode) [26] | — | Syntactic (statement count) |
| NDepend ND1001 too many methods | > 20 methods (excl. accessors), only if ≥1 non-const field [26] | — | Syntactic |
| NDepend ND1002 too many fields | > 15 (non-const, non static-readonly) [26] | — | Syntactic |
| NDepend ND1007 poor cohesion | LCOM > 0.91 AND >10 fields AND >10 methods (and >8 after filtering) [26] | — | Syntactic approximation |
| NDepend ND1008 too many locals | > 15 variables [26] | — | Syntactic |
| NDepend ND1009 unmaintainable | LOC ≥ 30 AND MI ≤ 35 AND CC ≥ 20 [26] | — | Approximate |
| NDepend ND1200 interface too big | ≥ 14 members [26] | — | Syntactic |
| NDepend ND1202 deep inheritance | ≥ 4 non-third-party base classes [26] | — | Partially |
| CA2200 rethrow | `throw ex;` of the caught variable inside catch [12] — **on as warning in .NET 10** | — | Syntactic |
| CA1031 catch general exception | `catch (Exception)`, `catch (SystemException)`, bare `catch` [11] — unless the catch ends with a rethrow | — | Syntactic |
| CA1051 visible instance fields | non-private instance field in externally visible type [14] | — | Syntactic |
| SA1600 / SA1611 / SA1615 | missing doc header / `<param>` / `<returns>` [21][22][23] | — | Syntactic |

MessagePack-CSharp itself (the target) silences SA1600 and keeps SA1611/SA1615/CA1062/CS1591 at **suggestion** — i.e. documentation completeness is *not* a build gate in that repo [19]. It also uses StyleCop field style (camelCase, no underscore, `this.` qualification), not the dotnet/runtime `_camelCase` style — see §A3.

---

## PART A — C#/.NET-specific measurable best practices

### A1. Microsoft code metrics (Visual Studio / Microsoft.CodeAnalysis.Metrics)

The metrics are documented in [1] and implemented in the open-source Roslyn analyzers repo (`src/Utilities/Compiler/CodeMetrics/`), which I read directly [3]. Where documentation and code differ in detail, the code is what produces the numbers.

#### A1.1 Maintainability Index (MI)

- **Documented formula (0–100 rescale)** [2]:
  `MI = MAX(0, (171 − 5.2·ln(HalsteadVolume) − 0.23·CC − 16.2·ln(LinesOfCode)) · 100 / 171)`
  The original unbounded formula was `171 − 5.2·ln(HV) − 0.23·CC − 16.2·ln(LOC)`; Microsoft clamped ≤0 to 0 and rebased 171 → 100 [2].
- **Thresholds** [2] (also restated in [1]): 0–9 red "low maintainability", 10–19 yellow "moderate", 20–100 green "good". Microsoft says it "decided to be conservative": red should mean "a high degree of confidence that there was an issue" and the 0–100 range was split "80-20 to keep the noise level low" [2].
- **What the implementation actually feeds in** [3] (`CodeAnalysisMetricData.MethodMetricData.cs`, `MetricsHelper.cs`):
  - Method MI: `171 − 5.2·max(0, ln(Volume)) − 0.23·CC − 16.2·max(0, ln(EffectiveLinesOfCode))`, then `max(0, ·)/171·100`, rounded to an integer (`Math.Round`). `ln` is natural log; `max(0, ·)` guards ln(0).
  - **LOC in MI is *executable* lines, not source lines**: `EffectiveLinesOfCode` = executable lines (+1 if the symbol has an initializer).
  - Type MI: same formula on **per-member averages** — average Halstead volume, average CC and average effective LOC over the "effective children" (members that contribute complexity) (`NamedTypeMetricData.cs`). "Simple" fields (no initializer or a simple one) are filtered out of the type's complexity so they don't skew it. If the type has exactly one effective member and no complexity of its own, that member's MI is reused as the type's MI.
- **Halstead as implemented** [3] (`ComputationalComplexityMetrics.cs`): computed over Roslyn `IOperation` trees, skipping implicit operations. Operands = distinct referenced symbols (locals, parameters, fields, properties, methods, events) + distinct constants; operators = operation kinds, binary/unary operator kinds and case kinds. `Volume = N · log2(n)` with `N = N1 + N2`, `n = n1 + n2`. Quirk: the `DistinctOperators` getter starts from the count of distinct *binary* operator kinds (not all operation kinds) and adds `count−1` for binary, unary and case kinds. To reproduce VS numbers exactly you would have to copy this; a tree-sitter re-implementation will only approximate MI.
- **Executable lines as implemented** [3]: count of operations whose parent is a block and which contain explicit (user-written) code, plus field/property/parameter initializers, plus nested conditionals. Tree-sitter equivalent: number of statement nodes whose parent is a `block` (plus initializers). That is close to NDepend's "logical LOC" (sequence points excluding braces) [27].
- Generated code is mostly ignored, but WinForms designer code is not [1]. Code in anonymous methods/lambdas counts toward the declaring member [1].

#### A1.2 Cyclomatic complexity (CC)

- **CA1502 doc** [4]: "cyclomatic complexity = the number of edges − the number of nodes + 1", and operationally "adding 1 to the following: the number of branches (such as `if`, `while`, and `do`)" and "the number of `case` statements in a `switch`". Default rule threshold: **> 25**. Examples: 1 for no branch, 2 for one `if`, 3 for `if (a || b)`, 8 for a 7-case switch [4].
- **Implementation** [3] (`MetricsHelper.ComputeCoupledTypesAndComplexityExcludingMemberDecls`): +1 per body block (method body / constructor body / block), then +1 for each non-implicit operation of kind `CaseClause`, `Coalesce` (`??`), `Conditional` (`if`/`?:`), `ConditionalAccess` (`?.`), `Loop` (for/foreach/while/do), and binary `&&`, `||`, and `&`/`|` **on booleans**. A method with CC 0 is bumped to 1. Type CC = sum of member CCs.
  - Note: `catch` is **not** counted by Roslyn metrics, but is counted by NDepend [27]. `?.` is counted by Roslyn but not listed by NDepend. Pick one definition and document it; the Roslyn one is the "Microsoft" one.
  - The VS doc shows CC = 2 ("the lowest value possible") for a freshly created console app [9]. My reading is that this is the value aggregated over the generated type (`Main` plus the implicit constructor, each 1), not a single method. That is my inference, not a statement in the doc.
- **Guidance quoted in the VS docs** [9]: NIST SP 500-235 — "a limit of 10 is a good starting point"; "limits as high as 15 have been used successfully"; limits over 10 only with experienced staff, formal design, code walkthroughs and a comprehensive test plan. The legacy rule warns at 25 [9].
- Tree-sitter (C# grammar) node mapping: `if_statement`, `while_statement`, `do_statement`, `for_statement`, `foreach_statement`, `switch_section` labels / `case_switch_label` (count per case label), `switch_expression_arm`, `conditional_expression`, `binary_expression` with `&&`/`||`/`??`, `conditional_access_expression`. Fully syntactic. The exact node names should be checked against the tree-sitter-c-sharp grammar version you pin **[unverified node names]**.

#### A1.3 Class coupling

- Definition [1][10]: coupling "to unique classes through parameters, local variables, return types, method calls, generic or template instantiations, base classes, interface implementations, fields defined on external types, and attribute decoration". Each class counts once no matter how often used [10].
- Implementation [3] (`MetricsHelper.AddCoupledNamedTypesCore`): uses the **original definition** of generic types (so `IEnumerable<int>` and `IEnumerable<float>` count one `IEnumerable<T>`) but also adds every type argument. **Excluded**: `bool, byte, char, double, short, int, long, ushort, uint, ulong, IntPtr, UIntPtr, sbyte, float, string, object, ValueType, void`, anonymous types, and types marked `[CompilerGenerated]`/`[GeneratedCode]`. Containing types are removed from a symbol's own set.
- CA1506 [7]: default **95 for types, 40 for other symbols** (methods, fields, properties, events); compiler-generated types excluded. Configurable via `CodeMetricsConfig.txt` (`CA1506(Method): 60`, `CA1506(Type): 120`).
- Guidance in VS docs [10]: Shatnawi (2010) — "threshold values ... for a single member ... CBO = 9" as most efficient.
- Tree-sitter: needs semantics. Approximation: count distinct type identifiers appearing in type positions (`base_list`, parameter/return/field/local types, `object_creation_expression`, generic arguments, attributes, `typeof`, static member-access receivers that start with an uppercase identifier), minus the predefined-type exclusion list above. Expect noise from aliases, `var`, and extension methods.

#### A1.4 Depth of inheritance (DIT)

- VS counts `System.Object` as the root: a fresh class has DIT 1 [8]. The VS doc says the legacy rule "issues a warning when the depth of inheritance reaches 6 or greater" [8].
- CA1501 [5]: default threshold **5**; cause "A type is five or more levels deep in its inheritance hierarchy". In its example, `FifthDerivedClass` (DIT 6 counting from `System.Object`) violates; `FourthDerivedClass` doesn't. So the rule fires when the depth of the type's own (non-System) ancestor chain ≥ 5, equivalently VS DIT ≥ 6. Analysis is limited to hierarchies in the same module, and all `System.*` types are excluded (more can be added with `dotnet_code_quality.CA1501.additional_inheritance_excluded_symbol_names`) [5].
- VS doc: "no currently accepted standard for DIT values"; "a DIT around 5 or 6 should be an upper limit" [8]. NDepend: DIT ≥ 6 "might be hard to maintain" [27]; rule ND1202 fires at ≥ 4 *non-third-party* base classes [26].
- Implementation [3] (`NamedTypeMetricData.CalculateDepthOfInheritance`): for classes and interfaces, depth = number of `BaseType` hops until reaching `null` or an *excluded* type. For CA1501 the excluded set always contains `System.*`, so a class deriving directly from `object` has depth 0 and `FifthDerivedClass` has depth 5, which meets the threshold of 5. Structs, enums and delegates get a fixed depth of 1 ("Compat").
- Tree-sitter: resolvable only for in-repo base classes by name (build a class→base map from `base_list`; the first entry is a class only if it is a known in-repo class; interfaces conventionally start with `I` + uppercase).

#### A1.5 Lines of code

- **Lines of Source code**: "the exact number of source code lines that are present in your source file, including blank lines" (VS 2019 16.4+, Microsoft.CodeAnalysis.Metrics 2.9.5+) [1]. Implementation counts declaration span lines, discounting leading/trailing blank lines [3].
- **Lines of Executable code**: "the approximate number of executable code lines or operations" [1] (see A1.1 for the implementation).

### A2. CA / IDE analyzer rules as precise, checkable rules

"Enabled by default in .NET 10" is taken verbatim from each rule page.

| Rule | Title / category | Default | Exact trigger (checkable form) | Exceptions / options | Feasibility |
|---|---|---|---|---|---|
| **CA1501** [5] | Avoid excessive inheritance (Maintainability) | threshold 5; not enabled | type ≥ 5 levels deep (VS DIT ≥ 6); same-module only; `System.*` excluded | `CodeMetricsConfig.txt` `CA1501: 8`; extra exclusions option | Partial |
| **CA1502** [4] | Avoid excessive complexity | threshold 25; not enabled | method CC > 25 | Configurable per symbol kind (`CA1502(Type): 4`); safe to suppress for big `switch` | Syntactic |
| **CA1505** [6] | Avoid unmaintainable code | threshold 10; not enabled | MI < 10 for type/method/field/property/event | `CA1505(Method): 5`, `CA1505(Type): 15` | Approx. |
| **CA1506** [7] | Avoid excessive class coupling | 95 (types) / 40 (others); not enabled | unique type refs > threshold | compiler-generated types excluded | Approx. |
| **CA1822** [13] | Mark members as static (Performance) | **as suggestion** | member "does not access instance data or call instance methods" and isn't static | `api_surface` option; suppress for `MarshalByRefObject` subclasses and shipped public APIs (breaking) | Approx. (needs to know which identifiers are instance members; doable by in-type symbol table; misses inherited members) |
| **CA1031** [11] | Do not catch general exception types (Design) | not enabled | `catch (System.Exception)`, `catch (System.SystemException)`, or general `catch` | not reported if the general exception is rethrown "as the last statement in the catch block"; `disallowed_symbol_names` adds more types | Syntactic |
| **CA2200** [12] | Rethrow to preserve stack details (Usage) | **as warning** | inside a `catch (T e)`, a `throw e;` where `e` is the caught variable | use `throw;`, or `ExceptionDispatchInfo.Capture(e).Throw()` outside the handler | Syntactic |
| **CA1062** [15] | Validate arguments of public methods (Design) | not enabled | an externally visible (public/protected) method dereferences a reference-type parameter without a null check | options: `api_surface` (.NET 7+), `excluded_symbol_names`, `exclude_extension_method_this_parameter`, `null_check_validation_methods` | Needs dataflow; approximate. Largely moot when `<Nullable>enable</Nullable>` (MessagePack has it on [19]) |
| **CA1051** [14] | Do not declare visible instance fields (Design) | not enabled | non-private instance field in an externally visible type (externally visible = public, protected, protected internal) | `exclude_structs`; `api_surface` | Syntactic (modifier check + containing type visibility) |
| **IDE0051** [16] | Remove unused private member (CodeQuality) | no default severity on page | private methods, fields, properties, events with no read or write references | — | Syntactic approximation: name not referenced anywhere in the (partial) type; beware reflection/serialization/`nameof` |
| **IDE0052** [17] | Remove unread private member | no default severity on page | private fields/properties with ≥ 1 write reference and no read references | — | Syntactic approximation |
| **CA1716** [18] | Identifiers should not match keywords (Naming) | not enabled | name of namespace, type, or virtual/interface member (and parameters) equals a keyword of VB (case-insensitive), C# or C++/CLI (case-sensitive) | default analyzed kinds: Namespace, NamedType, Method, Property, Event, Parameter; externally visible only by default | Syntactic (keyword list is in the analyzer source [28]: about 248 case-sensitive and 198 case-insensitive entries by line count) |
| **CA1707** [20] | Identifiers should not contain underscores (Naming) | not enabled | `_` in namespace, type, member, parameter names | "safe to suppress this warning for test code"; `api_surface` | Syntactic |

Configuration of the metric rules: all four CA150x rules read `CodeMetricsConfig.txt` registered as `AdditionalFiles`, format `RuleId[(SymbolKind)]: N`, symbol kinds `Assembly, Namespace, Type, Method, Field, Event, Property` [4][5][6][7].

### A3. Naming conventions as checkable rules

**Framework Design Guidelines (FDG)** [24] — public surface:

| Identifier | Casing | Extra rules |
|---|---|---|
| Namespace, type, interface, method, property, event, public/protected field, enum value | PascalCase | Interfaces: prefix `I` + PascalCase [25] |
| Parameter | camelCase | — |
| Acronyms | 2-letter: both upper in Pascal (`IOStream`), both lower at start of camel (`ioStream`); ≥ 3 letters: only first letter upper (`HtmlTag`) [24] | — |
| Compound words | treat closed-form compounds as one word: `Callback`, `Endpoint`, `Metadata`, `Id` not `ID`, `Ok` not `OK`, `FileName`, `UserName` [24] | |
| Any | no underscores, hyphens or other non-alphanumerics; no Hungarian notation; avoid keyword collisions; no abbreviations/contractions; names can't differ by case alone [24][29] | |
| Types | classes/structs: nouns, no `C` prefix; interfaces: adjective phrases or nouns, `I` prefix [25] | |
| Generic type parameters | `T` or `T`-prefixed descriptive (`TSession`) [25] | CA1715 enforces [30] |
| Suffixes | `Attribute`, `EventArgs`, `Exception`, `Dictionary`, `Collection`, `Stream`, `Permission`; delegates for events → `EventHandler`, other delegates → `Callback`, never `Delegate`; enums: no `Enum`/`Flag`/`Flags` suffix; singular for normal enums, plural for `[Flags]` [25] | |
| Methods | verbs / verb phrases [31] | |
| Properties | nouns / adjectives; Booleans affirmative (`CanSeek`), optional `Is/Can/Has`; collections plural, not `…List` [31] | |
| Events | verb tense (`Closing`/`Closed`), no `Before`/`After`; handlers `(object sender, XEventArgs e)` [31] | |
| Fields | FDG covers only public/protected static fields: PascalCase, no prefixes like `g_`/`s_`; public/protected instance fields "are not allowed" [31] | |
| New API versions | numeric suffix allowed; no `Ex` suffix; `64` suffix for 64-bit variants [29] | |

**.NET runtime / docs team style** [32][30] (internal/private surface):
- Private/internal instance fields `_camelCase`; static `s_`; thread-static `t_`; prefer `readonly`; `static` before `readonly` [32].
- Constants (fields and locals) PascalCase; local functions PascalCase; explicit visibility, first among modifiers; Allman braces; 4 spaces; no more than one blank line in a row; `var` only when type is apparent; prefer `nameof`; fields at top of type; make internal/private types `sealed` or `static` unless derivation is needed; primary-constructor parameters camelCase without `_` [32].
- Docs team adds: no `__` (reserved for compiler); avoid single-letter names except loop counters; record positional parameters PascalCase [30].

**Conflict that matters for this project:** MessagePack-CSharp does *not* follow the runtime field style. Its `.editorconfig` sets instance fields and static fields to `camel_case` (no prefix), non-private static fields PascalCase, constants PascalCase, locals/parameters camelCase, local functions PascalCase, everything else PascalCase, and turns IDE1006 off ("StyleCop handles these for us") [19]. StyleCop's SA1309 (field names must not begin with an underscore) and SA1101 (prefix local calls with `this.`) apply [33][34]; SA1101 is set to suggestion in the repo [19]. A crude regex count over the challenge's local checkout (`corpus/messagepack-csharp/src`, commit 32258fdb, 2025-03-01) found 151 camelCase vs 7 underscore-prefixed private/internal/protected field declarations and 1,042 `this.<lowercase>` uses. **Recommendation:** read naming expectations from the target repo's `.editorconfig`/`stylecop.json` instead of hard-coding the runtime style. An agent PR that adds `_camelCase` fields to MessagePack goes against the repo's conventions.

Checkable regexes (ASCII approximation):
- PascalCase: `^[A-Z][a-zA-Z0-9]*$` (and for 3+-letter acronyms flag `[A-Z]{3,}` runs, allowing exactly-2-letter runs).
- camelCase: `^[a-z][a-zA-Z0-9]*$`.
- runtime private field: `^_[a-z][a-zA-Z0-9]*$`; static `^s_[a-z]…`; thread-static `^t_[a-z]…`.
- interface: `^I[A-Z][a-zA-Z0-9]*$`; type parameter: `^T([A-Z][a-zA-Z0-9]*)?$`.

### A4. StyleCop documentation rules and MessagePack-CSharp's configuration

- **SA1600 Elements should be documented** [21]: violation "if an element is completely missing a documentation header, or if the header is empty". Applies to classes, constructors, delegates, enums, events, finalizers, indexers, interfaces, methods, properties, records (each positional parameter needs `<param>`), structs. Partial elements → SA1601; explicit interface implementations exempt; `<inheritdoc/>` and `<include>` accepted.
- **Which visibilities** are required is driven by `stylecop.json` `documentationRules` [35]: `documentExposedElements` **true**, `documentInternalElements` **true**, `documentPrivateElements` false, `documentPrivateFields` false, `documentInterfaces` `"all"` (defaults). Other defaults: `companyName` "PlaceholderCompany", `xmlHeader` true, `fileNamingConvention` "stylecop", `documentationCulture` "en-US"; ordering `usingDirectivesPlacement` "insideNamespace"; naming `allowCommonHungarianPrefixes` true [35].
- **SA1611** [22]: a method, constructor, delegate or indexer has at least one parameter without a `<param>` tag.
- **SA1615** [23]: an element "containing a return value is missing a `<returns>` tag". Whether `Task`-returning or `async` members are exempt is not stated on the rule page **[unverified]**.
- **MessagePack-CSharp configuration** (upstream `master`, fetched 2026-11-14) [19]:
  - `stylecop.json`: copyright header text "Copyright (c) All contributors. All rights reserved. Licensed under the MIT license…", `fileNamingConvention: "metadata"`, `xmlHeader: false`, `newlineAtEndOfFile: "require"`, `systemUsingDirectivesFirst: true`, `usingDirectivesPlacement: "outsideNamespace"`. No `documentExposedElements`/`documentInternalElements` overrides, so the defaults (true/true) apply, but see severities. The local challenge checkout's `stylecop.json` is byte-identical to upstream.
  - `Directory.Build.props`: `AnalysisLevel latest`, `EnforceCodeStyleInBuild true`, `GenerateDocumentationFile true`; `src/Directory.Build.props`: `Nullable enable`, `LangVersion 13`.
  - Analyzer packages (global): `StyleCop.Analyzers.Unstable 1.2.0.556`, `CSharpIsNullAnalyzer`, `PolySharp`. The local challenge checkout also lists `Nerdbank.GitVersioning` and `Nullable` as global package references.
  - `.editorconfig` severities: **SA1600 silent, SA1601 silent, SA1602 silent**; SA1604, SA1611, SA1615, SA1618 **suggestion**; CA1062 suggestion; CS1591 suggestion; SA1101 suggestion; SA1121, SA1124 (no regions), SA1139 suggestion; SA1201/1202/1204/1214 (ordering) silent; SA1133/SA1134 silent; SA1130, SA1141, SA1414, SA1519 silent; **CA2016 (forward CancellationToken) warning**; DOC104–108, DOC200, DOC202 warning (DocumentationAnalyzers IDs; I found no package reference for them in `Directory.Packages.props`, so whether they are active is **[unverified]**). Upstream also disables SA1005, SA1507, SA1508, SA1512, SA1515 (these five lines are absent in the challenge's local 2025-03 checkout).
  - Code style: `var` preferred everywhere (suggestion), block bodies for methods/constructors/operators, expression bodies for properties/indexers/accessors, braces on new line (`csharp_new_line_before_open_brace = all`), System usings first.
  - **Implication for the certifier:** treat missing XML docs on public API as a *soft* signal for MessagePack (the repo doesn't gate on it), but a missing `<param>`/`<returns>` on a member that *does* have a doc header matches the repo's suggestion-level rules (SA1611/SA1615).

### A5. NDepend default rules (exact CQLinq conditions)

Extracted from the NDepend Rules Explorer source (rule bodies are embedded in the page) [26]; metric recommendations from the NDepend metrics reference [27].

| ID | Rule | Exact default condition |
|---|---|---|
| ND1000 | Avoid types too big | JustMyCode type with `NbLinesOfCode > 200` and LOC of its JustMyCode methods/ctors > 200; debt linear 1 h @200 → 10 h @2000; static types with mutable fields get factor 0.2 |
| ND1001 | Avoid types with too many methods | non-interface, `NbMethods > 20`, has ≥1 non-literal field; count excludes compiler-generated, getters/setters, event add/remove; > 20 |
| ND1002 | Avoid types with too many fields | non-enum; fields excluding compiler-generated, literals (`const`) and `static readonly`; > 15 (30 for Unity projects) |
| ND1003 | Avoid methods too big, too complex | `!IsAsync && ILNestingDepth > 2 && CyclomaticComplexity > 17`; ranked by `LOC/2 + CC + ILCC/3 + 3·ILNestingDepth` |
| ND1004 | Avoid methods with too many parameters | `NbParameters ≥ 8`, excluding overrides of third-party methods, ctors forwarding to a base ctor with ≥ 8 params, and `[DllImport]` |
| ND1005 | Avoid methods with too many overloads | ≥ 7 overloads (operators and `visit*`/`dispatch*` excluded); reported when pruned set > 7 |
| ND1006 | Avoid methods potentially poorly commented | `PercentageComment ≤ 5 && NbLinesOfCode ≥ 30 && CC ≥ 3` (EF Core migrations/DbContext/ModelSnapshot excluded) |
| ND1007 | Avoid types with poor cohesion | `LCOM > 0.91 && NbFields > 10 && NbMethods > 10`, then > 8 instance fields and > 8 methods after removing property/event accessors and backing fields |
| ND1008 | Avoid methods with too many local variables | `NbVariables > 15` (IL-based; "methods with more than 8 are already hard to maintain") |
| ND1009 | Avoid unmaintainable code | `NbLinesOfCode ≥ 30 && MaintainabilityIndex ≤ 35 && CC ≥ 20` |
| ND1200 | Avoid interfaces too big | methods (excl. accessors) + properties + events ≥ 14 |
| ND1202 | Class shouldn't be too deep in inheritance tree | ≥ 4 base classes excluding third-party ones |
| ND1410 | Avoid excessive class coupling | method: CC ≥ 10 and ≥ 40 non-third-party types used across ≥ 5 namespaces; type: CC ≥ 25 and ≥ 90 types across ≥ 10 namespaces |
| ND1609 | Methods should have a low CRAP score | `LOC > 10` and `CRAP = CC²·(1−cov)³ + CC > 60` (only with coverage data) |
| ND1701 | Potentially dead methods | non-public, non-entry-point, non-virtual, not explicit interface impl., not cctor/finalizer, … with no callers |

NDepend metric recommendations [27]:
- Method LOC (logical, PDB sequence points excluding braces): > 20 hard to maintain, > 40 split.
- CC: > 15 hard, > 30 extremely complex. NDepend CC = 1 + count of `if, while, for, foreach, case, default, continue, goto, &&, ||, catch, ?:, ??`, C# 9 `and`/`or` patterns; not counted: `else, do, switch, try, using, throw, finally, return`, object creation, calls, field access. Type CC = sum of method CCs; lambdas are not counted in the outer method.
- IL CC: > 20 hard, > 40 extreme. ILNestingDepth: > 4 hard, > 8 extreme.
- NbParameters > 5 "might be painful"; NbVariables > 8 hard, > 15 extreme; NbOverloads > 6 problematic.
- NbMethods > 20 and NbFields > 20 (non-enum) "might be hard to understand".
- PercentageComment = 100·comment/(comment+code): < 20 % should be more commented; > 40 % not necessarily good.
- LCOM = 1 − Σ(MF)/(M·F) in [0,1]; LCOM-HS = (M − Σ(MF)/F)/(M−1) in [0,2]; LCOM > 0.8 with > 10 fields and > 10 methods "might be problematic"; LCOM-HS > 1 "should be avoided".
- TypeCe (efferent coupling) > 50: "depends on too many other types".
- DIT ≥ 6 might be hard to maintain.
- Halstead volume (method): < 150 simple, 150–400 moderate, > 800 high cognitive load; types < 800 simple, 800–3,000 moderate.
- NDepend MI uses the same Microsoft 0–100 formula but its own bands: > 85 easy, 50–85 moderate, < 50 hard.

Note the two MI scales disagree: Microsoft flags red at < 10 (deliberately conservative) [2], while NDepend calls < 50 "hard to maintain" [27]. The corpus calibration in Part B can settle where real well-regarded C# libraries sit.

### A6. Proposed C# rule set for the certifier (derived from A1–A5)

Hard gates (absolute, cheap, syntactic, low false-positive rate):
1. CA2200 `throw e;` inside its own catch. Microsoft says "Do not suppress" and enables it as a warning by default [12].
2. CA1031 general catch without trailing rethrow [11]. Microsoft: "Do not suppress".
3. Method CC > 25 (CA1502) [4]; method MI < 10 (CA1505) [6].
4. Externally visible mutable instance fields (CA1051) [14].
5. Repo-convention naming violations (read from `.editorconfig` + StyleCop defaults; for MessagePack: no leading `_` on fields, PascalCase members, camelCase locals/params, `I`-prefixed interfaces).

Calibrated (percentile vs corpus, since absolute thresholds are disputed):
- Method CC (NIST 10 / NDepend 15 / CA 25), method logical LOC (NDepend 20/40), nesting depth (NDepend 4/8), parameters (NDepend 5 soft / 8 rule), locals (8/15), type LOC (200), methods per type (20), fields per type (15), interface size (14), LCOM / LCOM-HS, coupling (approx. CBO; VS 9 / CA 40 / CA 95), DIT (CA1501 ≥ 5 levels), MI (MS 10/20 vs NDepend 50/85), comment percentage, documentation coverage on public API (SA1600/1611/1615), unused/unread private members (IDE0051/0052).

---

## PART B — Benchmark corpus and datasets

### B1. Selection criteria used

- Library code (not apps), mostly C#, actively maintained (pushed within roughly the last 12 months as of 2026-11-14 per ecosyste.ms metadata [36]), widely used and/or .NET Foundation-affiliated, ideally with strict analyzer settings (TreatWarningsAsErrors, StyleCop, PublicApiAnalyzers, Sonar, Roslynator, AnalysisLevel), and size that keeps the whole corpus small enough to analyse quickly.
- Diversity of domains: serialization, data access, resilience, logging, DI, validation, time/text, testing, CLI/console, HTTP, LINQ/functional, scripting, imaging.
- Several repos share MessagePack-CSharp's maintainer-template style (AArnott's Library.Template: StyleCop + `this.` + DocumentationAnalyzers): **Nerdbank.MessagePack, vs-streamjsonrpc, vs-threading**. They form a "same-style control group" for convention rules.
- Overlap with SWE-Sharp-Bench repos (Polly, CsvHelper, MessagePack-CSharp, ImageSharp, StackExchange.Redis, Autofac, Moq, BenchmarkDotNet, RestSharp, Serilog, Spectre.Console) [37] gives agent-task data on the same codebases.

### B2. Proposed corpus

Columns: stars/pushed date/license/default branch come from the ecosyste.ms repository API snapshot taken 2026-11-14 [36]. "C# bytes" come from the GitHub languages API (the whole repository, including tests, benchmarks and samples) [38]. "Est. LOC" = C# bytes ÷ 39.7, the bytes-per-physical-line ratio I measured on the local MessagePack-CSharp checkout (681 `.cs` files, 3,766,770 bytes, 94,780 lines). Treat LOC as ±30 % estimates; the calibration pipeline should count real lines after excluding `obj/`, `bin/`, generated files, tests and benchmarks. Analyzer signals come from the repos' `Directory.Build.props`/`Directory.Packages.props`/`.editorconfig`/`stylecop.json` on the default branch [39]; "README → .NET Foundation" means the README references the .NET Foundation (member statement or its Code of Conduct) [40].

**Core corpus (25 repos)**

| # | Repository | Domain | Stars | Last push | License (ecosyste.ms) | C# bytes | Est. LOC | Quality signals verified |
|---|---|---|---|---|---|---|---|---|
| 1 | [JamesNK/Newtonsoft.Json](https://github.com/JamesNK/Newtonsoft.Json) | Serialization (JSON) | 11,318 | 2026-09-21 | mit | 6.75 MB | ~170k | Mature reference JSON library; root build config not at standard paths (not checked further) |
| 2 | [protobuf-net/protobuf-net](https://github.com/protobuf-net/protobuf-net) | Serialization (Protobuf) | 4,974 | 2026-11-06 | other | 8.71 MB | ~219k | GenerateDocumentationFile; contains generated code to exclude |
| 3 | [Cysharp/MemoryPack](https://github.com/Cysharp/MemoryPack) | Serialization (binary) | 4,779 | 2026-11-11 | mit | 1.44 MB | ~36k | Nullable on, GenerateDocumentationFile; closest domain match to MessagePack |
| 4 | [AArnott/Nerdbank.MessagePack](https://github.com/AArnott/Nerdbank.MessagePack) | Serialization (MessagePack) | 180 | 2026-11-12 | mit | 2.73 MB | ~69k | Same maintainer template as MessagePack-CSharp: StyleCop, DocumentationAnalyzers, VS Threading analyzers, AnalysisLevel latest, EnforceCodeStyleInBuild, Nullable, doc file |
| 5 | [JoshClose/CsvHelper](https://github.com/JoshClose/CsvHelper) | Serialization (CSV) | 5,217 | 2026-11-08 | other | 2.35 MB | ~59k | Nullable on; in SWE-Sharp-Bench |
| 6 | [DapperLib/Dapper](https://github.com/DapperLib/Dapper) | Data access (micro-ORM) | 18,411 | 2026-09-23 | other | 1.16 MB | ~29k | TreatWarningsAsErrors, PublicApiAnalyzers, doc file |
| 7 | [npgsql/npgsql](https://github.com/npgsql/npgsql) | Data access (PostgreSQL driver) | 3,749 | 2026-11-07 | postgresql | 4.54 MB | ~114k | TreatWarningsAsErrors, AnalysisLevel latest, Nullable, PublicApiAnalyzers, doc file |
| 8 | [StackExchange/StackExchange.Redis](https://github.com/StackExchange/StackExchange.Redis) | Client (Redis) | 6,208 | 2026-11-13 | mit | 7.99 MB | ~201k | TreatWarningsAsErrors, StyleCop, PublicApiAnalyzers, doc file; in SWE-Sharp-Bench; GitHub API now resolves it to seredis/StackExchange.Redis |
| 9 | [App-vNext/Polly](https://github.com/App-vNext/Polly) | Resilience | 14,254 | 2026-11-07 | bsd-3-clause | 4.48 MB | ~113k | StyleCop, SonarAnalyzer, PublicApiAnalyzers; README states .NET Foundation member; in SWE-Sharp-Bench |
| 10 | [serilog/serilog](https://github.com/serilog/serilog) | Logging | 8,063 | 2026-10-23 | apache-2.0 | 0.93 MB | ~23k | TreatWarningsAsErrors, Nullable; in SWE-Sharp-Bench |
| 11 | [autofac/Autofac](https://github.com/autofac/Autofac) | Dependency injection | 4,662 | 2026-11-05 | mit | 2.47 MB | ~62k | TreatWarningsAsErrors; in SWE-Sharp-Bench |
| 12 | [FluentValidation/FluentValidation](https://github.com/FluentValidation/FluentValidation) | Validation | 9,772 | 2026-11-03 | apache-2.0 | 1.14 MB | ~29k | TreatWarningsAsErrors; README: copyright .NET Foundation |
| 13 | [nodatime/nodatime](https://github.com/nodatime/nodatime) | Date/time | 3,008 | 2026-11-07 | apache-2.0 | 3.45 MB | ~87k | TreatWarningsAsErrors, Microsoft.CodeAnalysis.NetAnalyzers, Nullable; large data tables to exclude |
| 14 | [Humanizr/Humanizer](https://github.com/Humanizr/Humanizer) | Text/formatting | 9,968 | 2026-11-06 | other | 7.10 MB | ~179k | TreatWarningsAsErrors, AnalysisLevel latest (AnalysisMode Minimum), EnforceCodeStyleInBuild, Nullable, doc file; only 79% C# by bytes |
| 15 | [xunit/xunit](https://github.com/xunit/xunit) | Testing framework | 4,613 | 2026-11-09 | other | 6.52 MB | ~164k | README: part of the .NET Foundation |
| 16 | [nunit/nunit](https://github.com/nunit/nunit) | Testing framework | 2,630 | 2026-11-10 | mit | 5.29 MB | ~133k | Long-lived framework; root build config not at standard paths (not checked further) |
| 17 | [devlooped/moq](https://github.com/devlooped/moq) | Mocking | 6,409 | 2026-11-10 | mit | 0.58 MB | ~15k | Nullable, Meziantou analyzer; in SWE-Sharp-Bench |
| 18 | [bchavez/Bogus](https://github.com/bchavez/Bogus) | Test data generation | 9,753 | 2025-12-22 | other | 0.71 MB | ~18k | Slow-moving (last push 2025-12); no root build config found at standard paths |
| 19 | [dotnet/BenchmarkDotNet](https://github.com/dotnet/BenchmarkDotNet) | Benchmarking | 11,526 | 2026-11-06 | mit | 5.00 MB | ~126k | dotnet org; README references .NET Foundation CoC; in SWE-Sharp-Bench |
| 20 | [spectreconsole/spectre.console](https://github.com/spectreconsole/spectre.console) | Console UI | 11,692 | 2026-11-11 | mit | 2.68 MB | ~67k | Roslynator, Nullable, doc file; README .NET Foundation section; in SWE-Sharp-Bench |
| 21 | [dotnet/command-line-api](https://github.com/dotnet/command-line-api) | CLI parsing (System.CommandLine) | 3,680 | 2026-11-13 | mit | 1.06 MB | ~27k | dotnet org; TreatWarningsAsErrors; README .NET Foundation section; 74% C# by bytes |
| 22 | [restsharp/RestSharp](https://github.com/restsharp/RestSharp) | HTTP client | 9,812 | 2026-10-21 | apache-2.0 | 0.89 MB | ~23k | doc file; README .NET Foundation section; in SWE-Sharp-Bench |
| 23 | [morelinq/MoreLINQ](https://github.com/morelinq/MoreLINQ) | LINQ extensions | 3,832 | 2025-11-25 | apache-2.0 | 1.84 MB | ~46k | TreatWarningsAsErrors, AnalysisLevel 8.0-all, EnforceCodeStyleInBuild, Nullable; slow-moving (last push 2025-11) |
| 24 | [microsoft/vs-streamjsonrpc](https://github.com/microsoft/vs-streamjsonrpc) | RPC / serialization | 943 | 2026-11-12 | other | 2.83 MB | ~71k | Same template as MessagePack-CSharp (StyleCop, DocumentationAnalyzers, VS Threading analyzers, AnalysisLevel latest, EnforceCodeStyleInBuild, Nullable, doc file); depends on the MessagePack package (v2.5.307 in its Directory.Packages.props) |
| 25 | [microsoft/vs-threading](https://github.com/microsoft/vs-threading) | Async/threading | 1,041 | 2026-11-06 | other | 2.84 MB | ~72k | Same template as MessagePack-CSharp (as above) |

Core total: 85.5 MB of C# ≈ 2,153k physical lines (whole repos incl. tests). The library-only (`src/`) share will be much smaller.

**Alternates / handle with care**

| # | Repository | Domain | Stars | Last push | License (ecosyste.ms) | C# bytes | Est. LOC | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | [reactiveui/refit](https://github.com/reactiveui/refit) | HTTP (typed REST) | 9,578 | 2026-11-04 | other | 6.34 MB | ~160k | AnalysisLevel latest, EnforceCodeStyleInBuild, Nullable, doc file; C# bytes unusually high, check for generated/snapshot files |
| 2 | [CommunityToolkit/dotnet](https://github.com/CommunityToolkit/dotnet) | Toolkit (MVVM, HighPerformance) | 3,773 | 2026-03-25 | other | 3.90 MB | ~98k | doc file; README references .NET Foundation; last push 2026-03 |
| 3 | [LuckyPennySoftware/AutoMapper](https://github.com/LuckyPennySoftware/AutoMapper) | Object mapping | 10,180 | 2026-11-06 | other | 2.21 MB | ~56k | License moved to RPL-1.5/commercial from v15 (pin last permissive tag) |
| 4 | [LuckyPennySoftware/MediatR](https://github.com/LuckyPennySoftware/MediatR) | Mediator | 11,856 | 2026-11-12 | other | 0.46 MB | ~12k | License moved to RPL-1.5/commercial from v13 (pin 12.5.0) |
| 5 | [Tyrrrz/CliWrap](https://github.com/Tyrrrz/CliWrap) | Process execution | 5,010 | 2026-11-04 | mit | 0.21 MB | ~5k | TreatWarningsAsErrors, Nullable; below the 10k LOC target |
| 6 | [SixLabors/ImageSharp](https://github.com/SixLabors/ImageSharp) | Imaging | 8,048 | 2026-11-09 | other | 37.33 MB | ~940k | TreatWarningsAsErrors; Six Labors Split License; ~37 MB of C#, too large unless src/ only |
| 7 | [sebastienros/jint](https://github.com/sebastienros/jint) | JavaScript interpreter | 4,749 | 2026-11-08 | bsd-2-clause | 33.66 MB | ~848k | TreatWarningsAsErrors, Meziantou; ~34 MB of C#, too large unless src/ only |
| 8 | [dotnet/reactive](https://github.com/dotnet/reactive) | Reactive Extensions | 7,194 | 2026-11-06 | mit | 26.45 MB | ~666k | ~26 MB of C#; sample Rx.NET/Source/src only |

**Reference (target):** [MessagePack-CSharp/MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp): 6,807 stars, last push 2026-11-10, 3.85 MB C# by the GitHub API (~97k est. LOC). The local challenge checkout has 94,780 physical `.cs` lines in total, 47,652 under `src/`.

### B3. Caveats and exclusions

- **License changes (code still public, but note before redistributing derived data):** AutoMapper v15+ and MediatR 13+ moved to a dual RPL-1.5/commercial license in July 2025 (MediatR 12.5.0 was the last plain Apache-2.0 release) [41]; FluentAssertions v8 moved to a commercial Xceed license in January 2025 (v7 stays Apache-2.0) [42]; ImageSharp uses the Six Labors Split License (Apache-style terms below a revenue threshold, commercial above) [43]. Pin the last permissive tag if license purity matters, or keep them out of the core set (I listed AutoMapper/MediatR only as alternates).
- **Too big / not library-like:** dotnet/runtime (System.Text.Json lives there), dotnet/roslyn, dotnet/efcore, Avalonia, Orleans are well engineered but would dominate percentiles; if needed, sample sub-trees (e.g. `src/libraries/System.Text.Json/src`) instead of whole repos.
- **Generated code:** MessagePack-CSharp and protobuf-net contain T4/source-generated formatters; NodaTime and Humanizer contain large data tables. Exclude `*.g.cs`, `*.Designer.cs`, files with `<auto-generated>` headers or `[GeneratedCode]`, mirroring what VS code metrics do [1].
- **Tests vs library:** calibrate library code (`src/`) separately from tests; CA1707 explicitly tolerates underscores in test names [20].
- **Pin commits:** record the commit SHA of each corpus repo at calibration time; percentiles drift with upstream changes.

### B4. Existing C# datasets usable for predictive validity

| Dataset | What it contains | Use for us | Source |
|---|---|---|---|
| **SWE-Sharp-Bench** (Microsoft, arXiv 2511.02352) | 150 issue-resolving tasks from 17 C# repos with ≥ 5k stars; includes **18 MessagePack-CSharp tasks**; tasks are merged PRs that reference an issue and modify tests; Dockerized build/test; HF `microsoft/SWE-Sharp-Bench`, code in `microsoft/prose` | Gold human patches vs agent patches on the same repos; check whether certifier scores separate passing from failing agent patches | [37] |
| **AIDev** (MSR '26, arXiv 2602.09185) | 932,791 agentic PRs (Codex, Devin, Copilot, Cursor, Claude Code) in 116,211 repos, cutoff 2025-08-01; curated subset of 33,596 PRs from 2,807 repos with > 100 stars, with commit-level patches, reviews, review comments and timeline (merge/close); HF `hao-li/AIDev`, Zenodo 10.5281/zenodo.16899501 | Filter to C# repos; use merge vs reject and review comments as weak labels for "trustworthy AI code". The paper page I read gives no per-language breakdown, so the C# share is **[unverified]** | [44] |
| **Clean-CaDET C# code-smell dataset** (Univ. Novi Sad, Zenodo 10.5281/zenodo.6520056, CC-BY-4.0) | Open-source C# projects manually annotated (≥ 2 annotators per instance) for **Long Method** and **God/Large Class** severity, plus heuristics sheets; companion repo `Clean-CaDET/ML-code-smell-CSharp` | Direct validation of size/complexity/cohesion thresholds on C# against human labels. Project/instance counts aren't on the Zenodo page **[unverified]** | [45][46] |
| **CVEfixes** (arXiv 2107.08760; Zenodo 10.5281/zenodo.4476563) | CVE-fixing commits from open source with language metadata; the MVD paper extracted a C# subset (332 vulnerable / 1,280 non-vulnerable functions) | Small security-oriented validity check for C# | [47] (C# counts as reported by the MVD paper, which I saw only in a search snippet: **[unverified]**) |

I found no Defects4J-style reproducible C# bug database. Classic defect-prediction corpora (PROMISE, Unified Bug Dataset, GitHub Bug Dataset) are Java/C/C++ [48]. My web-search budget ran out before I could search further, so treat "none exists" as **[unverified]**. Practical fallback: SZZ-label bug-introducing commits in the corpus repos and correlate with metric percentiles.

---

## References

1. Microsoft Learn — How code metrics help identify risks (VS). https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-values
2. Microsoft Learn — Maintainability index range and meaning. https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-maintainability-index-range-and-meaning
3. dotnet/roslyn-analyzers source, `src/Utilities/Compiler/CodeMetrics/` (`CodeAnalysisMetricData.cs`, `CodeAnalysisMetricData.MethodMetricData.cs`, `CodeAnalysisMetricData.NamedTypeMetricData.cs`, `ComputationalComplexityMetrics.cs`, `MetricsHelper.cs`), branch `main`. https://github.com/dotnet/roslyn-analyzers/tree/main/src/Utilities/Compiler/CodeMetrics
4. CA1502: Avoid excessive complexity. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1502
5. CA1501: Avoid excessive inheritance. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1501
6. CA1505: Avoid unmaintainable code. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1505
7. CA1506: Avoid excessive class coupling. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1506
8. Code metrics — Depth of inheritance. https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-depth-of-inheritance
9. Code metrics — Cyclomatic complexity (quotes NIST SP 500-235 and NASA SATC). https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-cyclomatic-complexity
10. Code metrics — Class coupling (quotes Shatnawi 2010). https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-class-coupling
11. CA1031: Do not catch general exception types. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1031
12. CA2200: Rethrow to preserve stack details. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2200
13. CA1822: Mark members as static. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1822
14. CA1051: Do not declare visible instance fields. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1051
15. CA1062: Validate arguments of public methods. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1062
16. IDE0051: Remove unused private member. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0051
17. IDE0052: Remove unread private member. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0052
18. CA1716: Identifiers should not match keywords. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1716
19. MessagePack-CSharp configuration files on `master`: `stylecop.json`, `.editorconfig`, `Directory.Build.props`, `src/Directory.Build.props`, `Directory.Packages.props`, `global.json`. https://github.com/MessagePack-CSharp/MessagePack-CSharp (raw: https://raw.githubusercontent.com/MessagePack-CSharp/MessagePack-CSharp/master/.editorconfig, …/stylecop.json, …/Directory.Build.props). Compared with the challenge's local checkout `corpus/messagepack-csharp` (commit 32258fdbee4bcd653c79f51b4376b5103c6f4d27).
20. CA1707: Identifiers should not contain underscores. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1707
21. StyleCop Analyzers — SA1600. https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/SA1600.md
22. StyleCop Analyzers — SA1611. https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/SA1611.md
23. StyleCop Analyzers — SA1615. https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/SA1615.md
24. Framework Design Guidelines — Capitalization conventions. https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/capitalization-conventions
25. Framework Design Guidelines — Names of classes, structs, and interfaces. https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/names-of-classes-structs-and-interfaces
26. NDepend Rules Explorer (default rules with CQLinq source; ND1000–ND1009, ND1200, ND1202, ND1410, ND1609, ND1701 read). https://www.ndepend.com/default-rules/NDepend-Rules-Explorer.html
27. NDepend — Code metrics reference. https://www.ndepend.com/docs/code-metrics
28. dotnet/roslyn-analyzers — `IdentifiersShouldNotMatchKeywords.cs` (CA1716 keyword lists). https://github.com/dotnet/roslyn-analyzers/blob/main/src/NetAnalyzers/Core/Microsoft.CodeQuality.Analyzers/ApiDesignGuidelines/IdentifiersShouldNotMatchKeywords.cs
29. Framework Design Guidelines — General naming conventions. https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/general-naming-conventions
30. C# identifier names — rules and conventions. https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/identifier-names
31. Framework Design Guidelines — Names of type members. https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/names-of-type-members
32. dotnet/runtime — C# coding style. https://github.com/dotnet/runtime/blob/main/docs/coding-guidelines/coding-style.md
33. StyleCop Analyzers — SA1309. https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/SA1309.md
34. StyleCop Analyzers — SA1101. https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/SA1101.md
35. StyleCop Analyzers — Configuration (`stylecop.json` defaults). https://github.com/DotNetAnalyzers/StyleCopAnalyzers/blob/master/documentation/Configuration.md
36. ecosyste.ms repositories API (GitHub host), per-repo endpoint `https://repos.ecosyste.ms/api/v1/hosts/GitHub/repositories/{owner}%2F{repo}`, snapshot 2026-11-14.
37. Mhatre, Bajpai, Gulwani, Murphy-Hill, Soares — SWE-Sharp-Bench: A Reproducible Benchmark for C# Software Engineering Tasks, arXiv 2511.02352 (v3). https://arxiv.org/html/2511.02352v3 ; dataset https://huggingface.co/datasets/microsoft/SWE-Sharp-Bench
38. GitHub REST API — List repository languages, `https://api.github.com/repos/{owner}/{repo}/languages`, fetched 2026-11-14.
39. Build configuration files fetched from each repo's default branch via `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{Directory.Build.props|src/Directory.Build.props|Directory.Packages.props|.editorconfig|stylecop.json}`, 2026-11-14.
40. README files fetched from each repo's default branch (same method as [39]), 2026-11-14.
41. Jimmy Bogard — AutoMapper and MediatR Commercial Editions Launch Today. https://www.jimmybogard.com/automapper-and-mediatr-commercial-editions-launch-today/ ; and AutoMapper and MediatR Licensing Update. https://www.jimmybogard.com/automapper-and-mediatr-licensing-update/ (details as summarized by search results; pages not opened in full)
42. InfoQ — Fluent Assertions v8 license change (Jan 2025). https://www.infoq.com/news/2025/01/fluent-assertions-v8-license (details as summarized by search results)
43. NuGet — SixLabors.ImageSharp 3.1.3 license (Six Labors Split License 1.0). https://packages.nuget.org/packages/SixLabors.ImageSharp/3.1.3/License (details as summarized by search results)
44. AIDev: Studying AI Coding Agents on GitHub, arXiv 2602.09185 (MSR '26). https://arxiv.org/html/2602.09185v1 ; dataset https://huggingface.co/datasets/hao-li/AIDev
45. Luburić et al. — C# Dataset of Long Method and Large Class code smells (Zenodo 10.5281/zenodo.6520056). https://zenodo.org/records/6520056
46. Clean-CaDET — ML-code-smell-CSharp (reproducibility package). https://github.com/Clean-CaDET/ML-code-smell-CSharp (seen in search results only)
47. Bhandari et al. — CVEfixes, arXiv 2107.08760. https://arxiv.org/abs/2107.08760 ; MVD multi-lingual vulnerability framework, arXiv 2412.06166. https://arxiv.org/pdf/2412.06166 (both seen via search results only)
48. Search results on Java/C/C++ defect datasets (Unified Bug Dataset / GitHub Bug Dataset, Univ. Szeged). https://www.inf.u-szeged.hu/~ferenc/papers/GitHubBugDataSet/ (search snippet only)
