# 16 — Tool overlap, detection rates, capture–recapture estimation of residual defects, and an evidence-based ranking of quality checks

Scope: (A) empirical evidence on agreement/overlap and detection rates of static analysis tools; (B) statistical methods to estimate how many findings remain undetected when several detectors are run; (C) evidence for ranking quality checks by impact, plus a transparent multi-criteria formula applied to 18 checks for a C# certifier.

Context: an AI-free, mathematically defined code-quality certifier / quality gate for C# repositories (Junction 2026, Tieto "Earned Trust in AI Code") that runs several tools per category, normalises to SARIF, deduplicates, and estimates what remains undetected.

---

## 0. Method and verification status (read first)

- The shared WebSearch budget for this turn ran out before my first query, so I ran no keyword searches. Every source below was checked by fetching it directly from a known identifier (DOI, arXiv ID, publisher or author URL), using:
  - full-text PDFs (arXiv, NDSS, USENIX, TU Delft, UMD, Waterloo mirror, Verizon), with text extracted locally;
  - abstracts from Semantic Scholar, OpenAlex and Crossref looked up **by DOI** (not by keyword);
  - official web pages (OWASP, MITRE CWE, DORA, GitGuardian, Verizon).
- Each reference carries a status tag:
  - **[FT]**: I read the full text; numbers were checked against it.
  - **[ABS]**: the abstract was verified, so numbers quoted from it are verified, but deeper details were not.
  - **[BIB]**: only the bibliographic record (title, authors, venue, DOI) was verified. Any content claim is marked **[unverified]**.
  - **[TLDR]**: only Semantic Scholar's machine-generated one-line summary was available. Treat it as weak and confirm before quoting.
  - **[WEB]**: an official web page was fetched.
- Rule followed throughout: no number appears unless it was seen in a fetched source. Numbers I remember but could not re-verify are labelled **[unverified]**, or left out.
- Illustrative calculations in Part B use **made-up example inputs** and are labelled as such. They are arithmetic demonstrations, not evidence.

---

## Executive summary

1. **Static tools overlap very little, and each one alone misses most real defects.** This finding has replicated for 20 years:
   - Java bug finders do not subsume one another and often find non-overlapping bugs [1].
   - On Defects4J (594 real bugs), three widely used detectors were "mostly complementary" and missed "the large majority" of bugs [2].
   - Six C analyzers missed 47–80% of 192 real CVEs. Combining them still missed 30–69%, at the cost of flagging 15 percentage points more functions [3].
   - Seven Java SAST tools detected only 12.7% of real-world vulnerabilities, and 70.9% stayed undetected even when all tools were combined [6].
2. **Category-specific evidence points the same way:**
   - *Secrets*: across 9 detectors on SecretBench (818 repos, 4,457 unique true secrets), precision ranged from 1% to 75% and recall (repo level) from 17% to 88%. No tool had both high precision and high recall. Pairwise overlaps were asymmetric, for example 76% of ggshield's unique true positives were also found by TruffleHog but only 18% by Gitleaks [7].
   - *Software composition analysis (SCA, i.e. dependency scanners)*: 9 tools on one application reported between 17 and 332 vulnerable Maven dependencies, and between 36 and 313 unique vulnerabilities. The accuracy of each tool's vulnerability database was the main differentiator [9]. Re-bundled or re-packaged dependencies defeat every scanner tested [10].
   - *Clones*: token/text-based detectors have higher recall and AST-based ones higher precision. Individual tools found only 24–46% of injected "secret" clones [11]. On BigCloneBench, Type-1 recall is about 100% for most tools, but recall for "strongly Type-3" clones ranges from 15% to 95% between tools [13].
   - *SonarQube rules*: rules SonarQube labels as "bugs" predicted fault-inducing commits at chance level (AUC 0.509, precision 0.086, recall 0.028) [15]. Classes with technical-debt items were not more fault-prone, and effect sizes on change-proneness were negligible to small [16].
3. **Implication for the gate:**
   - Running several tools per category is justified, because their union raises recall [3][7][9].
   - Deduplication and matching thresholds directly change both the measured overlap and the residual-defect estimate.
   - A **clean result is weak evidence** in the categories with low recall (SAST especially). A **positive finding is strong evidence** wherever precision is high.
4. **Capture–recapture is the established statistical tool for "how many did all detectors miss?"**:
   - It has been used on software inspections since Eick et al. 1992 [24].
   - Comparative evaluations recommend the heterogeneity model Mh with the jackknife estimator [25][27]. With only two inspectors, they recommend an estimator that allows different detector capabilities [26].
   - With too few detectors, every model is inaccurate and underestimation can be substantial [25].
   - Tools that share rules or databases are **positively dependent**, which biases the estimate **downwards**. Use log-linear models with interaction terms [31][32], group tools into independent "families", and calibrate with seeded canaries.
   - Always report the estimate as a **lower bound on the defects this class of tools could detect**. It says nothing about defects no tool in the category can see [2][3][6].
5. **Proposed ranking formula** (Part C). Each criterion is scored on an anchored 1–5 scale:
   - Importance = **E × C × P × M**, where E is evidence strength, C consequence severity, P prevalence and M measurability.
   - Resulting top tier: **secrets, vulnerable dependencies, failing tests**.
   - Second tier: **error-handling anti-patterns, mutation score, patch coverage, complexity, unit size**, then **SAST** (high impact but low measurability), **coupling/cycles, duplication**.
   - Bottom tier: **naming, docs, dead code, cohesion, magic numbers, style, generic rule counts**.
   - A Monte-Carlo sensitivity test (each score perturbed by ±1) keeps the top three in the top five 75–84% of the time.

---

## Part A — Empirical evidence on overlap, agreement and detection rates

### A.1 General-purpose bug finders

| Study | Setting | Key verified findings | Status |
|---|---|---|---|
| Rutar, Almazan, Foster 2004 (ISSRE) [1] | Bandera, ESC/Java 2, FindBugs, JLint and PMD on several Java programs | No tool strictly subsumes another; the tools often find non-overlapping bugs. The authors propose a **meta-tool** that combines outputs and highlights lines, methods and classes that several tools warn about. | [ABS] |
| Habib & Pradel 2018 (ASE) [2] | Error Prone, Infer and SpotBugs on extended Defects4J: 15 Java projects, **594** known bugs | Static detectors find a non-negligible share of bugs; the tools are **mostly complementary**; they **miss the large majority** of bugs. Some misses are domain-specific and match no existing bug pattern. The exact detected count is **[unverified]**: the full text was not retrievable and the artifact README does not state it. | [ABS] |
| Thung et al. 2012 (ASE) [4] | FindBugs, JLint and PMD against hundreds of field defects in Lucene, Rhino and AspectJ | Many field defects could be detected, but a **substantial proportion could not be flagged**. The paper is explicitly about false negatives rather than false positives. Per-tool percentages are **[unverified]**: the full text was blocked by a bot wall. | [ABS] |
| Johnson et al. 2013 (ICSE) [5] | Interviews with 20 developers | All participants saw static analysis as beneficial, but **false positives** and the way warnings are presented are barriers to using it. | [ABS] |
| Kim & Ernst 2007 (FSE) [18] | FindBugs, JLint and PMD on Columba, Lucene and Scarab | Only **6%, 9% and 9%** of warnings were removed by bug-fix changes over 1–4 years; about 90% remained or were removed during non-fix changes. Selecting tool-assigned high-priority warnings gives a maximum precision of only **3%, 12% and 8%**. History-based prioritisation raised this to 17%, 25% and 67%. | [ABS] |
| Nagappan & Ball 2005 (ICSE) [20] | Two static analysis tools on Windows Server 2003 | Static-analysis defect density is **strongly positively correlated** with pre-release defect density found by testing. Discriminant analysis separated high- and low-quality components with **82.91%** accuracy. | [ABS] |
| Marcilio et al. 2019 (ICPC) [17] | 421,976 SonarQube issues from 246 projects across 4 SonarQube instances | On average only **13%** of issues were resolved; median time to fix was 18.99 days. | [ABS] |
| Kang, Aw, Lo 2022 (ICSE) [19] | Re-analysis of machine-learning "golden features" for filtering false alarms | Earlier near-perfect results came from **data leakage and duplication**. The "future revision" warning oracle disagrees with human oracles, so reported performance is over-optimistic. | [ABS] |
| Beller et al. 2016 (SANER) [21] | 9 automated static analysis tools (ASATs) across 122 and 168,214 open-source projects | ASAT use is widespread but not ubiquitous; configurations rarely change after introduction. The authors map 1,825 tool-specific warnings to 16 General Defect Classification classes, a precedent for our cross-tool normalisation. | [ABS] |

**Take-aways for design:**
- (i) The union of tools is needed, as [1], [2] and [3] all show.
- (ii) Raw warning counts are a poor quality signal, because most warnings are never fixed and tool priorities have low precision [17][18]. Gate on **high-precision categories**, or on **new findings in changed code**, rather than on raw totals.
- (iii) "Multiple tools flag the same location" is a recognised way to boost confidence. It is exactly Rutar et al.'s meta-tool idea [1].
- (iv) Any machine-learning false-positive filter is out of scope for an AI-free gate, and published results for such filters are inflated anyway [19].

### A.2 Security static analysis (SAST)

| Study | Setting | Verified numbers | Status |
|---|---|---|---|
| Lipp, Banescu, Pretschner 2022 (ISSTA) [3] | 5 open-source and 1 commercial C analyzer; 27 projects; 1.15 MLOC; **192** real vulnerabilities (CVE-based ground truth) | Individual tools **miss 47%–80%** of vulnerabilities. **Combining** tools lowers the false-negative rate to **30%–69%**, at the cost of **+15 percentage points** of functions flagged. Misses concentrate in vulnerabilities beyond classic memory bugs. | [ABS] |
| Li et al. 2023 (ESEC/FSE) [6] | 7 free or open-source Java SAST tools, chosen from 161; synthetic and real-world benchmarks | Tools do well on synthetic benchmarks, but **only 12.7%** of real-world vulnerabilities were detected. **Even combining all tools, 70.9% remain undetected.** | [ABS] |

Implication: SAST results answer "is there evidence of a vulnerability?" well, through high-confidence findings. They answer "is there no vulnerability?" poorly. In the ranking (Part C) this appears as a **low measurability (M)** score for SAST despite its maximal consequence.

### A.3 Secret detection

**Basak, Cox, Reaves, Williams 2023 (ESEM) [7] [FT].**
- Benchmark: SecretBench, with 818 public GitHub repos and 97,479 manually labelled candidate secrets. Of these, 15,084 are true secrets and **4,457 unique** true secrets.
- Tools: 5 open-source tools (git-secrets, Gitleaks, Repo-supervisor, TruffleHog, Whispers) and 4 proprietary ones (GitHub Secret Scanner, ggshield, SpectralOps, "Commercial X").
- Matching: a tool finding counts as a true positive if its similarity to a benchmark secret is at least 0.6 under Jaro-Winkler or Gestalt similarity. Manual checks of 100 secrets per tool showed this labelling was 97% correct.
- Recall was computed two ways. **Case 1** requires the same commit, file and line. **Case 2** only requires the secret to appear somewhere in the repository.

Table III of [7]:

| Tool | Precision | Recall Case 1 | Recall Case 2 | F1 |
|---|---|---|---|---|
| git-secrets | 0.05 | 0.04 | 0.21 | 0.08 |
| **Gitleaks** | 0.46 | **0.86** | **0.88** | **0.60** |
| Repo-supervisor | 0.02 | n/a | 0.17 | 0.04 |
| TruffleHog | 0.06 | 0.31 | 0.52 | 0.11 |
| Whispers | 0.01 | 0.01 | 0.38 | 0.02 |
| Commercial X | 0.25 | 0.22 | 0.48 | 0.32 |
| ggshield | 0.19 | 0.23 | 0.46 | 0.26 |
| **GitHub Secret Scanner** | **0.75** | 0.03 | 0.36 | 0.48 |
| SpectralOps | 0.01 | n/a | 0.67 | 0.02 |

Further findings:
- Five of the nine tools have precision below 7%.
- Overlap between tools is asymmetric and often low. 76% of ggshield's unique true positives were also reported by TruffleHog, but only 18% by Gitleaks.
- In the Gitleaks/TruffleHog/ggshield Venn diagram, Gitleaks and TruffleHog each reported many true secrets no other tool found (1,533 and 438 respectively). The authors conclude that no single tool can be relied on.
- **Verification changes precision drastically.** TruffleHog's precision went from 6% (almost 100K alerts) to **90%** with `--only-verified` (611 secrets). Verification itself still produced about 10% false positives.
- Causes of false negatives: faulty regexes, **skipped file types**, and insufficient rulesets. Some secrets sit in images or non-searchable PDFs.
- Per-category recall varies widely. For example, TruffleHog reached 98% repo-level recall on "Database and Server URL" secrets but 52% overall, so a portfolio of tools chosen by secret type helps.

**Meli, McNiece, Reaves 2019 (NDSS) [8] [FT]:**
- Over 100,000 repositories leaked secrets.
- Thousands of new unique secrets are leaked every day. The search collection found a median of 1,793 unique candidate secrets per day.
- Their real-time approach discovered 99% of newly committed files containing secrets.
- Persistence: about 6% of detected secrets were removed within the first hour, over 12% by the end of the first day, and only 19% after 16 days. In other words, **81% were not removed** during their monitoring.

**Industry telemetry [WEB]:**
- GitGuardian 2025 [82]: **23,770,171** new hard-coded secrets were detected in public GitHub commits in 2024, a 25% year-on-year increase. **70%** of secrets leaked in 2022 were still valid. **35%** of scanned customer private repositories contained at least one plaintext secret. Generic secrets made up 58% of detected leaks.
- Verizon DBIR 2025 [80] [FT]: the median time to remediate leaked secrets discovered in a GitHub repository was **94 days**. Credential abuse remained the most common initial access vector.

### A.4 Software composition analysis (dependency vulnerabilities)

**Imtiaz, Thorn, Williams 2021 (ESEM) [9] [FT].** Nine SCA tools were run on OpenMRS (Maven and npm projects).
- Reported vulnerable dependencies ranged from **17 to 332** for Maven and **32 to 239** for npm.
- Unique known vulnerabilities ranged from **36 to 313** for Maven and **45 to 234** for npm.
- Pairwise overlap was partial. For example, 54% of Snyk's reported Maven vulnerable dependencies were also reported by Commercial C, and 68% the other way round. CVEs did not fully overlap either.
- Reasons for disagreement included:
  - detection of JavaScript inside Maven projects;
  - internal-module inflation, where one CVE is reported per submodule;
  - the same CVE being attached to several related packages, because NVD lists a whole framework as affected;
  - non-CVE advisories that cannot be cross-referenced between tools;
  - **database accuracy**, which was the key differentiator.
- The authors' conclusion is not to rely on a single tool.

**Dann et al. 2021 (TSE) [10] [ABS]:**
- In 7,024 Java projects at SAP, more than 87% of the vulnerable classes considered occur in Maven Central in **re-bundled** form, and 56% in **re-packaged** form.
- None of the 6 scanners tested handles every type of modification. The scanners were OWASP Dependency-Check, Eclipse Steady, GitHub Security Alerts and three commercial tools.

Implications for C#/NuGet:
- Normalise advisories to an alias set (CVE, GHSA, OSV ID) before deduplicating.
- Collapse per-project duplicates.
- Run at least two independent database sources. For C#, examples are `dotnet list package --vulnerable`, osv-scanner and trivy. These names are our tool choices, not something the cited studies evaluated.

### A.5 Clone detection agreement and recall

**Bellon et al. 2007 (TSE) [11] [FT]:**
- 6 detectors were run on 8 C and Java programs, about 850 KLOC in total.
- An independent oracle (Bellon) judged **2%** of the 325,935 submitted candidates.
- The two token-based tools and the text-based tool behaved "astonishingly similarly" and had **higher recall**. The AST-based (Baxter) and metrics-based (Merlo) tools had **higher precision**. The PDG-based tool performed poorly.
- The share of rejected candidates ranged from **24% (Baxter) to 77% (Krinke)**.
- Of the clones secretly injected by the experimenters, individual tools found **only 24%–46%**. Krinke's tool found 4%, but it analysed only 3 of the 8 programs.
- Matching rule: a candidate matches a reference if their overlap reaches the "good"/"ok" threshold of 0.7. This is a precedent for our SARIF location-matching thresholds.

**Svajlenko & Roy 2014 (ICSME) [12] [ABS]:**
- Recall of 11 modern detectors was measured under 4 benchmark frameworks.
- Bellon's framework showed anomalies and disagreed with both expectations and the Mutation/Injection framework.
- **The choice of benchmark changes the conclusions**, so recall claims must name their benchmark.

**Sajnani et al. 2016, SourcererCC (ICSE) [13] [FT], recall per tool:**

Mutation framework recall (T1/T2/T3), including **C#** (MonoOSC subject system):

| Tool | Java | C | C# |
|---|---|---|---|
| SourcererCC | 100/100/100 | 100/100/100 | 100/100/100 |
| CCFinderX (token-based) | 99/70/0 | 100/77/0 | 100/78/0 |
| Deckard | 39/39/37 | 73/72/69 | not run |
| iClones | 100/92/96 | 99/96/99 | not run |
| NiCad | 100/100/100 | 99/99/99 | 98/98/98 |

BigCloneBench recall over all clones. The columns are clone types: T1 and T2, then Type-3 clones grouped by syntactic similarity (VST3 very strong, ST3 strong, MT3 moderate, WT3/T4 weak or Type-4):

| Tool | T1 | T2 | VST3 | ST3 | MT3 | WT3/T4 |
|---|---|---|---|---|---|---|
| SourcererCC | 100 | 98 | 93 | 61 | 5 | 0 |
| CCFinderX | 100 | 93 | 62 | 15 | 1 | 0 |
| Deckard | 60 | 58 | 62 | 31 | 12 | 1 |
| iClones | 100 | 82 | 82 | 24 | 0 | 0 |
| NiCad | 100 | 100 | 100 | 95 | 1 | 0 |

Precision figures reported in the same paper: SourcererCC 91%; NiCad 89–96% in an earlier artificial-clone study (possibly about 60% under aggressive normalisation); CCFinder 60–72%; Deckard up to 93% at a stricter threshold.

**Ragkhitwetsagul et al. 2018 (EMSE) [14] [ABS]:**
- 30 similarity tools were compared.
- Optimal configurations are **highly data-set-specific**: configurations tuned on one data set perform poorly on another.

Inference for our pipeline (mine, not tested in these studies):
- jscpd and PMD-CPD are token-based. They should behave like the token-based group: near-complete Type-1 and Type-2 recall, but weak recall once statements are edited (Type-3).
- Combining a token-based detector with a more normalising detector is therefore complementary.
- Thresholds such as minimum tokens or lines should be declared and fixed, not tuned per repository [14].

### A.6 Do generic quality-rule violations predict faults?

**Lenarduzzi, Lomio, Huttunen, Taibi 2020 (SANER) [15] [FT]:**
- 21 mature Java projects were studied, with fault-inducing commits labelled by SZZ.
- Of SonarQube's 202 Java rules, the abstract says only 25 can be considered to have relatively low fault-proneness.
- The best model (XGBoost on rule violations) reached an average AUC of **0.83**, with precision 0.608 and recall 0.182.
- SonarQube's own "bug"-type rules used directly reached **AUC 0.509**, precision 0.086 and recall 0.028, which is essentially chance.

**Lenarduzzi, Saarimäki, Taibi 2020 (JSS) [16] [FT]:**
- 33 Apache Java projects; 173 rules violated; more than 95K technical-debt items in more than 200K classes.
- Clean classes are less change-prone than dirty ones, but the difference is small, and Cliff's δ effect sizes are mostly negligible.
- There is **no difference in fault-proneness** between clean and dirty classes.
- SonarQube's type and severity labels contain many incongruities.

Take-away: tool-assigned severities and "bug" labels **cannot be used as consequence weights without validation**. The ranking in Part C therefore uses outcome studies, not vendor severities.

---

## Part B — Estimating undetected defects from multiple detectors

### B.1 Lineage in software engineering

- **Eick, Loader, Long, Votta, Vander Wiel 1992 (ICSE)**, "Estimating software fault content before coding" [24] [BIB]. This is the first use of capture–recapture for software design reviews at AT&T. That description comes from memory; the abstract was not retrievable, so it is **[unverified]**.
- **Briand, El Emam, Freimut, Laitenberger 2000 (TSE)** [25] [ABS]:
  - They compared capture–recapture estimates with the *actual* remaining defects on real inspection data.
  - Models are **strongly affected by the number of inspectors**. When there are too few, **no model is sufficiently accurate and underestimation may be substantial**.
  - They recommend the model in which defects have different detection probabilities (**Mh**), together with its **jackknife** estimator.
  - They also identified theoretical limits on calibrating estimates by past relative error.
- **El Emam & Laitenberger 2001 (TSE)** [26] [ABS]:
  - A Monte-Carlo study of the two-inspector case.
  - The best estimator **allows inspectors with different capabilities**. It always produces an estimate, behaves predictably when its assumptions hold, and gives relatively high decision accuracy for re-inspection decisions.
  - This corresponds to the Mt family, of which the Chapman estimator below is the practical two-occasion form.
- **Petersson, Thelin, Runeson, Wohlin 2004 (JSS)**, "after 10 years" review [27] [BIB/TLDR]. According to the machine-generated summary only, most software-engineering capture–recapture research is evaluation work, and most of it ends up recommending **Mh-JK**. Treat this as consistent with [25] but **[unverified]** in detail.
- **Runeson & Wohlin 1998 (EMSE)** [28] [BIB]: an experience-based capture–recapture method for code inspections.
- **Testing and fuzzing analogues.** Böhme's STADS framework [38] [ABS] treats software testing as species discovery and imports ecological estimators to extrapolate total coverage and residual risk. Böhme, Liyanage and Wüstholz 2021 [39] [ABS] show that standard estimators **systematically and substantially underestimate** residual risk when sampling is *adaptively biased*. This is a warning that also applies to correlated static analysers.

### B.2 Mapping detectors to the capture–recapture setting

| Ecology | Our certifier |
|---|---|
| Closed population of N animals | The set of N real, *detectable-in-principle* issues of one category (secrets, vulnerable packages, SAST weaknesses, clones) in a single commit snapshot. The population is closed because the code does not change during analysis. |
| Capture occasion j = 1..k | Tool j (or tool family j) run on the snapshot |
| Mark / identity | Deduplicated finding fingerprint: normalised secret hash + file; package@version + advisory alias set; CWE family + file + line window or function; clone pair with overlap ≥ 0.7 (as in [11][13]) |
| Capture history (e.g. 101) | Which tools reported the deduplicated finding |
| f_i | Number of findings reported by exactly i of the k tools |
| S_obs | Number of distinct findings in the union = Σ f_i |
| N̂ − S_obs = f̂_0 | **Estimated detectable-but-missed findings** |

Only categories with an **unknown population of discrete defects** are suitable: secrets, dependencies, SAST and clones. Deterministic metrics such as complexity, coverage and size are measurements, not samples, and need no capture–recapture.

### B.3 Estimators (formulas)

Notation: k tools; n_j findings from tool j; S_obs findings in the union; f_1 and f_2 the numbers of findings seen by exactly one and exactly two tools.

**Two tools (k = 2).** m = findings reported by both tools.
- Lincoln–Petersen: N̂ = n₁n₂ / m. This is undefined when m = 0 and biased for small m.
- Chapman's bias-reduced form [34]: N̂_C = (n₁+1)(n₂+1)/(m+1) − 1.
  Var(N̂_C) = (n₁+1)(n₂+1)(n₁−m)(n₂−m) / [(m+1)²(m+2)].
- Both assume independent tools and equal catchability within each tool. Different capabilities *across* tools are allowed, which is model Mt, consistent with [26].

**Three or more tools (k ≥ 3).** The model family is from Otis et al. 1978 [33]:
- **M0**: one detection probability for everything.
- **Mt**: probabilities differ by tool (Darroch-type maximum likelihood).
- **Mh**: probabilities differ by finding, so some issues are easy and some hard.
- **Mth**: both tool and finding effects.
- (**Mb**, behavioural response, does not apply: tools do not "learn" between occasions.)

Estimators for Mh:
- **Jackknife** (Burnham & Overton 1978 [30]), first and second order:
  N̂_J1 = S_obs + f₁·(k−1)/k
  N̂_J2 = S_obs + f₁·(2k−3)/k − f₂·(k−2)²/[k(k−1)]
- **Chao lower-bound estimator** (Chao 1987 [29]). It is designed for the common case where most individuals are caught once or twice, which is exactly when the jackknife performs badly [29]. Incidence form:
  N̂_Ch = S_obs + ((k−1)/k) · f₁² / (2f₂)
  If f₂ = 0, use the bias-corrected form S_obs + ((k−1)/k)·f₁(f₁−1)/2.
  Variance (standard incidence-form approximation), with a = (k−1)/k and r = f₁/f₂:
  Var ≈ f₂ · [ (a/2)r² + a²r³ + (a²/4)r⁴ ]
- **Log-linear models** (Fienberg 1972 [31]):
  - Treat the 2^k capture histories as an incomplete contingency table in which the all-zero cell is missing.
  - Fit Poisson log-linear models with main effects plus selected **pairwise tool interactions**, then project the missing cell.
  - This is the standard way to model **dependence between sources**.
  - The R package Rcapture [32] implements M0, Mt, Mh (Chao, Poisson, Darroch, Gamma), Mth and log-linear models with interactions, with AIC-based comparison.

**Confidence interval for N.** Chao 1987 proposes an interval that keeps nominal coverage well [29]. The commonly used log-normal form is: with f̂₀ = N̂ − S_obs and C = exp( z·√ln(1 + Var(N̂)/f̂₀²) ), the interval is [S_obs + f̂₀/C, S_obs + f̂₀·C]. Its lower end can never fall below S_obs, unlike a Wald interval.

**Interval for a proportion.** This is used for per-tool recall on a seeded benchmark, or for "share of findings confirmed by at least 2 tools". Use the **Wilson score interval** [35]:
(p̂ + z²/2n ± z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n).
Wilson or Agresti–Coull intervals are recommended over the Wald interval for small n or extreme p [36][37].

### B.4 Assumptions and how correlated tools violate them

| Assumption | Holds for static tools? | Effect if violated | Mitigation |
|---|---|---|---|
| Closed population | **Yes**: one immutable commit snapshot | n/a | Pin the commit SHA in the report |
| Marks identified correctly (perfect dedup) | **No**: tools report different spans, rule IDs and secret encodings. Basak et al. needed fuzzy matching [7]; Bellon used overlap ≥ 0.7 [11]. | Missed matches deflate m and **inflate N̂**. Over-merging inflates m and **deflates N̂**. | Fixed, declared matching rules. Report a sensitivity range over thresholds (e.g. overlap 0.5/0.7/0.9). |
| Independence between occasions | **No**: tools share regex corpora, the NVD/GHSA databases, or the same taint engine (e.g. several SCA tools pulling NVD [9]) | Positive dependence makes m larger than under independence, so N̂ is **biased low**. Complementary specialists (negative dependence) bias it **high**. | (a) Group tools into **families** by technique or data source and treat each family as one occasion. (b) Fit log-linear models with interaction terms [31][32]. (c) Report the spread across plausible models. |
| Equal catchability across findings (M0/Lincoln–Petersen) | **No**: some issues are trivially detectable by all tools, others by none | Heterogeneity biases N̂ **low** | Use Mh (jackknife or Chao) [25][29][30]. Chao is a *lower bound* by construction. |
| Every individual has catchability > 0 | **No**: domain-specific bugs match no existing pattern [2]; 70.9% of real vulnerabilities escaped all 7 SAST tools [6]; secrets in images are invisible to regex tools [7] | Capture–recapture can only estimate the population **detectable by this class of tools**. The true residual is larger. | State explicitly that f̂₀ is a **lower bound on residual detectable issues** and does not bound total residual risk. Complement with seeded canaries (B.5). |
| Enough occasions | Often only 2–3 tools per category | Few occasions mean high variance and underestimation [25] | k = 2: Chapman/Mt [26]. k ≥ 3: Mh-JK / Chao [25][27]. Never report a point estimate without its interval. |
| Adaptive bias | Not adaptive within a run | n/a for static tools (relevant for fuzzing [39]) | n/a |

### B.5 Calibration by seeding (canaries)

Fault seeding gives each tool an independent occasion with a **known** population, so detection probabilities can be measured instead of inferred. Precedents include Bellon's "secret" injected clones [11] and the Mutation/Injection framework [12][13].

Procedure:
1. In a disposable copy of the repository, inject K canaries per category. Examples:
   - format-valid fake secrets of several types (AWS-style key, JWT, connection string, private key block);
   - a pinned NuGet package version with a published advisory;
   - templated C# injection snippets (SQL string concatenation into `SqlCommand`, path traversal into `File.ReadAllText`);
   - Type-1, Type-2 and Type-3 clone pairs.
2. Measure per-tool seed recall p̂_j with a Wilson interval, and the seed recall of the union.
3. Compare the union seed recall with the capture–recapture completeness Ĉ = S_obs / N̂.
   - If the union seed recall is clearly lower than Ĉ, the tools are positively dependent or heterogeneous, and the capture–recapture estimate is optimistic.
   - Report both numbers.
4. Keep seeds outside the delivered repository. Mark them with a unique nonce so they can never be confused with real findings.

### B.6 Recommended computation for the certifier

For each category with k ≥ 2 tools:
1. Run all tools on the same SHA, convert output to SARIF, and normalise rule IDs to a common taxonomy: CWE for SAST, advisory alias set for SCA, secret type for secrets.
2. Deduplicate with fixed, declared matching rules, and build the capture-history matrix.
3. Compute the estimates:
   - k = 2: Chapman N̂ with its variance and log-normal CI.
   - k ≥ 3: Chao (Mh), jackknife J1/J2, and log-linear models with up to pairwise interactions, selected by AIC/BIC.
   - Report the model range together with the chosen estimate.
4. Report, for example:
   > *Secrets — observed 12 distinct (union of 3 tools; 9 confirmed by ≥2 tools). Estimated detectable-but-missed f̂₀ = 3 (95% CI 1–9; Chao Mh); estimated completeness 80% (CI 57–92%). Seed recall of tool union 94% (Wilson 95% CI …). Lower bound: excludes secrets undetectable by pattern/entropy tools (e.g., images).*
   (All numbers in this example are illustrative.)
5. Gate semantics. Use f̂₀ as a **confidence qualifier**, not a pass/fail threshold, because its variance is high with few tools [25].
   - Hard blocks come from *observed* high-precision findings.
   - The residual estimate lowers the confidence level of the certificate, for example "High / Medium / Low assurance".

### B.7 Worked example (illustrative inputs, not data)

- **Two SCA tools**, with n₁ = 40, n₂ = 30 and m = 20:
  - S_obs = 50.
  - Lincoln–Petersen N̂ = 60; Chapman N̂_C = 59.5 (SE ≈ 5.1), so f̂₀ ≈ 9.5.
  - Log-normal 95% CI for N is about [53.5, 75.6].
- **Three SAST tools**, with f₁ = 30, f₂ = 12 and f₃ = 8:
  - S_obs = 50.
  - Chao N̂ = 50 + (2/3)·30²/(2·12) = **75.0** (SE ≈ 12.7; 95% CI about [59.8, 113.8]).
  - J1 = 70.0 and J2 = 78.0.
  - Completeness is S_obs/N̂ ≈ 0.67. Deriving its interval from the N interval gives roughly 0.44–0.84. A naive Wilson interval that treats N̂ as fixed gives 0.55–0.76. It ignores the uncertainty in N̂ and is too narrow, so **prefer the interval derived from the N interval**.
- The spread between estimators (70–78) shows model uncertainty and should be reported alongside the chosen value.

(The values were computed with a small script in the session scratchpad. The formulas are as in B.3.)

---

## Part C — Evidence for ranking checks by consequence, and the ranking itself

### C.1 Evidence base, by concern

**Meta-level fault-prediction evidence**
- Hall et al. 2012 (TSE) [40] [ABS]:
  - A review of 208 fault-prediction studies from 2000–2010, synthesising 36 that report enough context.
  - Simple techniques (Naive Bayes, logistic regression) and **combinations** of metrics tend to perform well.
  - Methodology has a strong influence on results.
- Radjenović et al. 2013 (IST) [41] [BIB/TLDR]. According to the summary only, object-oriented and **process** metrics were reported as more successful than traditional size and complexity metrics, and process metrics were better for post-release faults. The specific per-metric results (CBO/RFC/WMC effective, LCOM/DIT/NOC weaker) are **[unverified]**.
- Ostrand, Weyuker, Bell 2005 (TSE) [76] [ABS]: the 20% of files with the most predicted faults contained **71–92%** (mean 83%) of detected faults. Defects concentrate heavily, which supports hotspot-weighted gating.
- Nagappan & Ball 2005 [20] [ABS]: static-analysis defect density predicts pre-release defect density (82.91% classification).

**Size and complexity**
- El Emam et al. 2001 (TSE) [42] [ABS]: a **strong size confounding effect** on object-oriented metric validity. Before controlling for size, the expected metrics look validated; size must be controlled for.
- Gil & Lalouche 2017 (EMSE) [43] [BIB/TLDR]: a metric's validity can be predicted from its correlation with size, which suggests size is the only "unique" valid metric. **[TLDR only]**.
- Landman, Serebrenik, Vinju 2014 (ICSME) [44] [ABS]: across 17.8M methods in 13K Java projects, cyclomatic complexity (CC) and SLOC correlate only moderately at method level. CC is **not redundant** with SLOC, and aggregation inflates the correlation.
- Hatton 1997 (IEEE Software) [45] [ABS]: medium-sized components were proportionately more reliable than small or large ones, so the size–fault-density relationship is **not monotone**.
- Sjøberg et al. 2013 (TSE) [46] [ABS]:
  - Six professional developers worked on four functionally equivalent Java systems.
  - **None of 12 smells** was associated with more effort after adjusting for file size and number of changes.
  - **File size and number of changes explained almost all variance in effort**.
- Palomba et al. 2018 (EMSE) [47] [ABS]: 395 releases of 30 projects and 17,350 validated smell instances. Smells tied to **long and/or complex code** are highly diffused, and smelly classes are more change- and fault-prone.
- Khomh et al. 2012 (EMSE) [48] [BIB/TLDR]: classes in antipatterns are more change- and fault-prone, and size alone does not explain this. **[TLDR only]**.
- Shin, Meneely, Williams, Osborne 2011 (TSE) [49] [ABS]:
  - On Firefox and the RHEL kernel, 24 of 28 complexity, churn and developer metrics discriminate vulnerable files.
  - Combined models predicted over 80% of vulnerable files with under 25% false positives.
- Tornhill & Borg 2022 (TechDebt), "Code Red" [72] [FT]:
  - 39 proprietary codebases and 30,737 files.
  - CodeScene "Code Health" is a proprietary composite of ISO 5055-style maintainability elements plus design smells such as God Class, God Methods and Duplicated Code.
  - Average Jira defects per file: Healthy 0.25, Alert 3.70 (about 15×). Cohen's d = 0.73 between Healthy and Alert.
  - Time-in-development was **+124%** and maximum cycle time about **9×**.
  - Caveats: observational data and a proprietary metric. The paper reports Pearson r = −0.58 between Code Health and resolution time.
- Borg et al. 2024 (TechDebt) [73] [ABS]: the relationship between code quality and outcomes is **non-linear**, with amplified returns at the high-quality end. The authors recommend preventing smells in **high-churn** files.

**Coupling, cohesion and architecture**
- Basili, Briand, Melo 1996 (TSE; tech-report full text) [50] [FT]:
  - RFC, DIT and WMC were significant predictors of class fault-proneness (NOC was significant but in the reverse direction).
  - **CBO was significant**.
  - **LCOM was insignificant in all cases**, partly because of its definition (it is set to 0 for many classes).
- Gyimóthy, Ferenc, Siket 2005 (TSE) [51] [ABS]: CK metrics validated against Mozilla's Bugzilla. The abstract gives no per-metric results; the claim that CBO performed best is **[unverified]**.
- Zimmermann & Nagappan 2008 (ICSE) [52] [ABS]: on Windows Server 2003, dependency-graph network measures gave **10 percentage points higher recall** than complexity metrics, and identified **60%** of critical binaries, twice as many as complexity metrics.
- Mo et al. 2021 (TSE) [53] and Mo et al. 2015 (WICSA) [54] [ABS]: across 19 large projects, architecture anti-patterns significantly increase bug- and change-proneness, and files involved in more anti-patterns are worse. Unstable Interface and Crossing contribute most. The claim that cross-module and cross-package **cycles** are among the 2015 hotspot patterns is **[unverified]** (not in the abstract).

**Duplication**
- Juergens et al. 2009 (ICSE) [55] [FT]:
  - 5 systems, 1,427 clone groups.
  - **52%** of clone groups contained inconsistencies; 28% of those were unintentional.
  - **About 50% of unintentionally inconsistent clone groups were faulty**, and developers confirmed **107** faults.
  - Fault density in the inconsistencies was 48.1 per kLOC on average.
- Rahman, Bird, Devanbu 2010 (MSR) [56] [ABS]: the great majority of bugs are **not** significantly associated with clones; clones may be *less* defect-prone; little evidence that more copies means more errors.
- Kim et al. 2005 (FSE) [57] [ABS]: many clones are short-lived, and many long-lived clones cannot easily be refactored.
- Overall evidence is **mixed**. The risk lies in *inconsistent change* to clones rather than in duplication itself, which argues for gating on *new* duplication in changed code.

**Error handling**
- Yuan et al. 2014 (OSDI) [58] [FT]:
  - 198 user-reported failures in Cassandra, HBase, HDFS, MapReduce and Redis.
  - **92%** of catastrophic failures resulted from incorrect handling of explicitly signalled non-fatal errors.
  - In **58%** the faults could have been caught by simple tests of error-handling code.
  - In **35%** the faults matched three **trivial, statically detectable patterns**: (i) an empty handler or one that only logs; (ii) aborting on an overly general exception; (iii) "FIXME"/"TODO" left in the handler.
  - Incorrect error handling caused 25% of non-catastrophic failures.
- OWASP Top 10:2025 [77] [WEB] introduced **A10:2025 Mishandling of Exceptional Conditions**.

**Naming, documentation, readability, dead code, style**
- Butler et al. 2010 (CSMR) [59] [ABS]: flawed identifier names were associated with lower code quality as measured by static analysis, at both class and method level.
- Hofmeister, Siegmund, Holt 2017 (SANER) [60] [ABS]: an experiment with **72 professional C# developers**. Full-word identifiers gave **19% faster** defect finding than single letters or abbreviations.
- Buse & Weimer 2010 (TSE) [61] [ABS]: a readability metric correlated strongly with code changes, automated defect reports and defect log messages over 2.2 MLOC. Comments alone mattered less than blank lines for local readability judgments.
- Wen et al. 2019 (ICPC) [62] [ABS]: a taxonomy of code–comment inconsistencies, built from 1.3 billion AST-level changes across 1,500 systems.
- Aghajani et al. 2019 (ICSE) [63] [BIB]: a taxonomy of documentation issues.
- Romano et al. 2020 (TSE) [64] [ABS]: dead code appears widespread. Interviews plus four experiments suggest it is **harmful** during maintenance and evolution.
- Mäntylä & Lassenius 2009 (TSE) [74] [ABS]: in 9 industrial and 23 student reviews (388 and 371 defects), **75%** of review-found defects did not affect visible functionality; they were evolvability defects.
- Beller et al. 2014 (MSR) [75] [FT]: more than 1,400 review-induced changes. The **75:25** evolvability-to-functional ratio was replicated. **Code comments (about 20%) and identifiers (about 10%)** were the dominant change categories.

**Tests: coverage and mutation**
- Inozemtseva & Holmes 2014 (ICSE) [65] [FT abstract]:
  - 31,000 suites across 5 systems.
  - **Low to moderate** correlation between coverage and mutation-based effectiveness when suite size is controlled.
  - Stronger coverage criteria gave no extra insight.
  - The authors advise against using coverage as a *target*.
- Kochhar, Thung, Lo 2015 (SANER) [66] [ABS]: with real bugs (67 in HTTPClient, 92 in Rhino), the correlation between coverage and bugs killed was significant: moderate for HTTPClient, strong for Rhino.
- Chen et al. 2020 (ASE) [67] [ABS]: argues that test-suite size is neither a confounder nor an independent variable to manipulate. Proposes a methodology for comparing coverage-, mutation- and random-based testing on an equal footing.
- Ivanković et al. 2019 (FSE), "Code coverage at Google" [68] [ABS]: coverage is computed daily for one billion lines in seven languages. Coverage becomes actionable at the **changeset/code-review level**, which is the basis for gating on patch coverage. There were 512 survey responses from 3,000 developers.
- Just et al. 2014 (FSE) [69] [ABS]: on 357 real faults in 5 applications (321 KLOC), mutant detection correlates significantly with real-fault detection **independently of coverage**.
- Papadakis et al. 2018 (ICSE) [70] [ABS]: correlations become **weak** once suite size is controlled. However, choosing suites by higher mutation score significantly improves fault detection, so mutants are good *guidance*.
- Petrović et al. 2021 (ICSE) [71] [FT]: from about 15M mutants at Google, mutants were coupled with **70% (1,043 of 1,502)** of high-priority bugs. Mutation testing on the bug-introducing change would have reported a live, fault-coupled mutant.

**Security frequency and consequence**
- CWE Top 25 2025 [78] [WEB]:
  - Based on 39,080 CVE records from 1 June 2024 to 1 June 2025.
  - Score = normalised frequency × normalised severity × 100, a multiplicative precedent for our formula.
  - Top entries: #1 CWE-79 XSS (60.38), #2 CWE-89 SQL injection (28.72), #3 CWE-352 CSRF, #4 CWE-862 Missing Authorization.
  - Other relevant ranks: CWE-22 path traversal #6, CWE-78 OS command injection #9, CWE-502 deserialization #15, CWE-20 input validation #18, CWE-918 SSRF #22.
  - **CWE-798 hard-coded credentials is not in the 2025 list.**
- CWE Top 25 2024 [79] [WEB]: based on 31,770 CVE records. CWE-798 was **#22** (score 3.46).
- OWASP Top 10:2025 [77] [WEB]:
  - A01 Broken Access Control
  - A02 Security Misconfiguration
  - **A03 Software Supply Chain Failures**
  - A04 Cryptographic Failures
  - A05 Injection
  - A06 Insecure Design
  - A07 Authentication Failures
  - A08 Software or Data Integrity Failures
  - A09 Security Logging and Alerting Failures
  - **A10 Mishandling of Exceptional Conditions**
- Verizon DBIR 2025 [80] [FT]:
  - Exploitation of vulnerabilities was the initial access vector in **20%** of breaches, a 34% increase. Edge devices and VPNs made up 22% of exploitation targets.
  - Third-party involvement doubled from 15% to **30%**.
  - Credential abuse remained the most common vector.
  - DBIR 2026 landing page [81] [WEB]: **31%** of breaches started with software vulnerabilities, overtaking stolen credentials. Only the landing page was read.
  - Caveat: DBIR figures cover all exploited vulnerabilities, including edge devices, and are not specific to application dependencies.

**Delivery outcomes (DORA)**
- DORA [83] [WEB] currently uses five software delivery metrics: change lead time, deployment frequency, failed deployment recovery time, change fail rate, and the newer deployment rework rate.
- The DORA 2024 report page [84] [WEB] states that AI adoption negatively affects delivery **stability and throughput** and that small batches and robust testing are therefore crucial. The exact percentages are **[unverified]** because the PDF was not read.
- Relevance: DORA metrics are the outcome layer that a certifier ultimately serves. Change fail rate is the closest outcome to "failing tests", "untested changes" and "mishandled errors".

### C.2 The ranking formula

**Importance(check) = E × C × P × M**, each scored on an anchored 1–5 integer scale. For readability, report the geometric mean (E·C·P·M)^¼; this gives an identical ordering. Also report **Impact = E × C × P** (without M), so that "matters a lot but is hard to measure" stays visible.

Why multiplicative:
- A check with negligible consequence or no measurable signal should not rank high because it scores well on another axis.
- This is the same reasoning as the CWE Top 25 score (frequency × severity) [78].
- Ties are broken by C, then E.

Anchors:

| Score | E: evidence strength (issue → bad outcome) | C: consequence when it manifests | P: prevalence | M: measurability without AI |
|---|---|---|---|---|
| 5 | Definitional, or multiple large real-world/incident datasets agree | Security compromise / breach / catastrophic production failure | Very common (most repos, or a top-ranked incident cause) | Deterministic, binary or exact (tests, instrumentation, version matching) |
| 4 | At least one large study with a clear effect, plus consistent support | Functional defect likely to reach users | Common | High-precision static detection; recall good for the main sub-types |
| 3 | Significant but small, or confounded (size), or mixed | Raised defect risk / slower delivery, measured | Moderate, or **no data (neutral default)** | Detectable but noisy (low precision or recall), or several metric variants disagree |
| 2 | Weak, indirect (comprehension only), or contradictory | Comprehension or maintenance cost without a measured defect link | Uncommon | Proxy or heuristic only (presence, not quality) |
| 1 | No empirical link found | Cosmetic | Rare | Needs human judgment |

Scoring rules:
- (1) Every cell cites at least one source, or is marked "neutral default".
- (2) When sources conflict, take the median of the studies' implied scores and note the conflict.
- (3) Vendor severities are not used, because they are invalid as consequence measures [15][16].
- (4) M covers both precision and recall. Low M means **a clean result is weak evidence**. It does **not** mean a finding is unimportant. Gate semantics: a finding in a high-C category blocks even when M is low.

### C.3 Scores, with evidence per cell

| # | Check (C# tooling examples) | E | C | P | M | Impact E·C·P | **Gate E·C·P·M** | Geo-mean |
|---|---|---|---|---|---|---|---|---|
| 1 | **Secrets in code/history** (gitleaks, trufflehog --only-verified, detect-secrets) | 4 | 5 | 4 | 4 | 80 | **320** | 4.23 |
| 2 | **Vulnerable dependencies** (dotnet list package --vulnerable, osv-scanner, trivy) | 4 | 5 | 4 | 4 | 80 | **320** | 4.23 |
| 3 | **Failing tests** (dotnet test) | 5 | 4 | 3 | 5 | 60 | **300** | 4.16 |
| 4 | **Error-handling anti-patterns** (empty/log-only catch, catch-all, TODO in handler) | 4 | 4 | 3 | 4 | 48 | **192** | 3.72 |
| 5 | **Mutation score on changed code** (Stryker.NET) | 4 | 4 | 3 | 4 | 48 | **192** | 3.72 |
| 6 | **Patch/diff coverage** (coverlet + diff) | 3 | 4 | 3 | 5 | 36 | **180** | 3.66 |
| 7 | **Complexity** (cyclomatic/cognitive; lizard, Roslyn metrics) | 3 | 3 | 4 | 5 | 36 | **180** | 3.66 |
| 8 | **Unit size** (method/class LOC) | 3 | 3 | 4 | 5 | 36 | **180** | 3.66 |
| 9 | **SAST vulnerabilities** (CodeQL, Semgrep, Roslyn security analyzers) | 4 | 5 | 4 | 2 | **80** | **160** | 3.56 |
| 10 | **Coupling / dependency cycles** | 4 | 3 | 3 | 4 | 36 | **144** | 3.46 |
| 11 | **Duplication** (jscpd, PMD-CPD) | 3 | 3 | 4 | 4 | 36 | **144** | 3.46 |
| 12 | Generic rule-violation counts (Sonar-style TD items) | 2 | 2 | 5 | 4 | 20 | 80 | 2.99 |
| 13 | Documentation (XML doc presence / comment consistency) | 2 | 2 | 5 | 2 | 20 | 40 | 2.51 |
| 14 | Cohesion (LCOM variants) | 2 | 2 | 3 | 3 | 12 | 36 | 2.45 |
| 15 | Dead code (unused members) | 2 | 2 | 3 | 3 | 12 | 36 | 2.45 |
| 16 | Naming conventions | 2 | 2 | 4 | 2 | 16 | 32 | 2.38 |
| 17 | Style consistency (dotnet format) | 1 | 1 | 4 | 5 | 4 | 20 | 2.11 |
| 18 | Magic numbers | 1 | 2 | 3 | 3 | 6 | 18 | 2.06 |

**Evidence per cell:**

1. **Secrets**
   - E4: widespread leakage, with 81% of leaked secrets not removed [8]; 70% of 2022 leaks still valid [82]; 94-day median remediation [80]; credential abuse is the top breach vector [80]. Not E5, because the share of breaches caused specifically by *repo-leaked* secrets is not quantified in what I read.
   - C5: these are credentials. CWE-798 was in the Top 25 in 2024 [79].
   - P4: 35% of private repos contain at least one secret; 23.8M new public leaks in 2024 [82].
   - M4: pattern-based and verifiable. The best union recall is high (Gitleaks alone reaches 0.88 repo-level), and precision with verification is about 90% [7]. Not 5, because precision varies 1–75% and some file types are skipped [7].
2. **Vulnerable dependencies**
   - E4: exploitation of vulnerabilities was 20% of initial access (2025) [80] and 31% (2026 page) [81]. Not E5, because DBIR mixes in edge devices.
   - C5: known, often weaponised CVEs. OWASP A03:2025 Software Supply Chain Failures [77].
   - P4: every tool flagged vulnerable dependencies in the case application (17–332) [9]. A general prevalence rate across repositories is **[no verified figure]**, so 4 is a judgment.
   - M4: deterministic version-to-advisory matching. But databases disagree [9] and re-bundling defeats scanners [10], so it is not 5.
3. **Failing tests**
   - E5: definitional. A failing test is an observed violation of specified behaviour.
   - C4: a functional defect.
   - P3: neutral default, since I found no prevalence data.
   - M5: binary and deterministic (flakiness must be controlled, e.g. by re-running).
4. **Error handling**
   - E4: 92% of catastrophic failures come from mishandled non-fatal errors, and 35% match trivial static patterns [58]; OWASP A10:2025 [77].
   - C4: catastrophic failures [58]. Not 5, because the consequence is usually availability rather than compromise.
   - P3: 25% of non-catastrophic failures [58]. Code-level prevalence was not measured.
   - M4: the three patterns are syntactically detectable [58]. Example Roslyn/Sonar rules are CA1031 (catch general exception), S108/S2486 (empty or ignored catch) and a TODO/FIXME scan; these rule IDs come from tool docs and were **not re-verified here**.
5. **Mutation score**
   - E4: correlation independent of coverage [69]; coupled to 70% of high-priority bugs [71]. Correlation weak after size control, but useful as guidance [70].
   - C4: test gaps let functional defects through.
   - P3: neutral default.
   - M4: deterministic but costly; equivalent mutants add noise.
6. **Patch coverage**
   - E3: low-to-moderate correlation with effectiveness [65]; significant correlation with real bugs [66]; used at changeset level at Google [68]; 23% of catastrophic failures would have been caught by statement coverage [58].
   - C4.
   - P3: neutral default.
   - M5: instrumentation-exact.
7. **Complexity**
   - E3: complexity discriminates vulnerable files [49]; long/complex smells are fault-prone [47]; not redundant with SLOC [44]. But size confounding [42][43] and no effect on effort after size adjustment [46].
   - C3.
   - P4: long/complex smells are highly diffused [47].
   - M5: exact computation (choose one definition and declare it).
8. **Unit size**
   - E3: size dominates [42][43][46], but the relationship is non-monotone [45].
   - C3. P4 [47]. M5.
9. **SAST vulnerabilities**
   - E4: the CWE Top 25 is built from 39,080 real CVEs and its top categories are code-level injection classes (XSS #1, SQL injection #2) [78].
   - C5.
   - P4: frequency-ranked [78].
   - **M2**: individual tools detect 12.7% of real vulnerabilities and the union still misses 70.9% [6]; individual tools miss 47–80% [3]. **Impact is top-tier (80); only measurability pulls it down.** Positive findings should still block.
10. **Coupling / cycles**
    - E4: network measures beat complexity metrics [52]; CBO and RFC significant [50]; architecture anti-patterns raise bug-proneness [53][54].
    - C3.
    - P3: neutral default.
    - M4: deterministic graph analysis. Thresholds are conventions.
11. **Duplication**
    - E3: inconsistent clones are faulty about 50% of the time [55], but clones are not more defect-prone overall [56], and many are short-lived [57].
    - C3.
    - P4: clones are frequent. 52% of clone groups were inconsistent [55], and Bellon et al.'s introduction cites 7–23% duplication from prior work [11].
    - M4: Type-1/Type-2 recall is about 100% with precision around 90% [13]. Type-3 recall varies widely and tools disagree [11][12][13].
12. **Generic rule counts**
    - E2: no difference in fault-proneness [16]; "bug" rules at chance level [15]; only 13% of issues fixed [17].
    - C2. P5: ubiquitous [16][17]. M4.
13. **Documentation**
    - E2: indirect evidence only [61][62][63].
    - C2.
    - P5: comments are the single largest review-change category at about 20% [75].
    - M2: presence is measurable (e.g. CS1591); quality is not.
14. **Cohesion**
    - E2: LCOM insignificant in all cases [50].
    - C2. P3: neutral default.
    - M3: several LCOM variants.
15. **Dead code**
    - E2: experiments suggest harm [64].
    - C2.
    - P3: "appears widespread" [64].
    - M3: private members are exact (IDE0051); public reachability is uncertain.
16. **Naming**
    - E2: associated with static-analysis quality [59]; comprehension speed (C# professionals) [60].
    - C2.
    - P4: about 10% of review changes [75].
    - M2: conventions are checkable (IDE1006); semantic quality needs a human.
17. **Style consistency**
    - E1: no defect link found.
    - C1.
    - P4: style fixes are part of the 75% evolvability share, but sub-share figures are not verified here [74][75].
    - M5: deterministic formatter.
18. **Magic numbers**
    - E1: no empirical defect link found in this search (absence of evidence, given the limited search).
    - C2. P3: neutral default.
    - M3: syntactically detectable (e.g. Sonar S109, **[rule ID unverified]**), with many false positives such as 0, 1 and array sizes.

### C.4 Sensitivity analysis (computed)

Rankings were recomputed under three alternatives:
- (a) without M, i.e. Impact only;
- (b) evidence weighted double (E²·C·P·M);
- (c) 20,000 Monte-Carlo runs in which every score was independently perturbed by −1, 0 or +1 and clipped to [1, 5].

| Check | Base rank | Rank without M | Rank with E² | MC median rank | P(top 5) |
|---|---|---|---|---|---|
| Secrets | 1 | 1 | 2 | 3 | 0.83 |
| Vulnerable dependencies | 2 | 2 | 3 | 3 | 0.84 |
| Failing tests | 3 | 4 | 1 | 3 | 0.75 |
| Error handling | 4 | 5 | 4 | 6 | 0.44 |
| Mutation score | 5 | 6 | 5 | 6 | 0.43 |
| Patch coverage | 6 | 7 | 8 | 7 | 0.33 |
| Complexity | 7 | 9 | 9 | 7 | 0.33 |
| Unit size | 8 | 10 | 10 | 7 | 0.32 |
| SAST | 9 | **3** | 6 | 8 | 0.27 |
| Coupling / cycles | 10 | 8 | 7 | 9 | 0.22 |
| Duplication | 11 | 11 | 11 | 8 | 0.22 |
| Generic rule counts | 12 | 12 | 12 | 12 | 0.03 |
| Documentation | 13 | 13 | 13 | 15 | 0.00 |
| Cohesion | 14 | 15 | 14 | 15 | 0.00 |
| Dead code | 15 | 16 | 15 | 15 | 0.00 |
| Naming | 16 | 14 | 16 | 16 | 0.00 |
| Style consistency | 17 | 18 | 17 | 15 | 0.00 |
| Magic numbers | 18 | 17 | 18 | 16 | 0.00 |

Robust conclusions:
- (i) The three hard-evidence, high-consequence checks are stable at the top: secrets, vulnerable dependencies and failing tests.
- (ii) The middle band (ranks 4–11) is **not** strictly ordered. Treat it as one tier.
- (iii) The bottom six never reach the top five. With the evidence available, they should be **informational**, not blocking.
- (iv) SAST moves between rank 3 and rank 9 depending only on whether measurability is included. Hence the recommended asymmetric policy: **block on SAST findings of high confidence and high severity, but do not let "no SAST findings" add assurance**.

### C.5 Resulting gate tiers (proposal)

- **Tier 1 — blocking:**
  - verified or high-confidence secrets;
  - dependencies with known advisories above a severity floor;
  - any failing test;
  - high-confidence SAST findings in CWE Top-25 classes.
- **Tier 2 — thresholded on changed code (new code only):**
  - error-handling anti-patterns;
  - mutation score and patch coverage;
  - complexity and unit size on new or modified methods;
  - new dependency cycles;
  - new duplication. Weight by churn, following the advice to prevent smells in high-churn files [73] and the heavy concentration of defects [76].
- **Tier 3 — advisory, reported but not blocking:** cohesion, documentation, naming, dead code, magic numbers, style, generic rule counts.
- **Assurance qualifier, from Part B:** for each multi-tool category, publish S_obs, f̂₀ with its CI, and the seed recall. The certificate's confidence level drops when f̂₀'s upper bound is large or seed recall is low.

### C.6 Caveats

- E, C, P and M are ordinal judgments anchored to evidence, not measured quantities. The formula is transparent and reproducible, but it is not "objective". Publish the score table with the certificate and accept change requests backed by citations.
- Most fault-prediction evidence is about Java or C. C#-specific evidence is scarce here; the exceptions are the C# subject system in the clone mutation framework [13] and the C# developer experiment [60]. Transfer to C# is an assumption.
- Several prevalence cells use the neutral default of 3 because I found no data. These are the first cells to update with telemetry from the team's own repositories.

---

## References

Status tags: [FT] full text read · [ABS] abstract verified · [BIB] bibliographic record only · [TLDR] Semantic Scholar machine summary only · [WEB] official page fetched.

Every DOI below was resolved by a lookup that returned the matching title (Semantic Scholar, OpenAlex or Crossref), except refs 33 and 34, which have no DOI. Volume, issue and page numbers come from bibliographic memory and were not individually checked.

**Part A — tool overlap and detection**
1. N. Rutar, C. B. Almazan, J. S. Foster. *A Comparison of Bug Finding Tools for Java.* ISSRE 2004. https://doi.org/10.1109/ISSRE.2004.1 [ABS]
2. A. Habib, M. Pradel. *How Many of All Bugs Do We Find? A Study of Static Bug Detectors.* ASE 2018, pp. 317–328. https://doi.org/10.1145/3238147.3238213 [ABS]. Artifact: https://github.com/sola-da/StaticBugCheckers
3. S. Lipp, S. Banescu, A. Pretschner. *An Empirical Study on the Effectiveness of Static C Code Analyzers for Vulnerability Detection.* ISSTA 2022. https://doi.org/10.1145/3533767.3534380 [ABS]
4. F. Thung, Lucia, D. Lo, L. Jiang, F. Rahman, P. Devanbu. *To What Extent Could We Detect Field Defects? An Empirical Study of False Negatives in Static Bug Finding Tools.* ASE 2012. https://doi.org/10.1145/2351676.2351685 [ABS]
5. B. Johnson, Y. Song, E. Murphy-Hill, R. Bowdidge. *Why Don't Software Developers Use Static Analysis Tools to Find Bugs?* ICSE 2013. https://doi.org/10.1109/ICSE.2013.6606613 [ABS]
6. K. Li, S. Chen, L. Fan, R. Feng, H. Liu, C. Liu, et al. *Comparison and Evaluation on Static Application Security Testing (SAST) Tools for Java.* ESEC/FSE 2023. https://doi.org/10.1145/3611643.3616262 [ABS]
7. S. K. Basak, J. Cox, B. Reaves, L. Williams. *A Comparative Study of Software Secrets Reporting by Secret Detection Tools.* ESEM 2023. https://doi.org/10.1109/ESEM56168.2023.10304853 · https://arxiv.org/abs/2307.00714 [FT]
8. M. Meli, M. R. McNiece, B. Reaves. *How Bad Can It Git? Characterizing Secret Leakage in Public GitHub Repositories.* NDSS 2019. https://doi.org/10.14722/ndss.2019.23418 · https://www.ndss-symposium.org/wp-content/uploads/2019/02/ndss2019_04B-3_Meli_paper.pdf [FT]
9. N. Imtiaz, S. Thorn, L. Williams. *A Comparative Study of Vulnerability Reporting by Software Composition Analysis Tools.* ESEM 2021. https://doi.org/10.1145/3475716.3475769 · https://arxiv.org/abs/2108.12078 [FT]
10. A. Dann, H. Plate, B. Hermann, S. E. Ponta, E. Bodden. *Identifying Challenges for OSS Vulnerability Scanners — A Study & Test Suite.* IEEE TSE 2021. https://doi.org/10.1109/TSE.2021.3101739 [ABS]
11. S. Bellon, R. Koschke, G. Antoniol, J. Krinke, E. Merlo. *Comparison and Evaluation of Clone Detection Tools.* IEEE TSE 33(9), 2007. https://doi.org/10.1109/TSE.2007.70725 · PDF mirror: http://plg.uwaterloo.ca/~migod/846/papers/bellon-tse07.pdf [FT]
12. J. Svajlenko, C. K. Roy. *Evaluating Modern Clone Detection Tools.* ICSME 2014. https://doi.org/10.1109/ICSME.2014.54 [ABS]
13. H. Sajnani, V. Saini, J. Svajlenko, C. K. Roy, C. V. Lopes. *SourcererCC: Scaling Code Clone Detection to Big Code.* ICSE 2016. https://arxiv.org/abs/1512.06448 [FT]
14. C. Ragkhitwetsagul, J. Krinke, D. Clark. *A Comparison of Code Similarity Analysers.* EMSE 2018. https://doi.org/10.1007/s10664-017-9564-7 [ABS]
15. V. Lenarduzzi, F. Lomio, H. Huttunen, D. Taibi. *Are SonarQube Rules Inducing Bugs?* SANER 2020. https://doi.org/10.1109/SANER48275.2020.9054821 · https://arxiv.org/abs/1907.00376 [FT]
16. V. Lenarduzzi, N. Saarimäki, D. Taibi. *Some SonarQube Issues Have a Significant but Small Effect on Faults and Changes. A Large-Scale Empirical Study.* JSS 170, 2020, 110750. https://doi.org/10.1016/j.jss.2020.110750 · https://arxiv.org/abs/1908.11590 [FT]
17. D. Marcilio, R. Bonifácio, E. Monteiro, E. Canedo, W. Luz, G. Pinto. *Are Static Analysis Violations Really Fixed? A Closer Look at Realistic Usage of SonarQube.* ICPC 2019. https://doi.org/10.1109/ICPC.2019.00040 [ABS]
18. S. Kim, M. D. Ernst. *Which Warnings Should I Fix First?* ESEC/FSE 2007. https://doi.org/10.1145/1287624.1287633 [ABS]
19. H. J. Kang, K. L. Aw, D. Lo. *Detecting False Alarms from Automatic Static Analysis Tools: How Far Are We?* ICSE 2022. https://doi.org/10.1145/3510003.3510214 · https://arxiv.org/abs/2202.05982 [ABS]
20. N. Nagappan, T. Ball. *Static Analysis Tools as Early Indicators of Pre-Release Defect Density.* ICSE 2005. https://doi.org/10.1145/1062455.1062558 [ABS]
21. M. Beller, R. Bholanath, S. McIntosh, A. Zaidman. *Analyzing the State of Static Analysis: A Large-Scale Evaluation in Open Source Software.* SANER 2016. https://doi.org/10.1109/SANER.2016.105 [ABS]
22. C. Sadowski, E. Aftandilian, A. Eagle, L. Miller-Cushon, C. Jaspan. *Lessons from Building Static Analysis Tools at Google.* CACM 61(4), 2018. https://doi.org/10.1145/3188720 [BIB]
23. S. Heckman, L. Williams. *A Systematic Literature Review of Actionable Alert Identification Techniques for Automated Static Code Analysis.* IST 53(4), 2011. https://doi.org/10.1016/j.infsof.2010.12.007 [BIB]

**Part B — capture–recapture and interval estimation**

24. S. G. Eick, C. R. Loader, M. D. Long, L. G. Votta, S. Vander Wiel. *Estimating Software Fault Content Before Coding.* ICSE 1992, pp. 59–65. https://doi.org/10.1145/143062.143090 [BIB]
25. L. C. Briand, K. El Emam, B. G. Freimut, O. Laitenberger. *A Comprehensive Evaluation of Capture-Recapture Models for Estimating Software Defect Content.* IEEE TSE 26(6), 2000. https://doi.org/10.1109/32.852741 [ABS]
26. K. El Emam, O. Laitenberger. *Evaluating Capture-Recapture Models with Two Inspectors.* IEEE TSE 27(9), 2001. https://doi.org/10.1109/32.950319 [ABS]
27. H. Petersson, T. Thelin, P. Runeson, C. Wohlin. *Capture–Recapture in Software Inspections after 10 Years Research — Theory, Evaluation and Application.* JSS 72(2), 2004. https://doi.org/10.1016/S0164-1212(03)00090-6 [BIB/TLDR]
28. P. Runeson, C. Wohlin. *An Experimental Evaluation of an Experience-Based Capture-Recapture Method in Software Code Inspections.* EMSE 3, 1998. https://doi.org/10.1023/A:1009728205264 [BIB]
29. A. Chao. *Estimating the Population Size for Capture-Recapture Data with Unequal Catchability.* Biometrics 43(4), 1987. https://doi.org/10.2307/2531532 [ABS]
30. K. P. Burnham, W. S. Overton. *Estimation of the Size of a Closed Population when Capture Probabilities Vary Among Animals.* Biometrika 65(3), 1978. https://doi.org/10.1093/biomet/65.3.625 [ABS]
31. S. E. Fienberg. *The Multiple Recapture Census for Closed Populations and Incomplete 2^k Contingency Tables.* Biometrika 59(3), 1972. https://doi.org/10.1093/biomet/59.3.591 [ABS]
32. S. Baillargeon, L.-P. Rivest. *Rcapture: Loglinear Models for Capture-Recapture in R.* Journal of Statistical Software 19(5), 2007. https://doi.org/10.18637/jss.v019.i05 [BIB]
33. D. L. Otis, K. P. Burnham, G. C. White, D. R. Anderson. *Statistical Inference from Capture Data on Closed Animal Populations.* Wildlife Monographs 62, 1978. [BIB not fetched; model notation M0/Mt/Mb/Mh]
34. D. G. Chapman. *Some Properties of the Hypergeometric Distribution with Applications to Zoological Sample Censuses.* Univ. California Publications in Statistics 1, 1951. [BIB not fetched; standard source of the Chapman estimator]
35. E. B. Wilson. *Probable Inference, the Law of Succession, and Statistical Inference.* JASA 22(158), 1927. https://doi.org/10.1080/01621459.1927.10502953 [BIB]
36. A. Agresti, B. A. Coull. *Approximate Is Better than "Exact" for Interval Estimation of Binomial Proportions.* The American Statistician 52(2), 1998. https://doi.org/10.1080/00031305.1998.10480550 [BIB]
37. L. D. Brown, T. T. Cai, A. DasGupta. *Interval Estimation for a Binomial Proportion.* Statistical Science 16(2), 2001. https://doi.org/10.1214/ss/1009213286 [BIB]
38. M. Böhme. *STADS: Software Testing as Species Discovery.* ACM TOSEM 27(2), 2018. https://doi.org/10.1145/3210309 · https://arxiv.org/abs/1803.02130 [ABS]
39. M. Böhme, D. Liyanage, V. Wüstholz. *Estimating Residual Risk in Greybox Fuzzing.* ESEC/FSE 2021. https://doi.org/10.1145/3468264.3468570 [ABS]

**Part C — consequence and impact evidence**

40. T. Hall, S. Beecham, D. Bowes, D. Gray, S. Counsell. *A Systematic Literature Review on Fault Prediction Performance in Software Engineering.* IEEE TSE 38(6), 2012. https://doi.org/10.1109/TSE.2011.103 [ABS]
41. D. Radjenović, M. Heričko, R. Torkar, A. Živkovič. *Software Fault Prediction Metrics: A Systematic Literature Review.* IST 55(8), 2013. https://doi.org/10.1016/j.infsof.2013.02.009 [BIB/TLDR]
42. K. El Emam, S. Benlarbi, N. Goel, S. N. Rai. *The Confounding Effect of Class Size on the Validity of Object-Oriented Metrics.* IEEE TSE 27(7), 2001. https://doi.org/10.1109/32.935855 [ABS]
43. Y. Gil, G. Lalouche. *On the Correlation between Size and Metric Validity.* EMSE 22, 2017. https://doi.org/10.1007/s10664-017-9513-5 [BIB/TLDR]
44. D. Landman, A. Serebrenik, J. Vinju. *Empirical Analysis of the Relationship between CC and SLOC in a Large Corpus of Java Methods.* ICSME 2014. https://doi.org/10.1109/ICSME.2014.44 [ABS]
45. L. Hatton. *Reexamining the Fault Density–Component Size Connection.* IEEE Software 14(2), 1997. https://doi.org/10.1109/52.582978 [ABS]
46. D. I. K. Sjøberg, A. Yamashita, B. Anda, A. Mockus, T. Dybå. *Quantifying the Effect of Code Smells on Maintenance Effort.* IEEE TSE 39(8), 2013. https://doi.org/10.1109/TSE.2012.89 [ABS]
47. F. Palomba, G. Bavota, M. Di Penta, F. Fasano, R. Oliveto, A. De Lucia. *On the Diffuseness and the Impact on Maintainability of Code Smells: A Large Scale Empirical Investigation.* EMSE 23, 2018. https://doi.org/10.1007/s10664-017-9535-z [ABS]
48. F. Khomh, M. Di Penta, Y.-G. Guéhéneuc, G. Antoniol. *An Exploratory Study of the Impact of Antipatterns on Class Change- and Fault-Proneness.* EMSE 17, 2012. https://doi.org/10.1007/s10664-011-9171-y [BIB/TLDR]
49. Y. Shin, A. Meneely, L. Williams, J. A. Osborne. *Evaluating Complexity, Code Churn, and Developer Activity Metrics as Indicators of Software Vulnerabilities.* IEEE TSE 37(6), 2011. https://doi.org/10.1109/TSE.2010.81 [ABS]
50. V. R. Basili, L. C. Briand, W. L. Melo. *A Validation of Object-Oriented Design Metrics as Quality Indicators.* IEEE TSE 22(10), 1996. https://doi.org/10.1109/32.544352 · tech-report full text (CS-TR-3443): https://drum.lib.umd.edu/bitstreams/d038e3cc-d184-4dae-823b-3f39a6a400cb/download [FT]
51. T. Gyimóthy, R. Ferenc, I. Siket. *Empirical Validation of Object-Oriented Metrics on Open Source Software for Fault Prediction.* IEEE TSE 31(10), 2005. https://doi.org/10.1109/TSE.2005.112 [ABS]
52. T. Zimmermann, N. Nagappan. *Predicting Defects Using Network Analysis on Dependency Graphs.* ICSE 2008. https://doi.org/10.1145/1368088.1368161 [ABS]
53. R. Mo, Y. Cai, R. Kazman, L. Xiao, Q. Feng. *Architecture Anti-Patterns: Automatically Detectable Violations of Design Principles.* IEEE TSE 47(5), 2021. https://doi.org/10.1109/TSE.2019.2910856 [ABS]
54. R. Mo, Y. Cai, R. Kazman, L. Xiao. *Hotspot Patterns: The Formal Definition and Automatic Detection of Architecture Smells.* WICSA 2015. https://doi.org/10.1109/WICSA.2015.12 [ABS]
55. E. Juergens, F. Deissenboeck, B. Hummel, S. Wagner. *Do Code Clones Matter?* ICSE 2009. https://doi.org/10.1109/ICSE.2009.5070547 · https://arxiv.org/abs/1701.05472 [FT]
56. F. Rahman, C. Bird, P. Devanbu. *Clones: What Is That Smell?* MSR 2010 (extended: EMSE 17, 2012, https://doi.org/10.1007/s10664-011-9195-3). https://doi.org/10.1109/MSR.2010.5463343 [ABS]
57. M. Kim, V. Sazawal, D. Notkin, G. Murphy. *An Empirical Study of Code Clone Genealogies.* ESEC/FSE 2005. https://doi.org/10.1145/1081706.1081737 [ABS]
58. D. Yuan, Y. Luo, X. Zhuang, G. R. Rodrigues, X. Zhao, Y. Zhang, P. U. Jain, M. Stumm. *Simple Testing Can Prevent Most Critical Failures: An Analysis of Production Failures in Distributed Data-Intensive Systems.* OSDI 2014. https://www.usenix.org/conference/osdi14/technical-sessions/presentation/yuan [FT]
59. S. Butler, M. Wermelinger, Y. Yu, H. Sharp. *Exploring the Influence of Identifier Names on Code Quality: An Empirical Study.* CSMR 2010. https://doi.org/10.1109/CSMR.2010.27 [ABS]
60. J. Hofmeister, J. Siegmund, D. V. Holt. *Shorter Identifier Names Take Longer to Comprehend.* SANER 2017. https://doi.org/10.1109/SANER.2017.7884623 [ABS]
61. R. P. L. Buse, W. Weimer. *Learning a Metric for Code Readability.* IEEE TSE 36(4), 2010. https://doi.org/10.1109/TSE.2009.70 [ABS]
62. F. Wen, C. Nagy, G. Bavota, M. Lanza. *A Large-Scale Empirical Study on Code-Comment Inconsistencies.* ICPC 2019. https://doi.org/10.1109/ICPC.2019.00019 [ABS]
63. E. Aghajani, C. Nagy, O. L. Vega-Márquez, M. Linares-Vásquez, L. Moreno, G. Bavota, et al. *Software Documentation Issues Unveiled.* ICSE 2019. https://doi.org/10.1109/ICSE.2019.00122 [BIB]
64. S. Romano, C. Vendome, G. Scanniello, D. Poshyvanyk. *A Multi-Study Investigation into Dead Code.* IEEE TSE 46(1), 2020. https://doi.org/10.1109/TSE.2018.2842781 [ABS]
65. L. Inozemtseva, R. Holmes. *Coverage Is Not Strongly Correlated with Test Suite Effectiveness.* ICSE 2014. https://doi.org/10.1145/2568225.2568271 · https://www.cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf [FT abstract/intro]
66. P. S. Kochhar, F. Thung, D. Lo. *Code Coverage and Test Suite Effectiveness: Empirical Study with Real Bugs in Large Systems.* SANER 2015. https://doi.org/10.1109/SANER.2015.7081877 [ABS]
67. Y. Chen, R. Gopinath, A. Tadakamalla, M. D. Ernst, R. Holmes, G. Fraser, et al. *Revisiting the Relationship Between Fault Detection, Test Adequacy Criteria, and Test Set Size.* ASE 2020. https://doi.org/10.1145/3324884.3416667 [ABS]
68. M. Ivanković, G. Petrović, R. Just, G. Fraser. *Code Coverage at Google.* ESEC/FSE 2019. https://doi.org/10.1145/3338906.3340459 [ABS]
69. R. Just, D. Jalali, L. Inozemtseva, M. D. Ernst, R. Holmes, G. Fraser. *Are Mutants a Valid Substitute for Real Faults in Software Testing?* FSE 2014. https://doi.org/10.1145/2635868.2635929 [ABS]
70. M. Papadakis, D. Shin, S. Yoo, D.-H. Bae. *Are Mutation Scores Correlated with Real Fault Detection?* ICSE 2018. https://doi.org/10.1145/3180155.3180183 [ABS]
71. G. Petrović, M. Ivanković, G. Fraser, R. Just. *Does Mutation Testing Improve Testing Practices?* ICSE 2021. https://doi.org/10.1109/ICSE43902.2021.00087 · https://arxiv.org/abs/2103.07189 [FT]
72. A. Tornhill, M. Borg. *Code Red: The Business Impact of Code Quality — A Quantitative Study of 39 Proprietary Production Codebases.* TechDebt 2022. https://arxiv.org/abs/2203.04374 [FT]
73. M. Borg, I. Pruvost, E. Mones, A. Tornhill. *Increasing, not Diminishing: Investigating the Returns of Highly Maintainable Code.* TechDebt 2024. https://doi.org/10.1145/3644384.3644471 · https://arxiv.org/abs/2401.13407 [ABS]
74. M. V. Mäntylä, C. Lassenius. *What Types of Defects Are Really Discovered in Code Reviews?* IEEE TSE 35(3), 2009. https://doi.org/10.1109/TSE.2008.71 [ABS]
75. M. Beller, A. Bacchelli, A. Zaidman, E. Juergens. *Modern Code Reviews in Open-Source Projects: Which Problems Do They Fix?* MSR 2014. https://doi.org/10.1145/2597073.2597082 · https://repository.tudelft.nl/file/File_9eb1b79b-a0f2-4631-9e2c-d71d4081a138 [FT]
76. T. J. Ostrand, E. J. Weyuker, R. M. Bell. *Predicting the Location and Number of Faults in Large Software Systems.* IEEE TSE 31(4), 2005. https://doi.org/10.1109/TSE.2005.49 [ABS]

**Industry and standards sources**

77. OWASP Foundation. *OWASP Top 10:2025.* https://top10.owasp.org/2025 [WEB]
78. MITRE. *2025 CWE Top 25 Most Dangerous Software Weaknesses* (list and methodology). https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html · https://cwe.mitre.org/top25/archive/2025/2025_methodology.html [WEB]
79. MITRE. *2024 CWE Top 25.* https://cwe.mitre.org/top25/archive/2024/2024_top25_list.html · https://cwe.mitre.org/top25/archive/2024/2024_cwe_top25.html [WEB]
80. Verizon. *2025 Data Breach Investigations Report.* https://www.verizon.com/business/resources/reports/2025-dbir-data-breach-investigations-report.pdf [FT]
81. Verizon. *DBIR landing page (2026 edition figures).* https://www.verizon.com/business/resources/reports/dbir/ [WEB]
82. GitGuardian. *The State of Secrets Sprawl 2025.* https://www.gitguardian.com/state-of-secrets-sprawl-report-2025 [WEB]
83. DORA. *DORA's software delivery metrics: the four keys (now five).* https://dora.dev/guides/dora-metrics-four-keys/ [WEB]
84. DORA. *Accelerate State of DevOps Report 2024.* https://dora.dev/research/2024/dora-report/ [WEB]

---

### Gaps and suggested follow-ups (when search budget is available)

- Exact detection counts in Habib & Pradel 2018 [2] and per-tool percentages in Thung et al. 2012 [4]: the full texts were not retrievable.
- Full text of Petersson et al. 2004 [27] and Eick et al. 1992 [24]: needed to cite specific estimator-performance numbers.
- Any prior work applying capture–recapture **across static analysers** (rather than human inspectors or fuzzers). None could be searched for in this session.
- C#-specific studies: Roslyn analyzer precision, SAST tools on .NET (e.g. OWASP Benchmark-style suites for C#), and NuGet SCA disagreement.
- Charoenwet et al. ISSTA 2024 (SAST in secure code review), and the DORA 2024 AI-adoption percentages from the report PDF.
