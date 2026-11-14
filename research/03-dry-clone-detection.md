# 03 — DRY made mathematical: code clone detection for C#

Scope: an AI-free, deterministic DRY metric for C# (MessagePack-CSharp plus agent-written PRs), built with Python and tree-sitter. It needs a formal definition, per-line localisation for a heatmap, thresholds, and a validation protocol.

How to read this file: bracketed numbers like [4] point to the reference list at the end. **[unverified]** means I could not open the primary source in this session, so the claim rests on memory or a secondary source. The web-search budget ran out partway through. After that I could only fetch URLs I already knew, so a few primary sources (Göde & Koschke 2011, Monden 2002, Krinke 2007 full text, Clean Code) are marked unverified or secondary.

---

## 0. TL;DR (recommendation)

1. **The metric is clone detection, but DRY is broader.** DRY is about duplicated *knowledge*, not duplicated text [1]. Syntactic clones are a measurable proxy for it, with known false positives: coincidental similarity, intentional per-type specialisation, and tables.
2. **Detector:**
   - tree-sitter tokens, with comments, `using` directives, attributes and preprocessor directive lines removed.
   - Type-1 tokens kept raw. Type-2 normalisation: identifiers become `$I`, numbers `$N`, strings and chars `$S`.
   - Karp–Rabin rolling hash over windows of **k = 50 tokens**, with a minimum fragment span of **6 SLOC**.
   - Consecutive window matches are merged into maximal pairs.
   - A consistent-renaming check (Baker p-match) separates parameterised clones from "blind" Type-2 ones.
   - Type-3 by **gap chaining**: seeds of 20 tokens, gaps of at most 30 tokens, similarity = matched / longer span ≥ 0.7, which is equivalent to NiCad's UPI ≤ 0.3. A method-level **SourcererCC bag-overlap** check (θ = 0.7) runs as a second Type-3 detector.
   - Filters: generated code, overlapping self-matches, and "tabular" repetitive code (distinct-5-gram ratio < 0.3–0.5).
3. **Metrics:**
   - Duplicated-line density DLD = |∪ cloned SLOC| / SLOC, the SonarQube definition [8].
   - Token clone coverage.
   - Clone-class count.
   - Per-line heat h(ℓ) = max similarity of clone fragments covering ℓ.
   - **PR-level metrics:** new-duplication ratio of added lines, ΔDLD, and an **inconsistent-change flag**: the PR edits one instance of a base clone class but not its siblings.
4. **Thresholds:**
   - The repository-level rating follows SIG: ≤3% `++`, 3–5% `+`, 5–10% `o`, 10–20% `−`, >20% `−−` [21]. Note that SIG measures exact 6-line duplication.
   - For agent PRs, judge relative to the base repo, because MessagePack's own Type-2 density is very high (38% before filters, ~30–32% after; see §5).
5. **Validation:**
   - Recall: Mutation-and-Injection style [16], with the 15 operators and Wilson CIs.
   - Precision: a stratified manual sample of ≥ 385 pairs (95% ± 5%), as SourcererCC did with 390 pairs [13].
6. **Key evidence:**
   - Juergens et al.: 52% of clone groups were changed inconsistently. 28% of those changes were unintentional, and **half of the unintentional ones were faults**. Three of the five systems were commercial C# [17].
   - Counterpoints:
     - Kapser & Godfrey: up to 71% of clones had a positive effect [18].
     - Rahman et al.: clones are not more defect-prone, and groups with more than 3 copies have *lower* defect density [19].
     - Kim et al.: 48–72% of clone genealogies that disappeared did so within about 8 check-ins [20].

---

## 1. What DRY means (and why clones are only a proxy)

- **Definition.** Hunt & Thomas: "Every piece of knowledge must have a single, unambiguous, authoritative representation within a system." [1] This is from the 20th-anniversary edition excerpt. Wikipedia gives the 1999 first edition, p. 27, as the original source [2].
- **Knowledge, not text** (verified in the 20th-anniversary excerpt [1]). The authors say the first edition explained DRY poorly and that many readers took it as "don't copy-paste source lines". They call that a small, fairly trivial part of DRY. DRY is about duplicating knowledge or intent, possibly expressed in completely different ways.
  - Their acid test: if one change forces edits in several places and formats (code and docs, schema and struct, …), the code is not DRY.
  - The same excerpt has a section headed "Not All Code Duplication is Knowledge Duplication". Its example: `validate_age` and `validate_quantity` have identical bodies but encode different rules. The authors call that a coincidence, not duplication [1].
- **What this means for the certifier:**
  - A syntactic clone detector measures *candidate* knowledge duplication. It produces false positives (coincidental clones) and misses semantic duplication: Type-4 clones, and duplication across artefact types such as code vs. docs, or schema vs. DTO.
  - We should present DLD as "textual/structural repetition". Clone *co-change* (§6, §10.6) is the better proxy for real knowledge duplication.

## 2. Clone taxonomy

Roy, Cordy & Koschke 2009 [3], paraphrased:

| Type | Definition |
|---|---|
| Type-1 | Identical apart from whitespace, layout and comments |
| Type-2 | Syntactically identical apart from identifiers, literals, types, whitespace, layout and comments |
| Type-3 | Copied with further edits: statements changed, added or removed, on top of Type-2 differences |
| Type-4 | Same computation, different syntactic implementation |

The paper also maps four editing scenarios, each with sub-scenarios, onto these types.

From Bellon et al. 2007 [4]:

- Their Type-2 definition covers identifiers only. They add *parameterised clones*: a **bijective** identifier mapping turns A into a Type-1 copy of B. This is a subset of Type-2.
- Type-1 and Type-2 similarity is an equivalence relation, so clone classes are well defined. Type-3 similarity is **not transitive**. Bellon therefore evaluates Type-3 clones as **pairs**.
- Common Type-3 operationalisations: two Type-1/2 clones separated by a small gap, or a Levenshtein-distance threshold [4].
- Bellon requires clones to be syntactically complete, i.e. replaceable by a function call.

BigCloneBench splits Type-3/4 by syntactic similarity, measured by line and by token after T1/T2 normalisation, taking the smaller value [13]:

| Category | Similarity |
|---|---|
| VST3 | [90%, 100%) |
| ST3 | [70%, 90%) |
| MT3 | [50%, 70%) |
| WT3/T4 | [0%, 50%) |

## 3. Algorithms with implementable detail

### 3.1 Token-based

**Baker's Dup** (as described in [3]):

- Tokens are split into *parameter* tokens (identifiers and literals) and others.
- Parameters are encoded by position index, which allows **consistent** substitution: Type-2 p-matches.
- A suffix tree over the sequence finds repeated substrings.
- Type-3 clones come from joining Type-1/2 clones within a user-set gap.

**CCFinder** (Kamiya, Kusumoto, Inoue 2002 [5]; I did not open the paper; details come from [3], the student slides [5b], and Kim et al. [20]):

- Lexing, then transformation rules. Examples:
  - remove namespace qualifiers (`std::ios_base::hex` → `hex`)
  - remove template parameters
  - remove accessibility keywords
  - wrap single-statement bodies in braces
- **Parameter replacement**: identifiers for types, variables and constants all become one special token `$p`.
- Suffix-tree matching.
- Default minimum is **30 tokens**. Kim et al. call it the default and found it gives about 7-line average clones [20]. The slides equate it to about 13 lines.
- CCFinderX also uses a "minimum token types = 12" filter, as configured in [13].
- CCFinder filters table initialisations and very short in-line clones as not useful (search-result snippet of [5]) **[unverified wording]**.

**PMD CPD** [6]:

- Uses the **Karp–Rabin** string-matching algorithm.
- `--minimum-tokens` is **required and has no default**. The documentation examples use 100.
- C# options: `--ignore-usings`, `--ignore-literal-sequences` (e.g. initialiser lists), `--ignore-annotations` (C# attributes).
- `--ignore-identifiers` and `--ignore-literals` are listed for Java and C++ only.
- Code can be suppressed with `CPD-OFF` / `CPD-ON` comments.

**jscpd** [7]:

- Rolling **Rabin–Karp** hash over language tokens.
- Defaults: `--min-tokens 50`, `--min-lines 5`, mode `mild`.
- `--max-gap-lines N` merges consecutive exact clones from the same file pair. The resulting similarity is matched tokens / tokens of the **longer** merged span, and merges are refused below 0.5.
- Type-2 is opt-in through `--ignore-identifiers` / `--ignore-literals`.

**SonarQube** [8]:

- Non-Java languages: a block needs ≥ 100 successive duplicated tokens spread over ≥ 10 lines (30 for COBOL, 20 for ABAP).
- Java: ≥ 10 successive duplicated statements.
- Formula: `duplicated_lines_density = duplicated_lines / lines × 100`. The 8.9 documentation says "lines of code"; the SonarCloud documentation says "lines".

**Suffix structures:**

- Bellon notes that suffix trees are linear in program size and scale well in practice [4].
- RTF and SHINOBI use suffix *arrays*, which are more memory-efficient [3].
- A suffix array plus LCP array finds all maximal repeats in O(n log n) or O(n) time. This is an alternative to hashing; I did not benchmark it.

**Winnowing** (Schleimer, Wilkerson & Aiken 2003 [14]):

- Fingerprints are hashes of k-grams. Window size is w = t − k + 1. Take the minimum hash in each window, choosing the rightmost on ties.
- **Guarantee:** every match of length ≥ t is detected, and nothing shorter than the noise threshold k.
- Expected density is 2/(w+1).
- Useful for scalable PR-vs-repo lookups, e.g. indexing a large base once.

### 3.2 AST-based

**CloneDR** (Baxter et al. 1998 [9]):

- Hash subtrees into B buckets, with B on the order of N (in practice B = 10% of N).
- For near-misses, deliberately use a "bad" hash that **ignores identifiers** (leaves).
- Compare only within a bucket:

  `Similarity = 2·S / (2·S + L + R)`

  where S = shared nodes, L and R = nodes unique to each subtree.
- A mass threshold sets the minimum subtree size.
- When a pair is accepted, its sub-clones are removed.
- Sequence detection finds statement-list clones.
- The paper reports 12.7% average cloned code across 19 subsystems, with one subsystem at about 28%.

**Deckard** (Jiang et al. 2007 [10]):

- q-level characteristic vectors (counts of relevant node types) approximate tree edit distance in Euclidean space.
- Vectors are merged over sibling statement sequences with a sliding window, whose step is the stride.
- LSH (Euclidean) clusters similar vectors.
- Parameters: `minT` 30 or 50 tokens, stride 2…∞ (∞ means no merging), Similarity 0.9–1.0. Similarity is mapped to a Euclidean threshold through CloneDR's 2H/(2H+L+R) [10].

**NiCad** (Roy & Cordy 2008 [11], [12]):

- Extract blocks or functions with TXL. Pretty-print one statement part per line. Optionally normalise or blind-rename (`X`) or consistently rename (`Xn`).
- Compare line sequences with an LCS. UPI = unique items / total items, computed for both fragments. A pair is a clone if both UPIs are ≤ the threshold.
- The threshold is size-sensitive: at 30%, a 10-line fragment can have 3 unique lines.
- The 2008 paper used structured blocks of ≥ 6 lines for C.
- The NiCad tool runs four UPI thresholds by default (0.0, 0.1, 0.2, 0.3). Its example config uses `minsize=5`, `maxsize=500`, `rename=blind` [12].
- Per the 2008 paper title it targets near-miss clones; NiCad 5/6 also support C# **[unverified]**.

**SourcererCC** (Sajnani et al. 2016 [13]):

- Each block is a bag of tokens.
- Overlap O(Bx, By) = |Bx ∩ By|. A pair is a clone iff O ≥ ⌈θ · max(|Bx|, |By|)⌉.
- Scaling comes from two filters, which need a global token order (rarest token first):
  - **sub-block overlap filter**: index only the first t − ⌈θt⌉ + 1 tokens
  - **token-position filter**: stop early when the remaining tokens cannot reach the threshold
- Configuration used: min 6 lines, θ = 70%, function granularity.
- Identifiers are *not* normalised, which keeps precision up.

### 3.3 Recommended minimum clone sizes

| Source | Minimum | Rationale |
|---|---|---|
| Bellon benchmark [4] | 6 lines | Participants' consensus; smaller clones tend to be spurious |
| SourcererCC / BigCloneBench [13] | 6 lines or 50 tokens | The paper calls this the usual minimum size for benchmarking |
| SIG [21] | 6 lines (exact, leading spaces ignored) | Simple, language-independent, fast |
| SonarQube [8] | 100 tokens and 10 lines | Product default |
| CCFinder [20] | 30 tokens | Tool default; developers don't consider very short snippets clones |
| Deckard [10] | 30 / 50 tokens | Experiments |
| jscpd [7] | 50 tokens / 5 lines | Defaults |
| Juergens (C#/Java) [17] | 10 statements, edit distance ≤ 5, inconsistency ratio ≤ 0.2, first 2 statements equal | Best precision/recall compromise in pilots |

## 4. Evaluation of clone detectors

**Bellon et al. 2007** [4]:

- Setup:
  - Six tools, eight C and Java systems (about 850 KLOC), clones of ≥ 6 lines.
  - The oracle (Bellon himself) judged **2% of 325,935** candidates, with the source tool hidden. This took 44 h + 33 h.
  - Undisclosed clones were also *injected* to estimate recall.
- Matching uses line sets:

  `overlap(CF1, CF2) = |L1 ∩ L2| / |L1 ∪ L2|`

  `contained(CF1, CF2) = |L1 ∩ L2| / |L1|`

  `good(CP1, CP2) = min(overlap(CF1s), overlap(CF2s))`

  `ok(CP1, CP2) = min(max(contained both directions) per side)`

  With p = 0.7, two 6-line fragments may be shifted by one line.
- Findings:
  - Token and text tools have higher recall. Merlo's metrics tool and Baxter's AST tool have higher precision.
  - Rejected candidates ranged from 24% (Baxter) to 77% (Krinke).
  - Individual tools found only 24–46% of the injected clones.
  - Spurious syntactic clones are typical: sequences of assignments, long array initialisers, and structurally equal code over unrelated record fields.

**BigCloneBench** (as described in [13]):

- Built from IJaDataset 2.0 (25,000 Java systems, 3M files, 250 MLOC) by mining functions that implement known functionalities.
- The snapshot used in [13] had 48 functionalities and 8M validated pairs.

**Tool recall on BigCloneBench** (from [13], Table 5, all clones; values in %):

| Tool | T1 | T2 | VST3 | ST3 | MT3 | WT3/T4 |
|---|---|---|---|---|---|---|
| SourcererCC | 100 | 98 | 93 | 61 | 5 | 0 |
| CCFinderX | 100 | 93 | 62 | 15 | 1 | 0 |
| Deckard | 60 | 58 | 62 | 31 | 12 | 1 |
| iClones | 100 | 82 | 82 | 24 | 0 | 0 |
| NiCad | 100 | 100 | 100 | 95 | 1 | 0 |

**Precision**, as reported or cited in [13]:

- SourcererCC: 91% (355 of 390 sampled pairs, 3 judges). Its false positives were unrelated but similar API usage, and **similar unit-test methods** made of assertion sequences.
- Deckard: up to 93% at a higher threshold.
- CCFinder: 60–72%.
- NiCad: 89–96% on artificial clones, and around 60% with aggressive normalisation.
- Token tools lose precision through Type-2 normalisation.

**Mutation / injection framework** (Roy & Cordy 2008/2009 [15]; Svajlenko & Roy, TSE 2021 [16]). This is directly reusable for us:

- **Procedure:**
  1. Pick a random fragment from a corpus.
  2. Apply **one** clone-type-specific mutation operator.
  3. Inject the copy into a subject system.
  4. Run the detector.
  5. Check whether the injected pair is reported.
  6. Repeat thousands of times.
- Operators are implemented with simple token grammars for **Java, C and C#** [16].
- Operators (descriptions paraphrased from [16], Table 2):

  | Op | Type | Edit |
  |---|---|---|
  | mCW-A / mCW-R | 1 | add or remove whitespace between tokens |
  | mCC-BT / mCC-EOL | 1 | add a `/* */` comment between tokens, or a `//` comment at end of line |
  | mCF-A / mCF-R | 1 | add or remove a newline |
  | mSRI | 2 | rename one identifier systematically (all occurrences) |
  | mARI | 2 | rename a single occurrence of an identifier |
  | mRL-N / mRL-S | 2 | change a numeric, or a string/char, literal |
  | mSIL / mSDL | 3 | add or remove a parameter in a call or signature |
  | mIL / mDL | 3 | insert or delete a one-statement line |
  | mML | 3 | modify a whole line (wrap it in a one-line `if`) |

- **Match criterion** [16]:
  - The reported clone must *subsume* the injected one. A subsume tolerance lets ⌊tol × lines⌋ lines be missed at each end.
  - The *mutation containment* (minimum distance of the edit from the fragment edges, as a ratio) must be ≥ the tolerance, so the tool has to cover the edit.
  - An optional similarity check rejects chance subsumption.
- **SourcererCC's setup** [13]: 250 functions × 10 locations × 15 operators = **37,500 clones per language**. Constraints: 15–200 lines, 100–2,000 tokens, containment 15%, subsumption of 70% by line.
- **C# results** (subject MonoOSC, corpus Mono/MonoDevelop):

  | Tool | T1 | T2 | T3 |
  |---|---|---|---|
  | SourcererCC | 100 | 100 | 100 |
  | NiCad | 98 | 98 | 98 |
  | CCFinderX | 100 | 78 | 0 |

## 5. Calibration on MessagePack-CSharp (own measurements, prototype)

**What I ran:**

- A ~300-line pure-Python prototype (tree-sitter 0.26.1, tree-sitter-c-sharp 0.23.5). It lives only in the session scratchpad and is not in the repo.
- Target: the local clone `workspace/messagepack-csharp` @ `32258fd` (2025-03-01) [37].
- SLOC here = lines with at least one token after removing comments, `using` directives and attributes.
- Runtime about 1–2 s for 176k tokens. These numbers come from one prototype run and one seed; treat them as indicative.

**5.1 Generated code is a major false-positive source in this repo**

- **15 T4 outputs** sit next to `.tt` templates without a `<auto-generated>` header, so header-only detection misses them:
  - `Formatters/PrimitiveFormatter.cs` (1,996 lines), `ForceSizePrimitiveFormatter.cs`, `TupleFormatter.cs`, `ValueTupleFormatter.cs`
  - `MessagePackReader.Integers.cs`, `MessagePackPrimitives.Readers.Integers.cs`
  - `Internal/UnsafeMemory.cs`, …
  - They carry a custom comment, `THIS (.cs) FILE IS GENERATED. DO NOT CHANGE IT.`
  - The `.csproj` marks them `<AutoGen>True</AutoGen><DependentUpon>*.tt</DependentUpon>`.
- **225 `*.g.cs` snapshot files** live in `tests/MessagePack.SourceGenerator.Tests/Resources`.
- Excluding generated files removed 19 of 190 `src` files: **~38% of `src` tokens** (282,785 → 176,099).
- For T1 at k = 100 / 10 lines, that cut DLD from **11.9% to 7.3%**.

**5.2 Duplicated-line density (`src`, generated code excluded, SLOC = 26,949)**

| Config | Raw | + overlap & tabular filter (DR < 0.5) |
|---|---|---|
| T1, k = 50, ≥ 6 lines | 17.2% | 16.9% |
| T2 consistent renaming, k = 50, ≥ 6 lines | 38.0% | 29.5% |
| T2 blind, k = 50, ≥ 6 lines | 40.1% | – |
| T1, k = 100, ≥ 10 lines (Sonar-like) | 7.3% | 7.1% |
| T2 consistent, k = 100, ≥ 10 lines | 21.4% | 15.6% |
| T2c + gap chaining (seed 20, min 50, gap 30, sim ≥ 0.7) | 51.5% | – |

`tests` (generated excluded, SLOC = 11,378): T1 k50 13.5%; T2c k50 41.4% raw and 27.4% filtered; Sonar-like 5.4%.

**Observations:**

1. The Type-2 numbers are dominated by **intentional per-type specialisation**, the normal pattern for a high-performance serializer:
   - `UnsafeRefSerializeHelper.cs`
   - `LZ4Codec.Unsafe32/64`
   - `StandardClassLibraryFormatter.cs`
   - the Unity `Formatters.cs`

   They are also dominated by **switch/case tables** (`GuidBits.cs`, `case n: x = reader.ReadSingle(); break;`).

   On the SIG scale, T1 k50 rates `−`, and only the Sonar-like k100 / 10-line setting rates `o`. Any absolute rating depends heavily on parameters, so **report the configuration with the number**.
2. The tabular filter removes 45% of T2 pairs (1,874 → 1,033) but only 5% of T1 pairs. Tables are mostly a Type-2 problem.

**5.3 Recall by injection (MIF-style, simplified)**

Setup:

- 50 trials per operator, 400 mutants in total. Random methods of 15–200 lines from `src`.
- Containment and tolerance 15%.
- The pair is detected only between the original file and the injected copy. Recall in %:

| Operator | Type | T1 k50 | T2c k50 | T2 blind k50 | Sonar-like T1 k100/10L | T2c k50 + filters (DR < 0.5) | Gap chaining | Bag θ = 0.7 (method) |
|---|---|---|---|---|---|---|---|---|
| mCC | 1 | 100 | 98 | 98 | 70 | 88 | 100 | 100 |
| mCF | 1 | 98 | 96 | 96 | 68 | 86 | 100 | 100 |
| mSRI | 2 | 12 | 98 | 98 | 10 | 88 | 100 | 100 |
| mARI | 2 | 20 | 22 | 96 | 16 | 16 | 90 | 100 |
| mRL | 2 | 10 | 56 | 98 | 6 | 50 | 90 | 100 |
| mIL | 3 | 0 | 0 | 4 | 0 | 0 | 74 | 100 |
| mDL | 3 | 2 | 2 | 6 | 0 | 2 | 66 | 94 |
| mML | 3 | 4 | 4 | 4 | 2 | 4 | 84 | 100 |
| **Type-1** (n = 100) | | 99 [94.6–99.8] | 97 | 97 | 69 | 87 (93 with DR < 0.3) | 100 | 100 |
| **Type-2** (n = 150) | | 14 | 59 [50.7–66.2] | 97 | 11 | 51 | 93 [88.2–96.3] | 100 |
| **Type-3** (n = 150) | | 2 | 2 | 5 | 1 | 2 | 75 [67.9–81.5] | 98 [94.3–99.3] |

Brackets are Wilson 95% CIs. The Type-3 counts are 113/150 for gap chaining and 147/150 for the bag detector.

**Takeaways:**

- Plain window detectors cannot satisfy the MIF "must cover the mutation" criterion for Type-3 edits. Gap chaining or bag overlap is required.
- Consistent renaming loses arbitrary renames (mARI) and single-literal changes (mRL), by design.
- The tabular filter costs 6–12 points of Type-1 recall, because some injected methods are themselves switch tables. Use DR < 0.3, or report tabular clones as a separate low-severity class.
- Precision was **not** measured; it needs manual labelling (§9.3).
- A first run had a lexer bug: whole `#if` blocks were skipped, which hid real code. The fix keeps code inside `#if` and drops only the directive lines. After the fix, unmutated self-injection was detected in 199/200 cases; the one miss was a method under 50 tokens.

## 6. Evidence that clones matter (and counter-evidence)

**Juergens, Deissenboeck, Hummel, Wagner, ICSE 2009** [17]:

- Systems: 3 commercial **C#** systems (Munich Re, 317/454/495 kLOC), 1 COBOL system, 1 Java system.
- About 1,800 manual assessments. **107 faults confirmed** by developers.
- Mean ratios:

  | Measure | Value |
  |---|---|
  | Clone groups changed inconsistently, \|IC\|/\|C\| | 0.52 |
  | Inconsistencies that were unintentional | 0.28 |
  | Faulty / inconsistent | 0.15 (range 3–23%; 18% excluding COBOL) |
  | **Faulty / unintentionally inconsistent** | **0.50** |
  | Fault density in inconsistencies | 3.4–91.4 per kLOC (mean 48.1), vs. 0.1–50 typically reported |

- Precision of their detector: 0.96 for exact clone groups and 0.83 for inconsistent clone groups.
- Generated code was excluded.

**Kapser & Godfrey, EMSE 2008** [18]:

- Describes cloning patterns used deliberately: forking, templating, customisation.
- In Apache and Gnumeric, **up to 71% of clones** could be considered to have a positive effect on maintainability.
- Their false-positive filters are directly reusable:
  1. Simple-call regions: ≥ 70% of callee names must be similar, where similar means Levenshtein distance < half the shorter name.
  2. Switch and simple if/else regions: ≥ 50% of tokens identical and in the same order.
  3. Drop pairs whose fragments overlap by > 30%.

**Rahman, Bird & Devanbu, MSR 2010** (Best Paper) [19]:

- Deckard on Apache, Evolution, Gimp and Nautilus.
- Most bugs were not significantly associated with clones. Cloned code may be *less* defect-prone.
- **Prolific clone groups (> 3 members) have lower defect density** than groups of ≤ 3 (one-sided Wilcoxon, BH-adjusted, significant in all projects).

**Kim, Sazawal, Notkin & Murphy, ESEC/FSE 2005** [20]. Clone genealogies in carol and dnsjava, using CCFinder at 30 tokens:

- 36–38% of genealogies changed consistently.
- 49–64% are not easily refactorable.
- Among genealogies that disappeared, 48–72% did so within an average of about 8 check-ins.

**Krinke 2007**, as summarised by [17] and [19]; secondary, full text not opened:

- Only about half of clone groups change consistently.
- Once inconsistent, groups rarely become consistent again.
- Krinke 2008 found cloned code more stable than non-cloned code.

**Mondal et al.**, via the replication [27], secondary: cloned code showed higher changeability than non-cloned code. Other studies (Krinke, Hotta) found clones more stable. Results conflict.

**Göde & Koschke, ICSE 2011**, "Frequency and risks of changes to clones": **[unverified]**, not accessible this session. From memory, it reports that most clones are never changed and that a small share of inconsistent changes are unintentional and harmful. Do not quote numbers until verified.

**Monden et al., METRICS 2002**, legacy COBOL: **[unverified]**. From memory: modules with clones were *more* reliable on average, but modules with very large clones (≥ 200 lines) were less reliable, and modules with more clones were less maintainable. Verify before citing.

**Prevalence:**

- Roy & Cordy cite 7–23% of code as cloned [15].
- Baxter found 12.7% on average, 28% in one subsystem [9].
- Kim et al. list estimates of gcc 8.7%, JDK 29%, Linux 22.7% from earlier studies [20].

**AI-assisted code** (GitClear 2025, industry report, not peer-reviewed) [22]:

- 211M changed lines (2020–2024), from repos owned by Google, Microsoft, Meta and enterprises.
- "Copy/pasted" lines rose from 8.3% (2021) to 12.3% (2024).
- Moved/refactored lines fell from 25% to under 10% of changed lines.
- The detection method is not published.

## 7. Quantitative DRY metrics (formal definitions)

Let F be the included files, T the token multiset after filtering, and S the set of SLOC (file, line) pairs with ≥ 1 token. Let P be the reported clone pairs and 𝒞 the clone classes, built with union-find over T1/T2 fragments. Each fragment f has a token set tok(f) and a line set lines(f).

1. **Token clone coverage:**

   `TCC = |⋃_{f∈P} tok(f)| / |T|`

   This is CCFinder-style coverage ("CVR") **[unverified name]**.
2. **Duplicated-line density** (SonarQube [8]):

   `DLD = |⋃_f lines(f) ∩ S| / |S| × 100`

   Sonar's non-Java criteria are ≥ 100 tokens and ≥ 10 lines.
3. **SIG duplication** [21]: the percentage of code in exact-equal blocks of ≥ 6 lines, ignoring leading whitespace. Ratings: `++` 0–3, `+` 3–5, `o` 5–10, `−` 10–20, `−−` 20–100. The paper says well-designed systems should not exceed 5%, and that above 20% erosion is out of control.
4. **Clone classes:** |𝒞|, their size distribution, and max |C|. Rule-of-three view: classes with ≥ 3 instances are refactoring candidates.
5. **Redundancy-free source size** (RFSS, a term associated with Juergens et al.; **[unverified definition]**). Proposed formalisation:

   `RFSS = |S| − Σ_{C∈𝒞} (|⋃_{f∈C} lines(f)| − max_{f∈C} |lines(f)|)`

   `blow-up = |S| / RFSS`

   That is, the size if each class were collapsed to its largest instance.
6. **Per-line heat** (heatmap):

   `h(ℓ) = max_{f∋ℓ} sim(f)`

   - sim = 1 for T1 and T2c, matched/longer-span for T3, overlap ratio for bag clones.
   - Show alongside: n(ℓ) = |C(f)| − 1 sibling locations, and the clone type.
   - Optional rule-of-three weight: `h₃(ℓ) = h(ℓ) · (1 − 1/|C|)`.
7. **PR metrics** (for agent-written PRs), with A the set of added or modified SLOC in the PR:
   - **New-duplication ratio:** `NDR = |A ∩ ⋃_{f∈P_post} lines(f)| / |A|`, counting only pairs with ≥ 1 fragment in A.
   - **ΔDLD** = DLD(post) − DLD(base), computed over touched files and over the repo.
   - **Inconsistent-change indicator**, after Juergens [17]. For every base clone class C touched by the PR, let changed(C) = instances whose lines intersect the diff. Flag when 0 < |changed(C)| < |C| and post-PR sim(changed, unchanged) < sim_base, i.e. the change was not propagated.
   - **Self-clone injection:** a PR that adds a fragment f with sim(f, g) ≥ 0.9 to existing code g of ≥ 6 lines or 50 tokens, i.e. copy-paste where reuse was possible.

## 8. What to exclude (false-positive control)

1. **Generated code.**
   - Microsoft's .NET analyzers treat names ending `.designer.cs` / `.generated.cs`, and files with auto-generated headers, as generated. `generated_code = true` in `.editorconfig` adds patterns [23].
   - Roslyn also treats `.g.cs` / `.g.i.cs` as generated **[unverified; source file not fetched]**.
   - Specific to MessagePack (§5.1): T4 siblings (`X.cs` next to `X.tt`); `.csproj` `<AutoGen>True` with `<DependentUpon>*.tt`; the custom marker "FILE IS GENERATED. DO NOT CHANGE"; and test snapshot `*.g.cs` files.
   - Juergens also excluded generated code [17].
2. **`using` directives, attributes, and preprocessor directive lines.** PMD has options for usings and attributes [6]. Keep the code *inside* `#if` branches. File headers and license comments disappear with comment removal.
3. **Tabular / low-entropy code:**
   - switch-case tables, initialiser lists, sequences of simple assignments [4], [18]
   - PMD's `--ignore-literal-sequences` [6]
   - CCFinderX's minimum token-type count of 12 [13]
   - Our filter: distinct-5-gram ratio `DR(f) = |{5-grams}| / (|f| − 4) < τ`, with τ = 0.3–0.5.
4. **Overlapping self-matches** in periodic regions: drop same-file pairs whose line ranges intersect [18].
5. **Tests.** Similar test methods made of assertion sequences were SourcererCC's main false-positive class [13]. Report tests separately, with their own thresholds, or use T1 only.
6. **Intentional specialisation**, e.g. per-primitive formatters and 32/64-bit codecs. Do not penalise base-repo clones in PR scoring; only *new* or *inconsistent* clones count.
7. **Explicit suppression:** support `// CPD-OFF` / `// CPD-ON`, as PMD does [6], or a `// dry-ignore` marker, and report the suppressed volume.

## 9. Recommended algorithm (step by step)

### 9.1 Pipeline

1. **Select files:** `**/*.cs`, excluding `obj/`, `bin/`, and the generated rules in §8.1. Partition into `src` and `tests`.
2. **Lex with tree-sitter-c-sharp.** Walk the tree in order, emitting leaves as `(kind, text, line, byte span)`.
   - Skip `comment`, `using_directive`, `attribute_list`, and directive leaves of `preproc_*` nodes (and the `#if` condition). Recurse into `preproc_if` bodies.
   - Emit whole-literal nodes as one token: `string_literal`, `verbatim_string_literal`, `raw_string_literal`, `interpolated_string_expression`, `character_literal`.
   - Kinds: `identifier` → id; `integer_literal` / `real_literal` → num; the literal nodes above → str; everything else → kw. All these node names were checked against grammar 0.23.5.
3. **Normalise.** T1: raw text. T2: id → `$I`, num → `$N`, str → `$S`. Keep keywords, operators and `predefined_type` (`int`, `string`, …). Map each normalised token to an integer id.
4. **Hash.** Karp–Rabin rolling hash over windows of k = 50 tokens, base about 10⁶, modulus 2⁶¹−1. Windows never cross file boundaries; use sentinels. Bucket by hash.
5. **Enumerate pairs** inside buckets. Verify token equality to reject collisions. Skip same-file pairs closer than k tokens. Cap bucket size at about 64 and mark capped buckets as tabular.
6. **Merge** window pairs (i, j), (i+1, j+1), … into maximal pairs (i, j, L).
7. **Consistent-renaming split** (T2c). Walk the pair and keep bijections id→id and lit→lit. Cut at the first conflict and keep pieces ≥ k. Label the result T2c; T2-blind leftovers are possible "inconsistent rename" bugs.
8. **Type-3 by gap chaining.** Run steps 4–7 with seed k_s = 20. Chain seeds of the same file pair along the diagonal when both gaps are ≤ g = 30 tokens. Accept if matched ≥ 50 tokens and `sim = matched / max(span_A, span_B) ≥ 0.7`; this mirrors NiCad UPI ≤ 0.3 [11] and jscpd's similarity [7].
9. **Type-3 at method level, second detector.** For each `method_declaration`, `constructor_declaration`, `local_function_statement` or `accessor_declaration` with ≥ 50 tokens, build a bag of raw tokens and report pairs with `|A∩B| ≥ ⌈0.7·max(|A|,|B|)⌉` [13]. Use the sub-block prefix filter for speed: sort tokens by global rarity and index the first `|B| − ⌈θ|B|⌉ + 1` tokens. Report as T3-bag, with lower confidence.
10. **Filter:**
    - each fragment ≥ 6 SLOC
    - no same-file overlap
    - DR ≥ 0.3 (or 0.5)
    - optional syntactic-completeness trim to statement boundaries using tree-sitter, as Bellon requires [4]
11. **Group:** union-find for T1 and T2c only. T3 stays as pairs, because it is not transitive [4].
12. **Compute metrics** from §7. Emit per-line heat with clone ids and sibling locations as JSON for the UI.
13. **PR mode:** run on base and head. Compute NDR, ΔDLD, inconsistent-change flags and self-clone injections, restricted to the diff hunks.

Complexity is O(n) hashing plus the sum over buckets of b²; capping bounds the worst case. The Python prototype took about 1.6 s for 176k tokens.

### 9.2 Parameters and proposed thresholds

| Parameter | Value | Justification |
|---|---|---|
| k (window) | 50 tokens | BigCloneBench/SourcererCC standard [13]; jscpd default [7]. Offer 100 tokens / 10 lines as a "Sonar-compatible" mode [8] |
| min lines | 6 SLOC | Bellon [4], SIG [21], SourcererCC [13] |
| T3 similarity | ≥ 0.7 | NiCad UPI 0.3 [11], SourcererCC θ [13], Bellon p [4] |
| gap | ≤ 30 tokens (about 2–3 lines) | Our injection run gave T3 recall 75%; jscpd refuses merges below 0.5 [7] |
| DR (tabular) | 0.3 | Keeps T1 recall at 93% while removing tables (§5.3) |

Proposed thresholds, to be calibrated (§9.3):

- **Repo rating:** SIG bands on T1 / 6-line DLD [21]. Also report the Sonar-mode number.
- **Agent PR:**
  - **Fail** if the PR adds a T1/T2c clone of ≥ 10 lines whose sibling already exists, i.e. copy instead of reuse.
  - **Fail** if it leaves a base clone class inconsistently changed (Juergens: 50% of unintentional inconsistencies were faults [17]).
  - **Warn** if NDR > base DLD of the touched files, or if ΔDLD > 0.5 percentage points on touched files.

### 9.3 Validation protocol

1. **Recall:** MIF-style injection with the 15 operators [16], plus C#-specific ones (e.g. `var` ↔ explicit type, expression-bodied ↔ block body).
   - Use ≥ 50 mutants per operator; that gives a worst-case Wilson half-width of about ±14%.
   - Report per-type recall with Wilson 95% CIs. Use containment = tolerance = 15% [13], [16].
   - Also inject the *agent-style* duplicates seen in real PRs.
2. **Precision:** a stratified random sample of reported pairs by type, n ≥ 385 for ±5% at 95%. SourcererCC used 390 pairs with 3 judges [13].
   - Use ≥ 2 judges and report Cohen's κ.
   - Label with "true clone", "coincidental", "tabular" and "generated", so the filters can be tuned.
3. **Matching:** Bellon good/ok with p = 0.7 [4], or MIF subsumption [16].
4. **Threshold calibration:**
   - Compute NDR and ΔDLD for all human commits and PRs in MessagePack history. Set warn and fail at the 90th and 95th percentiles of that distribution.
   - Check the fault signal retrospectively: are inconsistent-change flags enriched in later bug-fix commits? (Juergens-style; this is a design proposal, not done yet.)
5. **Determinism:** same input gives the same output. Pin the grammar version and hash parameters, and log the parameter set inside the certificate.

## 10. Extra scope: the teammate's DRY-adjacent claims

1. **"DRY concerns knowledge, not text" — CORRECT.**
   - The 20th-anniversary edition (2019) explicitly adds this framing. It says the first edition explained DRY poorly and that many readers reduced it to "don't copy-paste lines". It defines DRY as duplication of knowledge or intent, and has a section "Not All Code Duplication is Knowledge Duplication" (the age/quantity validation example) [1].
   - The definition sentence also appears in the 1999 edition (p. 27) [2].
2. **"Rule of three: Don Roberts, popularised in Fowler's Refactoring (1999)" — CORRECT** per Wikipedia [28].
   - Wikipedia's summary: when similar code appears a third time, extract it into a procedure. It cites *Refactoring* (Fowler with Beck, Brant, Opdyke, Roberts, 1999).
   - I did not open the book itself.
3. **WET / AHA / Metz — mostly CORRECT, with attributions refined.**
   - WET is a backronym, usually "write everything twice" [2].
   - Kent C. Dodds' "AHA Programming" post (2020-06-22) [30] expands AHA as "Avoid Hasty Abstractions". He credits the *acronym* to Cher Scarlett and the WET coinage to Conlin Durbin. His takeaway is to optimise for change first.
   - Sandi Metz, "The Wrong Abstraction", 2016-01-20 [29]. The sentence the teammate cited is there verbatim, as is a companion "prefer duplication…" line. The post says the idea first appeared in her RailsConf 2014 talk "All the Little Things". It describes the failure mode: shared code gains parameters and conditionals with each near-fit requirement.
4. **KISS / YAGNI:**
   - KISS is "reportedly" coined by Kelly Johnson, lead engineer at Lockheed Skunk Works. The earliest noted use is the US Navy in 1960. Johnson's form had no comma. Sources: Wikipedia, citing Ben Rich's memoir and Dalzell [32]. → **Correct, with "reportedly".**
   - YAGNI comes from Extreme Programming. Fowler [33] traces the phrase to Kent Beck answering Chet Hendrickson on the C3 project. Ron Jeffries wrote the early article "You're NOT gonna need it!" (1998-04-04) [34]. → **"From XP" is correct; crediting Ron Jeffries as originator is imprecise.** Better: "XP (Beck; articulated by Jeffries)".
   - Fowler limits YAGNI to presumptive features, not to work that makes code easier to change. He lists four costs: build, delay, carry, repair [33].
5. **Over-DRY abstractions and flag arguments:**
   - **Definitions.** Fowler (2011-06-23) [31]: a flag argument tells a function to carry out a different operation depending on its value. He recommends separate methods, except when the boolean comes straight from data (e.g. a checkbox).
   - *Clean Code* (Martin 2008) also condemns flag arguments **[unverified; book not accessed]**.
   - Classic **control coupling**, passing a "what-to-do" flag, ranks 4th of 6 coupling levels, above stamp and data coupling (Stevens, Myers & Constantine 1974, via [35]).
   - **Empirical evidence:** I found and verified **no controlled study** linking boolean flag parameters, or abstractions made to remove duplication, to defects or comprehension cost. The search budget ran out before I could look further.
   - Indirect evidence against aggressive deduplication, all verified:
     - Kim et al.: many clone genealogies are short-lived (48–72% of disappeared ones gone within about 8 check-ins), and 49–64% are not easily refactorable [20].
     - Juergens et al.: about 72% of inconsistencies were *intentional* divergence [17].
     - Kapser & Godfrey: up to 71% of clones had a positive effect [18].
     - Rahman et al.: prolific clones had lower defect density [19].
   - For the certifier: an "over-DRY" detector, e.g. methods with bool parameters that drive top-level `if`/`switch` branches, would be a separate smell. Here it is only justified by expert opinion [29], [31], [35].
6. **Co-change as a proxy for knowledge duplication:**
   - Kim et al. 2005: 36–38% of genealogies changed consistently, meaning the copies did share knowledge [20]. Note the fourth author, Gail Murphy, whom the teammate omitted.
   - Krinke 2007: only about 50% of clone groups changed consistently, and inconsistent groups stayed inconsistent (via [17], [19]).
   - Juergens 2009: the numbers in §6.
   - Göde & Koschke 2011: **[unverified]**.
   - **Is a class of ≥ 3 riskier than a pair?** The verified evidence points the other way. Rahman et al. found groups with > 3 members had *lower* defect density, statistically significant in all four projects [19].
   - So use class size to **prioritise refactoring** (rule of three), not as a defect-risk multiplier. Use **inconsistent change within a class** as the risk signal [17].

---

## References

All entries were checked this session unless marked otherwise. "PDF" means I extracted and read the full text.

1. D. Thomas, A. Hunt. *The Pragmatic Programmer, 20th Anniversary Edition* (2019), Topic "DRY—The Evils of Duplication" excerpt. https://media.pragprog.com/titles/tpp20/dry.pdf (PDF)
2. Wikipedia, "Don't repeat yourself" (cites Hunt & Thomas 1999, p. 27; WET). https://en.wikipedia.org/wiki/Don%27t_repeat_yourself
3. C. K. Roy, J. R. Cordy, R. Koschke. "Comparison and evaluation of code clone detection techniques and tools: A qualitative approach." *Sci. Comput. Program.* 74(7):470–495, 2009. doi:10.1016/j.scico.2009.02.007. https://www.cs.usask.ca/~croy/papers/2009/RCK_SCP_Clones.pdf (PDF)
4. S. Bellon, R. Koschke, G. Antoniol, J. Krinke, E. Merlo. "Comparison and Evaluation of Clone Detection Tools." *IEEE TSE* 33(9):577–591, 2007. doi:10.1109/TSE.2007.70725. https://plg.uwaterloo.ca/~migod/846/papers/bellon-tse07.pdf (PDF)
5. T. Kamiya, S. Kusumoto, K. Inoue. "CCFinder: A Multilinguistic Token-Based Code Clone Detection System for Large Scale Source Code." *IEEE TSE* 28(7):654–670, 2002 (DOI 10.1109/TSE.2002.1019480, **not verified**; paper not opened). Index page: https://sel.ist.osaka-u.ac.jp/lab-db/en/betuzuri/contents/387/
   - 5b. Student slides summarising CCFinder (secondary): https://courses.cs.vt.edu/cs6704/spring17/slides_by_students/CCFinder-Tithi.pdf
6. PMD CPD documentation. https://pmd.github.io/pmd/pmd_userdocs_cpd.html
7. jscpd README and engine docs. https://github.com/kucherenko/jscpd ; https://raw.githubusercontent.com/kucherenko/jscpd/master/docs/rust.md
8. SonarQube 8.9 metric definitions (Duplications). https://docs.sonarsource.com/sonarqube-server/8.9/user-guide/metric-definitions ; SonarCloud version (search snippet): https://docs.sonarcloud.io/digging-deeper/metric-definitions/
9. I. D. Baxter, A. Yahin, L. Moura, M. Sant'Anna, L. Bier. "Clone Detection Using Abstract Syntax Trees." ICSM 1998 (DOI 10.1109/ICSM.1998.738528, **not verified**). https://www.semanticdesigns.com/Company/Publications/ICSM98.pdf (PDF)
10. L. Jiang, G. Misherghi, Z. Su, S. Glondu. "DECKARD: Scalable and Accurate Tree-based Detection of Code Clones." ICSE 2007, pp. 96–105. doi:10.1109/ICSE.2007.30. https://www.cs.ucdavis.edu/~su/publications/icse07.pdf (PDF)
11. C. K. Roy, J. R. Cordy. "NICAD: Accurate Detection of Near-Miss Intentional Clones Using Flexible Pretty-Printing and Code Normalization." ICPC 2008. https://www.cs.usask.ca/~croy/papers/2008/RC_ICPC08_NICAD.pdf (PDF)
12. J. R. Cordy, C. K. Roy. "The NiCad Clone Detector." ICPC 2011 tool demo. https://www.cs.usask.ca/~croy/papers/2011/CR-NiCad-Tool-ICPC11.pdf (PDF)
13. H. Sajnani, V. Saini, J. Svajlenko, C. K. Roy, C. V. Lopes. "SourcererCC: Scaling Code Clone Detection to Big-Code." ICSE 2016. doi:10.1145/2884781.2884877. https://arxiv.org/abs/1512.06448 (PDF)
14. S. Schleimer, D. S. Wilkerson, A. Aiken. "Winnowing: Local Algorithms for Document Fingerprinting." SIGMOD 2003. http://theory.stanford.edu/~aiken/publications/papers/sigmod03.pdf (PDF)
15. C. K. Roy, J. R. Cordy. "Towards a Mutation-Based Automatic Framework for Evaluating Code Clone Detection Tools." C3S2E 2008. https://www.cs.usask.ca/~croy/papers/2008/RC_C3S2E_Framework.pdf (PDF). Follow-up: "A Mutation/Injection-Based Automatic Framework for Evaluating Code Clone Detection Tools," ICST Workshops 2009, pp. 157–166 (bibliographic data from search snippets / dblp: https://dblp.dagstuhl.de/rec/html/conf/icst/RoyC09).
16. J. Svajlenko, C. K. Roy. "The Mutation and Injection Framework: Evaluating Clone Detection Tools with Mutation Analysis." *IEEE TSE* 47(5):1060–1087, 2021 (volume/pages from search snippet). https://clones.usask.ca/pubfiles/articles/SvajlenkoMutationFrameworkTSE.pdf (PDF)
17. E. Juergens, F. Deissenboeck, B. Hummel, S. Wagner. "Do Code Clones Matter?" ICSE 2009, pp. 485–495. doi:10.1109/ICSE.2009.5070547. https://arxiv.org/abs/1701.05472 (PDF)
18. C. J. Kapser, M. W. Godfrey. "'Cloning considered harmful' considered harmful: patterns of cloning in software." *Empirical Software Engineering*, 2008. doi:10.1007/s10664-008-9076-6. https://plg.uwaterloo.ca/~migod/papers/2008/emse08-ClonePatterns.pdf (PDF)
19. F. Rahman, C. Bird, P. Devanbu. "Clones: What is that Smell?" MSR 2010 (Best Paper). https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/rahman2010cws.pdf (PDF); landing page https://www.microsoft.com/en-us/research/publication/clones-what-is-that-smell/
20. M. Kim, V. Sazawal, D. Notkin, G. C. Murphy. "An Empirical Study of Code Clone Genealogies." ESEC/FSE 2005. doi:10.1145/1081706.1081737. https://web.cs.ucla.edu/~miryung/Publications/esecfse05-clonegenealogy.pdf (PDF)
21. I. Heitlager, T. Kuipers, J. Visser. "A Practical Model for Measuring Maintainability." QUATIC 2007, pp. 30–39. https://www.di.uminho.pt/~joost/publications/HeitlagerKuipersVisser-Quatic2007.pdf (PDF)
22. GitClear. "AI Copilot Code Quality: 2025" research (industry report). https://www.gitclear.com/ai_assistant_code_quality_2025_research
23. Microsoft Learn. "Configure code analysis rules — Exclude generated code." https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/configuration-options
24. J. Krinke. "A Study of Consistent and Inconsistent Changes to Code Clones." WCRE 2007. **Full text not accessed**; findings via [17] and [19].
25. N. Göde, R. Koschke. "Frequency and Risks of Changes to Clones." ICSE 2011. **[unverified]**, not accessed.
26. A. Monden, D. Nakae, T. Kamiya, S. Sato, K. Matsumoto. "Software Quality Analysis by Code Clones in Industrial Legacy Software." METRICS 2002. **[unverified]**, not accessed.
27. O. El Halimi et al. "Comparative Stability of Cloned and Non-cloned Code: A Replication Study" (replicating Mondal et al.). https://arxiv.org/abs/1504.07713 (PDF; secondary source for Mondal)
28. Wikipedia, "Rule of three (computer programming)." https://en.wikipedia.org/wiki/Rule_of_three_(computer_programming)
29. S. Metz. "The Wrong Abstraction." 2016-01-20. https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction
30. K. C. Dodds. "AHA Programming." 2020-06-22. https://kentcdodds.com/blog/aha-programming
31. M. Fowler. "FlagArgument." 2011-06-23. https://martinfowler.com/bliki/FlagArgument.html
32. Wikipedia, "KISS principle." https://en.wikipedia.org/wiki/KISS_principle
33. M. Fowler. "Yagni." 2015-05-26. https://martinfowler.com/bliki/Yagni.html
34. R. Jeffries. "You're NOT gonna need it!" 1998-04-04. https://ronjeffries.com/xprog/articles/practices/pracnotneed/
35. Wikipedia, "Coupling (computer programming)" (cites Stevens, Myers, Constantine, *IBM Systems Journal* 13(2):115–139, 1974). https://en.wikipedia.org/wiki/Coupling_(computer_programming)
36. R. C. Martin. *Clean Code* (2008), flag arguments. **[unverified]**, book not accessed.
37. MessagePack-CSharp, local clone `workspace/messagepack-csharp` @ `32258fdbee4bcd653c79f51b4376b5103c6f4d27` (2025-03-01). Measured with the prototype; the scripts are in the session scratchpad only.
