# 07 — Measurement theory and statistics: validating code-quality metrics and certifying with confidence

Retrieved: 2026-11-14. Scope: (a) how to show that each metric in our AI-free C# quality certifier (Python + tree-sitter) measures what it claims (DRY, KISS, SRP, coupling, ...); (b) how to turn entity-level measurements into a system/PR score, a heatmap and a **certification decision with a stated confidence level**. Target: MessagePack-CSharp plus agent-written PRs.

Conventions:
- Bracketed numbers are references (list at the end). I opened every source cited with a number unless the reference entry says "metadata only" (title/venue/DOI checked via Crossref/OpenAlex, body not read).
- **[unverified]** = I could not open a source that confirms it. **[design]** = our own proposal, not taken from a source.
- Numbers like "n = 299" in the protocol were **computed by me with SciPy 1.18.1** (exact Clopper–Pearson bounds). They are not quoted from a paper.
- Library APIs (SciPy 1.18.1, statsmodels 0.15.0, pingouin 0.7.0) were checked by installing them and inspecting the signatures in a scratch venv.
- Budget note: the shared web-search budget ran out partway through. After that I only fetched known URLs and resolved known DOIs. A few items stay [unverified] for that reason (listed in §9).

---

## 0. TL;DR

**What "valid" means here.** A metric is valid only *for an intended use* [6][2]. Validation has two parts:
1. **Theoretical (internal) validity.** The metric has the properties its attribute requires (Briand–Morasca–Basili properties for size, complexity, cohesion and coupling [13]; Weyuker's properties [14]), and we only use statistics that its scale type permits [10][12].
2. **Empirical (external) validity.** The six IEEE 1061 / Schneidewind criteria: correlation (association), consistency, tracking, predictability, discriminative power, reliability (repeatability) [1][2][3][4].

**Validation protocol** (details in §7, runnable in roughly 5–6 h with scipy, statsmodels, pingouin and PyDriller):

| # | Experiment | Test | Accept if |
|---|---|---|---|
| E0 | Axiom/property unit tests on synthetic C# | deterministic | 100 % pass |
| E1 | Metamorphic **invariance** (rename, reformat, comments, member reorder, `#region`) | one-sided exact binomial (Clopper–Pearson) | lower 95 % bound of invariance rate ≥ 0.99 (zero failures in ≥ 299 pairs) |
| E2 | **Directional mutation** (inject a duplicate block, nesting, merge of unrelated classes, new dependency) plus inverse refactorings | exact binomial; exact-delta checks | lower 95 % bound ≥ 0.95 (≥ 59 pairs with 0 failures, ≥ 93 with 1 failure); off-target metrics stable ≥ 0.90 |
| E3 | Repeatability and parse robustness | bit-identical reruns; CP upper bound on parse-error rate | 100 % identical; parse-error upper bound < 1 % |
| E4 | **Convergent validity** against an independent tool (Roslyn metrics, lizard, Sonar) | ICC(A,1), Spearman, Bland–Altman, Cohen's κ | ICC lower 95 % CI ≥ 0.75 for same-definition metrics; bias explained |
| E5 | **Known groups**: before/after refactoring commits, plus curated clean vs. smelly code | Wilcoxon / Mann–Whitney (one-sided), Cliff's δ with bootstrap CI, Holm | Holm-adjusted p < 0.05 and δ lower CI bound > 0.147 |
| E6 | **Predictive validity** from git history (bug-fix keywords, SZZ via PyDriller, churn) | Spearman, *partial* Spearman controlling for LOC, logistic regression with log LOC (LR test, odds ratio), AUC; BH | partial ρ > 0 and LR test significant after BH; otherwise label the metric "size-redundant" |
| E7 | Aggregation sanity: monotonicity, no ecological-fallacy claims | deterministic | improving any entity never lowers the system score |

**Certification rule** (details in §8). For each validated metric *m* and risk level *k*, compute the LOC-weighted risk proportion p̂ₘₖ (the SIG "risk profile" [51][52][55]). Compute a **one-sided 95 % BCa bootstrap upper bound Uₘₖ, resampling files (clusters)** [64][66]. Then:
- **CERTIFIED** if Uₘₖ ≤ cₘₖ for every (m, k).
- **REJECTED** if some lower bound Lₘₖ > cₘₖ (Holm over these claims).
- **INCONCLUSIVE** otherwise.

Requiring *every* metric to pass is an intersection–union test. It keeps the consumer's risk (the chance of certifying code whose true risk exceeds a cap) at ≤ α **without any multiplicity correction** (Berger 1982 [67]). Default caps cₘₖ = the published SIG/TÜV NORD CERT 4-star caps (v18.1, 2026) [55], re-calibrated to our tree-sitter definitions (tools disagree [21]). The 0–100 score shown next to the certificate is *descriptive*: a LOC-weighted compliance index with a bootstrap CI. Only the certification rule carries the "95 % confidence" claim.

---

## 1. Measurement-theory foundations

### 1.1 Representational theory, scale types, admissible statistics
- Measurement is a mapping from an empirical relational system (entities and observed relations, e.g. "harder to understand than") into numbers that **preserves those relations** (the representation condition). Kaner & Bond quote Fenton & Pfleeger's definition to this effect [2].
- Scale type is fixed by the **admissible transformations** that keep all empirical relations true. Stevens' classic types [12], as used in SE by Fenton et al. [10][9]:
  - **Nominal:** any one-to-one mapping.
  - **Ordinal:** any monotone increasing map.
  - **Interval:** affine maps (e.g. °C ↔ °F).
  - **Ratio:** scalar multiplication (e.g. length units).
  - **Absolute:** counting.
- **Meaningfulness.** A statement is meaningful if its truth value does not change under admissible transformations. Fenton, Pfleeger & Glass [10] spell out the consequences:
  - The mean is meaningful for ratio data but not for ordinal data.
  - Medians are meaningful for ordinal data but not for nominal data.
  - Only frequency and mode statistics apply to nominal data.
  - Using the mean on ordinal data is a common mistake in SE studies.
  - Meaningful does not mean true.
- **Consequences for us [design]:**
  - Raw counts (cyclomatic complexity, statements, parameters, duplicated lines, distinct referenced types) are absolute or ratio scale. Sums, means and ratios are fine.
  - Risk categories ("low/moderate/high/very high") and star ratings are **ordinal**. Summarize them with medians, rank correlations (Spearman/Kendall) and Cliff's δ, not means and t-tests.
  - Our certification decision therefore uses **ratio-scale proportions** (the share of LOC above a threshold), not averages of ordinal ratings.
- Fenton (1994) argues that a search for a *general* complexity measure is doomed. Measurement theory does, however, help define and validate measures of *specific* complexity attributes [11]. Each of our metrics should name one specific attribute ("number of linearly independent paths", "redundant LOC"), not "quality".

### 1.2 Kitchenham, Pfleeger & Fenton (1995) validation framework [8]
- The framework defines a measurement structure model and five supporting models:
  - unit definition models;
  - instrumentation models;
  - attribute relationship models;
  - measurement protocols;
  - entity population models.
- It warns against artificially contrived scalars and recommends **measurement vectors** [8].
- Implication: report a *profile* per principle (the heatmap and per-metric risk profiles) next to any single score.

### 1.3 Property-based (axiomatic) validation: Briand, Morasca & Basili (1996) [13]
The paper defines a system as ⟨E, R⟩ (elements and relations) and a modular system with modules. The authors call these properties **necessary but not sufficient**: satisfying them does not guarantee a useful measure [13].

| Concept | Properties (paraphrased from [13]) | Our C# metric to check |
|---|---|---|
| **Size** | Size.1 nonnegativity. Size.2 null value (no elements ⇒ 0). Size.3 module additivity for disjoint modules. Derived: monotone when elements are added; merged size ≤ sum of overlapping modules. | statements/LOC, #methods |
| **Length** | Length.1–5: nonnegativity; null value; nonincreasing monotonicity for connected components; nondecreasing monotonicity for non-connected components; disjoint modules. | nesting depth |
| **Complexity** | Complexity.1 nonnegativity. Complexity.2 null value (no relations ⇒ 0). Complexity.3 symmetry (independent of the direction convention for relations). Complexity.4 module monotonicity: ≥ sum over modules with no common relations. Complexity.5 disjoint-module additivity. Derived: adding relations never decreases complexity. | cyclomatic/cognitive complexity |
| **Cohesion** | Cohesion.1 nonnegativity and normalization to [0, Max]. Cohesion.2 null value (no intra-module relations ⇒ 0). Cohesion.3 monotonicity: adding intra-module relations does not decrease cohesion. Cohesion.4: merging two unrelated modules yields cohesion ≤ the max of the two. | LCOM/TCC-type SRP metric (note LCOM measures *lack* of cohesion, so its direction is inverted) |
| **Coupling** | Coupling.1 nonnegativity. Coupling.2 null value. Coupling.3 monotonicity: adding inter-module relations does not decrease coupling. Coupling.4 merging modules: merged ≤ sum. Coupling.5 disjoint-module additivity. | efferent/afferent coupling, fan-in (SIG "module coupling") |

The size and complexity properties are compatible with ratio-scale measures [13].

These properties translate directly into **unit tests (E0)** and **metamorphic/mutation relations (E1/E2)**. For example, Cohesion.4 says: merge two unrelated classes, and cohesion must not rise above the larger of the two originals.

### 1.4 Weyuker's properties (1988) [14] (statements as listed in [15])
1. Not all programs get the same value.
2. Only finitely many programs share a given value.
3. Distinct programs can share a value.
4. Functionally equivalent programs can have different values.
5. Monotonicity under composition: |P| ≤ |P;Q| and |Q| ≤ |P;Q|.
6. Non-equivalence of interaction: there exist P, Q, R with |P| = |Q| but |P;R| ≠ |Q;R|.
7. Permutation of statements can change the value.
8. **Renaming does not change the value.**
9. Interaction can increase complexity: |P| + |Q| < |P;Q| for some P, Q.

Context:
- None of the four classic measures Weyuker analysed (statement count, cyclomatic number, effort, data flow) satisfied all nine properties [14].
- Fenton (1994) found a problem with the Weyuker properties [11].
- Property 8 is the formal basis of our identifier-renaming invariance test (E1).

### 1.5 Kaner & Bond (2004): ten questions for any metric [2]
1. Purpose.
2. Scope.
3. Attribute being measured.
4. Natural scale of the attribute.
5. Natural variability of the attribute.
6. The metric/instrument.
7. Natural scale of the metric.
8. Natural variability of instrument readings (measurement error).
9. Relationship between attribute and metric (the construct-validity question).
10. Foreseeable **side effects** of using the instrument (people optimizing the number instead of the attribute).

Kaner & Bond also argue that IEEE 1061's exemption for "direct" metrics rarely applies in SE, so **all metrics should be validated** [2]. They note that the higher the stakes of a measurement, the more important validation becomes. A *certificate* sits at the high-stakes end, because it informs others about a product [2].

**[design] Action:** fill a 10-question "metric card" per metric in the repo (one table row each). It is cheap, and it shows judges what each metric is for and how it could be gamed.

---

## 2. Validity criteria for empirical validation

### 2.1 IEEE Std 1061-1998 (criteria as summarized by Kaner & Bond from §4.5 of the standard [1][2])
Let F be the quality factor, measured by a "direct metric" (e.g. MTTF for reliability), and M: F → Y the metric.
- **Correlation:** the metric is linearly related to the factor, measured by the statistical correlation between them.
- **Consistency:** M is monotone. If f₁ > f₂ > f₃ then y₁ > y₂ > y₃, i.e. rank agreement.
- **Tracking:** when F changes from f₁ to f₂ over time, M should change promptly from y₁ to y₂.
- **Predictability:** knowing Y at some time lets us predict F.
- **Discriminative power:** the metric separates high-quality from low-quality components. The values for one group should be significantly higher (or lower) than for the other.
- **Reliability:** the metric shows the five properties above in at least **P %** of its applications. P is set by the user; the standard does not fix it.

In the standard, a direct metric is presumed valid and other metrics are validated against it [2]. Numeric example thresholds inside the standard (e.g. for R²) are **[unverified]**: I could not open the standard's text.

### 2.2 Schneidewind (1992) [3] (wording via the verbatim citations in [4])
Search snippets of Schneidewind's later work say this methodology was adopted into IEEE 1061 **[unverified primary]**. It has six criteria:

| Criterion | Question it asks (paraphrased) | Typical statistic [design] |
|---|---|---|
| **Association** | Is the *linear* association between F and M strong enough to use M as an indirect measure of F? | Pearson on log-transformed data; R² |
| **Consistency** | Are the *ranks* of F and M consistent enough? | Spearman ρ / Kendall τ |
| **Discriminative power** | Can M separate high-quality from low-quality components? | contingency table / χ², Mann–Whitney, AUC, Cliff's δ |
| **Tracking** | Does M follow changes in F (e.g. after design changes)? | paired Δ analysis; mutation (E2) |
| **Predictability** | Can M predict F with the required accuracy? | temporal hold-out regression or classification |
| **Repeatability** | Does M validate in a large enough share of trials to be dependable? | rerun on resamples or other projects; pass in ≥ P % |

The abstract stresses that nonparametric methods (contingency tables) are important for evaluating metrics against the criteria [3]. Omri et al. [4] and Nagappan & Ball [5] (metadata only) applied this scheme to static-analysis and complexity metrics.

### 2.3 Meneely, Smith & Williams (2012): 47 criteria, two philosophies [6][7]
- Systematic literature review: 2,288 papers screened down to 20, from which **47 unique criteria** were extracted. The criteria are not conflict-free [6].
- **Recommendation:** pick criteria that confirm the metric is fit for *its intended use*, not an arbitrary subset [6].
- The 47 criteria [7]:
  - a priori validity; actionability; appropriate continuity; appropriate granularity; association;
  - attribute validity; causal model validity; causal relationship validity; content validity; construct validity;
  - constructiveness; definition validity; discriminative power; dimensional consistency; economic productivity;
  - empirical validity; external validity; factor independence; improvement validity; instrument validity;
  - increasing growth validity; interaction sensitivity; internal consistency; internal validity; monotonicity;
  - metric reliability; non-collinearity; **non-exploitability**; non-uniformity; notation validity;
  - permutation validity; predictability; prediction system validity; process or product relevance; protocol validity;
  - rank consistency; **renaming insensitivity**; repeatability; representation condition; scale validity;
  - stability; theoretical validity; trackability; **transformation invariance**; underlying theory validity;
  - unit validity; usability.
- The "spectrum of philosophies" runs between theory-driven criteria (representation condition, scale validity) and goal-driven/pragmatic ones (actionability, predictability). The exact labels the paper uses are **[unverified]** because I did not read the full text.

**[design] Our chosen subset, by intended use ("certify that code respects DRY/KISS/SRP; point to where it does not"):**

| Criterion | Experiment |
|---|---|
| Representation condition, monotonicity, scale validity | E0 |
| Renaming insensitivity, transformation invariance, permutation validity | E1 |
| Trackability / tracking | E2 |
| Metric reliability, repeatability, stability | E3 |
| Instrument validity, construct validity (convergent and discriminant) | E4 |
| Discriminative power | E5 |
| Association, rank consistency, predictability, non-collinearity with size | E6 |
| Actionability | heatmap drill-down |
| Non-exploitability | E8 (gaming audit) |

### 2.4 Construct validity from psychometrics
- Cronbach & Meehl (1955) introduced construct validity. Evidence includes group differences and correlations with other measures [16].
- Campbell & Fiske (1959) multitrait–multimethod logic [17]:
  - **Convergent:** the same trait measured by different methods (our tool vs. an independent tool) should correlate highly.
  - **Discriminant:** different traits (e.g. complexity vs. cohesion) should correlate less.
- **Known-groups validity** is the group-difference form of this evidence: entities known to differ on the attribute must differ on the metric. It maps onto IEEE "discriminative power".

---

## 3. Experimental designs for metric validation

### 3.1 Metamorphic testing of metrics (E1 invariance, E2 direction)
- Metamorphic testing checks **metamorphic relations (MRs)**: necessary properties that relate several inputs to their expected outputs. It is useful when no exact oracle exists [18][19].
- For metric tools the MRs come straight from §1.3–1.4:
  - **Invariance MRs** (semantics-preserving transformations ⇒ metric unchanged): consistent identifier renaming (Weyuker P8; Meneely "renaming insensitivity"); whitespace/brace reformatting; comment insertion or removal; reordering of class members; `#region` insertion.
  - LAMPION applied exactly this kind of transformation (identifier and syntactic changes that keep semantics) to test code models. It found that simple transformations significantly change model behaviour [20], which is why such tests are worth running.
  - The deep-code-model literature warns that some published "semantics-preserving" transformations actually change semantics. Keep the transformations simple and syntactic.
- **Directional MRs** (inject a known violation ⇒ metric moves the expected way, often by an *exact* amount):
  - wrapping a statement in `if (c) {...}` ⇒ cyclomatic complexity +1;
  - copying a block of ≥ 6 lines elsewhere ⇒ redundant LOC grows by the block length (SIG's duplication definition: ≥ 6 lines, repeated literally modulo whitespace; redundancy = (occurrences − 1) × length [55]);
  - merging two unrelated classes ⇒ cohesion ≤ max of the two (Briand Cohesion.4);
  - adding a field of a new type ⇒ efferent coupling does not decrease (Coupling.3).
- **Inverse MRs** (refactorings): extract-method on a duplicate ⇒ redundancy decreases.
- **Discriminant MRs (specificity):** a DRY mutation should leave the SRP and complexity metrics unchanged. This is the Campbell–Fiske discriminant idea [17] at the mutation level.
- **Prior art:** I found no published study that applies metamorphic testing to *static code-metric tools* specifically. The extended search I ran returned none. Applying MT to metric tools is therefore our **[design]**, built on [18][19][20] and the axioms [13][14].

### 3.2 Convergent validity against independent tools (E4)
- Lincke, Lundberg & Löwe (2008) ran several commercial and free tools on the same systems with the same metric definitions. The **values were tool-dependent**, and even the **ranking of the most critical classes** differed between tools [21]. Two consequences:
  1. Disagreement with another tool is expected. Explain it through definitional differences.
  2. Thresholds calibrated on one tool (e.g. SIG's) do not transfer to ours without re-calibration.
- Statistics:
  - **ICC.** Use ICC(A,1), two-way, absolute agreement, single measures (pingouin labels it `ICC(A,1)`). Koo & Li: use two-way random effects to generalize to other raters; use *absolute agreement* when raters must give the same score; **base the interpretation on the 95 % CI, not the point estimate**. Bands: < 0.5 poor, 0.5–0.75 moderate, 0.75–0.9 good, > 0.9 excellent [23][24].
  - **Bland–Altman.** Plot the difference against the mean. Report bias = mean difference d̄ and **limits of agreement** d̄ ± 1.96 s (≈ ±2 s). Bland & Altman show that the correlation coefficient is *inappropriate* for judging agreement [22]. For count metrics with variance that grows with the mean, analyse log values (Bland–Altman also illustrate a log scale [22]).
  - **Spearman ρ** for rank agreement when definitions differ (e.g. cognitive vs. cyclomatic complexity).
  - **Cohen's κ** for agreement on binary "violation" flags [25] (statsmodels `cohens_kappa`).

### 3.3 Known-groups / discriminative power (E5)
- **Paired design:** entities before and after commits whose messages signal refactoring or cleanup (keyword classification of change reasons, after Mockus & Votta [31]). Test with one-sided Wilcoxon signed-rank or a sign test.
- **Independent design:** a curated "clean" vs. "smelly" set. Test with one-sided Mann–Whitney U.
- **Effect size: Cliff's δ** [39], an ordinal dominance statistic and therefore meaningful for ordinal data.
  - δ = 2A − 1, where A = P(X > Y) + 0.5·P(X = Y) is the Vargha–Delaney statistic [40]. Arcuri & Briand recommend A for SE experiments [41].
  - Magnitude bands used by the R `effsize` package: |δ| < 0.147 negligible, < 0.33 small, < 0.474 medium, otherwise large. The package attributes them to Hess & Kromrey (2004) [42]. The common attribution to Romano et al. (2006) is **[unverified]**.
  - Get a CI for δ by bootstrap (`scipy.stats.bootstrap`, BCa).
- AUC = A when "positive" means the high-risk group, so discriminative power can be reported as AUC with a bootstrap CI. (Identity: AUC equals the Mann–Whitney U divided by n₁n₂.)

### 3.4 Predictive validity from version history (E6)
- **Labelling bug fixes:**
  - Keyword heuristics on commit messages (fix/bug/defect/...), classifying change reasons from textual descriptions; Mockus & Votta found such classification agreed with developer opinion [31].
  - Link to issues where available. The Eclipse defect data set is a classic example [32] (metadata only).
- **Bug-introducing changes (SZZ):** Śliwerski, Zimmermann & Zeller link version-archive fixes to the changes that last touched the fixed lines [26].
  - Improvements: annotation graphs, ignoring non-semantic changes and outlier fixes. These removed about 38–51 % of false positives and 14–15 % of false negatives versus the original algorithm [27].
  - PyDriller implements the lookup as `Git.get_commits_last_modified_lines(commit)`: it returns the commits that last touched the lines modified or deleted by a (bug-fixing) commit. It can use `git hyper-blame` to skip given commits, such as refactorings [33].
- **Label-noise caveats (important):**
  - da Costa et al. found that "improved" SZZ variants can inflate wrong bug-introducing changes, and that a single change can be blamed for hundreds of future bugs [28].
  - Rosa et al. built a developer-informed oracle and report several lessons for improving SZZ [29].
  - Herbold et al. (398 releases, 38 Apache projects): **only about half of SZZ-labelled bug-fixing commits are actually bug-fixing**. With a six-month affected-release window, each correctly labelled defective file comes with one wrongly labelled file, and two defective files are missed [30].
  - Conclusion: treat defect outcomes as noisy and **always add a cleaner outcome** as well: change-proneness, i.e. commit count or churn after the snapshot.
- **Size confounding (must control):**
  - El Emam et al.: before controlling for class size, Chidamber–Kemerer and Lorenz–Kidd metrics looked validated against fault-proneness. Controlling for size showed a **strong confounding effect** that calls earlier validation studies into question [34].
  - Zhou et al. confirm that the confounding exists in general and propose a linear-regression-based way to remove it, which improved prediction [35].
  - Landman et al. (17.8 M Java methods): CC and SLOC correlate only *moderately* at method level, and **aggregation inflates the correlation** [37].
  - Gil & Lalouche (2017) study the same issue (title and venue verified; findings **[unverified]**, abstract not retrieved) [36].
  - Statistics:
    - **Partial Spearman** of metric vs. outcome controlling for LOC: `pingouin.partial_corr(..., covar='loc', method='spearman')`.
    - **Logistic regression** `defect_prone ~ log(LOC) + metric`, with a likelihood-ratio test on the metric term and the odds ratio per IQR increase with 95 % CI. Equivalently, compare nested models' AUC.
  - Keep model sizes small relative to the number of events. The "≥ 10 events per variable" rule is usually cited to Peduzzi et al. [45]; the content is **[unverified]** (metadata only).
- **Critique to cite:** Fenton & Neil argue that many defect-prediction models are misspecified, model only part of the problem, and have serious statistical and data-quality problems [76]. Use E6 as *corroborating* evidence, not as the sole proof.

### 3.5 Multiple testing
- **Holm** (step-down): sort p-values and reject H₍ₖ₎ while p₍ₖ₎ ≤ α/(m+1−k). It controls the FWER in the strong sense and is uniformly at least as powerful as Bonferroni [43]. Use it for **confirmatory** acceptance tests (E5, E6 per metric).
- **Benjamini–Hochberg** controls the FDR [44]. Use it for **exploratory** screening: many metric × outcome pairs, per-file heatmap flags. `scipy.stats.false_discovery_control(ps, method='bh'|'by')`, where `'by'` is valid under arbitrary dependence. statsmodels `multipletests` offers `holm`, `fdr_bh`, `fdr_by`, and others.
- **Certification needs no correction** when the decision is "all criteria must pass": see §5.3.

---

## 4. Aggregation from entities to a system score

### 4.1 Why not the mean
- Software metric distributions are highly skewed, and **the mean becomes unreliable** for them [48][52].
- Alves et al. add that methods assuming normality (e.g. mean + k·σ thresholds) rest on unjustified assumptions for source-code metrics [52].

### 4.2 Inequality indices
- **Theil index.** Serebrenik & van den Brand propose it for aggregating from methods/classes to the system. Its key feature is **decomposability**: you can study how artifact categories (technology, team, component) explain inequality [47].
- **Comparison of indices.** Vasilescu, Serebrenik & van den Brand lifted SLOC from class to package level across 106 Qualitas Corpus systems. **Gini, Theil, Atkinson and Hoover were highly and significantly correlated** and so convey essentially the same information [46].
- **[design] Use:** an inequality index answers "are violations *concentrated* in a few hotspots or spread systemically?" Report the Gini of per-file violating LOC next to the heatmap. Use Theil's between/within decomposition by top-level component (e.g. `MessagePack`, `MessagePack.Annotations`, generators). Do **not** use inequality as the compliance score: perfectly equal badness has Gini = 0.

### 4.3 SIG risk profiles and benchmark-derived thresholds
- **Heitlager, Kuipers & Visser (2007)** criticize the Maintainability Index and propose a model. Source properties (volume, complexity per unit, duplication, unit size, ...) map onto ISO 9126 sub-characteristics through **risk profiles** [51].
- **Alves, Ypma & Visser (2010)** derive thresholds from a benchmark of 100 OO systems (Java and C#) [52]:
  1. Weight each entity by LOC.
  2. Normalize per system so that each system contributes equally.
  3. Pool the systems.
  4. Read the thresholds at the **70 %, 80 % and 90 %** quantiles of code volume.
  - For McCabe this gives thresholds **6, 8, 14**, which define low (≤ 70 %), moderate (70–80 %), high (80–90 %) and very-high (> 90 %) risk. A motivating example in the same paper quotes "6, 8 and 15".
  - The method respects metric scale and distribution and resists outliers.
- **Alves, Correia & Visser (2011): two-stage aggregation** [53]. Stage 1 compares entity values with thresholds to build risk profiles. Stage 2 maps profiles to ratings using benchmark-calibrated rating thresholds, and the paper analyses the algorithm's sensitivity. The exact interpolation formula for continuous ratings is **[unverified]**: I did not obtain the full text.
- **Calibration distribution.** SIG calibrates ratings so that benchmark systems spread **⟨5, 30, 30, 30, 5⟩ %** over 1–5 stars, re-calibrated at least yearly [54].
- **Other threshold methods:**
  - **Relative thresholds** (Oliveira et al.): "most entities must satisfy the limit", tolerating a long tail [60].
  - **Data-mining thresholds for metric sets** (Herbold et al.) [59].

### 4.4 Squale: weighted, continuous, monotone aggregation [49][50]
Squale adds a **practice** level between metrics and criteria. Practice marks are adjusted by formulae so that **bad marks are stressed** [49]. The 2011 paper names two problems:
- Some weighting schemes can make overall quality *drop* when a developer improves a component.
- Threshold-based mappings are problematic.

It solves them with **weighted aggregation and continuous functions**, validated over 4 years at Air France-KLM and PSA Peugeot-Citroën [50]. The concrete formula and its λ constants are **[unverified]**: the HAL PDF was blocked. A mathematically standard way to get "stress bad marks, stay monotone" [design] is the exponential quasi-arithmetic mean

  A_λ(x₁..xₙ; w) = −log_λ( Σᵢ wᵢ λ^(−xᵢ) / Σᵢ wᵢ ), λ > 1.

Properties:
- It lies between min(x) and the weighted mean.
- It tends to the mean as λ → 1 and to the min as λ → ∞.
- It is strictly increasing in every xᵢ.

So improving any entity can never lower the aggregate, which is exactly Squale's requirement.

### 4.5 Quamoco: utility functions and weighted sums [56]
- **Utilities.** Each measure maps to a utility in [0, 1] through a simple **linear increasing or decreasing function between benchmark-derived min/max thresholds**. The thresholds are the minimum and maximum non-outlier values (box-plot rule, Q₁/Q₃ ± 1.5·IQR) over a benchmark base, e.g. 120 open-source projects.
- **Weights.** Derived from relevance rankings with the Rank-Order Centroid method.
- **Aggregation.** A **weighted sum** up the hierarchy.
- **Missing data.** For incomplete measurement data, Quamoco computes best-case and worst-case assessments and **reports the range** [56]. This is a good model for handling files tree-sitter fails to parse.

### 4.6 SQALE / SonarQube [57][58]
- SQALE estimates technical debt as remediation cost [57].
- SonarQube's maintainability rating uses the technical-debt ratio (remediation cost / development cost): **A ≤ 5 %, B 5–<10 %, C 10–<20 %, D 20–<50 %, E ≥ 50 %** [58].
- This is a fixed-threshold, deterministic rating with no uncertainty quantification.

### 4.7 Prior *certification* practice: SIG / TÜV (NORD) "Trusted Product Maintainability"
- **2010 scheme** (Baggen, Schill & Visser) [54]:
  - The evaluation follows ISO/IEC 14598. That ISO/IEC 25040, the SQuaRE evaluation-process standard [77], is its successor is **[unverified]**.
  - The lab works under ISO/IEC 17025 with separate evaluator and quality-officer roles.
  - To be certified, a system needs **≥ 2 stars on every sub-characteristic and ≥ 3 stars overall**.
  - Certificates record the model and tool versions.
  - Validation evidence cited: ratings correlate positively with defect-resolution speed in OSS systems [54].
  - Journal version: [54b].
- **Current criteria (SIG/TÜV NORD CERT Guidance for Producers, v18.1, 2026-03-31)** [55]. These caps are *sufficient conditions* for **4-star** eligibility, applied per programming language, as % of LOC:

| Property | 4-star cap (per language) |
|---|---|
| Duplication | redundant LOC ≤ **5.8 %** (clone = ≥ 6 lines repeated literally modulo whitespace) |
| Unit size | LOC in units > 15 LOC ≤ **48.0 %**; > 30 LOC ≤ **24.2 %**; > 60 LOC ≤ **9.1 %** |
| Unit complexity (McCabe) | LOC in units with CC > 5 ≤ **20.7 %**; > 10 ≤ **7.5 %**; > 25 ≤ **1.1 %** |
| Unit interfacing | LOC in units with ≥ 3 params ≤ **15.4 %**; ≥ 5 ≤ **3.4 %**; ≥ 7 ≤ **0.9 %** |
| Module coupling (incoming deps) | LOC in modules with fan-in > 10 ≤ **9.7 %**; > 20 ≤ **5.3 %**; > 50 ≤ **1.8 %** |
| Component entanglement | ≤ **0.075** (density + violation degree, normalized by benchmark maxima) |
| Component independence | ≥ **94.5 %** of code in modules without incoming cross-component dependencies |

Further details from [55]:
- **Definitions:** unit = smallest named executable piece (C# methods); module ≈ file/class; component = top-level directory grouping.
- **Scoping:** the system owner defines the system boundary during scoping.
- These are the most concrete, published, externally anchored caps for a "certify maintainability" claim.
- **Mapping to our principles [design]:** DRY ↔ duplication; KISS ↔ unit size, complexity, interfacing; SRP ↔ module coupling and size (cohesion has no SIG analogue, so calibrate it ourselves); architecture ↔ entanglement and independence.

**Statistical gap in prior art (our differentiator):**
- SIG/TÜV, SonarQube and SQALE produce *deterministic* ratings from a census of the code.
- Squale and Quamoco aggregate deterministically. Quamoco only gives best/worst ranges for missing data.
- None of the sources I opened attaches a **confidence statement** to the certificate.
- §5 supplies that confidence statement.

---

## 5. Certification with confidence

### 5.1 What is uncertain if we measure 100 % of the code?
Running on the whole repo is a census, so there is no finite-population sampling error. Two uncertainties remain:
1. **Instrument error.** Parse failures and definitional deviations. Bound it through E3/E4, and through best/worst ranges for unparsed files, as Quamoco does [56].
2. **Process uncertainty (superpopulation view) [design].** The question behind "earned trust in AI code" is whether the *producer* (team or agent) reliably writes compliant code. Treat the files of a system, or of a PR, as draws from the producer's process. The confidence bound then answers: "how high could the producer's true violation share plausibly be, given this code?"

Methods inside a file are correlated, so **resample files (clusters), not methods**. Resampling methods would understate the uncertainty. This is the standard cluster-bootstrap approach for clustered data [66].

### 5.2 Interval tools
- **BCa bootstrap** (Efron 1987): second-order accurate in many problems, and automatically handles bias and skewness [64][65]. In SciPy:
  ```python
  scipy.stats.bootstrap(data, statistic, paired=True, vectorized=True,
                        method='BCa', alternative='less'|'greater',
                        confidence_level=0.95, n_resamples=9999)
  ```
  `'less'` gives a one-sided interval (−∞, U]. I tested this with a LOC-weighted ratio statistic, data = (violating_loc_per_file, loc_per_file), paired=True.
- **Binomial proportions** (counts of units or mutation pairs).
  - Brown, Cai & DasGupta show that the textbook Wald interval behaves erratically. They recommend **Wilson** or Jeffreys for small n and Agresti–Coull for larger n [63].
  - Wilson's score interval [61]; **Clopper–Pearson** exact interval [62] when a guaranteed (conservative) bound is wanted.
  - SciPy: `binomtest(k, n, p0, alternative='greater').proportion_ci(0.95, method='exact'|'wilson'|'wilsoncc')`, a one-sided bound when `alternative` is one-sided.
- **Zero-failure bounds (computed):**
  - 0 failures in n trials ⇒ one-sided 95 % CP lower bound on the success rate = 0.05^(1/n). n = 59 ⇒ 0.9505; n = 299 ⇒ 0.9900.
  - Hanley et al. made the "nothing went wrong" bound famous (the "rule of three", ≈ 3/n) [71] (metadata only). We use the exact CP value instead.
- **Differences of proportions** (PR vs. baseline): Newcombe compares eleven interval methods [70] (metadata only; the recommended hybrid-score method is from memory **[unverified]**). Alternatively, use a two-sample cluster bootstrap.

### 5.3 Tests and decision rules
- **One-sided test per cap.** H₀: pₘₖ ≥ cₘₖ (fails) vs. H₁: pₘₖ < cₘₖ (complies). Reject H₀ at level α iff the one-sided (1−α) upper bound Uₘₖ < cₘₖ (confidence-interval/test duality).
- **Several caps at once: intersection–union test (IUT).**
  - Berger 1982: to accept a product only if *every* parameter meets its standard, test each parameter individually and accept only if all pass.
  - This method **attains exactly the prespecified consumer's risk** and uniformly minimizes the producer's risk, among other optimal properties [67].
  - So for "all caps satisfied" each test runs at α = 0.05 with **no Holm/Bonferroni adjustment**, and the overall probability of certifying a non-compliant process stays ≤ 0.05.
  - (Adjust only when you *claim* several separate findings, e.g. "metric X fails AND metric Y fails": then use Holm [43].)
- **Equivalence / non-inferiority for PRs.**
  - TOST: declare equivalence within ±δ if both one-sided tests reject at α, which is the same as the (1−2α) CI lying inside (−δ, δ) [68][69].
  - For agent PRs, the natural claim is **non-inferiority**: "the PR's violation share is not worse than the repo baseline by more than δ". Reject H₀: p_PR − p_base ≥ δ when the one-sided upper bound of the difference is < δ.
  - δ is a policy choice [design]. Lakens stresses justifying the smallest effect size of interest [69].
- **Sequential option.** For streams of PRs, Wald's SPRT accumulates evidence across PRs with fixed error rates [73]. This is optional, a nice "the agent earns trust over time" story [design].

### 5.4 How to phrase the result (template) [design]
> "Certified (α = 0.05). For each of the K validated maintainability properties, the one-sided 95 % BCa cluster-bootstrap upper confidence bound of the LOC-weighted share of code exceeding the risk threshold lies below its cap (Table X). The certificate is an intersection–union test, so the probability that a codebase whose true share exceeds *any* cap is certified is at most 5 % (Berger 1982). The certification is conditional on the measurement instrument passing validation experiments E0–E4 (protocol v1, tool commit abc123). Caps are the SIG/TÜV NORD CERT 4-star caps v18.1, re-calibrated to our metric definitions."

**Avoid:**
- "95 % of the code is good". That is not what the test says.
- "the metric is statistically significant". That is meaningless without a hypothesis.

---

## 6. Pitfalls and how the protocol handles them

| Pitfall | Evidence | Counter-measure |
|---|---|---|
| **Ecological fallacy**: inferring entity-level relations from aggregate data, or the reverse | Choosing the wrong aggregation level can give misleading results in defect prediction and hypothesis testing [38]. Aggregation inflates the CC–SLOC correlation [37]. | Validate each metric at the level it is reported (method/file for the heatmap, system for the certificate). Do not read a system-level correlation as a file-level property. |
| **Size confounding** | [34][35][36][37] | Partial correlations / logistic regression with log LOC (E6). LOC weighting in risk profiles is intentional ("how much code is at risk") and stated. |
| **Threshold arbitrariness** | Most thresholds come from expert opinion or few observations [52]. Tools disagree [21]. | Benchmark-derived quantile thresholds [52], relative thresholds [60], or the SIG published caps [55]. Re-calibrate to our tool on a C# corpus. Run a sensitivity analysis: the certificate should not flip under ±1 threshold step. |
| **Goodhart's law** | Strathern: once a measure becomes a target, it stops being a good measure [74]. Kaner & Bond's Q10 on side effects [2]. | E8 gaming audit. Multi-metric vectors [8]. Type-2 clone detection (identifier-normalized) so renaming cannot hide duplicates. Publish the metric cards. |
| **Compensatory aggregation** hides a terrible dimension behind good ones | Squale's anomaly [50]. SIG's per-sub-characteristic minimums [54]. | The certification rule is non-compensatory (IUT over all caps). The weighted score is display-only. |
| **Scale misuse** (means of ordinal ratings) | [10] | Proportions (ratio scale) for decisions; medians, Spearman and Cliff's δ for ordinal data. |
| **Defect-label noise (SZZ)** | About half of SZZ fix labels are wrong [30]; inflation and blame outliers [28] | Change-proneness as a second outcome. Manually check a random sample of 30 labels. Report the label precision with a Wilson CI. |
| **Non-independence** (methods within files) | [66] | Cluster bootstrap by file. |
| **Forking paths / multiple tests** | [43][44] | Pre-register acceptance criteria (this file). Holm for confirmatory tests, BH for exploratory ones. |
| **Validity is use-specific** | [6][2] | State the intended use on the certificate. |

---

## 7. VALIDATION PROTOCOL (concrete, Python, about 5–6 hours)

Common setup:
- Freeze the tool commit and record a SHA-256 of the config.
- Scope (§4.7): `src/**` of MessagePack-CSharp. Exclude tests, benchmarks, sandbox and generated `*.g.cs` files, and report the exclusion list.
- Unit = method/constructor/accessor/local function; module = file. Python ≥ 3.11 with scipy ≥ 1.11 (`false_discovery_control`), statsmodels, pingouin, pydriller.
- α = 0.05 for every confirmatory test.
- One CSV per experiment, with columns `metric, case_id, expected, observed, pass`.

**E0. Property (axiom) unit tests** (about 30 min)
- *What:* for every metric, encode its Briand et al. properties [13] and the relevant Weyuker properties [14] as pytest cases on synthetic C# snippets:
  - nonnegativity;
  - null value (empty class or method ⇒ 0);
  - size additivity over two disjoint classes;
  - complexity monotonicity (adding a branch never decreases CC);
  - cohesion bounds [0, Max] and Cohesion.4 (merging unrelated classes);
  - coupling monotonicity and merge sub-additivity;
  - Weyuker P1 (not constant) and P3 (distinct programs can tie).
- *Declare* the scale type of each metric in its metric card [10][12].
- *Accept:* 100 % pass (deterministic). Any failure ⇒ fix the definition, or document the violated property and drop the claim.

**E1. Metamorphic invariance** (about 45 min)
- *Sample:* draw ≥ 60 methods/classes at random (seeded) from MessagePack-CSharp.
- *Transformations (5):*
  1. consistent α-renaming of locals, parameters and private members (Weyuker P8);
  2. whitespace and brace-style reformatting;
  3. adding or removing comments and XML-doc;
  4. reordering class members;
  5. wrapping members in `#region`.

  That gives ≥ 300 (entity, transformation) pairs per metric.
- *Expected:* each metric declares which transformations it must be invariant to. Physical-LOC metrics are *expected* to change under transformation 2, so use logical LOC/statement counts for certification metrics.
- *Test:* one-sided exact binomial on the invariance rate: `binomtest(k, n, alternative='greater').proportion_ci(0.95, 'exact').low`.
- *Accept:* lower bound ≥ 0.99. With zero failures this needs n ≥ 299 (computed). One failure ⇒ n ≥ 473 (computed). Log and investigate every failure.

**E2. Directional mutation / fault injection (tracking, sensitivity, specificity)** (about 60 min)
- *Operators (each with an exact or signed expected delta):*
  - **DRY:** copy a random block of ≥ 6 lines into another method or file ⇒ redundant LOC += block length × 1 (exact) [55]. Inverse: extract a duplicated block into a method ⇒ redundancy decreases.
  - **KISS:** wrap a statement in `if (flag) { … }` ⇒ CC +1 (exact). Add `&& cond` ⇒ CC +1 if `&&`/`||` are counted (state the definition). Nest an existing block one level deeper ⇒ cognitive complexity and nesting depth increase. Add a parameter ⇒ interface size +1.
  - **SRP/cohesion:** merge two unrelated classes ⇒ cohesion ≤ max(originals) (Cohesion.4), i.e. LCOM4 = sum of components. Add a method that touches only a new field ⇒ LCOM4 +1.
  - **Coupling:** add a field or parameter of a new type ⇒ efferent coupling +1 (Coupling.3 monotone).
- *Sample:* for each operator, ≥ 100 mutants on random sites (seeded). Only compiling-plausible sites; syntax validity checked by tree-sitter having no ERROR nodes.
- *Tests:*
  - (a) **Direction/exactness rate**: one-sided CP lower bound.
  - (b) **Specificity**: rate at which *off-target* metrics stay unchanged (e.g. a DRY mutation leaves CC and LCOM unchanged) [17].
  - (c) Report the median Δ with a bootstrap CI.
- *Accept:* (a) lower bound ≥ 0.95. That needs n ≥ 59 with 0 failures, ≥ 93 with 1 failure, ≥ 124 with 2 failures (computed). (b) Point estimate ≥ 0.90, with every exception explained by the definition (e.g. an extracted method legitimately adds a unit).

**E3. Repeatability and instrument robustness** (about 15 min)
- *Determinism:* run the tool twice on the same commit, on two machines or Python versions if available. *Accept:* outputs byte-identical (100 %).
- *Parse robustness:* share of C# files or methods with tree-sitter ERROR/MISSING nodes. *Accept:* one-sided 95 % CP upper bound < 1 %. Report unparsed files and compute best/worst-case certification over them, as Quamoco does [56].
- *Stability (IEEE "reliability", Schneidewind "repeatability"):* rerun E5/E6 on B = 20 bootstrap resamples of files, or on a second C# repo. *Accept:* each criterion holds in ≥ P = 80 % of trials. P is our choice: IEEE 1061 leaves P to the user [2].

**E4. Convergent and discriminant validity against independent tools** (about 45 min)
- *References:*
  - Roslyn-based Microsoft code metrics (CC, class coupling, LOC) via the .NET SDK available in this environment;
  - `lizard` (CCN, NLOC, parameter count);
  - optionally SonarScanner for .NET (cognitive complexity, duplication).
  - Whether lizard supports C#, and how to invoke the Roslyn metrics, is **[unverified]**: check before use.
- *Pairing:* match methods by file and line span; report the match rate.
- *Statistics:*
  - **ICC(A,1)** with 95 % CI (`pingouin.intraclass_corr`) [23][24].
  - **Bland–Altman** bias and LoA (d̄ ± 1.96 s; on log1p if the spread grows with magnitude) [22].
  - Spearman ρ with bootstrap CI.
  - Cohen's κ on the binary flags "CC > 10" and "params ≥ 5" [25].
  - MTMM check [17]: ρ(our CC, ref CC) > ρ(our CC, ref coupling).
- *Accept:*
  - Same-definition metrics (CC, params, LOC): ICC lower 95 % bound ≥ 0.75 ("good" [24]), with any systematic bias traced to a documented definitional difference (e.g. counting `??`, `?.`, `case`, `catch`, switch-expression arms).
  - Different-definition metrics: ρ lower bound ≥ 0.5 [design] and MTMM ordering satisfied.
  - Expect imperfect agreement [21]: the goal is to *explain* the disagreement, not to get ICC = 1.

**E5. Known-groups discriminative power** (about 30 min)
- *Groups:*
  - (a) **Paired:** entities touched by commits whose messages match refactoring/cleanup keywords (`refactor|clean ?up|simplif|extract|dedup|remove duplicat`), before vs. after [31].
  - (b) **Unpaired:** the E2 mutants vs. their originals, as a positive control. Optionally, a hand-labelled set of 30 clean and 30 smelly methods from two reviewers, with κ reported.
- *Tests:*
  - (a) One-sided Wilcoxon signed-rank (`scipy.stats.wilcoxon(..., alternative='less')`) on Δmetric.
  - (b) One-sided Mann–Whitney U.
  - Effect size: Cliff's δ with bootstrap BCa CI [39][40][42].
  - Holm across metrics [43].
- *Accept:* Holm-adjusted p < 0.05 **and** the δ lower CI bound > 0.147 (above "negligible" [42]). Note: refactoring commits may target a principle other than the one a metric measures. Report per-keyword sub-groups and treat (a) as corroborating.

**E6. Predictive validity (association, consistency, predictability) from history** (about 60–90 min)
- *Snapshot:* take the snapshot at a tag T about 12–18 months before HEAD. Compute file-level metrics (LOC-weighted risk shares, max CC, redundancy, LCOM, fan-in/out) on files that exist at T.
- *Outcomes in (T, HEAD]:*
  - (i) **bug-fix commit count**, by keyword heuristic on messages and linked issues [31];
  - (ii) **SZZ** bug-introducing lines via PyDriller `get_commits_last_modified_lines` on those fixes [26][33];
  - (iii) **change-proneness** (commits and churn touching the file). This is the cleanest outcome.
- *Label audit:* manually inspect a random 30 fix labels and report precision with a Wilson CI. This matters because of [30].
- *Statistics per metric:*
  - Spearman ρ with outcomes (consistency).
  - Pearson on log1p (association).
  - **Partial Spearman controlling for log LOC** [34][35].
  - Logistic regression `y = 1[≥1 fix] ~ log LOC + metric`: likelihood-ratio test of the metric term, OR per IQR with 95 % CI, ΔAUC vs. the size-only model (predictability/discriminative power).
  - BH across metric × outcome [44].
- *Accept* ("valid beyond size"): partial ρ > 0 with BH-q < 0.05 for outcome (iii), **and** the same sign for (i) or (ii).
  - "Size-redundant": significant raw but not partial association. Keep such a metric only if it is justified by construct (E0–E2) and say so.
  - "Not supported": neither.
- *Power note:* MessagePack-CSharp may have few labelled bug fixes. Report the number of events. If events are scarce, fit one metric per model (plus log LOC) and lean on outcome (iii).

**E7. Aggregation sanity (no ecological leaps, monotone score)** (about 15 min)
- *Monotonicity:* for 200 random single-entity improvements (inverse E2 mutations), the system score and every risk share must not get worse. *Accept:* 100 % (deterministic).
- *Level consistency:* report entity-level and system-level validation separately. Never claim that a system-level correlation implies per-file risk [38][37].
- *Concentration:* report the Gini of violating LOC across files and Theil's between/within decomposition by component [46][47], as descriptive statistics.

**E8. Gaming / non-exploitability audit** (about 20 min, qualitative plus counts)
- *Adversarial edits:*
  - split a long method into sequential fragments passing many parameters (unit size improves, interfacing worsens?);
  - rename duplicates (type-1 vs. type-2 clone detection);
  - move code into lambdas or local functions (does CC disappear?).
- *Report:* which metric each edit fools. This feeds the "non-exploitability" criterion [7] and Kaner Q10 [2].
- *Accept:* every known exploit is either caught by another metric in the vector or documented as a limitation.

**Report the validation table:** one row per metric with E0–E8 PASS/FAIL, with the CIs. Only metrics passing E0–E4 enter the certificate. E5/E6 decide the "evidence level" label (construct-only / predictive) and may set the weight in the display score.

---

## 8. CERTIFICATION FORMULA (proposal) [design, building on [52][53][55][64][66][67]]

**Inputs:**
- Units u (methods), modules f (files) and components c (top-level directories).
- Validated metrics m ∈ M.
- For unit-level metrics, risk thresholds t_{m,1} < t_{m,2} < t_{m,3} and caps c_{m,1} ≥ c_{m,2} ≥ c_{m,3}.
- Default thresholds and caps: the SIG/TÜV NORD 4-star values [55] (e.g. CC: t = 5, 10, 25 with caps 20.7 %, 7.5 %, 1.1 %; unit size: t = 15, 30, 60 LOC with caps 48.0 %, 24.2 %, 9.1 %; parameters: ≥ 3, ≥ 5, ≥ 7 with caps 15.4 %, 3.4 %, 0.9 %; duplication: redundant LOC ≤ 5.8 %).
- Re-calibration option: re-derive thresholds on a C# benchmark corpus with the Alves 70/80/90 % LOC-quantile method [52] using *our* tool, because tool definitions differ [21].

**1. Risk profile (ratio scale), per metric m and level k:**

 p̂_{m,k} = Σ_f V_{m,k}(f) / Σ_f L(f), where V_{m,k}(f) = Σ_{u∈f} LOC(u)·1[x_m(u) > t_{m,k}] and L(f) = Σ_{u∈f} LOC(u).

For duplication, p̂_dup = redundant LOC / total LOC. For module-level metrics (fan-in), replace units by modules.

**2. Confidence bounds (cluster bootstrap over files):**

 U_{m,k} = one-sided 95 % BCa upper bound of p̂_{m,k}, resampling files with replacement (B = 9999);
 L_{m,k} = one-sided 95 % BCa lower bound.

```python
from scipy import stats
def share(v, l, axis=-1):  # LOC-weighted ratio estimator
    return v.sum(axis=axis) / l.sum(axis=axis)
up = stats.bootstrap((V_mk, L), share, paired=True, vectorized=True,
                     method='BCa', alternative='less', confidence_level=0.95,
                     n_resamples=9999, rng=seed).confidence_interval.high
lo = stats.bootstrap((V_mk, L), share, paired=True, vectorized=True,
                     method='BCa', alternative='greater', confidence_level=0.95,
                     n_resamples=9999, rng=seed).confidence_interval.low
```
For tiny scopes (PRs touching fewer than about 30 files), BCa is unreliable. Switch to an exact binomial over *units*: `binomtest(k_viol, n_units, alternative='less').proportion_ci(0.95,'exact').high`.

Worked bounds (computed):

| Violating units / units | One-sided 95 % upper bound (exact) |
|---|---|
| 0 / 10 | 0.259 |
| 0 / 20 | 0.139 |
| 1 / 20 | 0.216 |
| 0 / 30 | 0.095 |

So small PRs will often, and honestly, come out **INCONCLUSIVE** against tight caps.

**3. Decision (intersection–union over all (m,k) [67]):**
- **CERTIFIED** iff U_{m,k} ≤ c_{m,k} for all m, k, plus the architecture checks (entanglement ≤ 0.075, independence ≥ 94.5 % [55]) where applicable.
- **REJECTED** iff some L_{m,k} > c_{m,k} after Holm adjustment over the (m,k) "fail" claims [43].
- **INCONCLUSIVE** otherwise. The certificate lists which caps lack evidence.
- **Unparsed code:** evaluate twice, with unparsed files assumed fully compliant and fully violating (Quamoco-style range [56]). Certify only if both runs certify.

**4. Agent-PR rule (non-inferiority) [design]:**
- For the units added or modified by the PR, compute p̂^PR_{m,k}. Certify "no degradation" iff the one-sided 95 % upper bound of p^PR_{m,k} − p^base_{m,k} is < δ_{m} for all (m,k). Use a two-sample cluster bootstrap, or Newcombe's interval for unit counts [70].
- Set δ_m in advance, e.g. a fraction of the cap; this is a policy choice [69].
- Absolute compliance of the PR uses the step-3 rule on the PR's own units.
- Optionally accumulate PR evidence over time with SPRT [73] ("trust is earned").

**5. Display score (descriptive, not inferential):**
- Per principle P (DRY, KISS, SRP, Coupling, ...) and metric m, take the entity severity s_{m,u} = Σ_k 1[x_m(u) > t_{m,k}] ∈ {0,1,2,3}.
- **Compliance:** C_m = 1 − (1/3)·Σ_k p̂_{m,k}. This equals 1 − (LOC-weighted mean severity)/3 and lies in [0,1]. It is linear and transparent.
- **Cap headroom:** H_m = min_k (c_{m,k} − U_{m,k}) / c_{m,k}. It is ≥ 0 iff metric m passes.
- **Overall:** S = 100 · Σ_P w_P · min_{m∈P} C_m, with equal weights or Rank-Order-Centroid weights as in Quamoco [56]. Show S with a cluster-bootstrap 95 % CI, e.g. "S = 78 [74, 81]".
- If a harsher score is wanted, replace the inner mean with the exponential quasi-arithmetic mean A_λ (§4.4). It is still monotone: improving any unit never lowers the score, which is Squale's requirement [50].
- Note on scale: s is ordinal, so C_m treats severity steps as equally spaced. That is acceptable for *display* but is why the certificate uses only the ratio-scale shares p̂ [10].

**6. Heatmap:**
- Cell color per file × principle = that file's LOC-weighted mean severity.
- Unit-level drill-down shows the raw metric value and the threshold crossed.
- Overlay the Gini/Theil concentration (§4.2) to tell "hotspot" from "systemic" problems.
- Per-file "significantly worse than repo" flags, if any, must use BH [44] and be labelled exploratory.

**7. Certificate record** (traceability, mirroring SIG/TÜV practice [54][55]):
- tool commit and config hash;
- scope and exclusions;
- metric definitions and the version of the validation report (E0–E8);
- thresholds and caps with their provenance;
- α, B and the seed;
- per-(m,k) p̂, L, U, cap and verdict;
- the overall verdict and the S score with its CI.

---

## 9. Unverified or partially verified items
- IEEE 1061-1998: criteria come from the Kaner & Bond summary of §4.5 [2]. The standard's text, any numeric example thresholds and its current status (revised or withdrawn?) are **[unverified]**.
- Schneidewind criterion wording comes from the verbatim quotes in [4]. Statistical procedures beyond the abstract (contingency tables) are **[unverified]**. That the methodology was "adopted into IEEE 1061" comes from search snippets of Schneidewind's later work **[unverified primary]**.
- The exact names of Meneely et al.'s "two philosophies" are **[unverified]**.
- Squale's concrete formula and λ constants are **[unverified]** (HAL blocked). §4.4 gives a standard mathematical form instead.
- The Alves et al. 2011 rating interpolation formula is **[unverified]**.
- The findings of Gil & Lalouche 2017 are **[unverified]** (title, venue and DOI verified).
- The Cliff's δ bands' attribution to Romano et al. 2006 is **[unverified]**. The R effsize source attributes them to Hess & Kromrey 2004 [42].
- EPV ≥ 10 (Peduzzi), the rule-of-three content (Hanley) and Newcombe's recommended method: metadata only.
- ISO/IEC 25040: only a partial secondary page was readable [77]. Its edition and the full list of process activities are **[unverified]**. ISO/IEC 5055 was not checked.
- Tool support (lizard for C#; how to invoke Roslyn metrics) is **[unverified]**. Check locally.

---

## References

[1] IEEE Std 1061-1998, *IEEE Standard for a Software Quality Metrics Methodology*. DOI 10.1109/IEEESTD.1998.243394 (metadata only; content via [2]).
[2] C. Kaner, W. P. Bond, "Software Engineering Metrics: What Do They Measure and How Do We Know?", METRICS 2004. https://kaner.com/pdfs/metrics2004.pdf
[3] N. F. Schneidewind, "Methodology for validating software metrics", IEEE TSE 18(5):410–422, 1992. DOI 10.1109/32.135774 (abstract read via OpenAlex).
[4] S. Omri, P. Montag, C. Sinz, "Static Analysis and Code Complexity Metrics as Early Indicators of Software Defects", JSEA 11:153–166, 2018. DOI 10.4236/jsea.2018.114010. https://pdfs.semanticscholar.org/e7a5/1d9a0afd603a4e6082ca658594014e0cae3e.pdf
[5] N. Nagappan, T. Ball, "Static analysis tools as early indicators of pre-release defect density", ICSE 2005. DOI 10.1145/1062455.1062558 (metadata only).
[6] A. Meneely, B. Smith, L. Williams, "Validating software metrics: A spectrum of philosophies", ACM TOSEM 21(4):1–28, 2012. DOI 10.1145/2377656.2377661 (abstract read).
[7] "How to validate software measures – list of attributes from a systematic review", metrics.blogg.gu.se, 2018 (list of the 47 criteria from [6]). https://metrics.blogg.gu.se/?p=310
[8] B. Kitchenham, S. L. Pfleeger, N. Fenton, "Towards a framework for software measurement validation", IEEE TSE 21(12):929–944, 1995. DOI 10.1109/32.489070 (abstract read).
[9] N. Fenton, J. Bieman, *Software Metrics: A Rigorous and Practical Approach*, 3rd ed., CRC Press, 2014. ISBN 9781439838228. https://www.oreilly.com/library/view/-/9781439838228/ (table of contents only).
[10] N. Fenton, S. L. Pfleeger, R. L. Glass, "Science and substance: a challenge to software engineers", IEEE Software 11(4):86–95, 1994. DOI 10.1109/52.300094. PDF: https://www.st.cs.uni-saarland.de/edu/softmine2007/Papers/fenton94.pdf
[11] N. Fenton, "Software measurement: a necessary scientific basis", IEEE TSE 20(3):199–206, 1994. DOI 10.1109/32.268921 (abstract read).
[12] S. S. Stevens, "On the theory of scales of measurement", Science 103(2684):677–680, 1946. DOI 10.1126/science.103.2684.677 (metadata only).
[13] L. C. Briand, S. Morasca, V. R. Basili, "Property-based software engineering measurement", IEEE TSE 22(1):68–86, 1996. DOI 10.1109/32.481535. PDF: https://www.cs.umd.edu/users/basili/publications/journals/J58.pdf
[14] E. J. Weyuker, "Evaluating software complexity measures", IEEE TSE 14(9):1357–1365, 1988. DOI 10.1109/32.6178.
[15] D. Beyer, P. Häring, "A Formal Evaluation of DepDegree Based on Weyuker's Properties", ICPC 2014. https://www.sosy-lab.org/research/pub/2014-ICPC.A_Formal_Evaluation_of_DepDegree_Based_on_Weyukers_Properties.pdf
[16] L. J. Cronbach, P. E. Meehl, "Construct validity in psychological tests", Psychological Bulletin 52(4):281–302, 1955. DOI 10.1037/h0040957 (metadata only).
[17] D. T. Campbell, D. W. Fiske, "Convergent and discriminant validation by the multitrait-multimethod matrix", Psychological Bulletin 56(2):81–105, 1959. DOI 10.1037/h0046016 (metadata only).
[18] T. Y. Chen et al., "Metamorphic Testing: A Review of Challenges and Opportunities", ACM Computing Surveys 51(1):1–27, 2018. DOI 10.1145/3143561 (abstract read).
[19] S. Segura, G. Fraser, A. B. Sanchez, A. Ruiz-Cortés, "A Survey on Metamorphic Testing", IEEE TSE 42(9):805–824, 2016. DOI 10.1109/TSE.2016.2532875 (metadata only).
[20] L. Applis, A. Panichella, A. van Deursen, "Assessing Robustness of ML-Based Program Analysis Tools using Metamorphic Program Transformations" (LAMPION), ASE 2021, 1377–1381. DOI 10.1109/ASE51524.2021.9678706 (abstract read).
[21] R. Lincke, J. Lundberg, W. Löwe, "Comparing software metrics tools", ISSTA 2008, 131–142. DOI 10.1145/1390630.1390648 (abstract read).
[22] J. M. Bland, D. G. Altman, "Statistical methods for assessing agreement between two methods of clinical measurement", The Lancet 327(8476):307–310, 1986. DOI 10.1016/S0140-6736(86)90837-8. Free copy: https://www-users.york.ac.uk/~mb55/meas/ba.pdf
[23] P. E. Shrout, J. L. Fleiss, "Intraclass correlations: Uses in assessing rater reliability", Psychological Bulletin 86(2):420–428, 1979. DOI 10.1037/0033-2909.86.2.420 (metadata only).
[24] T. K. Koo, M. Y. Li, "A Guideline of Selecting and Reporting Intraclass Correlation Coefficients for Reliability Research", J. Chiropractic Medicine 15(2):155–163, 2016. DOI 10.1016/j.jcm.2016.02.012. https://pmc.ncbi.nlm.nih.gov/articles/PMC4913118/
[25] J. Cohen, "A Coefficient of Agreement for Nominal Scales", Educational and Psychological Measurement 20(1):37–46, 1960. DOI 10.1177/001316446002000104 (metadata only).
[26] J. Śliwerski, T. Zimmermann, A. Zeller, "When do changes induce fixes?", MSR 2005. DOI 10.1145/1083142.1083147 (abstract read).
[27] S. Kim, T. Zimmermann, K. Pan, E. J. Whitehead Jr., "Automatic Identification of Bug-Introducing Changes", ASE 2006, 81–90. DOI 10.1109/ASE.2006.23 (abstract read).
[28] D. A. da Costa, S. McIntosh, W. Shang, U. Kulesza, R. Coelho, A. E. Hassan, "A Framework for Evaluating the Results of the SZZ Approach for Identifying Bug-Introducing Changes", IEEE TSE 43(7):641–657, 2017. DOI 10.1109/TSE.2016.2616306 (abstract read).
[29] G. Rosa, L. Pascarella, S. Scalabrino, R. Tufano, G. Bavota, M. Lanza, "Evaluating SZZ Implementations Through a Developer-Informed Oracle", ICSE 2021, 436–447. DOI 10.1109/ICSE43902.2021.00049. arXiv: https://arxiv.org/abs/2102.03300
[30] S. Herbold, A. Trautsch, F. Trautsch, B. Ledel, "Problems with SZZ and features: An empirical study of the state of practice of defect prediction data collection", Empirical Software Engineering 27(2), 2022. DOI 10.1007/s10664-021-10092-4 (abstract read).
[31] A. Mockus, L. G. Votta, "Identifying reasons for software changes using historic databases", ICSM 2000, 120–130. DOI 10.1109/ICSM.2000.883028 (abstract read).
[32] T. Zimmermann, R. Premraj, A. Zeller, "Predicting Defects for Eclipse", PROMISE 2007. DOI 10.1109/PROMISE.2007.10 (metadata only).
[33] D. Spadini, M. Aniche, A. Bacchelli, "PyDriller: Python framework for mining software repositories", ESEC/FSE 2018, 908–911. DOI 10.1145/3236024.3264598. Docs: https://pydriller.readthedocs.io/en/latest/git.html
[34] K. El Emam, S. Benlarbi, N. Goel, S. N. Rai, "The confounding effect of class size on the validity of object-oriented metrics", IEEE TSE 27(7):630–650, 2001. DOI 10.1109/32.935855 (abstract read).
[35] Y. Zhou, B. Xu, H. Leung, L. Chen, "An in-depth study of the potentially confounding effect of class size in fault prediction", ACM TOSEM 23(1):1–51, 2014. DOI 10.1145/2556777 (abstract read).
[36] Y. Gil, G. Lalouche, "On the correlation between size and metric validity", Empirical Software Engineering 22(5):2585–2611, 2017. DOI 10.1007/s10664-017-9513-5 (metadata only).
[37] D. Landman, A. Serebrenik, J. Vinju, "Empirical Analysis of the Relationship between CC and SLOC in a Large Corpus of Java Methods", ICSME 2014, 221–230. DOI 10.1109/ICSME.2014.44 (abstract read).
[38] D. Posnett, V. Filkov, P. Devanbu, "Ecological inference in empirical software engineering", ASE 2011, 362–371. DOI 10.1109/ASE.2011.6100074 (abstract read).
[39] N. Cliff, "Dominance statistics: Ordinal analyses to answer ordinal questions", Psychological Bulletin 114(3):494–509, 1993. DOI 10.1037/0033-2909.114.3.494 (metadata only).
[40] A. Vargha, H. D. Delaney, "A Critique and Improvement of the CL Common Language Effect Size Statistics of McGraw and Wong", J. Educational and Behavioral Statistics 25(2):101–132, 2000. DOI 10.3102/10769986025002101 (metadata only).
[41] A. Arcuri, L. Briand, "A practical guide for using statistical tests to assess randomized algorithms in software engineering", ICSE 2011, 1–10. DOI 10.1145/1985793.1985795 (metadata only).
[42] M. Torchiano, R package `effsize`, `R/CliffDelta.R` (magnitude levels 0.147/0.33/0.474, attributed to Hess & Kromrey 2004). https://raw.githubusercontent.com/mtorchiano/effsize/master/R/CliffDelta.R
[43] S. Holm, "A simple sequentially rejective multiple test procedure", Scandinavian Journal of Statistics 6(2):65–70, 1979. JSTOR 4615733 (procedure and citation via https://en.wikipedia.org/wiki/Holm%E2%80%93Bonferroni_method).
[44] Y. Benjamini, Y. Hochberg, "Controlling the False Discovery Rate: A Practical and Powerful Approach to Multiple Testing", JRSS-B 57(1):289–300, 1995. DOI 10.1111/j.2517-6161.1995.tb02031.x (metadata only).
[45] P. Peduzzi, J. Concato, E. Kemper, T. R. Holford, A. R. Feinstein, "A simulation study of the number of events per variable in logistic regression analysis", J. Clinical Epidemiology 49(12):1373–1379, 1996. DOI 10.1016/S0895-4356(96)00236-3 (metadata only).
[46] B. Vasilescu, A. Serebrenik, M. van den Brand, "You can't control the unfamiliar: A study on the relations between aggregation techniques for software metrics", ICSM 2011, 313–322. DOI 10.1109/ICSM.2011.6080798 (abstract read).
[47] A. Serebrenik, M. van den Brand, "Theil index for aggregation of software metrics values", ICSM 2010. DOI 10.1109/ICSM.2010.5609637 (abstract read).
[48] A. Serebrenik, M. van den Brand, B. Vasilescu, "Seeing the Forest for the Trees with New Econometric Aggregation Techniques", ERCIM News 88. https://ercim-news.ercim.eu/en88/special/seeing-the-forest-for-the-trees-with-new-econometric-aggregation-techniques
[49] K. Mordal-Manet, F. Balmas, S. Denier, S. Ducasse, H. Wertz et al., "The Squale model — A practice-based industrial quality model", ICSM 2009, 531–534. DOI 10.1109/ICSM.2009.5306381 (abstract read).
[50] K. Mordal-Manet, J. Laval, S. Ducasse, N. Anquetil, F. Balmas et al., "An Empirical Model for Continuous and Weighted Metric Aggregation", CSMR 2011, 141–150. DOI 10.1109/CSMR.2011.20. HAL: https://inria.hal.science/inria-00637367 (abstract read; full text blocked).
[51] I. Heitlager, T. Kuipers, J. Visser, "A Practical Model for Measuring Maintainability", QUATIC 2007, 30–39. DOI 10.1109/QUATIC.2007.8 (abstract read).
[52] T. L. Alves, C. Ypma, J. Visser, "Deriving metric thresholds from benchmark data", ICSM 2010. DOI 10.1109/ICSM.2010.5609747. PDF copy: https://list.inf.unibe.ch/hyperkitty/list/moose-dev@list.inf.unibe.ch/message/5JKRBNHFQI3AFFUZJELPGASSYK4HWQPO/attachment/4/Alves101.pdf
[53] T. L. Alves, J. P. Correia, J. Visser, "Benchmark-Based Aggregation of Metrics to Ratings", IWSM-MENSURA 2011, 20–29. DOI 10.1109/IWSM-MENSURA.2011.15 (abstract read).
[54] R. Baggen, K. Schill, J. Visser, "Standardized Code Quality Benchmarking for Improving Software Maintainability", SQM 2010 workshop. https://webarchive.di.uminho.pt/wiki.di.uminho.pt/twiki/pub/Personal/Joost/PublicationList/SQM2010-StandardizedCodeQuality.pdf
[54b] R. Baggen, J. P. Correia, K. Schill, J. Visser, same title, Software Quality Journal 20(2):287–307, 2012. DOI 10.1007/s11219-011-9144-9 (metadata only).
[55] Software Improvement Group, "SIG/TÜV NORD CERT Evaluation Criteria Trusted Product Maintainability: Guidance for Producers", Version 18.1, 31 March 2026. https://softwareimprovementgroup.com/wp-content/uploads/2020-SIG-TUViT-Evaluation-Criteria-Trusted-Product-Maintainability.pdf (the URL says 2020; the document served is v18.1).
[56] S. Wagner et al., "Operationalised product quality models and assessment: The Quamoco approach", Information and Software Technology 62:101–123, 2015. DOI 10.1016/j.infsof.2015.02.009. arXiv: https://arxiv.org/abs/1611.09230
[57] J.-L. Letouzey, "The SQALE method for evaluating Technical Debt", MTD 2012, 31–36. DOI 10.1109/MTD.2012.6225997 (abstract read).
[58] SonarSource, SonarQube Server documentation, "Metrics definitions" (maintainability rating grid). https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-metrics/metrics-definition/
[59] S. Herbold, J. Grabowski, S. Waack, "Calculation and optimization of thresholds for sets of software metrics", Empirical Software Engineering 16(6):812–841, 2011. DOI 10.1007/s10664-011-9162-z (abstract read).
[60] P. Oliveira, M. T. Valente, F. P. Lima, "Extracting relative thresholds for source code metrics", CSMR-WCRE 2014, 254–263. DOI 10.1109/CSMR-WCRE.2014.6747177 (abstract read).
[61] E. B. Wilson, "Probable Inference, the Law of Succession, and Statistical Inference", JASA 22(158):209–212, 1927. DOI 10.1080/01621459.1927.10502953 (metadata only).
[62] C. J. Clopper, E. S. Pearson, "The use of confidence or fiducial limits illustrated in the case of the binomial", Biometrika 26(4):404–413, 1934. DOI 10.1093/biomet/26.4.404 (metadata only).
[63] L. D. Brown, T. T. Cai, A. DasGupta, "Interval Estimation for a Binomial Proportion", Statistical Science 16(2):101–133, 2001. DOI 10.1214/ss/1009213286 (abstract read).
[64] B. Efron, "Better Bootstrap Confidence Intervals", JASA 82(397):171–185, 1987. DOI 10.1080/01621459.1987.10478410 (abstract read).
[65] B. Efron, R. Tibshirani, "Bootstrap Methods for Standard Errors, Confidence Intervals, and Other Measures of Statistical Accuracy", Statistical Science 1(1):54–75, 1986. DOI 10.1214/ss/1177013815 (metadata only).
[66] C. A. Field, A. H. Welsh, "Bootstrapping Clustered Data", JRSS-B 69(3):369–390, 2007. DOI 10.1111/j.1467-9868.2007.00593.x (metadata only).
[67] R. L. Berger, "Multiparameter Hypothesis Testing and Acceptance Sampling", Technometrics 24(4):295–300, 1982. DOI 10.1080/00401706.1982.10487790 (abstract read).
[68] D. J. Schuirmann, "A comparison of the Two One-Sided Tests Procedure and the Power Approach for assessing the equivalence of average bioavailability", J. Pharmacokinetics and Biopharmaceutics 15(6):657–680, 1987. DOI 10.1007/BF01068419 (metadata only).
[69] D. Lakens, "Equivalence Tests: A Practical Primer for t Tests, Correlations, and Meta-Analyses", Social Psychological and Personality Science 8(4):355–362, 2017. DOI 10.1177/1948550617697177 (metadata only).
[70] R. G. Newcombe, "Interval estimation for the difference between independent proportions: comparison of eleven methods", Statistics in Medicine 17(8):873–890, 1998. DOI 10.1002/(SICI)1097-0258(19980430)17:8<873::AID-SIM779>3.0.CO;2-I (metadata only).
[71] J. A. Hanley et al., "If Nothing Goes Wrong, Is Everything All Right?", JAMA 249(13):1743, 1983. DOI 10.1001/jama.1983.03330370053031 (metadata only).
[72] D. G. Bonett, T. A. Wright, "Sample Size Requirements for Estimating Pearson, Kendall and Spearman Correlations", Psychometrika 65(1):23–28, 2000. DOI 10.1007/BF02294183 (metadata only; useful for planning E4/E6 sample sizes).
[73] A. Wald, "Sequential Tests of Statistical Hypotheses", Annals of Mathematical Statistics 16(2):117–186, 1945. DOI 10.1214/aoms/1177731118 (metadata only).
[74] M. Strathern, "'Improving ratings': audit in the British University system", European Review 5(3):305–321, 1997. DOI 10.1002/(SICI)1234-981X(199707)5:3<305::AID-EURO184>3.0.CO;2-4 (wording and attribution via https://en.wikipedia.org/wiki/Goodhart%27s_law).
[75] M. Shepperd, "A critique of cyclomatic complexity as a software metric", Software Engineering Journal 3(2):30–36, 1988. DOI 10.1049/sej.1988.0003 (metadata only).
[76] N. E. Fenton, M. Neil, "A critique of software defect prediction models", IEEE TSE 25(5):675–689, 1999. DOI 10.1109/32.815326 (abstract read).
[77] ISO/IEC 25040 (SQuaRE evaluation process), secondary description: https://iso25000.com/index.php/en/iso-25000-standards/iso-25040 (partial; activities "Define the evaluation" and "Design the evaluation" confirmed).
[78] SciPy 1.18 reference: `scipy.stats.bootstrap` https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html ; `scipy.stats.binomtest` https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.binomtest.html ; `scipy.stats.false_discovery_control` https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.false_discovery_control.html (plus local signature checks: scipy 1.18.1, statsmodels 0.15.0, pingouin 0.7.0).
