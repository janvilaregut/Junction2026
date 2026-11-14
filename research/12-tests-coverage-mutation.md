# 12 — Tests dimension: measuring test adequacy deterministically (coverage, patch coverage, mutation, test-code quality)

Retrieved: 2026-11-14. Scope: what the evidence says about measuring test adequacy without humans or LLMs, what thresholds can be defended, the exact formulas (SonarQube, Codecov, diff-cover, Google, Stryker), how to score tests 0–100 and gate on them with proper statistics, and the .NET tooling needed for MessagePack-CSharp and the 4 agent-written PR branches.

Conventions: every number below comes from a source I opened: the PDF text, the official docs page, the source code, or the abstract in an OpenAlex/Semantic Scholar record (reference numbers in brackets). Anything I could not open is marked **[unverified]**. Statements marked **[design]** are our own proposals, not findings from the literature.

Note on method: this session's web-search quota ran out midway. After that I fetched only known URLs: publisher, author, arXiv, figshare, docs and GitHub raw pages, plus DOI lookups in OpenAlex and Semantic Scholar. Three sources were behind bot protection (Spadini et al. PDF, the Kochhar PDFs, dblp), and I did not try to get around it. For those I used only the abstracts.

---

## 0. TL;DR: what to hard-code, and how well each part is justified

| Element | Proposed rule / formula | Justification strength | Source |
|---|---|---|---|
| **Failing tests** | Blocker: 0 tests that pass on base and fail on head (a regression), and 0 failing tests among the tests the PR adds or modifies. | Strong (industry-universal precondition). Google computes changelist coverage only when all tests pass [2]. Sonar tracks `test_success_density = (tests − (errors + failures)) / tests × 100` [10]. | [2][10][31] |
| **New-code (patch) coverage** | Gate: `cov_new ≥ 80 %` when the change has at least 20 coverable new lines (Sonar fudge factor), *or* the 3-valued Wilson gate in §6.3. | **Convention, not causal evidence.** Sonar way default is 80 % [11]. Google's opt-in Level 4 is changelist ≥ 80 %, and Level 5 is ≥ 90 % [2]. The Google blog calls 90 % per-commit "a good lower threshold" and 99 % "reasonable" [3]. Low coverage does indicate under-testing, but high coverage does not establish effectiveness [1][7][37][40]. | [1][2][3][11] |
| **Coverage formula** | Sonar-compatible: `cov = (LC + CC) / (EL + C)`. LC = covered coverable lines. CC = covered condition outcomes. EL = coverable lines. C = condition outcomes to cover. Equivalent to the classic `(CT+CF+LC)/(2B+EL)`. Also report line-only `LC/EL`. | Exact. Taken from the SonarQube source code [12]. | [9][12][13] |
| **Diff selection** | Added and modified lines in the post-image of `git diff base...head`, intersected with lines that appear in Cobertura. Deleted lines don't count. Lines without coverage data are not scored. | Exact. Same convention as Google "delta coverage" [2] and diff-cover [15]. | [2][15][16] |
| **Effectiveness** | Mutation score on changed lines: `MS = (killed + timeout) / (killed + timeout + survived + no_coverage)` from Stryker.NET's JSON report, filtered to diff lines. Score it, list surviving mutants, and gate only on extreme values **[design]**. | Strong evidence that mutants beat coverage as a proxy. 73 % of 357 real faults are coupled to mutants, and mutant detection correlates with real-fault detection more strongly than statement coverage does, even with coverage controlled [4]. At Google, mutants were coupled to 70 % of 1,502 high-priority bugs [21]. Google itself does *not* gate on a mutation score, which it calls "neither concrete nor actionable"; it surfaces survivors instead [20]. | [4][7][20][21][22][23] |
| **Test-code hygiene** | Deterministic static checks on new or modified test methods. Assertion presence, plus a fixed smell set (Empty, Unknown/no-assert, Sleepy, Ignored/Skip, Conditional Logic, Redundant Print, Exception-handling-by-try/catch, Duplicate Assert, Sensitive Equality). Plus test co-change and traceability for changed production types. | Moderate. The number of assertions correlates strongly with suite effectiveness [26]. Smelly tests are more change- and defect-prone, and production code they test is more defect-prone [27]. Naming-convention traceability is highly accurate when conventions are followed [30]. | [26][27][28][29][30] |
| **Statistics** | Treat new coverable lines as Bernoulli trials and report the Wilson interval. Fail only if the one-sided 95 % upper bound is below 0.80; pass if the point estimate is at least 0.80; otherwise *inconclusive*, falling back to point estimate or warning **[design]**. | Wilson is recommended over Wald for small n [33]. | [33][34][35] |
| **Weight inside "Tests" (20 %)** | `T = 0` if a blocker fires. Otherwise `T = 0.40·U_cov + 0.35·U_mut + 0.25·H`, with mutation unavailable → `0.60·U_cov + 0.40·H` and a flag **[design]**. | Design choice. The weighting mirrors the evidence: coverage is necessary but not sufficient, and mutation is the stronger proxy. | §6 |

Bottom line on the teammate's proposal. Keep "0 failing tests" as a blocker, but make it *differential*: failures already present on base must not block the PR. Keep "new-code coverage ≥ 80 %" as a gate, but cite it honestly as Sonar's default and Google's Level 4 changelist threshold, not as an evidence-derived optimum. It also needs a small-change rule (Sonar's 20-line fudge factor, or the Wilson rule in §6.3). Then add mutation on the diff as the effectiveness measure. The literature says that coverage alone cannot certify test quality [1][3][7][37].

---

## 1. Evidence: does coverage measure test-suite effectiveness?

### 1.1 Inozemtseva & Holmes, ICSE 2014: "Coverage is not strongly correlated with test suite effectiveness" [1]
- **Design.** The authors generated 31,000 test suites for five large Java systems of up to 724,000 LOC (Apache POI, Closure, HSQLDB, JFreeChart, Joda Time). For each system they built 1,000 random suites at each size 3, 10, 30, 100, … test methods. Coverage was measured with CodeCover (statement, decision, modified-condition coverage). Effectiveness was the PIT mutation kill rate, raw and "normalized" by the mutants the suite covers. Mutants that the full suite could not detect were treated as equivalent, which was up to 35 % of mutants.
- **Size ignored.** Kendall τ between coverage and *raw* effectiveness was 0.79–0.95 across projects (Table 4). For *normalized* effectiveness it ranged from −0.35 (HSQLDB) to 0.84 (Table 3).
- **Size controlled.** The correlation "typically ranges from low to moderate." The authors call τ < 0.4 "low" and 0.4–0.7 "moderate." In their words: "it is not generally safe to assume that effectiveness is correlated with coverage." The apparent relationship is "largely due to the fact that high coverage suites contain more test cases."
- **Criteria are interchangeable.** Statement/decision τ = 0.92, decision/MCC τ = 0.91, statement/MCC τ = 0.92. "Stronger forms of coverage do not provide greater insight." This is a direct argument for using cheap line coverage plus something stronger than branch coverage, rather than MC/DC.
- **Recommendation.** Coverage is "useful for identifying under-tested parts of a program," but "should not be used as a quality target." The authors suggest mutation score "may be a good substitute."

### 1.2 Gopinath, Jensen & Groce, ICSE 2014: "Code coverage for suite evaluation by developers" [6]
- **Design.** Hundreds of open-source Maven/Java projects from GitHub. From 1,254 candidates, 729 had tests, and each tool produced results for roughly 250–360 of them (e.g., 259 PIT results with the original suites). Randoop-generated suites gave about 240–330 results per tool. The question is *cross-project* evaluation of a single suite, which is our situation: each PR has one suite.
- **Results (Table 7, p < 0.001).** Mutation kill ratio vs statement coverage: R² = 0.94 and τβ = 0.82 for the original developer suites, and R² = 0.72, τβ = 0.54 for Randoop suites. Branch coverage gave R² = 0.92/τβ = 0.77, and path coverage R² = 0.75/τβ = 0.67.
- **Conclusion.** "Statement (not block, branch, or path) coverage predicts mutation kills best" when evaluating one suite.
- **Reconciling with [1].** Across projects, coverage ranks suites well. Within a project, once suite size is fixed, much of the signal disappears. Chen et al. [7] argue that size control by random sampling is itself flawed (§1.5).

### 1.3 Real faults rather than mutants
- **Kochhar, Thung & Lo, SANER 2015** [36] (abstract). The authors generated Randoop suites with varying coverage and tested them against 67 real bugs (Apache HttpClient) and 92 real bugs (Mozilla Rhino). The correlation between coverage and bug-killing was statistically significant: moderate for HttpClient and strong for Rhino, for both statement and branch coverage.
- **Kochhar, Lo, Lawall & Nagappan, IEEE Trans. Reliability 2017** [37] (abstract). The study covered 100 large open-source Java projects with post-release bug reports, normalized by cyclomatic complexity and LOC. It found that coverage "has an insignificant correlation with the number of bugs that are found after the release of software at the project level, and no such correlation at the file level."
- **Mockus, Nagappan & Dinh-Trong, ESEM 2009** [38] (abstract). Two dissimilar industrial projects. Higher coverage was associated with fewer field-reported problems once adjusted for prerelease changes. Test effort grew exponentially with coverage while the reduction in field problems grew only linearly, so "for most projects the optimal levels of coverage are likely to be well short of 100%." This justifies saturating the coverage utility below 100 % (§6.2).
- **Hemmati, QRS 2015** [39] (abstract). Developer-written fault-revealing tests from five open-source projects. Statement coverage alone was "very weak" and detected only 10 % of the faults. Combining control-flow criteria beat the strongest single criterion (28 % vs 19 %). A def-use criterion could detect 79 % of the faults that went undetected. About 15 % of faults escaped all standard control/data-flow criteria, mostly because of missing specification logic.
- **Niedermayr, Jürgens & Wagner, CSED 2016** [40] (abstract). Extreme mutation found "pseudo-tested" methods: covered, but they would not expose faults if broken. The ratio was acceptable for unit tests but not for system tests, so coverage is a valid effectiveness indicator only for unit tests.

### 1.4 Mutants as a stand-in for real faults
- **Just et al., FSE 2014: "Are mutants a valid substitute for real faults in software testing?"** [4]
  - 357 real faults (Defects4J) in 5 programs totaling 321 KLOC, 230,000 mutants, developer-written and generated suites.
  - A coupling effect exists for **73 %** of real faults. **10 %** need a new or stronger operator, and **17 %** are not coupled to any mutant.
  - There is a statistically significant correlation between mutant detection and real-fault detection, "independently of code coverage." It is stronger than the correlation between statement coverage and real-fault detection.
  - Of 480 triggering tests, 222 increased statement coverage and detected 28 new mutants on average. The 258 that did not detected 2 on average.
  - The operators most often coupled to real faults were **conditional operator replacement, relational operator replacement and statement deletion**. In Stryker.NET these correspond to `logical`, `equality`, and `statement`/`block` [17]. Our mutation profile must keep them on.
- **Papadakis et al., ICSE 2018: "Are mutation scores correlated with real fault detection?"** [24]. The ACM PDF returned 403, so this is summarized via Chen et al. [7] §2.4. The study used 231 real faults (a Defects4J subset) plus four C programs. For each fault it drew 10,000 fixed-size and 10,000 random-size test sets from a pool of developer and EvoSuite/Randoop tests. Correlations between mutant detection and fault detection were "moderate to strong when test set size was ignored" and "negligible to weak when test set size was controlled."

### 1.5 Chen et al., ASE 2020: "Revisiting the relationship between fault detection, test adequacy criteria, and test set size" [7]
- The authors argue that test-set size is "neither a confounding variable … nor an independent variable that should be experimentally manipulated." They call the random-selection, size-stratified design used by [1] and [24] "flawed" and "prone to misleading results."
- Their method: on 231 Defects4J faults, build 100 coverage-adequate and 100 mutation-adequate sets per fault by greedy selection, then compare against equal-size random baselines.
- **Findings.**
  - "Adequacy-based test selection is superior to random selection."
  - "Mutation-based test selection is most effective when employed after coverage has exhausted its usefulness."
  - A hybrid Coverage→Mutation approach gave the highest fault-detection probability at each step. The authors note this mirrors Google's setup.
  - Reducing a suite by mutants mostly preserves fault detection, while reducing it by coverage "see[s] a substantial loss."
  - The number of test methods is "not a reliable measure for test set size."
- **Implication for us.** Gate on coverage first. Then measure mutation on what is covered. Never reward raw test count.

### 1.6 Synthesis for a certifier
1. Low new-code coverage reliably signals that new code is untested, and every study agrees with that direction. Its value as a *ceiling* signal is weak: high coverage says little about assertion quality [1][3][40].
2. Line coverage carries about the same information as branch or MC/DC coverage [1][6], so use line coverage primarily. Sonar's combined line+condition number is fine for compatibility.
3. Mutation score is the best-supported automatic proxy [4][7][21], with known limits: 17 % of faults are uncoupled [4], equivalent and unproductive mutants exist [20], and cost is high.
4. Assertions matter. Zhang & Mesbah [26] show that the number of assertions in a suite strongly correlates with effectiveness and "directly influences" the size-effectiveness relationship.

---

## 2. Industry practice and where the numbers come from

### 2.1 Google: "Code coverage at Google" (Ivanković, Petrović, Just, Fraser; ESEC/FSE 2019) [2]
- **Scale.** Coverage is computed daily for about 1 billion lines across 7 languages [2][41]. By Q1 2018 more than 90 % of projects used automated coverage, even though it is not mandatory [41].
- **Scopes.** *Project coverage* is line coverage, computed daily. *Changelist coverage* comes in two forms: *overall*, over whole files in the CL, and *delta*, defined as "the code coverage of only the lines that were modified or added in a changelist. (Deleted lines no longer exist, and hence cannot be covered.)"
- **Thresholds (Table 2).** These are voluntary: "Google does not enforce any code coverage thresholds across the entire codebase", but "many projects opt-into a centralized voluntary alerting system."

  | Level | Project coverage | Changelist coverage |
  |---|---|---|
  | 1 | automation disabled | |
  | 2 | automation enabled | |
  | 3 | ≥ 60 % | ≥ 70 % |
  | 4 | ≥ 75 % | ≥ 80 % |
  | 5 | ≥ 90 % | ≥ 90 % |

  The authors suspect the gradual rise in project coverage since mid-2016 reflects adoption of these levels. Safety-critical projects use mutation testing.
- **Precondition.** "The coverage infrastructure only computes changelist coverage if all tests for that changelist pass." This is precedent for ordering *tests pass → then coverage*.
- **Survey.** 3,000 developers were invited and 512 responded (17 %).
  - When authoring a CL, 45 % use coverage "Often/Very often" and 25 % "Sometimes."
  - When reviewing, the figures are 40 % and 28 %. 10 % never use coverage.
  - Write-in sentiment: 60 % positive, 24 % neutral, 16 % negative (n = 286).
- **Recommendations.** Measure automatically at critical points in the workflow, display coverage in the tools developers already use, and rely on established coverage libraries.

### 2.2 Google Testing Blog: "Code Coverage Best Practices" (Arguelles, Ivanković, Bender; 7 Aug 2020) [3]
- The tiers are 60 % "acceptable", 75 % "commendable" and 90 % "exemplary." The authors prefer team-chosen targets over top-down mandates.
- **Per-commit:** "per-commit coverage goals of 99% are reasonable, and 90% is a good lower threshold."
- "A high code coverage percentage does not guarantee high quality in the test coverage." Mutation testing is "a better technique to assess whether you're adequately exercising the lines your tests cover."
- "What's not covered is more meaningful than what is covered."

### 2.3 SonarQube "Sonar way" quality gate [11]
- Four conditions, all on new code:
  - no new issues (or A ratings)
  - all new Security Hotspots reviewed
  - **new-code coverage ≥ 80.0 %**
  - new-code duplication ≤ 3.0 %
- **Fudge factor:** "coverage and duplication conditions are ignored until the number of new lines is at least 20." It is enabled by default and can be overridden.
- The docs give **no rationale** for 80 %. A "Sonar way for AI Code" gate exists, but the page I opened doesn't list its conditions **[unverified]**.

### 2.4 Stryker defaults [18]
- `thresholds: { high: 80, low: 60, break: 0 }`. The `break` threshold makes Stryker exit with code 1 when the score falls below it.
- These are tool UI defaults (red/amber/green), **not** empirically derived.

### 2.5 Where each threshold comes from

| Number | Origin | Evidence type |
|---|---|---|
| 80 % new-code coverage | Sonar way default [11]; Google changelist Level 4 [2] | Convention / voluntary industrial practice |
| 90 % per-commit | Google blog "good lower threshold" [3]; Google changelist Level 5 [2] | Practitioner guidance |
| 60/75/90 project coverage | Google tiers [2][3] | Practitioner guidance |
| < 100 % optimum | Mockus et al.: exponential effort vs linear benefit [38] | Industrial empirical (2 projects) |
| 20-line minimum | Sonar fudge factor [11] | Engineering heuristic |
| Mutation 60/80 | Stryker color bands [18] | Tool default |

---

## 3. Differential (patch / new-code) coverage: exact definitions

### 3.1 SonarQube
- **Documented formulas.** The current docs, and the 9.9 and 10.6 versions, give `coverage = (CT + LC)/(B + EL)`, `line_coverage = LC/EL` and `branch_coverage = (CT + CF)/(2·B)` [9]. In these, CT = conditions evaluated true at least once, CF = false at least once, LC = `lines_to_cover − uncovered_lines`, B = total conditions and EL = `lines_to_cover`. A user in a community thread quotes an older docs version as `coverage = (CT + CF + LC)/(2·B + EL)` [13]. A community reply maps `CT + CF` to the API metric `conditions_to_cover` [14].
- **Implementation (authoritative).** In SonarQube's compute engine, `LinesAndConditionsWithUncoveredCounter` [12] is applied to `LINES_TO_COVER`, `CONDITIONS_TO_COVER`, `UNCOVERED_LINES` and `UNCOVERED_CONDITIONS`:
  ```
  elements        = lines_to_cover + conditions_to_cover
  coveredElements = elements − uncovered_lines − uncovered_conditions
  coverage        = coveredElements / elements      (no measure if elements = 0)
  ```
  `conditions_to_cover` counts branch *outcomes*, which is 2·B when each boolean condition has two outcomes. So the implementation equals the classic `(CT+CF+LC)/(2B+EL)`. The docs' `(CT+LC)/(B+EL)` is the same thing if "B" is read as conditions-to-cover. **Use the code's form.**
- **New code.** `new_coverage`, `new_line_coverage` and `new_branch_coverage` use the same formulas restricted to new or updated code [9].
- **Tests.** `test_success_density = (tests − (test_errors + test_failures)) / tests × 100` [9].

### 3.2 Codecov
- `coverage = hits / (hits + partials + misses)`. A *partial* is a line where some branches were not executed, so it counts as not covered [16].
- **Patch status** "only measures lines adjusted in the pull request" [16b]. `target` can be `auto` (base commit) or an exact number, and `threshold` allows a tolerated drop [16b].

### 3.3 diff-cover
- "Diff coverage is the percentage of new or modified lines that are covered by tests." It compares a Cobertura, Clover, JaCoCo or LCov XML report with `git diff`.
- `--compare-branch` defaults to `origin/main`. `--fail-under` gives a non-zero exit code below the threshold.
- Diff lines absent from the coverage report are not scored. `--expand-coverage-report` helps with multi-line statements. Output can be console, HTML, JSON or Markdown [15].
- It works on .NET Cobertura output as-is.

### 3.4 Google "delta coverage" [2]
Coverage of added and modified lines only. Deleted lines are excluded by definition.

### 3.5 Reference algorithm for our Python certifier [design, derived from 3.1–3.4]
```
Input: base SHA, head SHA, Cobertura XML from running the head test suite
1. D = {(path, line)} for '+' lines in `git diff --unified=0 --no-renames base...head -- '*.cs'`
   (post-image line numbers; exclude tests/, benchmark/, sandbox/, *.g.cs, obj/)
2. From Cobertura: for each <class filename=...> resolve path against <sources>;
   for each <line number=n hits=h [branch="True" condition-coverage="x% (c/t)"]>:
      coverable[(path,n)] = (h > 0, c, t)     # c/t = covered/total branch outcomes (0/0 if none)
3. N  = D ∩ keys(coverable)          # coverable new lines; D \ coverable are non-executable → ignored
   EL = |N|;  LC = #{x∈N : hits>0}
   C  = Σ t over N;  CC = Σ c over N
4. line_cov_new     = LC / EL
   sonar_cov_new    = (LC + CC) / (EL + C)
   gate applies iff EL ≥ 20  (Sonar fudge factor)  — or use the Wilson rule (§6.3)
5. Emit the uncovered (path, line) list as evidence (deterministic, sorted).
```
Edge cases to handle deterministically:
- **Path normalization.** The Microsoft collector writes absolute paths. Coverlet writes paths relative to `<sources>`, or SourceLink URLs when `UseSourceLink` is on [19].
- **Multi-targeting.** MessagePack builds several TFMs, so the same line can appear several times. Take the union: a line is covered if any report covers it, as diff-cover does with multiple reports [15].
- **Attribute exclusions.** If the PR *adds* `[ExcludeFromCodeCoverage]` or `GeneratedCode` attributes, the excluded lines leave the denominator. Flag this as a gaming signal (§6.5).
- **Partially covered lines.** Codecov counts them as *not* covered [16]. The Sonar form counts covered outcomes. Report both.

---

## 4. Mutation testing

### 4.1 Google at scale
- **State of Mutation Testing at Google** (Petrović & Ivanković, ICSE-SEIP 2018) [22]. Diff-based, probabilistic mutation that skips uncovered lines and "arid" (uninteresting) nodes. About 6,000 engineers use it, it reaches more than 14,000 code authors through review, and it covers about 30 % of diffs that have coverage.
- **Practical Mutation Testing at Scale: A view from Google** (Petrović, Ivanković, Fraser, Just; arXiv 2102.11378, submitted to IEEE) [20]
  - Covers more than 24,000 developers and more than 1,000 projects. Evaluated on about 17 M mutants and 760,000 changes, with 2 M mutants surfaced in review.
  - Developers initially classified 85 % of reported mutants as unproductive. Suppression heuristics (more than a hundred arid-node rules) raised the productive ratio "from 15% to 89%."
  - Reporting is limited to at most one mutant per line, on lines that are changed and covered.
  - Google computes no global mutation score: it is "infeasibly expensive," and the score "is neither concrete nor actionable, and it does not guide testing."
- **Does mutation testing improve testing practices?** (Petrović, Ivanković, Fraser, Just; ICSE 2021) [21]
  - About 15 M mutants. With more exposure to mutation testing, developers write more tests, and better ones, leaving fewer live mutants.
  - **Mutants are coupled with 70 % (1,043 of 1,502) of high-priority bugs.** Had mutation testing run on the bug-introducing change, it would have reported a fault-coupled live mutant.
- **Takeaways for us.**
  - Mutate only changed and covered lines.
  - Report survivors as concrete evidence.
  - Treat a *diff-level* mutation score as one input to a score rather than as a hard gate.
  - Filter "arid" code (logging, capacity hints, etc.) to avoid penalizing unproductive mutants.

### 4.2 Stryker.NET (C#)
- **Install and run** [25]:
  - Global: `dotnet tool install -g dotnet-stryker`. Or per repo: `dotnet new tool-manifest` then `dotnet tool install dotnet-stryker`.
  - Run from the test project directory with `dotnet stryker`.
  - The docs say it needs **the .NET 10 runtime or newer** to run Stryker itself; the target app can stay on .NET 8.
  - `--project` is required when the test project references more than one project [18]. MessagePack.Tests references several, so use `--project MessagePack.csproj`.
- **Key options** [18]:
  - `mutation-level`: Basic, Standard (default), Advanced or Complete, each including the levels below it.
  - `coverage-analysis`: `perTest` (default, fastest), `perTestInIsolation`, `all`, or `off`.
  - `since`: `--since:<committish>` tests only changed code; `since.target` defaults to `master`.
  - `with-baseline` (experimental) reuses unchanged results. It is mutually exclusive with `since`.
  - `mutate`: globs. `concurrency`: half the logical cores by default. `timeout-ratio`: 1.5, plus `additional-timeout` of 3,000 ms.
  - Reporters include `json`, `html`, `cleartext` and `dashboard`. `thresholds` default to 80/60/0.
- **Mutators** [17]:
  - `arithmetic`, `equality` (relational), `logical`, `boolean`, `assignment`
  - `initializer`, `statement`/`block` removal, `unary`, `update`, `checked`
  - `linq`, `string`, `stringmethod`, `bitwise`, `regex`, `math`
  - `nullcoalescing`, `conditional`, `collectionexpression`
- **Mutant schemata** [42]. All mutants are compiled in, guarded by a runtime switch (an `ActiveMutation` check). Mutants that fail to compile are rolled back and marked as build errors, which usually takes "1-3 retries." Constants such as enum initializers cannot be mutated.
- **States and formulas** [8]:
  - `Detected = Killed + Timeout`
  - `Undetected = Survived + NoCoverage`
  - `Covered = Detected + Survived`
  - `Valid = Detected + Undetected`
  - `Invalid = CompileError + RuntimeError`
  - **Mutation score = Detected / Valid × 100**
  - Score on covered code = Detected / Covered × 100
  - Ignored and Pending mutants don't count.
- **Report schema** [43]. JSON with `files{path → {language, source, mutants[]}}`. Each mutant has `id`, `mutatorName`, `location.start/end{line,column}` (start inclusive, end exclusive), `status` ∈ {Killed, Survived, NoCoverage, CompileError, RuntimeError, Timeout, Ignored, Pending}, plus `coveredBy`, `killedBy` and `replacement`. **Filter mutants to diff lines** with `location.start.line ∈ D(path)`. That gives a line-level diff mutation score, whereas `--since` works on changed files.
- **Runtime.** The Stryker docs I opened give **no runtime figures** **[unverified]**. Cost scales with the number of mutants × the tests covering each mutant ÷ concurrency (perTest analysis), plus one build and an initial test run. Recommendations **[design]**:
  - Restrict with `--since:<base>` or `--mutate` globs set to the changed files, then filter to diff lines.
  - Put a wall-clock cap on the run (e.g., 10–15 min per branch).
  - If more than M mutants remain, sample uniformly with a seed derived from the head SHA. Report the score with a Wilson CI (§6.3), in the spirit of Google's probabilistic selection [20][22].

### 4.3 Why mutation and coverage go together
Chen et al. [7] found that the best fault-detection probability comes from *coverage first, mutation after coverage is exhausted*. Google uses the same pipeline: mutants only on covered changed lines [20]. A mutant on an uncovered line is `NoCoverage`, so it double-counts the coverage deficit. That suggests also reporting **Detected / Covered**, the mutation score on covered code [8], so the two dimensions stay separate.

---

## 5. Test-code quality (static, deterministic)

### 5.1 Assertions
- **Zhang & Mesbah, ESEC/FSE 2015** [26]. 6,700 suites and 24,000 assertions from 5 Java projects. "The number of assertions in a test suite strongly correlates with its effectiveness, and this factor directly influences the relationship between test suite size and effectiveness." Assertion coverage also correlates strongly, and assertion *type* matters.
- **Kudrjavets, Nagappan & Ball, ISSRE 2006**, on production-code assertion density vs faults at Microsoft. I could not open the paper or verify its DOI or numbers. It is commonly cited for a negative correlation between assertion density and fault density **[unverified]**. Note it concerns *production* asserts, not test asserts.
- **Metric [design].** For each new or modified test method, count assertion calls: xUnit `Assert.*`, FluentAssertions `.Should()`, `Assert.Throws*`, NUnit `Assert.That`, Shouldly `Should*`. Then compute (a) the fraction of test methods with at least 1 assertion (absence = the tsDetect "Unknown Test" smell [28]) and (b) assertions per test method. Don't reward density beyond a cap, because it is size-confounded [1][7].

### 5.2 Test smells
- **Catalogue.** Smells catalogued in testsmells.org / tsDetect [28]:
  - Assertion Roulette, Conditional Test Logic, Constructor Initialization, Default Test
  - Duplicate Assert, Eager Test, Empty Test, Exception Handling
  - General Fixture, Ignored Test, Lazy Test, Magic Number Test
  - Mystery Guest, Redundant Print, Redundant Assertion, Resource Optimism
  - Sensitive Equality, Sleepy Test, Unknown Test
- **Origins.** Several smells (Mystery Guest, General Fixture, Eager Test, Assertion Roulette, Sensitive Equality, Resource Optimism, …) come from van Deursen, Moonen, van den Bergh & Kok, "Refactoring Test Code," XP 2001 **[unverified; not opened]**.
- **tsDetect** (Peruma et al., ESEC/FSE 2020 demo) [29]. Rule-based detection for Java with 96 % average precision and 97 % recall on 65 test files covering 19 smell types. Our certifier needs a C#/xUnit port of these rules, buildable on tree-sitter or Roslyn syntax.
- **Spadini, Palomba, Zaidman, Bruntink & Bacchelli, ICSME 2018** [27] (abstract). 221 releases of ten systems, more than 1 M test cases, six smells.
  - (i) Tests with smells are more change- and defect-prone.
  - (ii) Indirect Testing, Eager Test and Assertion Roulette are the most significant for change-proneness.
  - (iii) "Production code is more defect-prone when tested by smelly tests."
  - The PDF was bot-protected, so I have no effect sizes.
- **Smells cheap to detect deterministically in xUnit** **[design]**. These need only syntax and have unambiguous semantics:

  | Smell | Detection rule |
  |---|---|
  | Empty Test | `[Fact]`/`[Theory]` with an empty body |
  | Unknown Test | no assertion call and no `Assert.Throws` |
  | Ignored Test | `[Fact(Skip = …)]` / `[Theory(Skip = …)]` |
  | Sleepy Test | `Thread.Sleep` / `Task.Delay` in a test body |
  | Redundant Print | `Console.Write*` in a test body |
  | Conditional Test Logic | `if`/`switch`/`for`/`foreach`/`while` in a test body |
  | Exception Handling | `try`/`catch` instead of `Assert.Throws` |
  | Duplicate Assert | identical assertion text twice in one method |
  | Sensitive Equality | `.ToString()` inside an `Assert.Equal` argument |
  | Redundant Assertion | `Assert.True(true)`, `Assert.Equal(x, x)` |

### 5.3 Test-to-code traceability and co-change
- **Van Rompaey & Demeyer, CSMR 2009** [30] (abstract). Evaluated six strategies: naming conventions, static call graph, last-call-before-assert (LCBA), lexical analysis, co-evolution/version-log mining, and others. "Test conventions yield highly accurate results"; without them, LCBA "appears as a valuable alternative."
- **White, Krinke & Tan, ICSE 2020 (TCtracer)** [44]. An ensemble of NC, NCC (name-contains), LCS-B/U, Levenshtein, LCBA, Tarantula and TF-IDF. It reached test-to-function MAP 78 % and test-class-to-class MAP 93 % on four open-source systems.
- **Metric [design].**
  - For each production type with changed lines, check whether there is a test class named `<Type>Tests`/`<Type>Test`, or test code that references the type name (NC/NCC static match).
  - Report `trace_ratio = linked_changed_types / changed_types`.
  - Also report binary *co-change*: did the PR touch test files when it touched production logic?
- **Test-to-code ratio** (test LOC / production LOC). I found **no verified evidence** linking it to defects. Report it as context only; don't score it.

### 5.4 Fail-to-pass verification (strong, deterministic, AI-specific) [design]
SWE-bench defines `FAIL_TO_PASS` as tests "resolved by the PR" and `PASS_TO_PASS` as tests "that should pass before and after the PR application" [31]. For an agent PR that adds tests, run the *new tests against the base revision* with production code from base and tests from head. If a new test also passes on base, it does not verify the change. Report `f2p_ratio = new_tests_failing_on_base / new_tests`. This check is cheap: one extra test run filtered to new test IDs. It directly targets tautological or "always-green" tests written by agents.

---

## 6. Scoring 0–100 and gating

### 6.1 Blockers (gate FAIL, Tests score = 0) [design, anchored in 2.1/3.1]
1. Any test that passes on base and fails on head (a regression, i.e., a `PASS_TO_PASS` violation) [31].
2. Any failing test among tests added or modified by the PR.
3. The build or test run fails, or coverage cannot be produced. Google likewise computes CL coverage only when all tests pass [2].

Pre-existing failures on base, and categories the repo itself filters, are excluded. MessagePack CI runs `dotnet test --filter "TestCategory!=FailsInCloudTest"` (`corpus/messagepack-csharp/azure-pipelines/dotnet-test-cloud.ps1`, local file).

Flakiness **[design]**: re-run failing tests once. A test that fails then passes is labeled *flaky* and reported, not blocked.

### 6.2 Utility functions (monotone, piecewise linear, deterministic) [design]
- **Coverage utility.** Anchored at Google's changelist levels 70/80/90 [2]. It saturates at 90 %, in line with Google's per-commit "good lower threshold" [3] and diminishing returns [38]:
  ```
  U_cov(c) = 0                     c ≤ 0.50
           = 50·(c−0.50)/0.20      0.50 < c ≤ 0.70      (→ 50 at Level-3)
           = 50 + 25·(c−0.70)/0.10 0.70 < c ≤ 0.80      (→ 75 at Level-4 / Sonar gate)
           = 75 + 25·(c−0.80)/0.10 0.80 < c ≤ 0.90      (→ 100 at Level-5)
           = 100                   c > 0.90
  ```
  Here `c` is the line coverage of new code, or the shrunk estimate from §6.3.
- **Mutation utility.** Anchored at Stryker's 60/80 bands [18]. These are tool defaults, so recalibrate on the corpus:
  ```
  U_mut(m) = clamp( 50·(m−0.40)/0.20 , 0, 50 )        for m ≤ 0.60
           = 50 + 50·(m−0.60)/0.20 (cap 100)          for m > 0.60
  ```
  Here `m` is the diff-line mutation score [8][43], or Detected/Covered if coverage is already penalized separately.
- **Hygiene.**
  ```
  H = 100·(0.40·A + 0.30·S + 0.30·R)
  ```
  - A = share of new or modified test methods with at least 1 assertion [26][28]
  - S = 1 − min(1, smells / tests_touched) [27][28]
  - R = trace_ratio, or f2p_ratio when the PR adds tests [30][31]
- **Tests dimension.**
  ```
  T = 0                                        if any blocker
  T = 0.40·U_cov + 0.35·U_mut + 0.25·H         if mutation ran
  T = 0.60·U_cov + 0.40·H  (flag "effectiveness unmeasured")  otherwise
  ```
  No new test code and no new production code → coverage is N/A; renormalize the weights.

### 6.3 Statistical treatment of "≥ 80 %"
Coverage of the PR's lines is a *census*, so there is no sampling error in the observed fraction. A CI is still meaningful for the claim "this author's or agent's change is tested at ≥ 80 %." That treats the change's coverable lines as n Bernoulli trials of a testing propensity p. This is a modeling assumption: lines cluster within methods, so the effective n is smaller and the CI is optimistic. Unit = changed method is a conservative alternative **[design]**.
- **Interval choice.** Brown, Cai & DasGupta [33] show that the Wald interval's erratic coverage is "more persistent than commonly appreciated." They recommend Wilson or Jeffreys for small n, and Agresti–Coull for larger n.
- **Wilson score interval** [34], with p̂ = k/n and z = 1.645 (one-sided 95 %) or 1.96 (two-sided):
  ```
  center = (p̂ + z²/(2n)) / (1 + z²/n)
  half   = z·sqrt(p̂(1−p̂)/n + z²/(4n²)) / (1 + z²/n)
  ```
  Clopper–Pearson exact [34]: lower bound = Beta quantile B(α; k, n−k+1), which is α^{1/n} when k = n. Ranking by the Wilson lower bound to handle small samples is a well-known practitioner pattern [35].
- **Computed values** (my calculation with the formula above):

  | n new coverable lines | p̂ | Wilson LB (1-sided 95 %) | Wilson LB (2-sided 95 %) |
  |---|---|---|---|
  | 5 | 4/5 = 0.80 | 0.435 | 0.376 |
  | 5 | 5/5 = 1.00 | 0.649 | 0.566 |
  | 10 | 8/10 = 0.80 | 0.541 | 0.490 |
  | 20 | 16/20 = 0.80 | 0.622 | 0.584 |
  | 20 | 20/20 = 1.00 | 0.881 | 0.839 |
  | 50 | 40/50 = 0.80 | 0.693 | 0.670 |
  | 100 | 80/100 = 0.80 | 0.727 | 0.711 |
  | 100 | 90/100 = 0.90 | 0.840 | 0.826 |
  | 500 | 400/500 = 0.80 | 0.769 | 0.763 |

  - Even 100 % covered needs **n ≥ 11** (one-sided) or **n ≥ 16** (two-sided) lines before LB ≥ 0.80. Clopper–Pearson one-sided needs n ≥ 14.
  - Requiring LB ≥ 0.80 at n = 100 means p̂ ≥ 0.87, so a "lower bound ≥ 80 %" gate is *much* stricter than Sonar's point-estimate gate.
- **Recommended 3-valued gate [design].** It replaces the arbitrary 20-line fudge factor with an error-rate-controlled rule.
  - **FAIL** if the one-sided 95 % Wilson *upper* bound < 0.80, i.e., significant evidence that coverage is below 80 %. This means FAIL at n=5 if k ≤ 2, at n=10 if k ≤ 5, at n=20 if k ≤ 13 (p̂ ≤ 0.65), at n=50 if k ≤ 35 (p̂ ≤ 0.70), and at n=100 if k ≤ 73.
  - **PASS** if p̂ ≥ 0.80, which matches Sonar.
  - **INCONCLUSIVE**, otherwise: small change with p̂ < 0.80 but not significantly so. Report it, don't block, and lower the score.
- **For the score**, use a shrunk estimate rather than the LB, so tiny PRs aren't over-punished: `c̃ = (k + m·p₀)/(n + m)`. This is a Beta prior centered on the repo's base coverage p₀ with m pseudo-lines, e.g., m = 10 **[design]**. Report p̂, the Wilson interval and c̃ together.
- **Mutation score sampling** uses the same machinery when mutants are subsampled. Use a seeded uniform sample and give the Wilson CI on Detected/Valid.

### 6.4 Determinism checklist
- Pin the SDK (MessagePack `global.json` = 8.0.402, rollForward patch), and pin the tool versions (coverlet or Microsoft.CodeCoverage, Stryker, ReportGenerator) in `dotnet-tools.json`.
- Use one coverage engine for base and head.
- Fix the TFM set and filters.
- Seed any sampling from the SHA.
- Sort all evidence lists.
- Turn on coverlet `DeterministicReport` when using deterministic builds [19].

### 6.5 Anti-gaming signals specific to agent PRs [design]
Each of these is cheap and syntactic. Each lowers H or becomes a blocker if the team prefers:
- New `[ExcludeFromCodeCoverage]`, `[GeneratedCode]` or `#pragma` coverage exclusions on changed code. These shrink the denominator.
- New `Skip=` attributes on tests, and deleted test methods or test files.
- New tests without assertions, or `Assert.True(true)`.
- New tests that pass on base: f2p failure (§5.4).
- Edits to the `.runsettings` or coverage filter.

---

## 7. .NET tooling: what to run for MessagePack-CSharp

### 7.1 Coverage engines
- **coverlet.collector (VSTest data collector).** `dotnet test --collect:"XPlat Code Coverage"` writes `TestResults/<guid>/coverage.cobertura.xml`. The GUID folder is unpredictable, so use `--results-directory` and glob.
  - Runsettings options: `Format`, `Include`/`Exclude` (`[Assembly]Type` filters), `ExcludeByAttribute`, `ExcludeByFile`, `SingleHit`, `UseSourceLink`, `IncludeTestAssembly`, `SkipAutoProps`, `DeterministicReport`.
  - **No threshold validation** in the collector [19].
  - It is the default in the xUnit template [45].
  - It is not compatible with Microsoft.Testing.Platform v2 [19][46].
- **coverlet.msbuild.** `dotnet test /p:CollectCoverage=true /p:CoverletOutputFormat=cobertura` [45].
  - `/p:Threshold=80 /p:ThresholdType=line|branch|method /p:ThresholdStat=Minimum|Total|Average`.
  - Formats: json (default), lcov, opencover, cobertura, teamcity.
  - Also `/p:ExcludeByAttribute`, `/p:ExcludeByFile`, `/p:MergeWith` and `/p:SkipAutoProps` [47].
  - The collector is generally preferred over msbuild because it instruments within the VSTest process lifecycle. That reason is **[unverified]** in the pages I opened; the README marks the collector as the template default [46].
- **coverlet.console.** `coverlet <test.dll> --target "dotnet" --targetargs "test <proj> --no-build"` [46].
- **Microsoft code coverage.** `dotnet test --collect "Code Coverage;Format=cobertura"`. This is what MessagePack's own CI uses, with `--settings test.runsettings --blame-hang-timeout 60s --blame-crash` (local file `azure-pipelines/dotnet-test-cloud.ps1`). The team's `corpus/dotnet/_lab/lab.runsettings` already derives from it, with product assemblies only and test assemblies excluded.
- **dotnet-coverage.** `dotnet tool install --global dotnet-coverage`. Commands: `collect`, `merge`, `connect`, `snapshot`, `shutdown`, `instrument`, `uninstrument`. Formats: `coverage`, `xml`, `cobertura` [48].
  - `dotnet-coverage merge -o merged.cobertura.xml -f cobertura **\*.coverage` merges the per-project and per-TFM GUID folders [48].
- **MTP mode.** `dotnet test --coverage --coverage-output-format cobertura` with `Microsoft.Testing.Extensions.CodeCoverage` and the global.json `"test": {"runner": "Microsoft.Testing.Platform"}` setting [45]. Not needed for MessagePack, which uses xunit 2.9.2 on VSTest (`Directory.Packages.props`, local).

### 7.2 Reports and diffs
- **ReportGenerator** [49]. `dotnet tool install -g dotnet-reportgenerator-globaltool`, then `reportgenerator -reports:<cobertura> -targetdir:<dir> -reporttypes:Html;Cobertura;JsonSummary;MarkdownSummary`.
  - Inputs include Cobertura, OpenCover, dotCover, Visual Studio, lcov and JaCoCo.
  - `-historydir` tracks coverage over time, and the `TextDeltaSummary`/`MarkdownDeltaSummary` reports cover deltas.
  - Its delta reports compare *reports*, not diff lines, so they are not patch coverage.
- **Patch coverage for .NET.**
  - `diff-cover coverage.cobertura.xml --compare-branch=<base> --fail-under=80 --format json:diff.json` works directly on Cobertura [15].
  - Or implement §3.5 in our Python (about 100 lines, no dependencies beyond `xml.etree` and `git`). That is preferable, because it lets us output Sonar-form and line-form coverage plus Wilson statistics.
  - Codecov's patch status is the hosted equivalent [16b]. MessagePack CI already publishes to codecov.io (`azure-pipelines/dotnet.yml`, local).

### 7.3 Suggested pipeline per branch [design]
```
for rev in (base, head):
  dotnet build -c Release
  dotnet test --no-build -c Release --filter "TestCategory!=FailsInCloudTest" \
      --settings corpus/dotnet/_lab/lab.runsettings --results-directory out/<rev>/tr \
      --logger "trx;LogFileName=tests.trx"
  dotnet-coverage merge -o out/<rev>/cov.cobertura.xml -f cobertura out/<rev>/tr/**/*.cobertura.xml   # or union in Python
python qlab/tests.py:  TRX diff (base vs head) → blockers;  git diff ∩ Cobertura → cov_new, Wilson;
                       new tests on base → f2p;  static xUnit smell scan → H
optional: cd tests/MessagePack.Tests && dotnet stryker --project MessagePack.csproj \
          --since:<base> --reporter json --coverage-analysis perTest   → filter mutants to diff lines → MS_diff
```
TRX gives per-test outcomes for the base/head comparison. The `--logger trx` flag is standard VSTest, but I did not open its doc page in this session **[unverified detail]**.

---

## 8. Open points and caveats
- The **80 %** gate is convention, not science. Present it as "Sonar way default and Google Level 4 changelist threshold" [2][11], not as an optimum. If the gate must be defended scientifically, the defensible claim is directional: "below roughly 70–80 %, new code is demonstrably under-exercised" [1][2][3]. Pair it with mutation for effectiveness.
- Mutation on MessagePack may be slow: large test projects, multiple TFMs, and source-generator tests. Measure the runtime on one PR branch before committing to it as a scored metric. If it is too slow, sample mutants with a seed and report a CI.
- Unopened or unverified sources: the Papadakis 2018 PDF (summarized via [7]), the Kudrjavets 2006 paper, the van Deursen 2001 paper, and the Spadini 2018 and Kochhar 2015/2017 full texts (only abstracts used). There are also no Stryker.NET runtime benchmarks and no "Sonar way for AI Code" conditions.

---

## References
1. Inozemtseva, L., Holmes, R. *Coverage Is Not Strongly Correlated with Test Suite Effectiveness.* ICSE 2014. PDF: https://cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf (DOI 10.1145/2568225.2568271)
2. Ivanković, M., Petrović, G., Just, R., Fraser, G. *Code Coverage at Google.* ESEC/FSE 2019, pp. 955–963. DOI 10.1145/3338906.3340459. PDF: https://storage.googleapis.com/gweb-research2023-media/pubtools/5172.pdf ; page: https://research.google/pubs/code-coverage-at-google/
3. Arguelles, C., Ivanković, M., Bender, A. *Code Coverage Best Practices.* Google Testing Blog, 7 Aug 2020. https://testing.googleblog.com/2020/08/code-coverage-best-practices.html (text read via the blog's Atom feed https://testing.googleblog.com/feeds/posts/default/-/Marko%20Ivankovi%C4%87)
4. Just, R., Jalali, D., Inozemtseva, L., Ernst, M. D., Holmes, R., Fraser, G. *Are Mutants a Valid Substitute for Real Faults in Software Testing?* FSE 2014, pp. 654–665. PDF: https://cs.ubc.ca/~rtholmes/papers/fse_2014_just.pdf (DOI 10.1145/2635868.2635929)
5. (see [36]–[40] for the real-fault and industrial studies)
6. Gopinath, R., Jensen, C., Groce, A. *Code Coverage for Suite Evaluation by Developers.* ICSE 2014. DOI 10.1145/2568225.2568278. PDF: https://rahul.gopinath.org/resources/icse2014/gopinath2014code.pdf
7. Chen, Y. T., Gopinath, R., Tadakamalla, A., Ernst, M. D., Holmes, R., Fraser, G., Ammann, P., Just, R. *Revisiting the Relationship Between Fault Detection, Test Adequacy Criteria, and Test Set Size.* ASE 2020. DOI 10.1145/3324884.3416667. PDF (figshare): https://api.figshare.com/v2/articles/24613371 → https://ndownloader.figshare.com/files/43247703
8. Stryker Mutator. *Mutant states and metrics.* https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/
9. SonarSource. *Metrics definition* (SonarQube Server, latest; also 10.6 and 9.9). https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-metrics/metrics-definition/ ; https://docs.sonarsource.com/sonarqube-server/10.6/user-guide/code-metrics/metrics-definition ; https://docs.sonarsource.com/sonarqube/9.9/user-guide/metric-definitions/
10. Same as [9] (unit test metrics, `test_success_density`).
11. SonarSource. *Introduction to quality gates* (SonarQube Server 2025.4). https://docs.sonarsource.com/sonarqube-server/2025.4/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates
12. SonarQube source code: `LinesAndConditionsWithUncoveredCounter.java`, `LinesAndConditionsWithUncoveredFormula.java`, `CoverageMeasuresStep.java`. https://raw.githubusercontent.com/SonarSource/sonarqube/master/server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/formula/coverage/LinesAndConditionsWithUncoveredCounter.java ; https://raw.githubusercontent.com/SonarSource/sonarqube/master/server/sonar-ce-task-projectanalysis/src/main/java/org/sonar/ce/task/projectanalysis/step/CoverageMeasuresStep.java
13. Sonar Community. *How coverage metrics is calculated* (quotes `(CT + CF + LC)/(2*B + EL)`). https://community.sonarsource.com/t/how-coverage-metrics-is-calculated/63335
14. Sonar Community. *Coverage metric definition details questions.* https://community.sonarsource.com/t/coverage-metric-definition-details-questions/133252
15. diff-cover README. https://raw.githubusercontent.com/Bachmann1234/diff_cover/main/README.rst
16. Codecov. *About code coverage.* https://docs.codecov.com/docs/about-code-coverage
16b. Codecov. *Commit status.* https://docs.codecov.com/docs/commit-status
17. Stryker.NET. *Mutations.* https://stryker-mutator.io/docs/stryker-net/mutations/
18. Stryker.NET. *Configuration.* https://stryker-mutator.io/docs/stryker-net/configuration/
19. Coverlet. *VSTest integration.* https://raw.githubusercontent.com/coverlet-coverage/coverlet/master/Documentation/VSTestIntegration.md
20. Petrović, G., Ivanković, M., Fraser, G., Just, R. *Practical Mutation Testing at Scale: A view from Google.* arXiv:2102.11378. https://arxiv.org/abs/2102.11378
21. Petrović, G., Ivanković, M., Fraser, G., Just, R. *Does mutation testing improve testing practices?* ICSE 2021. arXiv:2103.07189. https://arxiv.org/abs/2103.07189
22. Petrović, G., Ivanković, M. *State of Mutation Testing at Google.* ICSE-SEIP 2018. https://research.google/pubs/state-of-mutation-testing-at-google/
23. (see [20]–[22])
24. Papadakis, M., Shin, D., Yoo, S., Bae, D.-H. *Are Mutation Scores Correlated with Real Fault Detection? A Large Scale Empirical Study on the Relationship Between Mutants and Real Faults.* ICSE 2018. DOI 10.1145/3180155.3180183 (metadata: https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/3180155.3180183). Findings taken from the summary in [7] §2.4.
25. Stryker.NET. *Getting started.* https://stryker-mutator.io/docs/stryker-net/getting-started/
26. Zhang, Y., Mesbah, A. *Assertions Are Strongly Correlated with Test Suite Effectiveness.* ESEC/FSE 2015, pp. 214–224. DOI 10.1145/2786805.2786858 (abstract via https://api.openalex.org/works/doi:10.1145/2786805.2786858)
27. Spadini, D., Palomba, F., Zaidman, A., Bruntink, M., Bacchelli, A. *On the Relation of Test Smells to Software Code Quality.* ICSME 2018. DOI 10.1109/ICSME.2018.00010 (abstract via https://api.openalex.org/works/doi:10.1109/ICSME.2018.00010)
28. Test smells catalogue (tsDetect project). https://testsmells.org/pages/testsmells.html
29. Peruma, A., Almalki, K., Newman, C. D., Mkaouer, M. W., Ouni, A., Palomba, F. *tsDetect: An Open Source Test Smells Detection Tool.* ESEC/FSE 2020 (demo). DOI 10.1145/3368089.3417921 (abstract via https://api.openalex.org/works/doi:10.1145/3368089.3417921)
30. Van Rompaey, B., Demeyer, S. *Establishing Traceability Links between Unit Test Cases and Units under Test.* CSMR 2009, pp. 209–218. DOI 10.1109/CSMR.2009.39 (abstract via https://api.openalex.org/works/doi:10.1109/CSMR.2009.39)
31. SWE-bench dataset card (FAIL_TO_PASS / PASS_TO_PASS definitions). https://huggingface.co/datasets/princeton-nlp/SWE-bench
32. (reserved)
33. Brown, L. D., Cai, T. T., DasGupta, A. *Interval Estimation for a Binomial Proportion.* Statistical Science 16(2):101–133, 2001. DOI 10.1214/ss/1009213286 (abstract via https://api.openalex.org/works/doi:10.1214/ss/1009213286)
34. Wikipedia. *Binomial proportion confidence interval* (Wilson 1927 score interval; Clopper–Pearson). https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval
35. Miller, E. *How Not To Sort By Average Rating* (Wilson lower bound for small samples). https://www.evanmiller.org/how-not-to-sort-by-average-rating.html
36. Kochhar, P. S., Thung, F., Lo, D. *Code coverage and test suite effectiveness: Empirical study with real bugs in large systems.* SANER 2015. DOI 10.1109/SANER.2015.7081877 (abstract via https://api.openalex.org/works/doi:10.1109/SANER.2015.7081877)
37. Kochhar, P. S., Lo, D., Lawall, J., Nagappan, N. *Code Coverage and Postrelease Defects: A Large-Scale Study on Open Source Projects.* IEEE Transactions on Reliability, 2017. DOI 10.1109/TR.2017.2727062 (abstract via https://api.openalex.org/works/doi:10.1109/TR.2017.2727062)
38. Mockus, A., Nagappan, N., Dinh-Trong, T. T. *Test coverage and post-verification defects: A multiple case study.* ESEM 2009. DOI 10.1109/ESEM.2009.5315981 (abstract via https://api.openalex.org/works/doi:10.1109/ESEM.2009.5315981)
39. Hemmati, H. *How Effective Are Code Coverage Criteria?* QRS 2015, pp. 151–156. DOI 10.1109/QRS.2015.30 (abstract via https://api.openalex.org/works/doi:10.1109/QRS.2015.30)
40. Niedermayr, R., Jürgens, E., Wagner, S. *Will My Tests Tell Me If I Break This Code?* CSED 2016. arXiv:1611.07163. https://arxiv.org/abs/1611.07163
41. IEEE Spectrum. *Q&A: How Google Implements Code Coverage at Massive Scale.* https://spectrum.ieee.org/tech-talk/computing/software/qa-how-google-implements-code-coverage-at-massive-scale
42. Stryker.NET. *Mutant schemata* (technical reference). https://stryker-mutator.io/docs/stryker-net/technical-reference/mutant-schemata/
43. Stryker mutation-testing-elements. *Mutation testing report JSON schema.* https://raw.githubusercontent.com/stryker-mutator/mutation-testing-elements/master/packages/report-schema/src/mutation-testing-report-schema.json
44. White, R., Krinke, J., Tan, R. R. *Establishing Multilevel Test-to-Code Traceability Links.* ICSE 2020. DOI 10.1145/3377811.3380921. Submitted version: https://discovery.ucl.ac.uk/10091100/1/icse20.pdf
45. Microsoft Learn. *Use code coverage for unit testing (.NET).* https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-code-coverage
46. Coverlet README. https://raw.githubusercontent.com/coverlet-coverage/coverlet/master/README.md
47. Coverlet. *MSBuild integration.* https://raw.githubusercontent.com/coverlet-coverage/coverlet/master/Documentation/MSBuildIntegration.md
48. Microsoft Learn. *dotnet-coverage code coverage tool.* https://learn.microsoft.com/en-us/dotnet/core/additional-tools/dotnet-coverage
49. ReportGenerator README. https://raw.githubusercontent.com/danielpalme/ReportGenerator/main/README.md

Local files consulted (MessagePack-CSharp checkout in this worktree):
- `corpus/messagepack-csharp/azure-pipelines/dotnet-test-cloud.ps1`: CI test command, Microsoft collector with Cobertura, `FailsInCloudTest` filter
- `corpus/messagepack-csharp/global.json`: SDK 8.0.402
- `corpus/messagepack-csharp/Directory.Packages.props`: xunit 2.9.2
- `corpus/dotnet/_lab/lab.runsettings`: the team's derived coverage settings
