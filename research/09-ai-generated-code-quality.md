# 09 — Quality problems specific to AI-generated code, and the static metrics that catch them

Research date: 2026-11-14. Scope: what the evidence says goes wrong in LLM- and agent-written code (Copilot, ChatGPT, Cursor, Claude Code, Codex, Devin…). For each problem, the static metric that detects it and could be built for C# with Python + tree-sitter and no LLM. The target is MessagePack-CSharp plus 4 agent-written PR branches.

Verification policy: every number below comes from a primary source I opened (arXiv abstract or HTML, vendor report page, official blog), unless it is marked **[secondary]** (press coverage of a primary report I could not open in full) or **[unverified]**. Reference numbers like [7] point to the list at the end. Note: the shared web-search budget ran out near the end of this research, so a few side items (Uplevel, Stack Overflow survey) were not re-checked and are marked.

---

## 0. TL;DR

1. **Maintainability, not correctness, is where AI code fails most.** Three independent large analyses find that code smells make up about 89–90% of all static-analysis issues in AI code. Sonar: >90% for every model [36]. Liu et al. 2026: 89.3% of 484,366 issues in 302.6k AI commits [7]. Cynthia et al.: 89.0% of issues in merged agent bug-fix PRs [8]. Passing tests is not enough: 45% of ChatGPT programs that passed all tests still had style or maintainability issues [21], and in C# correctness vs static quality correlate at only r = 0.075 [35].
2. **The strongest AI-specific signal is duplication and ignored reuse.** GitClear tracks this across 153M, then 211M, then 623M changed lines. Copy/paste rose and "moved" (refactored) code collapsed. In 2024, copy/pasted lines exceeded moved lines for the first time [1][2][3][4]. Agent PRs show 1.87× the semantic redundancy of human PRs [9].
3. **Complexity piles up at project level.** Snippet studies often find AI code *simpler*, but quasi-experiments on real repositories disagree. After Cursor adoption, cognitive complexity rose 40.7% and SonarQube warnings 29.7% [5]. For autonomous agents the figures are about +39% complexity and about +18% warnings [6]. The complexity increase predicts later velocity slowdown [5].
4. **Error masking and unused code are the most frequent concrete rule hits** in AI commits. Broad exception handling is the #1 rule (8.5% of all issues). Unused variables, parameters, arguments and imports together are a large share [7]. GitClear reports "error-masking constructs" up 47% [4]. CodeRabbit finds error-handling issues about 2× more often in AI PRs [37].
5. **Agent PRs are larger and multi-purpose.** 39.9% of Claude Code PRs bundle several purposes vs 12.2% of human PRs [10]. Average PR size is up 154% on high-AI-adoption teams [41]. PRs that are not merged are larger [13]. Issue counts scale with PR size, so **normalize every metric by changed LOC** [8].
6. **Merge ≠ quality, and reviewers are lenient.** Merge success does not reflect post-merge quality [8]. Reviewers react more neutrally or positively to redundant AI PRs [9]. In a GitHub RCT, Copilot code was 5% more likely to be approved [40]. 22.7% of AI-introduced issues still exist at the latest revision [7]. This is the "earned trust" argument: review needs objective metrics because human judgment is being anchored.

---

## 1. Ranked list: AI-specific risk → measurable static metric (C#, tree-sitter) → evidence

Ranking criteria, each scored ★ to ★★★:
- **E**: evidence strength (independent sources, size, effect)
- **S**: AI-specificity (does it separate AI from human code, or only describe AI code?)
- **M**: measurability with tree-sitter alone (no compiler, no LLM)

| # | AI-specific risk | Static metric(s) to implement (C#) | Key evidence (numbers + ref) | E | S | M |
|---|---|---|---|---|---|---|
| 1 | **Duplication / copy-paste instead of reuse** ("more code, less reuse") | (a) Duplicated-line density of *added* code: token-normalized clone blocks of ≥5 consecutive meaningful lines (GitClear's block definition [4]). (b) **New-vs-existing clones**: added code that duplicates code already on the base branch (reuse ignored). (c) Within-PR copy/paste. (d) Connectivity: calls into existing repo methods per KLOC added (GitClear "function connectivity" [4]) | Copy/paste share 8.26% (2020) → 10.49% (2023), moved 24.99% → 16.92% [1]. Cloned lines 8.3% → 12.3%; moved fell from 25% (2021) to <10% (2024) [2]. Blocks with ≥5 duplicated lines up 8× in 2024; moved lines −39.9%; 2024 first year copy/paste > moved [3, secondary]. 2023 → 2026 YTD: block duplication 40.3 → 73.0 (+81%), within-commit copy/paste +41%, moved 13% → 3.8%, connectivity 343 → 223 calls/kLOC (−35%) [4]. Agent PRs: avg max redundancy 0.2867 vs 0.1532 for humans (≈1.87×, p<0.001) [9]. AI code "more repetitive" in 500k samples [23]. Repetition is "pervasive" across 19 code LLMs at character, statement and block level [28]. Duplicate code among top smells of generated code [19]. **Counter:** duplicate-line density effect after Cursor adoption *not significant* [5] | ★★★ | ★★★ | ★★★ |
| 2 | **Complexity accumulation** (bigger, deeper methods; refactors that add branches) | Cognitive complexity per method (SonarSource definition, rule S3776) and **delta vs base**. Cyclomatic complexity. Max nesting depth. NPath (flagged in ChatGPT Java [21]). Share of methods over threshold | Cursor adoption: cognitive complexity +40.7%, warnings +29.7% (807 treated vs 1,380 control repos). A 100% complexity increase goes with −64.5% lines added later [5]. Agents: about +39% cognitive complexity, about +18% warnings [6]. S3776 (cognitive complexity) is the #2 rule in merged agent bug-fix PRs (157 hits) [8]. Agent "readability" commits: MI decreased in 56.1%, CC increased in 42.7% [16]. GPT-4 code significantly more complex (Radon) [25]. Sonar: GPT-5 has the highest share of complexity smells, about 12% [36, secondary]. **Counter:** snippet-level AI code is simpler [22][23]. In one Codex case study only 9.1% of agent PRs changed CC vs 23.3% of human PRs [11] | ★★★ | ★★ | ★★★ |
| 3 | **Error masking / weak error handling** | Count per KLOC of: `catch (Exception)` / bare `catch` without rethrow; **empty catch blocks**; catch blocks with no throw, log or handler call (swallow); `catch {}` + `return default/null`; `#pragma warning disable`; null-forgiving `!` added. Delta vs base | Broad exception handling = **#1 rule** in 302.6k AI commits: 41,374 issues (8.5% of all) [7]. "Error-masking constructs" +47% (2023 → 2026) [4]. Error-handling issues "nearly 2×" in AI PRs (470 PRs) [37]. Try-except-pass (Bandit B110, CWE-703) among top security smells in LLM training sets [19] | ★★★ | ★★ | ★★★ |
| 4 | **Dead / unused code** | Unused parameters (in non-override, non-interface methods). Unused locals. Unused `using` directives (approximation: namespace never referenced). Unused private members. Commented-out code blocks | Unused variables/parameters 28,272 (5.8%), unused argument 24,357 (5.0%), unused import 17,376 [7]. S1172 unused function parameters is the #3 rule in agent bug-fix PRs (114) [8]. AI code has "more unused constructs and hardcoded debugging" than human code [23]. Unused argument is a top smell in generated code [19]. UnusedVariable (103) is a top ChatGPT Python issue [21] | ★★★ | ★★ | ★★ (approx. without semantic model) |
| 5 | **Oversized, multi-purpose, out-of-scope change sets** | Changed LOC, files touched, distinct namespaces/directories touched. "Concern count" (production vs test vs docs vs build files). Share of whitespace-only or rename-only hunks (noise). Public API surface delta (new public types/members) | Multi-purpose PRs: 39.9% of Claude Code PRs vs 12.2% of human PRs. "Too large" is a stated rejection reason (3.3%) [10]. Not-merged agent PRs are larger and touch more files [13]. Average PR size +154%, review time +91% on high-AI-adoption teams (10k+ devs) [41]. DORA cites small batch size as the missing basic [38]. Per-agent issue counts are explained by PR size; normalize by LOC [8] | ★★★ | ★★ | ★★★ |
| 6 | **Weak or smelly tests** (tests present but low value) | Test-to-production LOC ratio for the PR. Changed public methods with no matching test change. Assertions per test. Tests with 0 asserts. **Assertion Roulette** (multiple asserts, no message). **Magic Number Test**. Duplicated test bodies (clone metric on test files) | Agent PRs include tests far more often (18.8% vs 4.5%) [10], so *quality* of tests matters more than presence. Test-containing agent PRs are larger and slower [17]. LLM tests frequently show Assertion Roulette and Magic Number Test (20,505 LLM test suites) [34]. Test-related review comments are more common in rejected agent PRs (6.53% vs 5.44%, p<0.05) [14]. Tests are 16.4% of revisions on revised agent PRs [10] | ★★ | ★★ | ★★★ |
| 7 | **Duplicated literals / magic values** | String literals repeated ≥3 times in a file or type (cf. Sonar S1192). Numeric magic numbers outside const/static readonly/enums | S1192 "String literals should not be duplicated" is the **#1 rule** in merged agent bug-fix PRs (212 hits) [8]. Magic Number Test is a top LLM test smell [34] | ★★ | ★★ | ★★★ |
| 8 | **Security-sensitive patterns** (relevant: MessagePack is a deserializer) | Pattern rules: insecure deserialization settings (e.g., typeless resolvers or missing untrusted-data security options [project-specific, verify in repo]), `BinaryFormatter`, hard-coded secrets, logging of raw input, `unsafe` blocks added. Delta vs base | AI code fails security tests in 45% of tasks. C#/Python/JS 38–45%, Java >70%. Newer and bigger models not better (100+ LLMs) [44]. About 40% of 1,689 Copilot programs vulnerable [45]. AI commits introduce more security issues than they fix (~1.5×) [7]. More high-risk vulnerabilities in AI code [23]. Security up to 2.74× in AI PRs [37] | ★★★ | ★★ | ★ (pattern-level only) |
| 9 | **Hallucinated / unresolved symbols and dependencies** | Invocations of methods or types not declared anywhere in the repo and not in an allowlist of BCL/referenced-package namespaces. **New `PackageReference`s** in .csproj (each must be justified). New `using` of namespaces never seen in the repo | Hallucinated packages: ≥5.2% (commercial) and 21.7% (open-source) of packages, 205,474 unique fake names, 576k samples [32]. "Undefined variable or reference" is the #2 rule in AI commits (23,856, 4.9%) [7]. Undefined-variable is the top error in Copilot output [19]. Copilot calls helper methods that were never defined [22]. Missing module import 3.66% [27]. Note: in C# the compiler catches most of these, so value is mainly for new dependencies | ★★ | ★★★ | ★★ |
| 10 | **Short-term churn / self-rewrite** (code not stable on arrival) | Within each PR branch: lines added in commit *k* then modified or deleted in a later commit of the same branch (self-churn %). Revert commits. Across history: 2-week churn of agent lines | Churn (revised within 2 weeks) 3.32% (2020) → 5.53% (2023) [1]. Two-week churn +15% (2023 → 2026) [4]. Agent code shows more churn than human code over time (~110k PRs, 5 agents; effect sizes δ≈0.04–0.29) [15]. DORA 2025: delivery instability keeps rising even as throughput improves [39] | ★★ | ★★ | ★★ (needs git, not tree-sitter) |
| 11 | **Comment anomalies** (over-commenting, restating code, leftover TODOs) | Comment density per method vs repo baseline (flag outliers in both directions). XML-doc coverage of new public APIs. Comments that repeat the identifier (token overlap). TODO/FIXME/HACK count added. Commented-out code | Comment density varies 4× across models: Claude 3.7 Sonnet 16.4% vs GPT-4o 4.4% [36]. Comment density and identifier length are "strong indicators" of AI vs human code [31]. Comment duplication 1.22% of snippets [27]. Documentation is 29.0% of revisions to revised agent PRs [10]. Docs 11.4% of review comments on agent PRs [14] | ★★ | ★★ | ★★★ |
| 12 | **Naming inconsistency / low lexical diversity** | Convention conformance vs repo-inferred style (PascalCase public members, `_camelCase` private fields, `Async` suffix, `I` prefix on interfaces). Identifier length outliers. Lexical diversity (type/token ratio) of identifiers vs baseline | Naming issues "nearly 2×" in AI PRs [37]. Machine code has lower lexical diversity [29]. Identifier length is a strong AI indicator [31]. Confusing naming 1.02% [27] | ★ | ★★ | ★★★ |
| 13 | **Redundant control flow / non-idiomatic simplification misses** | Else after return/throw. Redundant conditionals (`if (x) return true; else return false;`). `for` loops that could be `foreach`. Reassigned parameters | Unnecessary Else in 17.48% of LLM snippets (most frequent maintainability issue) [27]. NoElseReturn (161) and AvoidReassigningParameters (176), ForLoopCanBeForeach (114) in ChatGPT code [21]. R1705 no-else-return in training-set top smells [19] | ★★ | ★ | ★★★ |
| 14 | **Verbosity** (more code per feature) | Added LOC per net functional change. Statements per method. Ratio of added to deleted lines (AI adds and rarely deletes) | Claude Sonnet 4 produced >3× the LOC of OpenCoder-8B on identical tasks [36]. GitClear: "added" share 39.18% (2020) → 42.34% (2023) [1]. **Counter:** at snippet level machine code is *more concise* [29] | ★ | ★ | ★★★ |

**How to read this for the certifier:** items 1–5 are the core AI-risk score (strong evidence, cheap with tree-sitter, clearly linked to AI). Items 6, 7, 11, 13 are cheap add-ons. Items 8–10 need extra inputs (pattern lists, git history) and are best reported as separate flags, not folded into the score.

---

## 2. Evidence in detail

### 2.1 Industry longitudinal data — GitClear (2024, 2025, 2026)

**2024 report, "Coding on Copilot: 2023 Data Suggests Downward Pressure on Code Quality"** [1]
- Data: 2020–2023 commits. The appendix sums to about 154M changed lines; the press summary says ~153M.
- Definitions. **Moved:** "cut and pasted to a new file, or a new function within the same file". **Copy/pasted:** line content (excluding keywords) "committed to multiple files or functions within a day". **Churn:** line authored, pushed, then revised within two weeks.
- Operation shares, 2020 → 2023: Added 39.18% → 42.34%; Deleted 19.47% → 21.12%; Updated 5.19% → 5.50%; **Moved 24.99% → 16.92%**; **Copy/pasted 8.26% → 10.49%**; Find/replaced 2.92% → 3.63%. 2024 projection: moved 13.38%, copy/pasted 11.55%.
- Churn: 3.32% (2020), 3.63% (2021), 3.97% (2022), **5.53% (2023)**, projected 7.09% (2024).
- Caveat: correlational, and GitClear sells code-analysis tooling. The 2024 projection came from a regression the authors ran with an OpenAI assistant.

**2025 report, "AI Copilot Code Quality"** [2][3]
- 211M changed lines, Jan 2020 – Dec 2024 [2].
- Refactoring-associated ("moved") lines "sunk from 25% of changed lines in 2021, to less than 10% in 2024". Cloned lines rose from 8.3% to 12.3% [2].
- DevClass [3, secondary]: blocks with ≥5 duplicated lines up **8×** during 2024; moved lines −39.9%; 2024 was the first year copy/pasted lines exceeded moved lines. (GitClear's own page headlines "4x more code cloning" [2]. Use the 8× figure only with the "≥5-line duplicated blocks, 2024" qualifier.)

**2026 reports, "Write-Only Mode" / "The Maintainability Gap"** [4]
- 623M analyzed changes, 2023–2026. **Block duplication** = "regions of five or more consecutive repeated meaningful lines".
- Block duplication 40.3 → 73.0 (+81%). The page gives conflicting units: per million changed lines in the text, per thousand changes in the chart. Within-commit copy/paste +41%. **Error-masking constructs +47%.** Two-week churn +15%. Refactoring moves −70%. Moved code 21% (2022) → 13% (2023) → 3.8% (2026 YTD). Copy/paste 9.4% (2022) → 15.7% (H1 2026). Function connectivity 343 → 223 method calls per thousand changed lines (−35%). Long-term (>12-month-old code) update share 1.7% → 0.46% (−74%).
- No direct AI-vs-human split. These are ecosystem trends during AI adoption, not line-level attribution.

**Takeaway for metrics:** GitClear's operational definitions can be reproduced directly: 5-line duplicated blocks, moved vs copy/pasted, connectivity, 2-week churn. They are the most cited industry evidence, so using the same definitions makes our certifier easy to defend.

### 2.2 Quasi-experimental studies on real repositories (closest to causal)

**He, Miller, Agarwal, Kästner, Vasilescu (CMU) — "Does AI-Assisted Coding Deliver? A DiD Study of Cursor's Impact"** [5]
- 807 Cursor-adopting vs 1,380 matched control GitHub repos. Staggered difference-in-differences. Quality measured with SonarQube Community: warnings, duplicated-line density, **cognitive complexity**.
- Post-adoption: static-analysis warnings **+29.7%**, code complexity **+40.7%**, lines added +28.6%. Velocity gains only in months 1–2 (+281.3% lines added in month 1).
- **Duplicate-line density: not significant** across all three estimators. This is important counter-evidence to GitClear at the per-repo level.
- Panel GMM: 100% more complexity → −64.5% lines added; 100% more warnings → −50.3%. The authors conclude these "act as a major factor causing long-term velocity slowdown".

**Agarwal, He, Vasilescu — "AI IDEs or Autonomous Agents?"** [6]
- For autonomous coding agents: static-analysis warnings about **+18%**, cognitive complexity about **+39%**, described as sustained agent-induced technical debt. Velocity gains appear only when the agent is the project's first AI tool.

**Takeaway:** cognitive complexity and warning density are the two metrics with causal-style evidence of AI-induced degradation that also predicts future cost. Both are cheap to compute.

### 2.3 Studies of agent-authored PRs and commits (closest to our target: 4 agent PR branches)

**Liu, Widyasari, Zhao, Irsan, Chen, Lo — "Debt Behind the AI Boom"** [7]
- 302.6k verified AI-authored commits, 6,299 repos, 5 assistants. Pylint, ESLint and Semgrep run before and after each commit.
- 484,366 introduced issues: **code smells 89.3%**, correctness 6.0%, security 4.7%. 7.5% (Copilot) to 14.8% (Gemini) of commits introduce ≥1 issue. **22.7% of introduced issues survive to the latest revision.**
- Top rules: **broad exception handling 41,374 (8.5%)**; undefined variable/reference 23,856 (4.9%); unused variables/parameters 28,272 (5.8%); unused argument 24,357 (5.0%); shadowed outer variable 20,647 (4.3%); access to protected member 19,796 (4.1%); unused import 17,376.
- Smells fixed (439,817) slightly outnumber smells introduced (432,748). Correctness and security issues are introduced more often than fixed; security ≈1.5×.

**Cynthia, Muttakin, Roy — "Beyond Bug Fixes" (MSR'26)** [8]
- 1,210 merged agent bug-fix PRs, 206 Python repos (AIDev). SonarQube base vs merged.
- Issue types: code smells 89.0%, security hotspots 7.0%, bugs 4.0%. Top rules: **S1192 duplicated string literals (212)**, **S3776 cognitive complexity (157)**, **S1172 unused parameters (114)**.
- Per-agent differences in raw issue counts largely disappear after normalizing by changed LOC. "Merge success does not reliably reflect post-merge code quality."

**Huang et al. — "More Code, Less Reuse" (MSR'26)** [9]
- Agents "frequently disregard code reuse opportunities". Semantic (Type-4) redundancy of new functions vs base-snapshot functions, using embedding cosine similarity: **AMR 0.2867 (agents) vs 0.1532 (humans), ≈1.87×, p<0.001**.
- Reviewers show more neutral, joy and sadness emotions on agent PRs, and fewer anger, disgust and fear. The authors warn that surface plausibility hides redundancy.
- Our certifier cannot use embeddings (no ML). A token-normalized clone detector (Type-1/2/3) gives a deterministic lower bound on the same phenomenon.

**Watanabe et al. — "On the Use of Agentic Coding" (Claude Code PRs)** [10]
- 567 agent PRs vs 567 human PRs, 157 repos. Merged: **83.8% vs 91.0%**. Merged without revision: 54.9% vs 58.5%.
- Agent PRs do more tests (18.8% vs 4.5%), refactoring (24.9% vs 14.9%), docs (22.1% vs 14.0%) and style (7.5% vs 1.8%), and are **multi-purpose 39.9% vs 12.2%**.
- Revisions needed on revised agent PRs: bug fixes 47.7%, docs 29.0%, refactoring 27.1%, style 23.4%, chores 21.0%, tests 16.4%.
- Stated rejection reasons: alternative solution 12.0%, too large 3.3%, non-optimal design 2.2%, unknown 64.1%.

**Li, Zhang, Hassan — AIDev / "SE 3.0"** [11][12]
- AIDev: 932,791 agent PRs, 116,211 repos, 5 agents. Curated subset of 33,596 PRs in repos with >100 stars [12].
- Acceptance (Table 5) [11]: human 76.8%, Codex 65.3%, Cursor 51.4%, Claude Code 52.5%, Devin 48.9%, Copilot 38.2%. Agents beat humans on docs (Codex 88.6%, Claude Code 85.7% vs 76.5%) but lag by 15–40 pp on feature, fix and perf work.
- Agent PRs described as "structurally simpler (via code complexity metrics)". In one Codex case study only 9.1% of agent PRs changed cyclomatic complexity vs 23.3% of human PRs.

**Ehsani et al. — "Where Do AI Coding Agents Fail?"** [13]
- 33k agent PRs, 600 analyzed qualitatively. PRs that were not merged are larger, touch more files, and often fail CI.
- Rejection taxonomy includes duplicate PRs, unwanted feature implementations and agent misalignment.

**Review-dynamics study of agent PRs (arXiv 2601.19287)** [14]
- 19,007 inline review comments on 3,162 agent PRs.
- Themes at comment level: functional/logic 38.5%, **refactor (restructuring, simplification, redundancy removal) 14%**, docs 11.4%, style 10.3%, undo/revert 10%, test >5%, security 2.9%.
- Test comments (6.53% vs 5.44%) and security comments (PR level 5.59% vs 3.05%) are more frequent in rejected PRs.

**Popescu et al. — "Investigating Autonomous Agent Contributions in the Wild" (MSR'26)** [15]
- About 110k PRs, 5 agents (Codex, Claude Code, Copilot, Jules, Devin). Agent code shows **higher churn over time** than human code. Survival differences are significant (p<0.001, Cliff's δ −0.05 to −0.14). Churn and deletion δ≈0.04–0.29.

**Horikawa et al. — "Do AI Agents Really Improve Code Readability?" (MSR'26)** [16]
- 403 agent readability commits. Agents mostly targeted logic complexity (42.4%) and documentation (24.2%).
- Yet the **Maintainability Index decreased in 56.1%** of commits and **cyclomatic complexity increased in 42.7%**. "Refactoring" claims by agents need metric verification.

**Haque, Ingale, Csallner — tests in agent PRs (MSR'26)** [17]
- Test-containing agent PRs are growing over time, are larger and take longer, with similar merge rates. 33–49% of Claude, Cursor and Copilot PRs modify initial test files at least once.

**Ottenhof et al. — "How do Agents Refactor"** [18]
- Java agent refactoring PRs vs developer refactorings (86 projects per group, DesigniteJava). Cursor is the only agent with a statistically significant increase in refactoring smells.

### 2.4 Snippet- and function-level academic studies

- **Siddiq et al., SCAM 2022** [19]. Pylint and Bandit on 3 training sets (CodeXGlue: 97.03% of samples smelly; APPS 69.15%; Code Clippy 39.12%), on GPT-Neo output, and on 656 Copilot samples for HumanEval.
  - Smells leak from training data into output. Top smells in generated code: **undefined variables, line too long, duplicate code, unused argument**.
  - Copilot: 18 code-smell types plus 2 security-smell types. Top suggestions smelly in **46.31%** of samples (0.664 smells/sample).
  - Top training-set security smells include try/except/pass (CWE-703).
- **Yetiştiren et al. 2023** [20]. HumanEval with Copilot, CodeWhisperer, ChatGPT. Correct: ChatGPT 65.2%, Copilot 46.3%, CodeWhisperer 31.1%. Average code-smell technical debt: 8.9 / 9.1 / 5.6 min.
- **Liu et al., TOSEM 33(5) 2024, "Refining ChatGPT-Generated Code"** [21]. 4,066 programs (2,033 tasks, Java and Python). PMD + Checkstyle (Java), Pylint + Flake8 (Python).
  - 47% have style/maintainability issues. **45% of the 2,756 test-passing programs still have them.**
  - Top issues. Python: ConsiderUsingEnumerate 213, NoElseReturn 161, UnusedVariable 103, TooManyBranches 36. Java: MultipleVariableDeclarations 334, AvoidReassigningParameters 176, ForLoopCanBeForeach 114, NPathComplexity 81.
  - ChatGPT self-repairs about 20–60% of issues when given static-analysis feedback. This supports a metric-feedback loop.
- **Nguyen & Nadi, MSR 2022** [22]. 132 Copilot solutions (33 LeetCode × 4 languages). Correctness Java 57%, JavaScript 27%. Low cyclomatic and cognitive complexity. Some code calls undefined helper methods.
- **Licorish et al. 2025** [25]. 72 Python tasks, GPT-4 vs human. GPT-4 passes more tests but has worse coding-standard adherence (Pylint) and often more complex code (Radon). Severe security outliers. (A secondary summary attributes the gap to documentation and naming [unverified].)
- **Paul, Zhu, Bayley 2025** [26]. Java (ScenEval). LLM code has on average **63.34% more smells** than reference solutions: implementation smells +73.35%, design smells +21.42%. Codex +84.97%, ChatGPT +65.05%, Gemini Pro +62.07%, Falcon +42.28%. The gap is larger for complex and OO tasks.
- **Abbassi et al. 2025** [27]. 492 HumanEval+ snippets (CodeLlama, DeepSeek-Coder, CodeGemma). Taxonomy of 5 categories and 19 subcategories, validated by 58 practitioners.
  - Frequencies: wrong logic 35.77%, partially wrong 30.08%, suboptimal memory 18.7%, suboptimal time 18.5%, **unnecessary else 17.48%**, redundant steps 5.28%, missing import 3.66%, code duplication 2.44%, comment duplication 1.22%, confusing naming 1.02%.
- **Cotroneo, Improta, Liguori, ISSRE 2025** [23]. Over 500k Python and Java samples, human vs ChatGPT, DeepSeek-Coder, Qwen-Coder. AI code is **simpler and more repetitive**, with **more unused constructs and hardcoded debugging** and more high-risk vulnerabilities. Human code is more complex and has *more* maintainability issues.
- **Molison et al., ESEM 2025** [24]. GPT-4o on 10k APPS Python problems. LLM code has fewer bugs and lower fix effort overall (SonarQube). On competition-level problems it sometimes introduces structural issues humans don't.
- **Liu M. et al. 2025, "Code Copycat Conundrum"** [28]. Repetition across 19 code LLMs, 3 benchmarks, 3 granularities (character, statement, block), 20 patterns. A rule-based de-repetition step cut rep-line by 93.5% and raised Pass@1 by 208.3% over greedy search.
- **Ghalandarian et al. 2026, C#/.NET** [35]. 85 HumanEval tasks in C# × 4 LLMs (GPT, Gemini, Claude, Grok), 340 solutions. Unit tests + Roslyn AST static quality + BenchmarkDotNet. **Correctness and static quality are almost uncorrelated (Pearson r = 0.075).** This is the only C#-specific study found, and it directly justifies a separate static quality score for C#.

### 2.5 Hallucination evidence

- **Spracklen et al., USENIX Security 2025** [32]. 16 LLMs, 576k samples (Python, JavaScript). Hallucinated packages ≥5.2% (commercial) and 21.7% (open-source). 205,474 unique hallucinated names. Supply-chain risk ("slopsquatting").
- **Zhang et al., ISSTA 2025** [33]. Repository-level hallucinations in 6 LLMs. Taxonomy built from manual analysis. Project-context conflicts are what static cross-referencing against the repo symbol table can catch.
- In C#, the compiler rejects undefined symbols, so hallucinated *APIs* show up mainly as build failures. The static risks that remain are **new package references** and plausible but wrong use of existing APIs. Wrong API use cannot be detected without semantics.

### 2.6 Security baseline

- **Pearce et al., IEEE S&P 2022** [45]. 89 scenarios, 1,689 Copilot programs, about 40% vulnerable.
- **Veracode 2025** [44]. 100+ LLMs, 80 tasks. OWASP Top-10 flaws in 45% of cases. Java >70%; Python, C# and JavaScript 38–45%. XSS failure 86%, log injection 88%. "Larger models do not perform significantly better."
- **Sonar** [36]. Llama 3.2 90B: >70% of vulnerabilities BLOCKER. GPT-4o: 62.5%. Claude Sonnet 4 vs 3.7: +6.3% pass rate but bugs "over 93% more likely" to be BLOCKER.

### 2.7 Test quality

- **Ouédraogo et al.** [34]. 20,505 LLM class-level test suites (GPT-3.5, GPT-4, Mistral 7B, Mixtral 8x7B), compared with 779,585 human tests and EvoSuite (tsDetect, JNose). The most frequent smells are **Assertion Roulette** and **Magic Number Test**. Patterns mirror human tests (possible leakage). Prompting, context length and model scale affect smells.

### 2.8 Vendor and industry reports (read with conflict-of-interest caution)

- **Sonar, "Coding Personalities of Leading LLMs" (Aug 2025)** [36]. More than 4,400 Java assignments, 6 LLMs, SonarQube. **Code smells >90% of issues for every model.** Verbosity: Claude Sonnet 4 produced >3× the LOC of OpenCoder-8B. Comment density 16.4% (Claude 3.7 Sonnet) vs 4.4% (GPT-4o).
- **CodeRabbit (Dec 2025)** [37]. 470 PRs (320 AI-co-authored, 150 human). **10.83 vs 6.45 issues per PR (≈1.7×).**
  - Logic/correctness +75%, readability >3×, error handling ≈2×, security up to 2.74×, excessive I/O ≈8×, formatting 2.66×, naming ≈2×. Critical and major findings 1.4–1.7×.
  - Authorship was inferred from co-author signals, and the "human" label is not guaranteed.
- **Faros AI (Jul 2025)** [41]. 10k+ developers, 1,255 teams. High-AI-adoption teams: +21% tasks, +98% PRs merged, **PR review time +91%, PR size +154%, bugs per developer +9%**. No significant company-level improvement.
- **GitHub Copilot RCT (Nov 2024), counter-evidence** [40]. 202 developers. Copilot group 53.2% more likely to pass all 10 unit tests. Readability +3.62%, reliability +2.94%, maintainability +2.47%, conciseness +4.16%. 18.2 vs 16.0 lines per code error. Reviewers 5% more likely to approve. Vendor-run, single small task.
- **Uplevel (2024)** [unverified, secondary coverage only]. 41% higher bug rate for developers with Copilot access, with no throughput gain. Measured access, not usage.

### 2.9 Organization-level (Google DORA, METR)

- **DORA 2024** [38]. A 25% increase in AI adoption is associated with: documentation quality +7.5%, code quality +3.4%, review speed +3.1%, but **delivery throughput −1.5% and delivery stability −7.2%**. 39% report little or no trust in AI code. The report stresses small batch sizes and robust testing.
- **DORA 2025** [39]. 90% AI adoption. AI is now positively linked to throughput, but "software delivery instability continues to rise" [InfoQ]. 59% report a positive effect on code quality (self-reported). Only 3% report high trust.
- **METR RCT 2025** [43]. 16 experienced OSS developers, 246 tasks. AI use increased completion time by 19%, while developers had forecast a 24% speedup. The perception gap is relevant to "earned trust".

### 2.10 Which metrics discriminate AI from human code (detection literature)

- **Shi et al., ICSE 2025** [29]. Machine code has lower lexical diversity and is more concise. "Syntactic segmentation" (whitespace and newline patterns) is the key discriminator.
- **Idialu et al., MSR 2024 ("Whodunit")** [30]. GPT-4 vs human CodeChef Python, 140 stylometric features, XGBoost F1 = 0.91. The most important feature is **average line length** (GPT-4 lines are longer). Empty-line density and function density (helper functions) matter. Halstead metrics add almost nothing.
- **Orel et al. 2025 ("Droid")** [31]. Over 1M samples, 7 languages, 43 models. Features related to "the length of identifiers (variable names) and the density of comments" are strong indicators. Long descriptive comments and consecutive empty lines also influence predictions.
- **Implication:** stylometric features (line length, comment density, identifier length, blank-line ratio) are *fingerprints* of AI authorship, not quality defects in themselves. The certifier should report them as context or outlier signals, not penalize them, except where they map to a defect: over-commenting, comment duplication, or commented-out code.

---

## 3. Counter-evidence and caveats (must be stated in the pitch)

1. **Snippet vs project level.** On isolated tasks, AI code is often *simpler* [22][23][11] and can have fewer bugs [24]. The degradation shows up at project and PR level as complexity accumulation [5][6][16], duplication against existing code [1–4][9], and size [10][41]. Our certifier analyzes PRs against a real base repo, which is the level where the risks appear.
2. **Duplication is contested at repo level.** GitClear's trends are strong but correlational, and GitClear is a vendor [1–4]. CMU's DiD found no significant duplicate-line-density effect [5]. Huang et al. find redundancy with *semantic* clones [9]. Recommendation: measure **new code that duplicates existing code** (reuse ignored), not just global duplication density.
3. **Normalize.** Issue counts track change size [8]. Report per changed KLOC and as deltas vs base.
4. **Vendor bias.** GitClear, Sonar, CodeRabbit, Faros, Veracode and GitHub all sell related products. Academic sources [5–24] corroborate the main directions.
5. **Survival.** Only part of AI-introduced issues get cleaned up later: 22.7% survive to HEAD [7]. Smells fixed ≈ smells introduced in aggregate [7], which suggests AI also *removes* smells. The certifier should credit removed issues (net delta), not only count additions.
6. **Generated and intentionally repetitive code in MessagePack-CSharp.** High-performance serializers often contain template-generated or unrolled code. Exclude files with `<auto-generated>` headers or produced from templates (verify in the repo, e.g., `*.tt` outputs). Use repo-relative baselines so that intended duplication and complexity in hot paths are not penalized.

---

## 4. Practical guidance for the certifier (derived from the evidence)

- **Compute everything as base→PR deltas, normalized per changed KLOC** [8], and compare the 4 PR branches against the human-written base repo's own distribution (percentiles). This is mathematically defined and repo-relative.
- **Core AI-risk sub-scores (priority order):**
  1. Reuse/duplication: clone blocks ≥5 normalized lines [4]. Split into (i) new↔existing clones and (ii) within-PR clones. Add an in-repo call connectivity ratio [4].
  2. Cognitive complexity delta and share of methods over threshold. Use the S3776 definition [8]; take the exact threshold from the metrics-definition research file.
  3. Error masking: catch-all or empty catch blocks and swallowed exceptions per KLOC [7][4][37].
  4. Dead code: unused params, locals, usings and private members [7][8][23].
  5. Change hygiene: size, files, concern count, noise hunks [10][13][41].
- **Add-ons:** duplicated string literals (S1192) [8]; test smells (Assertion Roulette, Magic Number Test, zero-assert tests) [34]; else-after-return and redundant conditionals [27][21]; TODO/commented-out code; new package references [32].
- **Report but do not score:** stylometric fingerprints (comment density, line length, identifier length) [29][30][31], except outliers that map to a defect.
- **Feedback loop.** Liu et al. show LLMs fix 20–60% of quality issues when given static-analysis feedback [21]. The certifier's deterministic findings can be fed back to the agents, which supports "humans remain accountable, machines do the checking".
- **Tree-sitter feasibility notes (C#).** Everything in rows 1–7 and 11–14 needs only the syntax tree: catch clauses, method declarations, parameter lists, using directives, literals, comments, if/else and return. Confirm node names against the tree-sitter-c-sharp grammar version used. Unused-symbol checks are syntactic approximations, since there is no semantic model. Mark them as heuristic, or restrict them to private and local scope where name resolution within a file is reliable.

---

## 5. References

[1] GitClear (W. Harding, M. Kloster), "Coding on Copilot: 2023 Data Suggests Downward Pressure on Code Quality (incl. 2024 projections)", Jan 2024. Full text: https://public.amplenote.com/BL6RLiQo6qqwoP7HNf6gqcRo — landing page: https://www.gitclear.com/coding_on_copilot_data_shows_ais_downward_pressure_on_code_quality
[2] GitClear, "AI Copilot Code Quality: Evaluating 2024's Increased Defect Rate via Code Quality Metrics", 2025. https://www.gitclear.com/ai_assistant_code_quality_2025_research
[3] DevClass, "AI is eroding code quality states new in-depth report", 20 Feb 2025 (coverage of [2]). https://www.devclass.com/ai-ml/2025/02/20/ai-is-eroding-code-quality-states-new-in-depth-report/1626250
[4] GitClear, "Write-Only Mode: AI Code Quality in 2026" / "The Maintainability Gap: AI Code Quality in 2026". https://www.gitclear.com/write_only_mode_ai_research ; http://www.gitclear.com/the_ai_code_quality_maintainability_gap
[5] H. He, C. Miller, S. Agarwal, C. Kästner, B. Vasilescu, "Does AI-Assisted Coding Deliver? A Difference-in-Differences Study of Cursor's Impact on Software Projects", arXiv:2511.04427 (v2 numbers used). https://arxiv.org/abs/2511.04427
[6] S. Agarwal, H. He, B. Vasilescu, "AI IDEs or Autonomous Agents? Measuring the Impact of Coding Agents on Software Development", arXiv:2601.13597. https://arxiv.org/abs/2601.13597
[7] Y. Liu, R. Widyasari, Y. Zhao, I. C. Irsan, J. Chen, D. Lo, "Debt Behind the AI Boom: A Large-Scale Empirical Study of AI-Generated Code in the Wild", arXiv:2603.28592. https://arxiv.org/abs/2603.28592
[8] Cynthia, Muttakin, Roy, "Beyond Bug Fixes: An Empirical Investigation of Post-Merge Code Quality Issues in Agent-Generated Pull Requests", MSR 2026 Mining Challenge, arXiv:2601.20109. https://arxiv.org/abs/2601.20109
[9] H. Huang, P. Jaisri, S. Shimizu, L. Chen, S. Nakashima, G. Rodríguez-Pérez, "More Code, Less Reuse: Investigating Code Quality and Reviewer Sentiment towards AI-generated Pull Requests", MSR 2026, arXiv:2601.21276. https://arxiv.org/abs/2601.21276
[10] Watanabe et al., "On the Use of Agentic Coding: An Empirical Study of Pull Requests on GitHub", arXiv:2509.14745 (v3). https://arxiv.org/abs/2509.14745
[11] H. Li, H. Zhang, A. E. Hassan, "The Rise of AI Teammates in Software Engineering (SE) 3.0: How Autonomous Coding Agents Are Reshaping Software Engineering", arXiv:2507.15003. https://arxiv.org/abs/2507.15003
[12] "AIDev: Studying AI Coding Agents on GitHub", arXiv:2602.09185. https://arxiv.org/abs/2602.09185
[13] R. Ehsani, S. Pathak, S. Rawal, A. Al Mujahid, M. M. Imran, P. Chatterjee, "Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests in GitHub", arXiv:2601.15195. https://arxiv.org/abs/2601.15195
[14] Empirical study of code-review dynamics in agent-generated PRs (AIDev subset; 19,450 inline comments / 3,177 PRs), arXiv:2601.19287. Authors not captured in this research. https://arxiv.org/abs/2601.19287
[15] R. M. Popescu, D. Gros, A. Botocan, R. Pandita, P. Devanbu, M. Izadi, "Investigating Autonomous Agent Contributions in the Wild: Activity Patterns and Code Change over Time", MSR 2026, arXiv:2604.00917. https://arxiv.org/abs/2604.00917
[16] K. Horikawa, K. Horikawa, Y. Kashiwa, H. Uwano, H. Iida, "Do AI Agents Really Improve Code Readability?", MSR 2026, arXiv:2603.13723. https://arxiv.org/abs/2603.13723
[17] Haque, Ingale, Csallner, "Do Autonomous Agents Contribute Test Code? A Study of Tests in Agentic Pull Requests", MSR 2026, arXiv:2601.03556. https://arxiv.org/abs/2601.03556
[18] L. Ottenhof, D. Penner, A. Hindle, T. Lutellier, "How do Agents Refactor: An Empirical Study", arXiv:2601.20160. https://arxiv.org/abs/2601.20160
[19] M. L. Siddiq, S. H. Majumder, M. R. Mim, S. Jajodia, J. C. S. Santos, "An Empirical Study of Code Smells in Transformer-based Code Generation Techniques", IEEE SCAM 2022, pp. 71–82, DOI 10.1109/SCAM55253.2022.00014. Preprint: https://lsiddiqsunny.github.io/public/scam_2022.pdf
[20] B. Yetiştiren, I. Özsoy, M. Ayerdem, E. Tüzün, "Evaluating the Code Quality of AI-Assisted Code Generation Tools: An Empirical Study on GitHub Copilot, Amazon CodeWhisperer, and ChatGPT", arXiv:2304.10778. https://arxiv.org/abs/2304.10778
[21] Y. Liu, T. Le-Cong, R. Widyasari, C. Tantithamthavorn, L. Li, X.-B. D. Le, D. Lo, "Refining ChatGPT-Generated Code: Characterizing and Mitigating Code Quality Issues", ACM TOSEM 33(5), 2024, DOI 10.1145/3643674; arXiv:2307.12596. https://arxiv.org/abs/2307.12596
[22] N. Nguyen, S. Nadi, "An Empirical Evaluation of GitHub Copilot's Code Suggestions", MSR 2022, DOI 10.1145/3524842.3528470. https://conf.researchr.org/details/msr-2022/msr-2022-technical-papers/11/An-Empirical-Evaluation-of-GitHub-Copilot-s-Code-Suggestions
[23] D. Cotroneo, C. Improta, P. Liguori, "Human-Written vs. AI-Generated Code: A Large-Scale Study of Defects, Vulnerabilities, and Complexity", ISSRE 2025, arXiv:2508.21634. https://arxiv.org/abs/2508.21634
[24] A. S. Molison, M. Moraes, G. Melo, F. Santos, W. K. G. Assuncao, "Is LLM-Generated Code More Maintainable & Reliable than Human-Written Code?", ESEM 2025, arXiv:2508.00700. https://arxiv.org/abs/2508.00700
[25] S. A. Licorish, A. Bajpai, C. Arora, F. Wang, K. Tantithamthavorn, "Comparing Human and LLM Generated Code: The Jury is Still Out!", arXiv:2501.16857. https://arxiv.org/abs/2501.16857
[26] D. G. Paul, H. Zhu, I. Bayley, "Investigating The Smells of LLM Generated Code", arXiv:2510.03029. https://arxiv.org/abs/2510.03029
[27] A. A. Abbassi, L. Da Silva, A. Nikanjam, F. Khomh, "Unveiling Inefficiencies in LLM-Generated Code: Toward a Comprehensive Taxonomy", arXiv:2503.06327 (v2, Table I). https://arxiv.org/abs/2503.06327
[28] M. Liu et al., "Code Copycat Conundrum: Demystifying Repetition in LLM-based Code Generation", arXiv:2504.12608. https://arxiv.org/abs/2504.12608
[29] Y. Shi, H. Zhang, C. Wan, X. Gu, "Between Lines of Code: Unraveling the Distinct Patterns of Machine and Human Programmers", ICSE 2025, arXiv:2401.06461. https://arxiv.org/abs/2401.06461
[30] O. J. Idialu, N. S. Mathews, R. Maipradit, J. M. Atlee, M. Nagappan, "Whodunit: Classifying Code as Human Authored or GPT-4 Generated – A Case Study on CodeChef Problems", MSR 2024, arXiv:2403.04013. https://arxiv.org/abs/2403.04013
[31] D. Orel, I. Paul, I. Gurevych, P. Nakov, "Droid: A Resource Suite for AI-Generated Code Detection", arXiv:2507.10583 (Appendix C.2/E.2). https://arxiv.org/abs/2507.10583
[32] J. Spracklen et al., "We Have a Package for You! A Comprehensive Analysis of Package Hallucinations by Code Generating LLMs", USENIX Security 2025, arXiv:2406.10279. https://arxiv.org/abs/2406.10279 ; https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen
[33] Z. Zhang, Y. Wang, C. Wang, J. Chen, Z. Zheng, "LLM Hallucinations in Practical Code Generation: Phenomena, Mechanism, and Mitigation", ISSTA 2025, arXiv:2409.20550. https://arxiv.org/abs/2409.20550
[34] W. C. Ouédraogo et al., "On the Diffusion of Test Smells in LLM-Generated Unit Tests" (orig. "Test smells in LLM-Generated Unit Tests"), arXiv:2410.10628. https://arxiv.org/abs/2410.10628
[35] S. M. M. Ghalandarian, M. Bazargani, M. Taromirad, "Benchmarking the Titans: A Multi-Dimensional Empirical Evaluation of LLM Code Generation Quality in the .NET Ecosystem", arXiv:2608.22529. https://arxiv.org/abs/2608.22529
[36] Sonar, "The Coding Personalities of Leading LLMs", Aug 2025. https://www.sonarsource.com/blog/the-coding-personalities-of-leading-llms (GPT-5 complexity figure from the GPT-5 update post via search snippet [secondary])
[37] CodeRabbit, "State of AI vs Human Code Generation Report", 17 Dec 2025. https://www.coderabbit.ai/blog/state-of-AI-vs-human-code-generation-report
[38] Google Cloud / DORA, "Announcing the 2024 DORA report". https://cloud.google.com/blog/products/devops-sre/announcing-the-2024-dora-report
[39] DORA 2025 "State of AI-assisted Software Development". Google summary: https://blog.google/innovation-and-ai/technology/developers-tools/dora-report-2025/ ; InfoQ coverage: https://www.infoq.com/news/2025/09/dora-state-of-ai-in-dev-2025 ; full PDF (not opened, >10MB): https://services.google.com/fh/files/misc/2025_state_of_ai_assisted_software_development.pdf
[40] GitHub, "Does GitHub Copilot improve code quality? Here's what the data says", Nov 2024. https://github.blog/news-insights/research/does-github-copilot-improve-code-quality-heres-what-the-data-says/
[41] Faros AI, "The AI Productivity Paradox Report 2025", 23 Jul 2025. https://www.faros.ai/blog/ai-productivity-paradox-report-2025
[42] Uplevel Data Labs, Copilot impact study, 2024 [unverified — known only via secondary coverage, e.g. https://www.itbrew.com/stories/2024/10/30/why-ai-coding-assistants-might-not-help-devs-much (blocked to fetch)].
[43] J. Becker, N. Rush, E. Barnes, D. Rein (METR), "Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity", arXiv:2507.09089. https://arxiv.org/abs/2507.09089
[44] Veracode, "AI-Generated Code Poses Major Security Risks in Nearly Half of All Development Tasks" (2025 GenAI Code Security Report). https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/
[45] H. Pearce, B. Ahmad, B. Tan, B. Dolan-Gavitt, R. Karri, "Asleep at the Keyboard? Assessing the Security of GitHub Copilot's Code Contributions", IEEE S&P 2022, arXiv:2108.09293. https://arxiv.org/abs/2108.09293

Not covered or not found: "Is ChatGPT's code DRY?" (no paper with that title was found; DRY evidence is covered by [1–4][9][23][28]). Stack Overflow 2025 survey figures were not verified (search budget exhausted). The SATD-by-agents paper ("Characterizing Self-Admitted Technical Debt Generated by AI Coding Agents", MSR'26) was seen only as a program listing [unverified].
