# 06 — Clean-code micro-practices: naming, comments/docs, magic numbers, error handling, dead code, readability, style consistency

Scope: deterministic (AI-free) metrics for C# (tree-sitter + Python), with per-line localization for the heatmap, parameter values, and the evidence behind each rule. Target: MessagePack-CSharp and agent-written PRs.

Verification legend:
- **[V]**: I read the primary source (full text or the official doc page) and the number or quote comes from it.
- **[V-abs]**: only the abstract or a record page was read, sometimes as quoted by a search engine. The claim is stated there, but the full text was not checked.
- **[V-sec]**: verified from a secondary source that summarizes the primary one (named next to the claim).
- **[unverified]**: from memory or not retrievable. Do not cite as fact until checked.

Note: the shared web-search budget ran out near the end of this research. Items marked [unverified] could not be checked for that reason.

---

## 0. TL;DR — the implementable rule set

| ID | Practice | Unit ("opportunity") | Violation rule (deterministic) | Default params | Line to highlight | Strongest evidence |
|---|---|---|---|---|---|---|
| N1 | Non-word (single-letter) names | declared identifier | `len(name)==1` and not in the allowlist and not a `for` loop counter / lambda param / discard / generic `T` | allowlist `{i,j,k,n,x,y,z,e,_,T}` | declaration line | 72 professional **C#** devs found defects **19% faster** with words than with letters/abbreviations; letters ≈ abbreviations [2][V] |
| N2 | Abbreviations / non-dictionary terms | identifier term (after splitting) | term ∉ EnglishDict ∪ DomainWhitelist ∪ AcronymList | ITID threshold per identifier < 1.0 → flag; score = mean ITID | declaration line | ITID formula [14][V]; Dorn NL feature [15][V]; Butler: non-dictionary words ↔ FindBugs priority-2 warnings [5][V-sec] |
| N3 | Excessively short or long names | identifier | `len < 3` (soft) / `len > 30` or `terms > 5` (soft) | Relf: short < 8 chars excluding i,j,k,l,m,n,t,x,y,z; long > 20 chars; 2–4 words [6][V-sec] | declaration | Relf/Butler guideline catalogue [5][6]; Lawrie: each extra syllable −1.4% recall [3][V] |
| N4 | Casing / convention anomaly | identifier per kind | regex mismatch vs the expected style for that kind (from the project `.editorconfig`, falling back to the .NET guidelines) | see §1.4 table | declaration | .NET Framework Design Guidelines [23][24][V]; MessagePack `.editorconfig` [26][V] |
| N5 | Underscore anomalies & Hungarian notation | identifier | `__` anywhere; leading/trailing `_` (unless the project style allows it); type-name prefix such as `strName` or `intCount` | — | declaration | .NET: "DO NOT use Hungarian notation", no `__` [23][24][V]; Relf [6] |
| N6 | Linguistic antipatterns (LA) | method / variable decl. | IDEAL rules A.2, A.3, B.2, B.3, B.4, B.5, B.6, A.4, D.1, D.2, E.1, G.1 (§1.6) | C# adaptations: `Task`≡void, `TryX` exempt, `override` exempt | signature line | LA-affected APIs: OR **1.29** for client bug introduction; B.5 OR **3.88** [9][V]; IDEAL precision 75.27% (C# evaluated) [8][V] |
| N7 | Naming-style consistency | identifier kind | normalized Shannon entropy of the case-style classes; minority members flagged | flag if minority share < 20% of kind | declaration | NATURALIZE: a third of review changes are convention feedback [21][V-abs] |
| D1 | Public API XML-doc coverage | public/protected type & member | no preceding `///` containing `<summary>` (≈ CS1591) | coverage = documented / public | declaration | CS1591 definition [27][V]; Java libs: only 46.2% of public methods documented, but 83.9% of the APIs clients actually use are [9][V] |
| D2 | Doc–signature consistency | documented method | `<param>` names ≠ parameter names; `<returns>` present on a void method or missing on a non-void one; PR changed the signature but not the doc | — | doc line + signature | code-comment co-evolution study, 1,500 systems [18][V-abs] |
| D3 | Trivial or unrelated member comment | member doc comment | Steidl c_coeff = matched words / comment words, where words match if Levenshtein < 2. Flag `c_coeff == 0` (unrelated) or `> 0.5` (trivial) | thresholds 0 / 0.5 | comment lines | Steidl et al. 2013, 16-dev survey [16][V] |
| D4 | Inline comment length | `//` comment | ≤ 2 words → "delete or extract method" | ≤2 / ≥30 words | comment | 70% of ≤2-word comments removed by devs; ≥30-word comments kept with ≥88% agreement in 9/10 cases [16][V] |
| D5 | Self-admitted technical debt | comment | regex `\b(TODO\|FIXME\|XXX\|HACK)\b` (MAT); optional extended list | case-insensitive | comment | MAT keywords [19][V-abs]; SATD in 2.4–31% of files [17][V-abs] |
| D6 | Commented-out code | comment block | Pham & Yang regex family (C#-adapted) and Steidl code-line ratio > 0.1 | §2.6 | comment block | precision 96.3% / recall 100% on 2,053 sampled comments [20][V] |
| M1 | Magic numbers | numeric literal | literal ∉ {−1,0,1,2} outside exempt contexts | Checkstyle {−1,0,1,2} [28]; Sonar C# {−1,0,1} plus 6 exempt contexts [29][V] | literal line | tool conventions only (no comprehension study found) |
| E1 | Empty catch | catch clause | block has no statements **and no comment** | — | `catch` line | Sonar S108/S2486 exempt commented blocks [31][V]; C# OSS median 10.6% of catches [10][V] |
| E2 | Catch-generic not rethrown | catch clause | type ∈ {`Exception`, `System.Exception`, `SystemException`} or bare `catch`, and the last statement is not `throw;` | CA1031 semantics [33][V] | `catch` line | Generic Catch significant for post-release defects in Umbraco (C#), χ² 14.82 vs 10.01 for size+complexity [11][V] |
| E3 | `throw ex;` (stack reset) | throw in catch | `throw <catchVar>;` | CA2200 (on as **warning** by default in .NET 10) [32][V] | throw line | Microsoft doc |
| E4 | Destructive wrapping | throw in catch | `throw new T(...)` whose argument list does not reference the catch variable | — | throw line | anti-pattern catalogue [10]; median 1.8% in C# vs 31.6% in Java [10][V] |
| E5 | Dummy handler / log-only | catch clause | every statement is a logging/printing call | logger name list §4 | `catch` line | Dummy Handler significant in Umbraco (C#) and Hibernate [11][V] |
| E6 | Catch-only-rethrow | catch clause | the only statement is `throw;` (S2737 exceptions apply) | — | `catch` line | Sonar S2737 [31][V] |
| E7 | Log-and-throw, return-null, TODO-only handler | catch clause | log call + `throw`; `return null;`; body is only a TODO/FIXME comment | — | `catch` line | de Pádua & Shang catalogue [10][V] |
| X1 | Unused private member | private method/field/property/event | 0 references in the type (all `partial` files) and no attributes | IDE0051 semantics [34][V] | declaration | dead code hampers comprehension of unfamiliar code [12][V-abs] |
| X2 | Unreachable statement | statement | follows `return/throw/break/continue/goto` in the same block | — | statement | [12][V-abs] |
| R1 | Local readability (Posnett) | sliding window of 4–11 lines | `z = 8.87 − 0.033·V + 0.40·Lines − 1.5·H_byte`; `R = 1/(1+e^(−z))` | window 8 lines, step 1 | window lines | Posnett et al. 2011 [13][V] |
| S1 | Formatting consistency | file | entropy of indentation unit, brace style, `this.` qualification and `var` use vs project majority | — | deviating lines | design (no direct paper) |

---

## 1. Identifier naming

### 1.1 Evidence

- **Lawrie, Morrell, Feild, Binkley (ICPC 2006, "What's in a name? A study of identifiers")** [1][V-abs]: over 100 programmers described 12 functions, each written with single letters, abbreviations or full words. Full words gave the best comprehension, but in many cases there was no statistically significant difference between full words and abbreviations.
- **Lawrie et al. (ISSE 2007, "Effective identifier names for comprehension and memory")** [3][V]: **128 participants**. Full words are best for comprehension, and well-chosen abbreviations are often statistically equivalent to them. In the recall model, "for each additional syllable present in the set of identifiers, on average PCIS decreases by 1.4%" (p < 0.0001). Each extra school year raises PCIS by 2.4% (p = 0.0494). Takeaway for us: do not penalize long names monotonically. Penalize non-words (single letters, opaque abbreviations).
- **Hofmeister, Siegmund, Holt (SANER 2017, "Shorter identifier names take longer to comprehend")** [2][V]. This is the most relevant study for us because its participants were **72 professional C# developers**, in a within-subjects defect-finding task on 15-line C# snippets.
  - Words were found **19% faster** (defects/minute) than letters + abbreviations. Contrast words vs non-words: t(71) = 2.73, p = .004, d_z = 0.32 (small-to-medium).
  - Letters vs abbreviations: t(71) = 0.07, not significant.
  - Syntax-error control task: F(2,142) = 0.8, not significant. So the effect is semantic, not perceptual.
  - Median time to find a semantic defect: Word 1:24.48, Abbreviation 1:38.57, Letter 1:40.36.
  - Abbreviations were generated by removing vowels and keeping the first 3 consonants (e.g. `request`→`rqs`). That is a useful pattern for an "opaque abbreviation" detector.
  - The authors note that `i` as a loop index can be considered idiomatic.
- **Butler, Wermelinger, Yu, Sharp (WCRE 2009, "Relating identifier naming flaws and code quality")** [4][V-abs]: 12 naming guidelines applied to 8 open-source Java projects. Statistically significant associations between flawed identifiers (violating at least one guideline) and FindBugs warnings. **CSMR 2010 follow-up** [5][V-abs]: the association also holds at method level and with readability metrics, and it used diagnostic-test techniques to find which flaws work as lightweight indicators. Per a secondary summary (Felienne Hermans' blog): "identifiers constructed of non-dictionary words are associated with 'priority two' FindBugs warnings" [5b][V-sec].
- **Relf 2004 guideline list** (source of Butler's guidelines) [6][V-sec, via Peter Hilton's summary]. Each item maps to a deterministic rule:
  - Multiple underscore characters (`Apple__Count`).
  - Outside underscore (`_Apple_Count`).
  - Naming-convention anomaly (non-standard mix of case).
  - Identifier encoding (Hungarian).
  - **Short identifier name: < 8 characters, excluding i, j, k, l, m, n, t, x, y, z.**
  - **Long identifier name: > 20 characters.**
  - **Number of words: should be 2, 3 or 4.**
  - English words (`App_Cnt` violates).
  - Numeric identifier name (`One_Hundred`).
  - Numeric digits (names differing only by digits).
  - Duplicate / similar identifier names in scope.
  - Unused identifier.
  - Un-named constant (any numeric value other than −1, 0, +1).
  - Enumeration ordering and qualification.
  - Butler's exact parameterization of his 12 [unverified]: the papers were not retrievable (HTTP 403).
- **Deissenboeck & Pizka (SQJ 2006, "Concise and consistent naming")** [7][V-sec: bibliographic record from [2]'s reference list]: a framework for naming correctness and consistency (synonyms/homonyms). It needs a name→concept mapping, so it is only partly automatable.
- **Linguistic antipatterns.**
  - Arnaoudova et al. CSMR 2013 (17 LA types, LAPD detector) [7b][V-abs].
  - Arnaoudova, Di Penta, Antoniol, EMSE 2016 [7c][V-abs, abstract as quoted in search results]: 69% of external and 51% of internal developers perceive LAs as poor practice.
  - **IDEAL (Peruma et al., ASE 2021 tool track)** [8][V]: 19 rules. Average precision **75.27%**; 14 of 19 rules above 50%. Evaluated on **C#** (Shadowsocks, PowerShell) and Java. Per-rule precision in §1.6.
  - **Aghajani et al. (ICSME 2018)** [9][V]:
    - 1.6k Maven library releases and 14k client projects.
    - 1.8% of methods are LA-affected (2.1% of public methods), and 64% of releases have at least one LA-affected public method.
    - Introducing a call to an LA-affected API gives **29% higher odds of a bug-inducing commit (OR 1.29, p = 0.007)**.
    - Per-type significant ORs: B.1 "Not implemented condition" **1.92**, B.4 "Not answered question" **1.93**, B.5 "Transform method does not return" **3.88**.
- **Identifier splitting.**
  - Samurai (Enslen, Hill, Pollock, Vijay-Shanker, MSR 2009): frequency-based splitting, evaluated on more than 8,000 Java identifiers [V-abs; accuracy numbers not retrieved].
  - **Spiral** (Hucka, JOSS 2018): a Python package with Ronin (Samurai-derived), camel-case and delimiter splitters [22][V-sec via the JOSS record summary]. Directly usable in a Python pipeline (archived repo, v1.1.0).

### 1.2 Splitting (preprocessing for N2/N3/N6/N7, D3)

Deterministic splitter for C# identifiers. A camel/Pascal splitter is adequate because .NET conventions forbid underscores in most identifiers [23][V].
1. Strip the `@` verbatim prefix. Strip and record leading prefixes allowed by the project config (`_`, `s_`, `t_`) and the interface `I` prefix (`^I(?=[A-Z][a-z])`) and type-parameter `T` prefix (`^T(?=[A-Z])`).
2. Split on `_` and digits, then by regex `[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+`. This handles acronyms such as `IOStream`→`IO`,`Stream` and `HtmlTag`→`Html`,`Tag`.
3. Lower-case the terms.
4. Optional: fall back to Spiral/Ronin [22] when a single long lowercase term isn't in the dictionary (e.g. `maxlen`).

### 1.3 N1–N3: non-words, abbreviations, length

- **N1 (single letter).** Flag when `len(core_name) == 1`, except:
  - `for`/`foreach` loop variables;
  - lambda parameters in single-expression lambdas;
  - `catch (X e)`;
  - discards `_`;
  - generic type parameter `T`.
  
  Baseline allowlist `{i, j, k, n, x, y, z, e}`. This is a deliberately tighter variant of Relf's exclusion list [6]; the .NET docs also say "avoid single-letter names, except for simple loop counters" [24][V]. Evidence: [2] (letters slower than words, C# developers).
- **N2 (dictionary coverage, ITID).** Per identifier, `ITID(id) = |terms ∩ D| / |terms|`. Per line (the Scalabrino definition), `ITID(l) = |Terms(l) ∩ Dictionary| / |Terms(l)|` [14][V]. Aggregate per file or PR as mean/min.
  - **D** = an English word list plus:
    - a whitelist of programming/domain terms, including the C# keyword and type names (`int`, `bool`, `async`, `utf8`, `msgpack`, `ext`, `lz4`, `nil`, `buf`?);
    - accepted acronyms (`id`, `io`, `ui`, `xml`, `json`, `http`, `uri`, `guid`).
  - Calibrate the whitelist by mining the **project's own** frequent terms. Terms used ≥ k times across MessagePack (e.g. k = 20) are treated as domain vocabulary. Otherwise every repo-specific term is penalized.
  - Flag terms that match the vowel-dropping abbreviation shape used in [2] (≥ 2 consonants, ≤ 1 vowel, length 2–4, not in D, e.g. `rqs`, `cnt`, `idx`, `str`, `msg`). This is a heuristic, so give it a lower weight. Some, like `idx`, are idiomatic; put them in a configurable allowlist.
  - The .NET guideline is "DO NOT use abbreviations or contractions as part of identifier names" (e.g. `GetWin`→`GetWindow`) [23][V].
- **N3 (length).** Relf: short < 8, long > 20, words ∈ [2, 4] [6]. These are heuristic guideline values, not empirically calibrated cut-offs. Lawrie [3] warns that longer names cost memory and found no clear advantage of full words over good abbreviations. Recommendation:
  - Use a *soft* penalty only for `len ≥ 2 and len < 3` non-dictionary names.
  - Use an informational flag only for `terms > 5` or `len > 30`. The 30 is our own choice, more permissive than Relf's 20, because PascalCase .NET type names are routinely long.

### 1.4 N4/N5: casing conventions per identifier kind (C#)

From the .NET Framework Design Guidelines [23][V] and the C# identifier-names doc [24][V]:

| Kind (tree-sitter node) | Expected (guidelines) | Regex |
|---|---|---|
| namespace, class, struct, record, enum, delegate | PascalCase | `^[A-Z][A-Za-z0-9]*$` |
| interface | `I` + PascalCase | `^I[A-Z][A-Za-z0-9]*$` |
| type parameter | `T` or `T`+PascalCase | `^T([A-Z][A-Za-z0-9]*)?$` |
| method, local function, property, event, enum member, const (any accessibility), public/protected field | PascalCase | `^[A-Z][A-Za-z0-9]*$` |
| parameter, local variable | camelCase | `^[a-z][A-Za-z0-9]*$` |
| private/internal instance field | **project-dependent**: runtime style `_camelCase`; MessagePack: `camelCase` (no prefix, `this.` qualification) | per `.editorconfig` |
| private/internal static field | runtime style `s_camelCase`; MessagePack: `camelCase` | per `.editorconfig` |
| attribute class | ends with `Attribute` | `Attribute$` |
| any | no `__` (reserved for the compiler) [24]; no Hungarian; no hyphens | `__` ⇒ violation |

Two-letter acronyms stay upper-case in PascalCase (`IOStream`) and lower-case at the start of camelCase (`ioStream`). Longer acronyms are Pascal-cased (`HtmlTag`) [23][V].

**MessagePack-CSharp specifics** [26][V]: the `.editorconfig` declares naming rules, all at `suggestion` severity:
- `instance_fields_should_be_camel_case`;
- `static_fields_should_be_camel_case`;
- `non_private_static_fields_should_be_pascal_case`;
- `constants_should_be_pascal_case`;
- `locals_should_be_camel_case`;
- `local_functions_should_be_pascal_case`;
- `members_should_be_pascal_case`.

Other relevant settings:
- **No underscore prefix is defined.**
- `SA1101` (prefix local calls with `this`) = suggestion; `dotnet_style_qualification_for_field = false:silent`.
- `IDE1006` = none.
- `CS1591` = suggestion.
- `SA1600/SA1601/SA1602` = silent.
- `SA1604/SA1611/SA1615/SA1618` = suggestion.
- `DOC104..DOC108, DOC200, DOC202` = warning.

**Consequence:** the certifier must read the target repo's `.editorconfig` naming rules (or infer them, §7) instead of hard-coding the Microsoft runtime style. Otherwise every MessagePack field would be a false positive.

N5 Hungarian detection (heuristic):
- first term ∈ {`str`, `sz`, `int`, `i`, `n`, `b`, `f`, `dbl`, `lp`, `m`, `p`, `arr`, `obj`} followed by an upper-case letter (e.g. `strName`, `bIsOpen`), **or**
- first/last term equal to the declared type's keyword or name (`nameString`, `intCount`).

The .NET guidelines say "DO NOT use Hungarian notation" [23][V].

### 1.5 N6-bis: numeric/duplicate names

- Names differing only by trailing digits in the same scope (`value1`, `value2`): Relf's "numeric digits" rule [6].
- A name made only of number words: Relf's "numeric identifier name" [6].
- Names in the same scope with Levenshtein ≤ 1 (`appleCount`/`appleCounts`): Relf's "similar identifier names" [6]. Low weight.

### 1.6 N6: Linguistic antipatterns — syntactic detection rules (IDEAL catalogue [8][V], C#-adapted)

IDEAL detection conditions and measured precision (Table III of [8]):

| ID | Name | Condition (IDEAL) | Precision |
|---|---|---|---|
| A.1 | "Get" more than accessor | get-prefixed public/protected method whose name contains an attribute name, returns that attribute's type, and has conditionals | 100% |
| A.2 | "Is" returns more than a Boolean | predicate prefix and non-boolean return | 100% |
| A.3 | "Set" method returns | set-prefix and non-void return | 98.44% |
| A.4 | Expecting but not getting single instance | singular last term, no collection term, collection return | 80.31% |
| B.1 | Not implemented condition | conditional term in name/comment but no conditional in body | 42.69% |
| B.2 | Validation method does not confirm | validation prefix, void return, no throw | 99.40% |
| B.3 | "Get" method does not return | get-prefix and void return | 100% |
| B.4 | Not answered question | predicate prefix and void return | 31.25% |
| B.5 | Transform method does not return | transformation term and void return | 42.99% |
| B.6 | Expecting but not getting a collection | get-prefix, plural/collection term, non-collection return | 80.50% |
| C.1 | Method name and return type are opposite | antonyms (needs WordNet) | 72.97% |
| C.2 | Method signature and comment are opposite | antonyms (needs WordNet) | 11.61% |
| D.1 | Says one but contains many | singular last term, collection type (attribute/variable/parameter) | 99.62% |
| D.2 | Name suggests Boolean but type does not | predicate prefix, non-boolean type | 100% |
| E.1 | Says many but contains one | plural last term, non-collection type | 94.40% |
| F.1 / F.2 | Attribute name/type or comment opposite | antonyms | 59.38% / 16.48% |
| G.1 | Name contains only special characters | — | 100% |
| G.2 | Redundant "test" in test method name | — | 100% |

Recommended for our certifier: the high-precision, purely syntactic rules **A.2, A.3, B.2, B.3, D.1, D.2, E.1, A.4, B.6**, plus **B.5** with low weight. B.5 has the highest bug odds ratio in [9] but only 43% precision in [8]. Skip C.x/F.x (WordNet antonyms, low precision).

C#-specific adaptation (our design; the IDEAL term lists themselves were not retrieved):
- **void-equivalents:** `void`, `Task`, `ValueTask` (non-generic). **Value-returning:** `T`, `Task<T>`, `ValueTask<T>`, `IAsyncEnumerable<T>`. Strip the `Async` suffix before term analysis.
- **Exempt:**
  - `override` methods, explicit interface implementations and `partial` method implementations, because their names are dictated by base types (e.g. `ISerializable.GetObjectData` returns void);
  - the `TryXxx(out …)` pattern, which returns bool by design;
  - event handlers `OnXxx`;
  - `[Fact]`/`[Test]` methods.
- **Term lists (proposed):**
  - get: `get`, `fetch`, `retrieve`, `find`, `read`, `compute`, `calculate`;
  - predicate: `is`, `has`, `can`, `should`, `are`, `was`, `will`, `does`, `contains`, `supports`, `needs`, `exists`;
  - set: `set`;
  - validation: `validate`, `check`, `verify`, `ensure`, `assert`;
  - transform: `to` (first term), `convert`, `transform`, `parse`, `serialize`, `deserialize`, `encode`, `decode`.
- **Collection types:** arrays `T[]`, `IEnumerable<>`, `ICollection<>`, `IList<>`, `IReadOnlyList<>`, `IReadOnlyCollection<>`, `List<>`, `HashSet<>`, `ISet<>`, `Dictionary<,>`, `IDictionary<,>`, `ImmutableArray<>`, `ReadOnlySpan<>`/`Span<>`/`Memory<>`/`ReadOnlyMemory<>` (configurable; `Span<byte>` named `buffer` is not a violation), `ReadOnlySequence<>`.
- **Plural detection (deterministic):** last term ends with `s`/`es`/`ies` and is not in a non-plural list (`status`, `bytes`?, `alias`, `analysis`, `class`, `process`, `address`, `access`, `success`, `options`?). Treat `data`, `metadata`, `info` as neutral (IDEAL authors call `data`/`result` ambiguous [8]).
- **Limitation:** `var` locals hide types in tree-sitter (no semantic model). Apply D.1/E.1/D.2 only when the type is written explicitly, or infer from `new T(...)` or a literal. IDEAL notes that `var` and `object` hinder LA analysis [8][V].

---

## 2. Comments and documentation

### 2.1 Evidence

- **Buse & Weimer (TSE 2010)** [13b][V]: 120 annotators, 100 snippets, 25 local features. Readability classifiers were 75–80% correct. The readability metric correlates with FindBugs warnings, code churn and defect log messages. "Comments, in of themselves, are less important than simple blank lines to local judgments of readability."
  - Implication: do **not** reward raw comment density monotonically. Report it, don't score it.
- **Steidl, Hummel, Juergens (ICPC 2013, "Quality analysis of source code comments")** [16][V]:
  - comment categories: copyright, header, member, inline, section, code, task;
  - the coherence coefficient and inline-length metrics (§2.4);
  - commented-out-code detection by the ratio of code lines (threshold 0.1).
- **Scalabrino et al. (ICPC 2016)** [14][V]: textual features:
  - CIC (comment–identifier consistency);
  - ITID (identifier terms in dictionary);
  - NMI (narrow-meaning identifiers, via WordNet hypernym depth);
  - TC (textual coherence);
  - CR (comment readability, Flesch–Kincaid);
  - NM (number of meanings).
  
  Evaluated on 600 snippets rated by 5K+ people; the textual features complement structural ones.
- **Wen, Nagy, Bavota, Lanza (ICPC 2019)** [18][V-abs]: 1.3 billion AST-level changes from 1,500 systems and a taxonomy from 500 manually analysed commits. Shows which code-change types trigger comment updates, i.e. where inconsistencies get introduced.
- **Aghajani et al. 2018** [9][V], baseline for API docs (Java):
  - 22.5% of all methods and 46.2% of public methods have Javadoc;
  - 49% of public methods are undocumented even after excluding getters/setters;
  - 83.9% of API methods actually used by clients are documented.
- **SATD.**
  - Potdar & Shihab (ICSME 2014): SATD appears in 2.4–31% of files, and 26.3–63.5% of it is removed after introduction [17][V-abs, as quoted in search results]. They derived **62 comment patterns** from 101,762 manually classified comments ([17b] SATDBailiff paper [V]). The full pattern list was not retrieved [unverified list].
  - Common SATD markers: comments beginning with TODO, FIXME, BUG, XXX, HACK [17b][V].
  - **MAT** [19] matches only TODO, FIXME, XXX, HACK, is unsupervised, was evaluated on 10 projects, and reportedly rivals ML approaches [19][V-abs; F1 numbers not retrieved].
- **Commented-out code (CO).**
  - Pham & Yang (ICPC 2020, "The secret life of commented-out source code") [20][V]:
    - 6 projects;
    - up to 20% of commits in early history involve CO code;
    - 10% of CO instances are uncommented at least once;
    - regex detector with precision 96.3% and recall 100% on a stratified sample of 2,053 comments;
    - false positives mostly come from code examples in documentation comments (Groovy, 84% precision).
  - Aman 2011 reportedly links commenting-out to fault-proneness in 7 Java projects [unverified, Japanese-language].

### 2.2 D1 — public API XML-doc coverage

- **Unit:** each `public`/`protected` (and `protected internal`) type, method, constructor, property, indexer, event, field, delegate or enum member whose containing types are all also externally visible. This is the CS1591 universe: "Missing XML comment for publicly visible type or member" [27][V].
- **Documented** = an immediately preceding `///` trivia block containing `<summary>` with ≥ 1 word of non-tag text, or `<inheritdoc/>`. `<inheritdoc/>` is acceptable for overrides and interface implementations.
- **Score:** `cov = documented / opportunities`. Per-line: highlight undocumented declarations.
- **PR mode:** count *new* public declarations in the diff without docs.
- **MessagePack note:** CS1591 is only a suggestion and SA1600 is silent there [26]. Use the repo's own baseline coverage as the reference instead of an absolute 100% target.

### 2.3 D2 — doc–signature consistency (deterministic subset of "comment–code inconsistency")

Rules (StyleCop SA16xx-like; rule semantics [unverified] but trivially derivable):
- the set of `<param name="…">` must equal the set of parameter names (missing, extra and misspelled entries are each a violation);
- `<typeparam>` likewise;
- `<returns>` must be absent for void/`Task` and should be present for value-returning methods (soft);
- `<exception cref="X">` for each `throw new X` directly in the body (soft).

**PR co-change rule:** if the PR changes a method's signature (parameters, return type or name) and the method has a doc comment, but the doc lines are unchanged in the diff, flag a probable inconsistency. This is motivated by [18].

### 2.4 D3/D4 — comment usefulness (Steidl metrics [16][V])

- **c_coeff (member comments):**
  1. Split comment words on whitespace and method-name words by camel case (after removing XML tags, delimiters and commented-out code).
  2. A comment word *matches* if some name word has Levenshtein distance < 2.
  3. `c_coeff = matched comment words / total comment words`.
  4. **Flag `c_coeff == 0`** (comment unrelated to the name, i.e. a poor comment or poor identifier) and **`c_coeff > 0.5`** (trivial comment that only restates the name, e.g. "removes all defined markers" on `removeAllMarkers` scores 0.75). The middle range is a grey zone.
  
  Recommendation: strip stop-words before computing c_coeff for C#. The paper did not say whether stop-words were removed [unverified].
- **CIC (method-level alternative)** [14][V]: `CIC(m) = |Comments(m) ∩ Ids(m)| / |Comments(m) ∪ Ids(m)|`, a Jaccard overlap of terms in the method comment and identifiers in the body, in [0,1]. Higher means more consistent.
- **Inline comment length (D4):** count words after normalization. Flag **≤ 2 words** as "delete or extract into a well-named method". Treat **≥ 30 words** as valuable (positive signal, never flagged). Survey: in 70% of ≤2-word examples participants deleted the comment or extracted a method; all ten ≥30-word comments were kept, with ≥88% agreement in 9 of 10 [16][V].
- **Comment readability (optional):** Flesch–Kincaid as used by Scalabrino: `FK = 206.835 − 1.015·(words/phrases) − 84.6·(syllables/words)` [14][V].

### 2.5 D5 — self-admitted technical debt

- **Regex (MAT keywords [19]):** `(?i)\b(TODO|FIXME|XXX|HACK)\b` in `//`, `/* */` and `///` comments. Optionally add `BUG`, `KLUDGE`, `WORKAROUND`, `TEMP(ORARY)?\b` (SATDBailiff mentions BUG [17b]; the others are our extension, [unverified] as validated patterns).
- **Metrics:** SATD count per KLOC, and SATD *introduced* in the PR diff (added comment lines matching). The heatmap marks the comment line.
- **Calibration:** reported prevalence spans 2.4–31% of files [17], so absolute thresholds are project-specific. Use the repo baseline.

### 2.6 D6 — commented-out code (C#-adapted Pham & Yang regexes)

Pham & Yang's Java patterns [20][V] (a comment block is CO if any pattern matches):
1. method call: `[a-zA-Z0-9]+\s*\(.*?\)\s*?(;|\{)`
2. declarations: `(public|private|void|protected|new)\s+.+?(;|\{)`
3. block headers: `(if|while|for|catch)\s*\(.*` and `(else|do|try|finally|switch)\s*\{.*`
4. statements: `return\b.*?;` and assignment `=.+?;`

C# additions (ours):
- `(internal|static|readonly|var|using|await|foreach|lock|throw)\b.*?(;|\{)`;
- `=>.*;`;
- `#(if|endif|region)` lines are *not* CO.

Steidl's block rule [16][V]: a comment is a "code" comment if `code_lines / comment_lines > 0.1`, where a line is code if it matches the method-call or if/while patterns or ends in `;`.

Exclusions:
- `///` XML doc comments, especially `<code>`/`<example>` content (the main false-positive source in [20]);
- license headers;
- lines containing URLs.

Unit is the contiguous comment block; highlight all lines of the block. Sonar's rule says commented-out code should be removed because it can be recovered from source control [30][V].

### 2.7 Comment density (informational only)

`density = comment_lines / (code_lines + comment_lines)`, excluding license headers and CO code (Steidl recommends excluding CO code from comment metrics [16]). There is no evidence-based optimal threshold, and Buse shows comments matter less than blank lines for local readability [13b]. Report it, don't score it.

---

## 3. Magic numbers and hard-coded literals

- **Checkstyle MagicNumber** [28][V]:
  - `ignoreNumbers` default **{−1, 0, 1, 2}**;
  - checks int/long/float/double literals;
  - exempt: constant definitions (`final` fields/variables), including whole expressions such as `static final int SECONDS_PER_DAY = 24*60*60` (via `constantWaiverParentToken`), and annotation element defaults (`ignoreAnnotationElementDefaults` = true);
  - **not** exempt by default: `hashCode` methods (`ignoreHashCodeMethod` = false), annotations (`ignoreAnnotation` = false), field declarations (`ignoreFieldDeclaration` = false).
- **SonarC# S109** [29][V]: −1, 0, 1 are not magic. Not flagged:
  - inside `GetHashCode`;
  - in a variable or field declaration;
  - as the single argument of an attribute;
  - as a named argument;
  - in a constructor call;
  - as a default parameter value.
- **Our C# rule M1:** flag numeric literals ∉ {−1, 0, 1, 2} (Checkstyle set; make 2 configurable, since Sonar uses {−1, 0, 1}). Exempt contexts:
  - initializers of `const`, `static readonly` and `readonly` fields and `const` locals;
  - enum member values;
  - attribute arguments;
  - named arguments;
  - default parameter values;
  - `GetHashCode` bodies;
  - array/collection initializer elements inside a constant/static-readonly initializer;
  - test methods (configurable).
- **Domain caveat (MessagePack):** binary-format code is full of byte constants, masks and shifts (`0xFF`, `0x7F`, `>> 8`). Proposal (ours, not from literature):
  - expose `ignoreBitMasks` (values `2^k − 1`, `2^k` for k ≤ 64, written in hex);
  - expose `ignoreShiftAmounts` (multiples of 8 as the right operand of `<<`/`>>`);
  - calibrate on the MessagePack baseline. Report magic-number density per KLOC relative to that baseline rather than absolute counts.
- **Hard-coded strings:** flag string literals duplicated ≥ 3 times in a file outside constants. This mirrors Sonar S1192's default [unverified threshold]. Exclude `nameof`, log message templates and test code.

No controlled comprehension or defect study specific to magic numbers was found. Treat M1 as a convention-conformance metric (low weight) unless the project's own history validates it (§8).

---

## 4. Exception-handling anti-patterns

### 4.1 Evidence

- **de Pádua & Shang (ICPC 2017, "Studying the prevalence of exception handling anti-patterns")** [10][V]:
  - **16 projects, 7 C#** (Glimpse, Google API, OpenRA, ShareX, SharpDevelop, SignalR, Umbraco) **and 9 Java**;
  - 19 anti-patterns: 17 at catch level, 2 at throws level (Java only);
  - C# parsed with **Roslyn**, plus an exception-flow analysis.
  - Only 5 anti-patterns appear in more than 20% of catch/throws in the median: Unhandled Exceptions 40.8%, Catch Generic 31.9%, Unreachable Handler 28.0%, Over-catch 24.6%, Destructive Wrapping 22.3%.
  - Language differences (Wilcoxon p < 0.05):
    - Destructive Wrapping median **31.6% in Java vs 1.8% in C#**;
    - Catch Generic in C# has text-stated min 45.0% and median 74.3%, vs Java max 33.8% and median 17.6%.
  - Catalogue definitions (Table I):
    - Catch and Do Nothing = the handler is empty;
    - Catch Generic = catches a generic type such as Exception;
    - Destructive Wrapping = propagates the exception as a new exception;
    - Dummy Handler = only displays or logs;
    - Log and Throw;
    - Catch/Log and Return Null;
    - Incomplete Implementation = only TODO/FIXME comments;
    - Nested Try;
    - Multi-Line Log;
    - Throw within Finally;
    - Over-catch (and Abort);
    - Unhandled and Unreachable Handler (need flow analysis).
  - **C# per-project rates from Table III** (% of catch blocks; medians computed by me from the 7 C# rows):

    | Anti-pattern | Range across the 7 C# projects | Median |
    |---|---|---|
    | Catch and Do Nothing | 6.7%–23.1% | ≈ 10.6% |
    | Catch Generic (table values) | 45.8%–90.6% | ≈ 76.2% (the text says 74.3%; small inconsistency in the paper) |
    | Dummy Handler | 10.0%–30.8% | ≈ 13.4% |
    | Destructive Wrapping | 0%–20% | ≈ 1.8% |
    | Log and Throw | ≤ 0.95% | — |
    | Catch and Return Null | 0%–19.6% | — |

    These are directly usable as **C# reference distributions** for thresholds.
- **de Pádua & Shang (MSR 2018, "Studying the relationship between exception handling practices and post-release defects")** [11][V]: Umbraco (**C#**), Hadoop and Hibernate (Java), file-level logistic models of post-release defects.
  - Most of the 17 anti-patterns were **not** significant.
  - **Dummy Handler** (percentage of affected catches) was positively related to defects in Umbraco and Hibernate.
  - **Generic Catch** (count) was positive in Umbraco, with more explanatory power than base size/complexity (χ² 14.82 vs 10.01).
  - Ignoring InterruptedException and Log and Throw were positive in Hadoop.
  - Exception-flow characteristics mattered in the Java projects.
  - Longer handlers were associated with defects ([11]; also summarized by Never Work in Theory [11b][V-sec]).
- **Ebert, Castor, Serebrenik (JSS 2015)** [36][V]: a survey of 154 developers and 220 exception-handling bugs from Eclipse and Tomcat.
  - In 70% of organizations there are no specific tests for exception-handling code.
  - Bugs from overly general catch blocks are rare, even though such blocks are common.
  - Empty catch blocks caused only **2 of 220** bugs and are often used *in* bug fixes, frequently with a comment explaining why the exception is ignored.
  
  ⇒ Weight empty catch with a comment as acceptable, and do not over-weight generic catch on its own.
- **Cabral & Marques (ECOOP 2007, "Exception handling: a field study in Java and .NET")**: 32 applications in Java and .NET [V-sec via [10]'s related work], 18,589 try blocks [V-abs via search snippet]. Handlers mostly log, notify the user or terminate. Exact empty-handler percentages [unverified].

### 4.2 Deterministic C# rules (tree-sitter `catch_clause`, `throw_statement`)

Let `C` = catch clause, `v` = its declared variable (if any), `B` = its block statements, and `type` = its declared type (or none for a bare `catch`).

| Rule | Condition | Notes / exemptions |
|---|---|---|
| E1 Empty catch | `len(B)==0` **and** no comment trivia inside the braces | Sonar S108/S2486 do not flag blocks containing comments [31][V]; Ebert [36] supports exempting them. Weight × 1.5 when `type` is generic (S2486 targets generic) |
| E2 Catch-generic not rethrown | `type ∈ {Exception, System.Exception, SystemException, System.SystemException}` or bare `catch` (no filter `when (…)`) **and** the last statement of `B` is not `throw;` | CA1031: the fix is to catch a specific type or rethrow as the last statement [33][V]. Exempt top-level entry points (`Main`, thread procs) and `catch` with an exception filter |
| E3 Rethrow losing stack | `throw_statement` with expression = identifier `v` | CA2200, enabled as warning by default in .NET 10; "Do not suppress" [32][V]. Sonar S3445 [31] |
| E4 Destructive wrapping | inside `C`: `throw new T(args)` where no arg references `v` (also check `v.InnerException`) | de Pádua's definition [10] refined to the information-losing case |
| E5 Dummy handler | `B` non-empty and every statement is an expression statement calling a logger | logger pattern: receiver/method matches `(?i)(log\|logger\|trace\|debug\|console)\b` or method ∈ {`Log*`, `Write*`, `Trace*`, `Debug*`, `Info`, `Warn*`, `Error`, `Fatal`} |
| E6 Catch-only-rethrow | `B == [throw;]` | S2737 exceptions: allowed if followed by a more general catch with logic [31][V] |
| E7a Log-and-throw | `B` contains a logger call and a `throw` | rare in C# (≤ 0.95% of catches [10]) |
| E7b Catch-and-return-null | `B` contains `return null;` (or is only a log plus `return null;`) | [10] |
| E7c Incomplete handler | `B` empty and its only comment matches the SATD regex | [10] "Incomplete Implementation" |
| E8 Nested try in catch | a `try_statement` inside `B` | [10] (low weight) |

Localization: the `catch` keyword line (E1/E2/E5/E6/E7) or the `throw` line (E3/E4). Exposure denominator: number of catch clauses in scope.

---

## 5. Dead code / YAGNI

- **Evidence.** Romano, Vendome, Scanniello et al., "A multi-study investigation into dead code" (TSE 2018/2020, DOI 10.1109/TSE.2018.2842781) [12][V-abs, as quoted in search results]: interviews plus four experiments. "Dead code significantly hampers source code comprehensibility and modifiability, especially in unfamiliar code", and developers perceive dead code as harmful but manage it poorly. The figure "up to 15.94% of methods" [unverified, from a search snippet]. The ICPC 2016 precursor experiment had 47 students [unverified detail].
- **X1 Unused private members (IDE0051 semantics** [34][V]: "unused private methods, fields, properties, and events that have no read or write references"). Tree-sitter approximation:
  - declared `private` (or default accessibility in a class);
  - the member name appears as an identifier token nowhere else in the containing type's declarations, including all `partial` parts across files, nor in `nameof(...)` or string literals of the same type.
  
  Exempt members with any attribute, especially serializer attributes (`[Key]`, `[SerializationConstructor]`, `[IgnoreMember]`, `[DataMember]`, `[JsonProperty]`), because MessagePack relies on reflection and source generators. Also exempt `extern` members, explicit interface implementations and members named `Dispose`/`Finalize`. IDE0052 (assigned but never read) is a natural extension [unverified ID semantics].
- **X2 Unreachable statements:** any statement after an unconditional `return`, `throw`, `break`, `continue` or `goto` in the same block (syntactic subset of compiler warning CS0162 [unverified code]). Also code after `while(true){…}` with no `break`.
- **X3 Unused locals/parameters:**
  - a local declared and never referenced (≈ CS0168/CS0219 [unverified codes]);
  - a non-public method parameter never referenced, excluding overrides, interface implementations, event handlers and `_` names (≈ IDE0060 [unverified]).
- **X4 Commented-out code:** see D6.

---

## 6. Readability models (deterministic formulas and features only)

### 6.1 Posnett, Hindle, Devanbu (MSR 2011, "A simpler model of software readability") [13][V]

- Retrained on the Buse dataset. A 3-variable logistic model outperforms Buse's 25-feature model (all performance measures, 10 Weka classifiers, 10×10-fold CV).
- **Formula** (Section 4.5): `p(readable) = 1 / (1 + e^(−z))`, with
  **`z = 8.87 − 0.033·V + 0.40·Lines − 1.5·Entropy`**.
  - V = Halstead volume = `N·log2(n)` (N = total operators+operands, n = distinct);
  - Lines = snippet line count;
  - Entropy = Shannon entropy `H(X) = −Σ p(x_i) log2 p(x_i)` over **bytes/characters** of the snippet. The final "improved Halstead model" uses lines, V and byte/character entropy.
  - Signs: the extracted PDF text lost the minus glyphs (the `+` before Lines survived). The paper states that V is negatively associated and lines positively associated, and that the raw byte-entropy correlation is negative. Spearman correlations with mean voter score: V −0.64, Lines +0.23, byte entropy −0.10, token entropy +0.62.
  - V and Lines alone explain roughly half of the variance in mean readability.
- **Validity domain:** the Buse snippets were **4–11 lines**. The positive Lines coefficient makes the formula meaningless for whole files. **Use:** compute R1 on sliding windows of 8 lines (step 1) over method bodies, and assign each line the mean `p` of the windows covering it. That gives a per-line heatmap. Report the method score as the min or mean.

### 6.2 Buse & Weimer features (TSE 2010) [13b][V]

The 25 features, each per-line averaged (avg) and/or maximum (max):
- line length;
- # identifiers;
- identifier length;
- indentation;
- # keywords;
- # numbers (avg+max);
- # comments, periods, commas, spaces, parentheses, arithmetic operators, comparison operators, assignments, `if`, loops, blank lines (avg);
- max occurrences of any single character, max occurrences of any single identifier (max).

Most predictive in the singleton analysis: **average line length** and **average identifiers per line**. Not predictive alone: average identifier length, `if` constructs, loops, comparison operators. 8 principal components explain 95% of variance. Usable as deterministic per-line signals (e.g. long lines and identifier-dense lines), with no ML needed if we only rank lines by these z-scored features against the repo baseline.

### 6.3 Dorn (2012, "A general software readability model") [15][V]

5,000 participants; Java, Python and CUDA (360 snippets per [14]). Features:
- visual/structural (indentation signals via DFT, alignment of `=` and of expressions);
- natural-language: the **fraction of identifiers whose camel/underscore-separated terms are English words** (= our N2);
- shallow syntax (line length, distinct identifiers, keyword/number/operator frequency).

Weights were learned by logistic regression and are not reproduced here. Use the features, not the weights.

### 6.4 Scalabrino et al. (ICPC 2016) [14][V]

Formulas for ITID, CIC (incl. a synonym variant), NMI (sum of WordNet hypernym depths), TC (max/min/avg vocabulary overlap between syntactic blocks) and FK comment readability; see §2.4. NMI and NM need WordNet, which is still deterministic (a lexical database lookup, not AI). Optional.

---

## 7. Style consistency via entropy (N7, S1)

- **Motivation:** NATURALIZE (Allamanis, Barr, Bird, Sutton, FSE 2014) learns a codebase's conventions statistically. It reports **94% accuracy** in top identifier-name suggestions, 10,968 projects, 14 of 18 generated patches accepted, and notes that **one third of code-review changes contain feedback about coding conventions** [21][V-abs]. NATURALIZE is ML (n-gram LM), so we only borrow the idea of *project-relative* consistency.
- **Deterministic metric (ours):**
  - For each identifier kind `k` (§1.4 rows), classify every declared name into a style class `c` ∈ {PascalCase, camelCase, _camelCase, s_camelCase, m_camelCase, UPPER_SNAKE, snake_case, other}.
  - Let `p_c` be the class proportions. Normalized entropy: `H_k = −Σ_c p_c log2 p_c / log2(|classes observed or 8|)`.
  - Consistency score `S_k = 1 − H_k`. Overall = mean of `S_k` weighted by kind frequency.
  - **Per-line:** flag declarations whose class ≠ the majority class of kind `k` when the majority share ≥ 80% (ours).
  - In PR mode, compare the PR's names against the **base-branch** majority. That catches agents importing a foreign style, such as `_camelCase` fields into MessagePack.
- **Formatting consistency (S1)**, same entropy recipe over:
  - indentation unit (tabs vs 2/4 spaces);
  - brace placement (Allman vs K&R);
  - `this.` qualification (MessagePack suggests SA1101 `this.` [26]);
  - `var` vs explicit types;
  - expression-bodied vs block members;
  - `using` placement (MessagePack: outside namespace, System first [26b][V]).

---

## 8. Scoring, localization and statistical validation (recommendations)

1. **Per-rule density** = violations / opportunities. Opportunities are, by rule:
   - declared identifiers (N*);
   - public members (D1);
   - documented methods (D2/D3);
   - comments (D4–D6);
   - numeric literals (M1);
   - catch clauses (E*);
   - private members (X1).
2. **Project-relative thresholds:** compute each rule's density distribution over files or methods of the MessagePack base branch. Flag a PR or file if its density exceeds the baseline P75/P90, or show its percentile. This handles domain idioms (magic numbers in a binary serializer, CS1591 being optional). Use the C# reference rates from [10] as a sanity check for E*.
3. **Heatmap value per line:** `h(line) = Σ_rules w_r · 1[line ∈ span(r)]`. Suggested weights favour rules with evidence of defect association or high precision:
   - w = 3: E2, E3, E5, N6 (B.x types);
   - w = 2: E1 (uncommented), E4, D2, D6, X1, X2, N1;
   - w = 1: N2–N5, N7, D3–D5, M1, E6–E8.
4. **Validation on the repo's history** (replicating the published designs):
   - **Odds ratio / Fisher's exact test** (Aghajani et al. design [9]): are lines/methods flagged by rule r more likely to be modified by later bug-fix commits (SZZ-style) than unflagged ones? Report OR with a 95% CI.
   - **Size-controlled logistic regression** (de Pádua & Shang design [11]): base model = size + complexity (+ churn). Add rule densities, and report the likelihood-ratio χ² improvement and Nagelkerke R². Size confounds almost every density metric.
   - **Redundancy check:** Spearman correlation among rule densities. Drop or merge pairs with |ρ| > 0.8 (cf. the multicollinearity issues in [13]).
   - **Agent PRs vs human PRs:** Mann–Whitney U and Cliff's δ per rule density; bootstrap CIs for the composite score.
   - **Precision audit:** manually label a stratified sample of each rule's hits on MessagePack (95% confidence, ±5–10% margin, as in [8] and [20]) and report precision per rule before using it in certification.

---

## References

1. D. Lawrie, C. Morrell, H. Feild, D. Binkley. "What's in a name? A study of identifiers." ICPC 2006, pp. 3–12. DOI 10.1109/ICPC.2006.51. https://ieeexplore.ieee.org/document/1631100 [V-abs]
2. J. Hofmeister, J. Siegmund, D. V. Holt. "Shorter identifier names take longer to comprehend." SANER 2017, pp. 217–227. DOI 10.1109/SANER.2017.7884623. https://www.se.cs.uni-saarland.de/publications/docs/HoSeHo17.pdf [V]
3. D. Lawrie, C. Morrell, H. Feild, D. Binkley. "Effective identifier names for comprehension and memory." Innovations in Systems and Software Engineering 3(4):303–318, 2007. https://www.cs.kent.edu/~jmaletic/cs63902/Papers/Lawrie07.pdf [V]
4. S. Butler, M. Wermelinger, Y. Yu, H. Sharp. "Relating identifier naming flaws and code quality: an empirical study." WCRE 2009, pp. 31–35. DOI 10.1109/WCRE.2009.50. https://bibtex.github.io/WCRE-1999-ButlerWYS99a.html [V-abs]
5. S. Butler, M. Wermelinger, Y. Yu, H. Sharp. "Exploring the influence of identifier names on code quality: an empirical study." CSMR 2010, pp. 156–165. DOI 10.1109/CSMR.2010.27. https://bibtex.github.io/CSMR-2010-ButlerWYS.html [V-abs]
   5b. F. Hermans, blog summary of Butler et al. https://felienne.com/archives/5452 [V-sec]
6. P. Relf (2004), identifier naming guidelines, as summarized by P. Hilton: https://hilton.org.uk/blog/relf-2004-source-code-readability [V-sec]
7. F. Deissenboeck, M. Pizka. "Concise and consistent naming." Software Quality Journal 14(3):261–282, 2006 (cited in [2]). [V-sec, bibliographic]
   7b. V. Arnaoudova, M. Di Penta, G. Antoniol, Y.-G. Guéhéneuc. "A new family of software anti-patterns: linguistic anti-patterns." CSMR 2013, pp. 187–196. DOI 10.1109/CSMR.2013.28. https://bibtex.github.io/CSMR-2013-ArnaoudovaPAG.html [V-abs]
   7c. V. Arnaoudova, M. Di Penta, G. Antoniol. "Linguistic antipatterns: what they are and how developers perceive them." Empirical Software Engineering 21(1):104–158, 2016. DOI 10.1007/s10664-014-9350-8. https://publications.polymtl.ca/34761/ [V-abs; 69%/51% from the abstract as quoted in search results]
8. A. Peruma et al. "IDEAL: An open-source identifier name appraisal tool." ASE 2021 tool demo (arXiv 2107.08344; co-author list [unverified]). https://arxiv.org/abs/2107.08344 [V]
9. E. Aghajani, C. Nagy, G. Bavota, M. Lanza. "A large-scale empirical study on linguistic antipatterns affecting APIs." ICSME 2018. https://www.inf.usi.ch/faculty/lanza/PUBS/P/Agha2018a.pdf [V]
10. G. B. de Pádua, W. Shang. "Studying the prevalence of exception handling anti-patterns." ICPC 2017, pp. 328–331. DOI 10.1109/ICPC.2017.1. https://arxiv.org/abs/1704.00778 [V]
11. G. B. de Pádua, W. Shang. "Studying the relationship between exception handling practices and post-release defects." MSR 2018, pp. 564–575. DOI 10.1145/3196398.3196435. https://ece.uwaterloo.ca/~wshang/pubs/MSR2018_GUI.pdf [V]
    11b. Never Work in Theory review: https://neverworkintheory.org/2021/09/16/exception-handling-practices-and-post-release-defects.html [V-sec]
12. S. Romano, C. Vendome, G. Scanniello, et al. "A multi-study investigation into dead code." IEEE TSE 46(1):71–99 (online 2018). DOI 10.1109/TSE.2018.2842781. [V-abs, as quoted in search results; the full text host refused connection]
13. D. Posnett, A. Hindle, P. Devanbu. "A simpler model of software readability." MSR 2011, pp. 73–82. DOI 10.1145/1985441.1985454 [DOI unverified]. https://doi.org/10.7939/r3-g6jx-gb29 (University of Alberta ERA copy) [V]
    13b. R. P. L. Buse, W. R. Weimer. "Learning a metric for code readability." IEEE TSE 36(4):546–558, 2010. https://web.eecs.umich.edu/~weimerw/p/weimer-tse2010-readability-preprint.pdf [V]
14. S. Scalabrino, M. Linares-Vásquez, D. Poshyvanyk, R. Oliveto. "Improving code readability models with textual features." ICPC 2016. https://www.cs.wm.edu/~denys/pubs/ICPC'16-Readability.pdf [V]
15. J. Dorn. "A general software readability model." MCS thesis/paper, University of Virginia, 2012. https://web.eecs.umich.edu/~weimerw/students/dorn-mcs-paper.pdf [V]
16. D. Steidl, B. Hummel, E. Juergens. "Quality analysis of source code comments." ICPC 2013. https://teamscale.com/hubfs/26978363/Publications/2013-quality-analysis-of-source-code-comments.pdf [V]
17. A. Potdar, E. Shihab. "An exploratory study on self-admitted technical debt." ICSME 2014, pp. 91–100. DOI 10.1109/ICSME.2014.31. https://bibtex.github.io/ICSME-2014-PotdarS.html [V-abs, figures as quoted in search results]
    17b. "SATDBailiff: Mining and tracking self-admitted technical debt" (arXiv 2107.00073), states "62 commonly occurring comment patterns" and 101,762 comments for [17]: https://ar5iv.labs.arxiv.org/html/2107.00073 [V]
18. F. Wen, C. Nagy, G. Bavota, M. Lanza. "A large-scale empirical study on code-comment inconsistencies." ICPC 2019, pp. 53–64. https://www.inf.usi.ch/faculty/lanza/PUBS/P/Wen2019a.pdf [V-abs]
19. "MAT: A simple yet strong baseline for identifying self-admitted technical debt." arXiv 1910.13238 (authors [unverified]). https://arxiv.org/abs/1910.13238 [V-abs]
20. T. M. T. Pham, J. Yang. "The secret life of commented-out source code." ICPC 2020. DOI 10.1145/3387904.3389259. https://phamtriminhtriet.github.io/papers/icpc20.pdf [V]
21. M. Allamanis, E. T. Barr, C. Bird, C. Sutton. "Learning natural coding conventions." FSE 2014 (arXiv 1402.4182). DOI 10.1145/2635868.2635883. https://arxiv.org/abs/1402.4182 [V-abs]
22. M. Hucka. "Spiral: splitters for identifiers in source code files." JOSS 3(24):653, 2018. DOI 10.21105/joss.00653. https://joss.theoj.org/papers/10.21105/joss.00653 [V-sec]. Samurai: E. Enslen, E. Hill, L. Pollock, K. Vijay-Shanker, MSR 2009, DOI 10.1109/MSR.2009.5069482 [V-abs]
23. Microsoft. Framework Design Guidelines: General Naming Conventions; Capitalization Conventions. https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/general-naming-conventions and https://learn.microsoft.com/en-us/dotnet/standard/design-guidelines/capitalization-conventions [V]
24. Microsoft. C# identifier names, rules and conventions. https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/identifier-names [V]
25. D. Binkley, M. Davis, D. Lawrie, C. Morrell. "To camelcase or under_score." ICPC 2009, pp. 158–167 (cited in [2]). [V-sec, bibliographic only]
26. MessagePack-CSharp `.editorconfig`. https://raw.githubusercontent.com/MessagePack-CSharp/MessagePack-CSharp/master/.editorconfig [V]
    26b. MessagePack-CSharp `stylecop.json`. https://raw.githubusercontent.com/MessagePack-CSharp/MessagePack-CSharp/master/stylecop.json [V]
27. Microsoft. Compiler warning CS1591. https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs1591 [V]
28. Checkstyle MagicNumber check. https://checkstyle.sourceforge.io/checks/coding/magicnumber.html [V]
29. SonarSource sonar-dotnet rule S109 (magic numbers). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/rspec/cs/S109.html [V]
30. SonarSource rule S125 (commented-out code). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/rspec/cs/S125.html [V]
31. SonarSource rules S108 (empty blocks), S2486 (ignored generic exceptions), S3445 (explicit rethrow), S2737 (catch only rethrows). https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/rspec/cs/S108.html (and S2486.html, S3445.html, S2737.html) [V]
32. Microsoft. CA2200: Rethrow to preserve stack details. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2200 [V]
33. Microsoft. CA1031: Do not catch general exception types. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1031 [V]
34. Microsoft. IDE0051: Remove unused private member. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/style-rules/ide0051 [V]
35. B. Cabral, P. Marques. "Exception handling: a field study in Java and .NET." ECOOP 2007, LNCS 4609, pp. 151–175. DOI 10.1007/978-3-540-73589-2_8. [V-sec via [10]; 18,589 try blocks via search snippet]
36. F. Ebert, F. Castor, A. Serebrenik. "An exploratory study on exception handling bugs in Java programs." JSS 106:82–101, 2015. DOI 10.1016/j.jss.2015.04.066. https://aserebre.win.tue.nl/FFA.pdf [V]

### Unverified or not retrieved (do not cite numbers)
- Butler et al.'s exact thresholds and per-flaw statistics (papers returned 403).
- The full Potdar–Shihab 62-pattern list.
- MAT's F1 values.
- Romano's 15.94% figure and the ICPC 2016 details.
- Cabral & Marques' empty-handler rate.
- Sonar S1192/S1135 parameters.
- Semantics of IDE0052, IDE0060, CS0162, CS0168, CS0219 and StyleCop SA16xx (IDs from memory, except where they appear as keys in [26]).
- Arafat & Riehle comment-density figures and Aman 2011 (commented-out code vs faults): not retrieved.
- Posnett paper DOI.
