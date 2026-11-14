# 01: What human code reviewers actually flag (empirical evidence)

Research for the AI-free C# code-quality certifier (Python + tree-sitter), Junction 2026, Tieto challenge "Earned Trust in AI Code".
Question: according to the empirical literature, which best practices and concerns do human reviewers flag most often, how often, and which of them can be measured statically from source without AI?

**How this was researched.** Every number below comes from the full text of the paper (PDF downloaded and text-extracted), or, where stated, from the paper's abstract or official page. Numbers I derived myself (for example a share computed from raw counts) are marked "(derived)". Items I could not check against a primary source are marked **[unverified]**. The shared web-search budget ran out near the end of the session, so a few planned sources (Thongtanunam et al. 2015, Spadini et al. 2018, Bavota & Russo 2015, Panichella et al. 2015 full text, Fregnan et al. 2022 full text) are only partly covered. Section 7 lists these gaps.

---

## 1. TL;DR: ranked concerns, with frequencies and static measurability

Ranking is by how often the concern appears across the studies. "Share" means the share of review comments or review-induced changes, unless the column says otherwise.

| Rank | Concern (reviewer's view) | Class | Typical share in studies | Rated useful by authors? | Measurable statically without AI? |
|---|---|---|---|---|---|
| 1 | **Documentation and comments** (missing, incorrect or unclear comments; API/doc-comments; TODOs; header comments) | Documentation | Beller 2014: single largest change category, about 20% of review changes. Turzo & Bosu 2023: 33.3% of 2,500 comments. Gunawardena 2023: 24.5% (API docs 16.3 + comments 4.8 + header comments 3.4) (derived). Mäntylä 2009: about 1/3 (industrial) to about 1/2 (student) of evolvability defects | Medium (Turzo: rank 9 of 15; Bosu: mostly "somewhat useful") | **Partly.** Presence and coverage of `///` XML docs on public API, `<param>`/`<returns>` consistency with the signature, TODO/FIXME counts, commented-out code, empty or trivial summaries. Whether a comment is *correct or clear* is not statically checkable (only proxies). |
| 2 | **Structure: organization and solution approach** (refactoring, moving or extracting code, simplifying logic, better API or library, design-level reorganization) | Structure/design | Mäntylä: 55% (industrial) / 44% (student) of evolvability defects. Bacchelli & Bird 2013: "code improvements" are 29% of comments (largest category). Crupi et al. 2026: refactoring is 266/447 = 59.5% of human quality-improvement comments (derived). Gunawardena: Implementation 14.9% + Design 7.4% = 22.3% (derived). Turzo: solution approach 8.5% + organization 7.7% | Medium to high (solution approach rank 5 of 15 in Turzo) | **Partly.** Organization smells are measurable (method/class size, cyclomatic and cognitive complexity, nesting depth, parameter count, cohesion/LCOM, coupling, duplication, God class, feature envy). "Solution approach" (pick a better algorithm, data structure or library) is mostly *not* measurable without AI. |
| 3 | **Functional defects** (logic, validation and null checks, interface/API misuse, resource handling, concurrency) | Functional | Mäntylä: about 20% (industrial) and 13% (student) of all findings. Beller: about 25% of changes. Czerwonka 2015: about 15% of comments indicate a possible defect. Bacchelli & Bird: 14% of comments (65 of 78 are logic issues). Gunawardena: 26% of concerns. Turzo: about 19% per the paper's text | **Highest** (Turzo top-4 are all functional; Bosu: functional comments rated "useful") | **Mostly no.** Needs tests or semantic analysis. Static *risk proxies* exist: missing argument validation, unchecked nulls after `FirstOrDefault`, `IDisposable` without `using`, `async void`, `.Result`/`.Wait()`, empty catch. |
| 4 | **Visual representation / formatting** (indentation, blank lines, whitespace, braces, line length, member order) | Style/visual | Mäntylä: about 10% of evolvability defects (and 12% in Siy & Votta). Gunawardena "Appearance": 14.6% of concerns. Trailing whitespace is the single most common concern type (5%). Turzo: 3.9%. Rare in ConQAT because an auto-formatter was used (Beller) | **Lowest** (Turzo: last of 15) | **Fully.** Deterministic (tree-sitter plus token positions). Low weight is warranted. |
| 5 | **Naming** (non-descriptive names, convention violations, typos) | Documentation (textual) | Beller: renamings are the 2nd largest category in ConQAT, about 10% of changes. Han et al. 2022: bad naming is 26% (OpenStack) and 41% (Qt) of smell-related reviews. Gunawardena: 4.6%. Turzo: naming-convention 3.5% | Medium-low | **Partly.** Convention conformance (.NET casing, `I` prefix, `Async` suffix, `_field`) is fully checkable. Descriptiveness has only heuristics (length, dictionary words, single letters outside loops, abbreviations). |
| 6 | **Unused, dead or unnecessary code** | Structure | Bacchelli & Bird: 55 of 570 comments (9.6%, derived) are about removing unnecessary or unused code. Crupi: 42 of 447 (9.4%, derived). Han et al.: dead code is 18% (OpenStack) and 32% (Qt) of smell-related reviews | Medium | **Yes.** Unused private members, locals, parameters and `using` directives; unreachable code after `return`/`throw`; commented-out code blocks. |
| 7 | **Duplication** | Structure | Han et al.: duplicated code is the #1 smell flagged in OpenStack reviews (617/1,184 = 52%) and 26% in Qt. Morales 2015: review coverage reduces Code Duplication | Medium | **Yes.** Token- or AST-subtree clone detection (Type-1/2 clones). Semantic (Type-4) duplication: no. |
| 8 | **Complexity / readability of code** | Structure | Google's guide lists complexity explicitly. Bacchelli & Bird: 52 of 570 comments about readability. Gunawardena: "nesting too deep", "unreadable code", "simplifiable logic" types. But Han et al.: "long method" is only 2% of smell-related reviews | Medium | **Yes** (as proxies): cyclomatic and cognitive complexity, nesting depth, method LOC, boolean-expression size. |
| 9 | **Encapsulation, modifiers and class design** (access modifiers, immutability, static candidates, cohesion) | Structure/documentation | Gunawardena: Modifiers 6.0% + Design 7.4%. Mäntylä counts `final`/`private` issues as "documentation supported by language". Microsoft C# checklist asks about modifier correctness | Medium | **Yes, mostly:** public mutable fields, missing `readonly`, methods that could be `static`, over-wide visibility, LCOM, very large public interfaces. |
| 10 | **Error handling and logging** | Functional/evolvability | Gunawardena: 3.4% (errors, warnings, logging). Bacchelli & Bird: 3 of 78 defect comments on exception handling. Microsoft C# checklist: catch specific exceptions, minimum logging | Medium-high | **Yes, mostly:** empty `catch`, `catch (Exception)`, `throw ex;`, catch without log or rethrow, generic `throw new Exception`. |
| 11 | **Tests** (missing tests, test quality) | Functional/process | Gunawardena: 2.4%. Google: tests should be in the same CL. Ram 2018 and Microsoft playbook: test inclusion is a reviewability factor | High (Google, Microsoft) | **Partly:** test files exist for the changed types, assertions per test, test-to-code ratio. Coverage needs execution, but no AI. |
| 12 | **Magic literals / hard-coded strings** | Structure | Gunawardena: Literals 1.9%. Microsoft C# checklist items on constants and magic numbers | Medium | **Yes:** numeric literals other than 0/1/-1 outside `const`/enum; repeated string literals. |
| 13 | **Performance, concurrency, security** | Functional | Low frequency, high severity. Gunawardena: performance 3.4%, threads 0.2%. Bacchelli & Bird: 5 of 570 comments on security. Turzo: timing 0.16% | High | **Partly** via patterns (locks, `async` misuse, allocation in loops, `Thread.Sleep` in async code), but true correctness is not static. |
| (process) | **Change size and reviewability** (small changes, clear description, coherent history) | Process | Ram 2018: change description, code churn and commit history are the top reviewability factors. SmartBear/Cisco: 200–400 LOC per review. Bosu 2015 and Czerwonka 2015: usefulness drops with more files (noticeable from 20+ files) | n/a | **Yes**, for PR branches: diff LOC, files touched, number of distinct concerns. |

**The single most robust finding.** Across industrial, student and open-source data, about **75% of what code review finds or fixes concerns evolvability/maintainability, and about 25% concerns functionality** (Mäntylä & Lassenius 2009; Beller et al. 2014; echoed by Czerwonka et al. 2015 at Microsoft: about 15% of comments are defect-related and at least 50% are maintainability-related). That is good news for a static, AI-free certifier: most of what humans care about in review is evolvability, which is far more amenable to static measurement than functional correctness. It is not fully measurable, though. Gunawardena et al. 2023 estimate that **38%** of concerns raised in real reviews could be detected automatically and accurately: 22% by existing tools, plus 16% with easy new heuristics.

---

## 2. The 75:25 rule in detail

| Source | Data | Evolvability / maintainability | Functional | Notes |
|---|---|---|---|---|
| Mäntylä & Lassenius 2009 [1] | 9 industrial C/C++ reviews (388 defects) + 23 student Java reviews (371 defects) | >70% of findings in both. Excluding false positives: **77% industrial, 85% student** | about 20% industrial, 13% student | Paper headline: 75% of defects do not affect visible functionality. "Roughly four out of five" true defects are evolvability. |
| Siy & Votta (as reported in [1]) | 31 inspection sessions, 369 evolvability defects | 60% | 18% | 22% false positives. Visual representation was 12% of evolvability defects. |
| Beller et al. 2014 [2] | >1,400 review-induced changes, ConQAT (Java) + GROMACS (C) | ConQAT-rand about 81% (6 points above 75%), ConQAT-100 about 75%, GROMACS 69% | rest | All within 10 percentage points of 75:25. |
| Czerwonka et al. 2015 [5] (Microsoft) | Microsoft review data | at least 50% of comments are about long-term maintainability | about 15% of comments indicate a possible defect | Position paper with data. Title: "Code Reviews Do Not Find Bugs". |
| Bacchelli & Bird 2013 [3] (Microsoft) | 570 comments | "code improvements" 29% (largest) | "defects" 14% (fourth of nine categories) | Defects were the top *expected* outcome but a minor *actual* one. |
| Turzo & Bosu 2023 [7] (OpenDev Nova) | 2,500 comments | Documentation + organization >40% | about 19% (paper's text) | Functional comments rated most useful. |
| Gunawardena et al. 2023 [8] | 417 concerns, 7 Java OSS projects | rest | 26% functional concerns | 38% auto-detectable. |

---

## 3. Study-by-study evidence

### 3.1 Mäntylä & Lassenius 2009: "What Types of Defects Are Really Discovered in Code Reviews?" [1]
IEEE TSE 35(3):430–448, DOI 10.1109/TSE.2008.71. Full text read (Aalto preprint).

- **Data:** 9 industrial C/C++ reviews (388 defects) and 23 student Java reviews (371 defects).
- **Taxonomy (the basis of almost every later scheme):**
  - *Evolvability defects:*
    - **Documentation.** Information in the code that communicates intent to humans. Subgroups: *textual* (comments, naming) and *supported by language* (for example `final`/immutable and `private` scope, element types). These are counted as documentation because they mainly communicate intent.
    - **Visual representation.** Readability for the eye: mostly indentation and blank-line usage.
    - **Structure.** Affects the syntax tree. Subgroups: *organization* (fixable by restructuring, for example moving functionality, dead code, duplication) and *solution approach* (requires an alternative implementation, for example a better data structure, using prebuilt functionality, semantic duplication or dead code).
  - *Functional defects:* resource, check (validation, return values), interface (calls, parameters), logic (comparison, control flow, computation), timing (concurrency), support (build/config/libraries), larger defects (missing or incomplete features).
  - *False positives.*
- **Distribution:**
  - Over 70% of findings were evolvability in both settings. Functional: about 20% (industrial) and 13% (student). Excluding false positives, evolvability is 77% and 85%.
  - Within evolvability: **visual representation about 10%** (10% and 11%), **documentation about one third (industrial) and almost half (student)**, **structure 55% (industrial) and 44% (student)**.
  - Across prior datasets, textual documentation defects ranged from **17% to 50%**, and organization from **26% to 55%**.
  - Within functional defects, no timing or support defects were found. Industrial reviewers found more "move functionality" and design-level issues. Students found more statement-level issues.
- **Implications stated by the authors (relevant to us):**
  - Only about 10% of evolvability defects (visual representation) can be mostly detected and fixed automatically. Pretty-printers should handle these so that reviews can focus on more important issues.
  - Tools can help detect structural defects, but humans are needed for analysis and repair. Tools that recognize alternative solution approaches or semantic duplication "will likely be challenging".
  - An empirically grounded defect classification should be the baseline for review checklists and coding standards.

### 3.2 Beller, Bacchelli, Zaidman, Juergens 2014: "Modern Code Reviews in Open-Source Projects: Which Problems Do They Fix?" [2]
MSR 2014, pp. 202–211, DOI 10.1145/2597073.2597082. Full text read.

- **Data:** >1,400 review-induced changes. Samples: ConQAT-rand (892 changes), ConQAT-100 (361) and GROMACS (216). Taxonomy adapted from Mäntylä: they classify *changes*, not comments, and drop the false-positive class.
- **Result:** the 75:25 maintainability-to-functional ratio holds in OSS too (ConQAT-rand about 81%, ConQAT-100 about 75%, GROMACS 69%).
- **Detailed profile:**
  - Changes in **code comments are the single largest category** in every sample.
  - **Identifier renamings** come second in ConQAT. In GROMACS, "other" functional changes come second, then renamings.
  - The introduction summarizes the dominant categories as **code comments (about 20%) and identifiers (about 10%)**, "similar to Mäntylä's results".
- **Automation effect:** ConQAT had **few visual-representation changes because developers used Eclipse's auto-formatter**. Once formatting is automated, it largely disappears from review.
- **Triggers:**
  - 78–90% of changes come from review comments. 10–22% are "undocumented" (self-motivated by the author).
  - 7–35% of review comments are discarded. In ConQAT, 93% and 91% of suggestions led to a change. In GROMACS, 65% did.
- **Other:** bug-fix tasks lead to fewer review changes. More altered files and higher churn lead to more changes. The identity of the reviewer had no effect.

### 3.3 Bacchelli & Bird 2013: "Expectations, Outcomes, and Challenges of Modern Code Review" (Microsoft) [3]
ICSE 2013, pp. 712–721, DOI 10.1109/ICSE.2013.6606617. Full text read.

- **Data:** interviews and observation. Survey of 165 managers (28% response rate) and 873 developers/testers (44% response rate). Card sort of **570 comments** from 200 CodeFlow threads.
- **Motivations (developers' first choice):** finding defects 44% (383). Code improvement 39% (337). Alternative solutions 17% (147). Knowledge transfer, team awareness and shared code ownership follow. Managers: finding defects is the top reason for 44%, code improvements for 31%.
- **Code improvement**, as defined by the authors: comments about readability, commenting, consistency and dead-code removal that do not involve correctness. Interviewees said at least one reviewer usually checks team conventions such as **formatting and function/variable naming**, often as the "first pass".
- **Actual outcomes (570 comments):**
  - **Code improvements: 165 (29%)**, the most frequent category. Of these, 58 are on using better code practices, 55 on removing unnecessary or unused code, and 52 on improving readability.
  - **Understanding** (clarification questions) is the 2nd most frequent category. The exact count is in a figure that could not be extracted.
  - **Defects: 78 (14%)**, only the 4th most frequent of 9 categories. Of these, 65 are logic issues, 6 high-level, 5 security and 3 wrong exception handling. Defect comments are mostly "micro-level", for example corner cases and operator precedence.
  - Knowledge transfer: 12 comments.
- **Implications:** most comments are about "code improvement" and low-level micro defects, which tools can partly automate (convention enforcement, typo checks, dead-code detection). Several interviewees complained that reviewers focus on formatting because it is easy, while missing real problems.

### 3.4 Czerwonka, Greiler, Tilford 2015: "Code Reviews Do Not Find Bugs: How the Current Code Review Best Practice Slows Us Down" (Microsoft) [5]
ICSE-SEIP 2015. Full text read.

- Only **about 15% of reviewer comments indicate a possible defect**, let alone a blocking one. **At least 50%** of comments concern long-term maintainability.
- Usefulness of comments, as judged by the author, rises with reviewer experience. First-time reviewers of a code area: about 33% useful. By the third time: about 67%.
- Usefulness falls as review size grows, noticeably from **20 or more changed files**. Developers spend about 6 hours per week reviewing. Median time to sign-off is about 24 hours.

### 3.5 Bosu, Greiler, Bird 2015: "Characteristics of Useful Code Reviews: An Empirical Study at Microsoft" [4]
MSR 2015, DOI 10.1109/MSR.2015.21. Full text read.

- **Qualitative phase:** 7 developers rated and classified 145 of their own received comments using the Mäntylä scheme.
  - About **69%** were rated useful or somewhat useful.
  - Comments identifying **functional defects were mostly rated "useful"**. More than 60% of the "somewhat useful" comments fell into the four evolvability categories: documentation, visual representation, organization and solution approach.
  - "Not useful" comments were mostly false positives or "other".
  - About 73% of comments fit Mäntylä's categories. New categories: questions, praise, alternate output or error messages, and design discussion. Questions and praise were not considered useful. The latter two were.
- **Quantitative phase:** a classifier applied to 1,496,340 comments from 5 projects (Azure, Bing, Visual Studio, Exchange, Office). **Overall usefulness density was 65.5%**, ranging from 63.3% to 68.6% per project. So about one third of comments are not useful.
- Reviewers who had reviewed or changed the file before gave nearly twice as many useful comments (65–71%) as first-time reviewers (32–37%). Usefulness decreases with the number of files in the change.

### 3.6 Sadowski et al. 2018: "Modern Code Review: A Case Study at Google" [6] and Google eng-practices [12][13]
ICSE-SEIP 2018, DOI 10.1145/3183519.3183525. Full text read; the page with the expectations table is an image.

- **Data:** 12 interviews, a survey with 44 valid responses, and logs of about 9 million reviewed changes.
- **Original impetus:** force developers to write code that others can understand, because code must teach future developers. Bug finding is welcome but secondary. Review expectations depend on the author–reviewer relationship. Themes are education, maintaining norms (readability, consistency), gatekeeping and accident prevention. The theme names were confirmed via the paper text plus a secondary summary [6b].
- **Process statistics:**
  - Over 80% of changes involve at most one iteration.
  - Fewer than 25% of changes have more than one reviewer (median reviewer count is 1).
  - Median change is **24 lines**. Over 35% of changes touch a single file, about 90% touch fewer than 10 files, and over 10% change a single line.
  - Median overall review latency is under 4 hours. 70% of changes are committed within 24 hours.
  - Critique displays **Tricorder** static-analysis results (110 analyzers, more than 30 languages) and pre-commit style checks. Readability approval is a separate, explicit requirement for convention conformance.
- **Google "What to look for in a code review" [12]**, which is the de-facto industry checklist:
  - **Design:** do the interactions make sense, and does the change belong here?
  - **Functionality:** edge cases, concurrency, user impact.
  - **Complexity:** at line, function and class level. "Too complex" means it cannot be understood quickly, or it invites bugs. Avoid over-engineering and speculative generality.
  - **Tests:** in the same CL, and they would fail if the code broke.
  - **Naming:** names communicate purpose without being too long.
  - **Comments:** clear, necessary, and explaining *why* rather than *what*. Remove stale TODOs.
  - **Style:** follow the style guide. Non-mandatory points get a "Nit:" prefix. Don't mix style and functional changes.
  - **Consistency:** the style guide first, then the surrounding code.
  - **Documentation:** update READMEs and generated docs.
  - **Every line, context, good things.**
- **Google "The Standard of Code Review" [13]:** approve once a change definitely improves overall code health. The aim is continuous improvement, not perfection. The style guide is the authority on style.

### 3.7 Turzo & Bosu 2023: "What Makes a Code Review Useful to OpenDev Developers? An Empirical Investigation" [7]
Empirical Software Engineering 2023/2024 (FSE 2024 journal-first), arXiv:2302.11686. Full text read.

- **Data:** 2,500 randomly sampled comments from OpenDev Nova (Python), classified with an 18-category scheme derived from Beller et al. They also surveyed developers on usefulness (scale 1–5).
- **Distribution of comments and usefulness rank (Table 5 of the paper):**

| Category | Share of 2,500 comments | Combined usefulness score (rank of 15) |
|---|---|---|
| Documentation | **33.32%** | 3.73 (9) |
| Question | 13.56% | 3.99 (6) |
| Solution approach | 8.48% | 4.00 (5) |
| Organization of code | 7.68% | 3.68 (10) |
| Praise | 4.20% | 3.03 (14) |
| Visual representation | 3.92% | 2.92 (15, lowest) |
| Validation | 3.68% | 4.16 (2) |
| Design discussion | 3.64% | 3.87 (7) |
| Naming convention | 3.52% | 3.43 (13) |
| Alternate output | 2.56% | 3.63 (11) |
| Logical | 2.28% | 4.11 (3) |
| Interface | 1.60% | 4.10 (4) |
| Resource | 1.48% | 3.83 (8) |
| Functional defect | 0.48% | 4.38 (1, highest) |
| Timing | 0.16% | 3.50 (12) |

- The table rows sum to about 90.6% (derived). The remainder is presumably support, false positive and other, which are not in the table.
- The text says only **19%** of comments belonged to the functional categories. The listed functional rows sum to only 9.7% (derived), a discrepancy I could not resolve from the text. The paper also states that documentation plus organization is **more than 40%**.
- About 77% of comments were useful. The survey's most frequently mentioned usefulness criteria were "finds defects" (44.4% of respondents) and "improves code quality" (42.5%).

### 3.8 Gunawardena, Tempero, Blincoe 2023: "Concerns identified in code review: A fine-grained, faceted classification" [8]
Information and Software Technology 153:107054. Full text read. **This is the paper most directly relevant to an automated certifier.**

- **Data:** 417 concerns from review comments in 7 OSS Java projects (Eclipse ecosystem, Gerrit). The authors derived 116 concern types in 15 groups.

| Concern group | Share of concerns |
|---|---|
| API documentation | **16.3%** |
| Implementation (better library or API, nesting too deep, simplifiable logic, unreadable code, extractable code, duplication, unused item, dead code, …) | **14.9%** |
| Appearance (indentation, blank lines, trailing or unnecessary whitespace, braces, long lines, member order) | **14.6%** |
| Logic and functionality | **14.1%** |
| Design (unnecessary class or method, low cohesion, static candidate, better design exists, …) | 7.4% |
| Modifiers (access and non-access) | 6.0% |
| Comments (inline, TODO) | 4.8% |
| Identifier naming | 4.6% |
| Errors, warnings and logging | 3.4% |
| Performance | 3.4% |
| Header comments (license, copyright) | 3.4% |
| Annotations | 2.6% |
| Test cases | 2.4% |
| Literals (magic numbers, non-externalized strings) | 1.9% |
| Threads | 0.2% |

- **Most frequent single types:** trailing whitespace (22/417, 5%) and missing documentation info (16/417, 4%). 43% of the 116 types occurred only once.
- **Automatability:** **38% (157/417)** of concerns are "automatically detectable" with accuracy.
  - 22% were already detectable by popular tools (Checkstyle, PMD, SonarQube, IntelliJ inspections, …).
  - 16% could be detected by easy new heuristics.
  - The remaining **62% need humans**. Of these, 22% are logic and functionality concerns.
  - Appearance is 39% of the auto-detectable concerns.
- **Functional share:** 26% of concerns. The authors argue that many of these could be caught more cheaply by tests.

### 3.9 Han et al. 2021 [9] / 2022 [10]: which code smells reviewers flag
ICPC 2021 (arXiv:2103.11446), and its EMSE 2022 extension (arXiv:2205.07535). Full text of [10] read; the [9] table was read via the ar5iv HTML.

- **Data:** 25,415 review comments manually checked (keyword search plus random sampling), yielding 1,539 smell-related reviews in OpenStack Nova/Neutron and Qt Base/Creator.
- **Smells are rare in reviews:** under 1% of review comments.
- **Frequencies:**
  - **OpenStack (1,184):** duplicated code 617 (52%), bad naming 304 (26%), dead code 218 (18%), long method 30 (2%).
  - **Qt (355):** bad naming 146 (41%), dead code 113 (32%), duplicated code 92 (26%), long method 2.
- **Cause:** where a cause was given (458 reviews), **82% (375) attributed the smell to a violation of coding conventions**.
- **Fix rates (ICPC 2021, OpenStack):** 86% overall. Duplicated code 82%, bad naming 91%, dead code 95%.
- **Takeaway:** reviewers flag **duplication, naming and dead code**. Classic metric smells such as "long method", "God class" and "feature envy" are rarely flagged explicitly in comments.

### 3.10 Crupi, Tufano, Bavota 2026: "Studying Quality Improvements Recommended via Manual and Automated Code Review" [11]
ICPC 2026, arXiv:2602.11925. HTML full text read; per-category counts are only in a figure.

- **Data:** 447 valid human reviewer comments from 179 PRs (Java and Python), recommending quality improvements.
- **Refactoring is the dominant root category: 266 of 447 comments (59.5%, derived)**, appearing in 223 PRs. Examples are extract method, move method and rename. "Removal of unneeded code" accounts for 42 comments.
- **Other root categories:** bug fixing, documentation, logging, object design principles, testing and other. Counts for these are not in the text.
- **Comparison with ChatGPT:** ChatGPT produced about 2.4 times more comments but matched only 10% of human comments (23% including partial matches).

### 3.11 Fregnan et al. 2022: "What happens in my code reviews?" [14]
EMSE 27, art. 89, DOI 10.1007/s10664-021-10075-5. **Only bibliographic data and abstract were verified.**

- 1,504 review changes were manually classified with Beller's taxonomy, and a classifier was trained (AUC-ROC > 0.91).
- A search-result summary said documentation and organization changes were the most common types. **[unverified]**: the full text could not be retrieved (Springer paywall; the preprint URL returned 404).

### 3.12 Ram, Sawant, Castelluccio, Bacchelli 2018: "What makes a code change easier to review?" [15]
ESEC/FSE 2018, pp. 201–212, DOI 10.1145/3236024.3236080. Full text read.

- **Method:** a review of white and gray literature yielded 10 themes: change description, change scope, code churn, code quality, code style, commit history, composite changes, nature of change, subsystem hotness and test inclusion. Then 10 interviews, plus 98 changes rated by professional developers.
- **Result:** reviewability is defined by how well a change is (1) explained (description, commit history), (2) sized and self-contained (churn, no composite changes), and (3) aligned with project style. **The top three factors are description, commit history and size.**
- **Literature they cite:** Gousios et al. found that documentation, adherence to conventions, style conformance and code quality matter for PR acceptance. Kononenko et al. found that documentation quality, readability and naming conventions affect understanding of a change. These are second-hand citations; I did not verify the original papers.

### 3.13 Does review improve quality? McIntosh et al. 2014 [16]; Morales et al. 2015 [17]

- **McIntosh, Kamei, Adams, Hassan** (MSR 2014, pp. 192–201; Qt, VTK, ITK). Full text read.
  - Both review *coverage* (the proportion of changes reviewed) and review *participation* are significantly linked to post-release defects.
  - Low coverage and low participation are estimated to produce components with up to **2 and 5 additional post-release defects** respectively.
- **Morales, McIntosh, Khomh** (SANER 2015, pp. 171–180, DOI 10.1109/SANER.2015.7081827). Full text read.
  - Components with low review coverage or participation are more prone to **7 anti-patterns**: Code Duplication, Blob, Data Class, Data Clumps, Feature Envy, Schizophrenic Class and Tradition Breaker.
  - Between 11% and 66% of components contain at least one of these.
  - High coverage reduces Blob, Data Class, Data Clumps, Feature Envy and Code Duplication. Hastily reviewed changes are associated with God Classes and code duplication.
  - **Relevance:** this indicates that these statically detectable anti-patterns are exactly what thorough human review prevents.

### 3.14 Industry checklists

- **Google eng-practices [12][13]:** see 3.6.
- **Microsoft Code-With Engineering Playbook, Reviewer Guidance [18]:**
  - Linters take care of style and formatting. Humans focus on business-logic correctness, test correctness, readability and maintainability of the design, and language-specific checklists.
  - *Code-quality pass:* complexity (does a function do too much; more than 3 arguments?), naming and readability, error handling, functionality (race conditions, security, PII handling), style (extraneous comments, conventions), and tests (committed with the code, covering edge cases).
- **Microsoft playbook, C# Code Reviews recipe [19]** (directly applicable to MessagePack-CSharp). Checklist items:
  - Correct `async`/`await`, `Task.WhenAll` and `CancellationToken` use. `Task.Delay` rather than `Thread.Sleep`. `Async` suffix on async methods.
  - Thread safety of shared objects and collections.
  - Deterministic disposal (`using` or `IDisposable` pattern). GC pressure and boxing.
  - Specific exceptions rather than base `Exception`. Argument validation (CA1062).
  - Constants rather than raw strings. Magic numbers explained, or turned into constants or enums.
  - Correct access modifiers and auto-property use. Appropriate LINQ use. Sensible logging.
  - Tests follow Arrange/Act/Assert.
  - Tooling: Microsoft.CodeAnalysis.NetAnalyzers, StyleCop.Analyzers, `.editorconfig`, `TreatWarningsAsErrors`, analyzers run in CI.
- **SmartBear / Cisco study [20]:**
  - Review 200–400 LOC at a time; beyond 400 LOC the ability to find defects diminishes.
  - Keep the inspection rate under 500 LOC per hour, and sessions to 60 minutes or less.
  - The commonly cited study scale (about 2,500 reviews, 3.2M LOC, Cisco, 10 months) is **[unverified]**: it appears only in secondary sources I did not open. SmartBear's own page does not state it.
- **OWASP Code Review Guide [21]:** the OWASP project page was reached. It confirms the guide exists (CC BY-SA 4.0, GitHub-hosted) but gives no details of its contents. Category details are **[unverified]**.

### 3.15 Security in review: Paul, Turzo, Bosu 2021 [22]
ICSE 2021, arXiv:2102.06909. Abstract only.

- Chromium OS: 516 reviews identified security defects, and 374 reviews missed them. A model of 9 review attributes reached AUC 0.91.
- **Relevance:** security is a minor share of review comments (5 of 570 in Bacchelli & Bird), but it is important when missed.

---

## 4. Unified taxonomy (for mapping our metrics)

```
Code review findings
├── Evolvability (~75%)
│   ├── Documentation (largest single class: ~20–33% of all comments/changes)
│   │   ├── Textual: comments, API/doc-comments, header comments, TODOs; naming (~4–10%)
│   │   └── Supported by language: access modifiers, readonly/const, types
│   ├── Visual representation (~10% of evolvability; ~4–15% of comments): indentation, blank lines, whitespace, braces, line length
│   └── Structure (~44–55% of evolvability)
│       ├── Organization: move/extract, dead/unused code, duplication, complexity, cohesion, magic literals
│       └── Solution approach: better algorithm, data structure, library or API (needs expertise; mostly not static)
├── Functional (~13–26%): logic, check/validation, interface, resource, timing, support, larger
└── Discussion (comments that cause no change): questions/understanding (~14% in Turzo; 2nd in Bacchelli & Bird), praise, design discussion
```

Mapping to the four buckets requested:

- **Style/visual:** visual representation, plus naming *conventions*.
- **Structure/design:** organization, solution approach, design, modifiers, duplication, dead code, complexity, literals, error-handling structure.
- **Documentation:** comments, API docs, header comments, naming *semantics*.
- **Functional:** logic, validation, interface, resource, timing, larger defects, tests, performance, security.

---

## 5. Best practices to certify: evidence and a static measurement idea for each

The ordering below combines frequency (sections 1–3) with how reliably the practice can be measured statically. Rough tree-sitter-c-sharp node names are given as hints. Roslyn rule IDs in brackets are my own suggestions from general .NET knowledge, **not verified in this research**, except CA1062, which appears in the Microsoft playbook [19].

1. **Public API documentation.** Evidence: the most frequent comment category in [2], [7] and [8]; Google lists comments and documentation [12].
   - *Metric:* share of `public`/`protected` types and members with a preceding `///` comment that contains a non-empty `<summary>`.
   - *Consistency checks:* `<param name>` matches the parameter list, `<returns>` is present for non-void methods, no orphan params.
   - *Heatmap:* per member.
   - *Not measurable:* whether the documentation is correct.
2. **Comment hygiene.** Evidence: Mäntylä's textual-documentation class [1]; Gunawardena's comment types (unnecessary, missing, unclear, TODO) [8]; Google says remove stale TODOs [12].
   - *Metrics:* TODO/FIXME/HACK density; commented-out code (comment lines that parse as C# statements); comment-to-code ratio in methods above a complexity threshold.
3. **Naming conventions and identifier quality.** Evidence: renamings are about 10% of changes [2]; bad naming is 26–41% of smell reviews [10]; naming is in the Google and Microsoft checklists.
   - *Metrics:* .NET casing rules per declaration kind (PascalCase for types and members, camelCase for parameters and locals, `I` prefix for interfaces, `Async` suffix for Task-returning methods, `_camel` for private fields if that is the project convention).
   - *Heuristics:* single-letter names outside `for`/lambda parameters; names under 3 characters; non-dictionary abbreviations.
4. **Small, simple methods (complexity).** Evidence: Google "Complexity" [12]; Microsoft "doing too much / >3 args" [18]; readability comments [3]; nesting and simplifiable-logic types [8].
   - *Metrics:* cyclomatic complexity (count `if`, `case`, `for`, `foreach`, `while`, `catch`, `&&`, `||`, `?:`, `??`), cognitive complexity (nesting-weighted), maximum nesting depth, method LOC, parameter count.
5. **No duplication.** Evidence: #1 smell in OpenStack reviews [10]; anti-pattern reduced by review [17]; Mäntylä organization class [1].
   - *Metric:* hash normalized token windows or AST subtrees (identifiers and literals abstracted) to find Type-1 and Type-2 clones; report the duplicated-line ratio and clone pairs, localized to lines.
6. **No dead or unused code.** Evidence: about 9–10% of comments in [3] and [11]; 18–32% of smell reviews [10].
   - *Metrics:* private methods, fields and properties never referenced in the file or type; unused parameters and locals; unused `using` directives; statements after `return`/`throw`/`break` in the same block. [IDE0051, IDE0052, IDE0060, CS0168]
7. **Error handling.** Evidence: [3], [8], [19].
   - *Metrics:* empty `catch_clause` blocks; `catch (Exception)` or bare `catch` without rethrow; `throw ex;` (loses the stack); catch blocks that neither log nor rethrow; `throw new Exception(...)`. [CA1031, CA2200]
8. **Encapsulation and class design.** Evidence: modifiers and design [8]; the Blob, Data Class and Feature Envy anti-patterns reduced by review [17]; Microsoft modifier checks [19].
   - *Metrics:* public non-const, non-readonly fields; fields never reassigned but not `readonly`; methods that don't use `this` but aren't `static`; class size (members, LOC); LCOM-style cohesion; efferent coupling (distinct referenced types). [IDE0044, CA1822, CA1051]
9. **Formatting consistency.** Evidence: about 10% of evolvability [1]; 14.6% Appearance [8]; lowest usefulness [7]; disappears with auto-formatters [2].
   - *Metrics:* indentation consistency, trailing whitespace, tabs vs. spaces, line length, brace style, missing braces on single-statement `if`, blank-line runs.
   - *Weight:* low.
10. **Constants instead of magic literals.** Evidence: [8], [19].
    - *Metrics:* numeric literals other than -1/0/1/2 outside `const`/`enum`/attribute arguments; string literals repeated 3 or more times.
11. **Tests accompany code** (optional; needs repository context). Evidence: [12], [15], [18].
    - *Metrics:* for each changed production type, does a test file or test type reference it; asserts per test method; Arrange/Act/Assert structure.
12. **Change reviewability** (PR-level, for the agent branches). Evidence: [4], [5], [15], [20].
    - *Metrics:* changed LOC (flag above 400), files touched (flag at 20 or more), mixing formatting-only and logic changes in one diff (Google: don't mix style and functional changes).

**Functional-risk proxies** are not a substitute for tests, but are statically detectable patterns from the C# checklist [19]:

- `async void` outside event handlers
- `.Result` / `.Wait()` on tasks
- `Thread.Sleep` in async methods
- `IDisposable` locals not in `using`
- public methods dereferencing parameters without null checks [CA1062]
- `FirstOrDefault()` result dereferenced without a check
- `lock` on `this` or on a public object

---

## 6. Implications for the certifier

- **Weighting evidence.** Frequency and perceived usefulness are inversely related.
  - Documentation, visual and naming issues are frequent but rated less useful [7][4].
  - Functional issues are rare but rated most useful.
  - A defensible scheme gives high weight to structure (complexity, duplication, dead code, design), medium to documentation and naming, low to formatting, and a separate "risk" score for functional-risk proxies.
- **Honesty about coverage.** Gunawardena et al. [8] estimate that **38%** of human review concerns are automatically detectable. Mäntylä [1] says most evolvability defects cannot be fixed by tools alone. The certifier should present itself as covering the *measurable subset* of what reviewers check, not as a full replacement for review. This fits the "earned trust" framing.
- **Statistical validation ideas.** These follow from the literature:
  - (a) Correlate our metric scores with review outcomes, for example the number of review-induced changes per file. Beller found more changes for higher churn and more files [2].
  - (b) Use the Morales et al. design [17]: test whether our anti-pattern metrics are higher in less-reviewed or agent-written code.
  - (c) Check inter-metric redundancy, because several metrics are size-confounded. Morales excluded size for size-based anti-patterns.
- **The AI-code angle.** Crupi et al. [11] show LLM reviewers rarely match human reviewers' recommendations (10%). A deterministic certifier anchored in the human-review taxonomy above is a principled complement.

---

## 7. Gaps and unverified items

- **Thongtanunam et al. 2015** ("Investigating code review practices in defective files", MSR 2015): **not verified**. The search budget was exhausted before it could be retrieved.
- **Spadini et al. 2018** ("When testing meets code review", ICSE 2018): **not verified**.
- **Bavota & Russo 2015** ("Four eyes are better than two"): **not verified**.
- **Panichella et al. 2015** ("Would static analysis tools help developers with code reviews?", SANER 2015): only bibliographic data and abstract-level claims seen in search results. A secondary claim that coding-structure warnings are the ones most addressed in review is **[unverified]**.
- **Fregnan et al. 2022**: category percentages are **[unverified]**; see 3.11.
- **Bacchelli & Bird 2013**: the exact counts for "understanding", "social communication" and the other card-sort categories are in a figure that could not be extracted. Only the text-stated counts are used here.
- **Mäntylä & Lassenius 2009**: Tables 3–18 are images in the preprint. Only percentages stated in the prose are used here.
- **Sadowski et al. 2018**: the table of expectation themes is an image. The theme names come from paper text plus a secondary summary [6b].
- **SmartBear/Cisco**: the study scale numbers are **[unverified]**. The practice thresholds come from SmartBear's own page.
- **OWASP Code Review Guide**: content categories are **[unverified]**.

---

## References

1. M. V. Mäntylä, C. Lassenius. "What Types of Defects Are Really Discovered in Code Reviews?" *IEEE TSE* 35(3):430–448, 2009. DOI: https://doi.org/10.1109/TSE.2008.71. Preprint (read): https://aaltodoc.aalto.fi/server/api/core/bitstreams/cab054e8-0c06-47ab-8754-54bb09a0a6d3/content. Author page: https://mmantyla.github.io/wiki/What+Types+of+Defects+Are+Really+Discovered+in+Code+Reviews%253F.html
2. M. Beller, A. Bacchelli, A. Zaidman, E. Juergens. "Modern Code Reviews in Open-Source Projects: Which Problems Do They Fix?" *MSR 2014*, pp. 202–211. DOI: https://doi.org/10.1145/2597073.2597082. Full text (read): https://repository.tudelft.nl/file/File_9eb1b79b-a0f2-4631-9e2c-d71d4081a138. Record: https://repository.tudelft.nl/record/uuid:8747d363-137b-4a9a-a02a-f8aebd26c674. Data: https://api.figshare.com/v2/articles/915389
3. A. Bacchelli, C. Bird. "Expectations, Outcomes, and Challenges of Modern Code Review." *ICSE 2013*, pp. 712–721. DOI: https://doi.org/10.1109/ICSE.2013.6606617. Full text (read): https://web.eecs.umich.edu/~weimerw/2018-481/readings/codereview.pdf
4. A. Bosu, M. Greiler, C. Bird. "Characteristics of Useful Code Reviews: An Empirical Study at Microsoft." *MSR 2015*. DOI: https://doi.org/10.1109/MSR.2015.21. Full text (read): https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/bosu2015useful.pdf
5. J. Czerwonka, M. Greiler, J. Tilford. "Code Reviews Do Not Find Bugs: How the Current Code Review Best Practice Slows Us Down." *ICSE-SEIP 2015*. Full text (read): https://microsoft.com/en-us/research/wp-content/uploads/2015/05/PID3556473.pdf
6. C. Sadowski, E. Söderberg, L. Church, M. Sipko, A. Bacchelli. "Modern Code Review: A Case Study at Google." *ICSE-SEIP 2018*. DOI: https://doi.org/10.1145/3183519.3183525. Full text (read): https://storage.googleapis.com/gweb-research2023-media/pubtools/4476.pdf. Page: https://research.google/pubs/modern-code-review-a-case-study-at-google/
   - 6b. Secondary summary (A. Reid's notes), used only for the theme names: https://alastairreid.github.io/RelatedWork/papers/sadowski:icse-seip:2018
7. A. K. Turzo, A. Bosu. "What Makes a Code Review Useful to OpenDev Developers? An Empirical Investigation." *Empirical Software Engineering*, 2023/2024. arXiv: https://arxiv.org/abs/2302.11686. Full text (read): https://arxiv.org/pdf/2302.11686
8. S. Gunawardena, E. Tempero, K. Blincoe. "Concerns identified in code review: A fine-grained, faceted classification." *Information and Software Technology* 153:107054, 2023. Author PDF (read): https://kblincoe.github.io/publications/2022_IST_CodeReview.pdf. dblp: https://dblp.org/rec/journals/infsof/GunawardenaTB23
9. X. Han, A. Tahir, P. Liang, S. Counsell, Y. Luo. "Understanding Code Smell Detection via Code Review: A Study of the OpenStack Community." *ICPC 2021*. https://arxiv.org/abs/2103.11446 (table read via https://ar5iv.arxiv.org/html/2103.11446)
10. X. Han, A. Tahir, P. Liang, S. Counsell, K. Blincoe, B. Li, Y. Luo. "Code Smells Detection via Modern Code Review: A Study of the OpenStack and Qt Communities." *Empirical Software Engineering*, 2022. https://arxiv.org/abs/2205.07535 (full text read)
11. G. Crupi, R. Tufano, G. Bavota. "Studying Quality Improvements Recommended via Manual and Automated Code Review." *ICPC 2026*. https://arxiv.org/abs/2602.11925 (HTML read: https://arxiv.org/html/2602.11925v1)
12. Google Engineering Practices. "What to look for in a code review." https://google.github.io/eng-practices/review/reviewer/looking-for.html
13. Google Engineering Practices. "The Standard of Code Review." https://google.github.io/eng-practices/review/reviewer/standard.html
14. E. Fregnan, F. Petrulio, L. Di Geronimo, A. Bacchelli. "What happens in my code reviews? An investigation on automatically classifying review changes." *Empirical Software Engineering* 27, art. 89, 2022. DOI: https://doi.org/10.1007/s10664-021-10075-5 (abstract-level only)
15. A. Ram, A. A. Sawant, M. Castelluccio, A. Bacchelli. "What Makes a Code Change Easier to Review: An Empirical Investigation on Code Change Reviewability." *ESEC/FSE 2018*, pp. 201–212. DOI: https://doi.org/10.1145/3236024.3236080. Preprint (read): https://zenodo.org/records/1323659/files/preprint.pdf
16. S. McIntosh, Y. Kamei, B. Adams, A. E. Hassan. "The Impact of Code Review Coverage and Code Review Participation on Software Quality: A Case Study of the Qt, VTK, and ITK Projects." *MSR 2014*, pp. 192–201. Full text (read): https://rebels.cs.uwaterloo.ca/papers/msr2014_mcintosh.pdf. Page: https://rebels.cs.uwaterloo.ca/confpaper/2014/05/30/the-impact-of-code-review-coverage-and-code-review-participation-on-software-quality.html
17. R. Morales, S. McIntosh, F. Khomh. "Do Code Review Practices Impact Design Quality? A Case Study of the Qt, VTK, and ITK Projects." *SANER 2015*, pp. 171–180. DOI: https://doi.org/10.1109/SANER.2015.7081827. Full text (read): https://www.swat.polymtl.ca/data/SANER15/Morales-saner15.pdf
18. Microsoft Code-With Engineering Playbook. "Reviewer Guidance." https://microsoft.github.io/code-with-engineering-playbook/code-reviews/process-guidance/reviewer-guidance/
19. Microsoft Code-With Engineering Playbook. "C# Code Reviews." https://microsoft.github.io/code-with-engineering-playbook/code-reviews/recipes/csharp/
20. SmartBear. "Best Practices for Code Review" (based on the SmartBear/Cisco study). https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/
21. OWASP Code Review Guide project page. https://owasp.org/www-project-code-review-guide/ (content not verified)
22. R. Paul, A. K. Turzo, A. Bosu. "Why Security Defects Go Unnoticed during Code Reviews? A Case-Control Study of the Chromium OS Project." *ICSE 2021*. https://arxiv.org/abs/2102.06909 (abstract only)
