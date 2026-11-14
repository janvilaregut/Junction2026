# 13 — The mathematics of aggregating quality indicators into scores and gates

Retrieved: 2026-11-14. Scope: how established quality models and multi-criteria decision analysis (MCDA) turn many indicators into one score and one accept/reject decision, and what that implies for the proposed certifier
`Q = 0.30·S + 0.25·F + 0.20·P + 0.15·M + 0.10·C` (S Security, F Reliability, P Tests, M Maintainability, C Consistency, each 0–100) with a separate 3-state gate (pass / fail / incomplete).

Conventions:
- Bracketed numbers point to the reference list at the end. Each reference says how far I checked it: **read** (I opened the full text or the relevant section), **abstract** (abstract or summary only), or **metadata** (title, authors, venue and DOI confirmed through Crossref, content not opened). Anything I could not confirm is marked **[unverified]**.
- Numbers labelled **(our computation)** come from small Python scripts I wrote and ran for this note, not from a paper. They use the formulas shown, plus synthetic profiles where stated.
- Limitation: the shared web-search budget ran out partway through. After that I only fetched known URLs or DOIs. One consequence is that I did not find a controlled study showing that quality gates cause better outcomes (§4.4). That is a gap in what I searched, not proof that no such study exists.

---

## 0. TL;DR

1. **Keep the teammate's architecture: a score that is separate from the accept decision, plus three outcomes.** It matches what working systems do. SonarQube ratings use the worst finding, not an average [18]. The Sonar quality gate fails if *any* condition fails [16]. SIG certification requires every quality rating to be at least 2 stars *and* the overall rating to be at least 3 stars [13]. Quamoco reports a best-case/worst-case range when data are missing [1].
2. **A weighted arithmetic mean like Q is fully compensatory, so it cannot be the decision rule.** The weights act as exchange rates between dimensions, not as importance [24]. With the proposed weights, 1 point of S is worth 3 points of C everywhere on the scale. A repository with S = 83.3 and everything else at 100 already scores Q = 95 (our computation). So whether "one critical finding still allows 95" depends only on how many S points the S formula deducts for one critical finding, which is an arbitrary choice.
3. **Keep the score, but replace the arithmetic mean with a weighted geometric mean of benchmark-calibrated utilities.** Formulas are in §7. The geometric mean is the p = 0 member of the power-mean family. It only partly compensates: the cost of making up for a weak dimension grows as that dimension gets worse. It is also the aggregator whose rankings do not change when you rescale one dimension's units [24][25]. Inside a dimension, aggregate file- or finding-level marks with Squale-style "soft-min" weighting [4].
4. **Weights:** the order S > F > P > M > C fits the Rank-Order Centroid (ROC) approach that Quamoco used [1][31]. ROC weights for 5 ranks are (0.457, 0.257, 0.157, 0.090, 0.040). The teammate's weights (0.30, 0.25, 0.20, 0.15, 0.10) also respect that order, but they are not the centroid. Report Q under both, and present every weight-dependent decision as robust or fragile using the closed-form bounds in §8.3.
5. **Gate:** use strong-Kleene three-valued logic, with FAIL < INCOMPLETE < PASS and gate = min over conditions [51]. Score conditions are tested on the interval [Q_lo, Q_hi]. Conditions that rely on sampled evidence are tested on confidence bounds (Clopper–Pearson [54], SPRT [53]). Keep "not applicable" (nothing to measure, like Sonar's 20-line rule [16]) separate from "unknown" (should have been measured, but was not).

---

## 1. How established quality models aggregate

| Model | Leaf normalisation | Aggregation | Compensatory? | Missing data |
|---|---|---|---|---|
| **Quamoco** [1][2] | Rule-violation counts divided by a size measure (e.g. LOC). Then a **linear increasing or decreasing utility between min and max thresholds** taken from a benchmark | **Weighted sum** at every level. Weights come from relevance rankings via **Rank-Order Centroid** (Swing approach). Final utility is mapped to school grades 1–6 | Fully (linear) | **Best-case and worst-case values for missing data, reported as a range** [1] |
| **Squale** [3][4][5][6] | Each component gets an individual mark (IM) in [0, 3] from expert-agreed, mostly continuous formulas | Practice mark = **−log_λ( (1/n)·Σ λ^(−IM_i) )**. λ sets "hard", "medium" or "soft" weighting. Criteria = weighted average of practices. Factors = average of criteria | Within a practice: **penalising** (a few bad components drag the mark down). Above that: compensatory | Not covered in what I read |
| **SQALE** [7][8] | Each non-compliance gets a **remediation cost** (a ratio scale) | **Sum** of remediation costs gives the SQALE Quality Index. A separate sum of non-remediation (business impact) costs gives the SBII. Density = debt / size | Additive, but every term is ≥ 0, so good code adds 0 and cannot cancel debt elsewhere. Each flaw belongs to exactly one characteristic (orthogonal model) | — |
| **SIG / TÜViT** [9][10][11][12][13] | Per-unit metrics are binned into risk categories using benchmark thresholds (70th/80th/90th percentiles weighted by LOC [10] **[unverified: percentile detail from secondary slides]**). Each system gets a **quality profile** (% of LOC per risk category) | Profile → property rating (stars) via a benchmark calibration in which about 5 % of systems get 5★, 30 % 4★, 30 % 3★, 30 % 2★ and 5 % 1★ [13]. Properties → ISO characteristics → overall rating | Mostly averaging, **plus conjunctive certification floors**: every quality rating ≥ 2★ and overall ≥ 3★ [13] | — |
| **QMOOD** [14] | Design properties (e.g. coupling, cohesion, messaging) from OO design metrics | Each quality attribute is a **weighted linear combination of design properties** with signed weights **[unverified: exact coefficients and baseline normalisation not opened]** | Fully | — |
| **SonarQube ratings** [18] | Severity of each issue | **Security and Reliability rating = worst severity present** (A = 0 issues, … E = at least one blocker). Maintainability = technical-debt-ratio bands (A ≤ 5 %, B 5–10 %, C 10–20 %, D 20–50 %, E ≥ 50 %) | **Non-compensatory (max of severities)** for S and F | — |
| **ISO/IEC 25040** [15] | Defines the SQuaRE evaluation *process*, not a formula **[unverified: ISO page blocked]**. Quamoco calls this kind of procedure too abstract to put into operation [1] | — | — | — |

Key verified details:
- **Quamoco thresholds** (Appendix A of [1]). Take the benchmark values, compute Q1 and Q3 over the *non-zero* values, and set IQR = Q3 − Q1. Then max = the largest value ≤ Q3 + 1.5·IQR and min = the smallest value ≥ Q1 − 1.5·IQR. If fewer than 5 benchmark systems have a non-zero value, use a jump function: min = 0, max = 0.00000001. The aim is to stop outliers from producing extreme thresholds.
- **Quamoco calibration and validation.** The C# model was calibrated on only 23 systems and was left out of the main validation. The Java base model ranked 5 open-source systems in a way that correlated with a 9-expert ranking at Spearman r = 0.9. The experts' own agreement was Kendall's W = 0.66. That is n = 5, so treat it as weak evidence [1].
- **Squale worked example** [4]: marks 0.5, 1.5, 3. Arithmetic mean ≈ 1.67, weighted practice mark 0.93. The deliverable gives no λ values. λ ≈ 10 reproduces 0.93 (λ = 9 gives 0.95, λ = 10 gives 0.934) (our computation). **[unverified: the λ constants Squale uses for hard, medium and soft.]**
- **Why SQALE adds** [7]: non-remediation costs sit on a ratio scale, not an ordinal one, so adding them is consistent with measurement theory and the representation condition [8]. The same argument means **averaging ordinal letter grades is not meaningful** (§2.3).
- **SIG validation** (slides [13]): moving from 2★ to 4★ came with resolution speed rising by factors of 3.5 and 4.0, and productivity by a factor of 10. These numbers come from slides summarising MSc theses and an SQM 2010 paper, so they are secondary evidence.

What this means for us: every mature model separates **(a) a benchmark-calibrated mapping from raw measures to a bounded utility** from **(b) an aggregation rule**. The models that people use to *decide* (SonarQube ratings, Sonar gates, SIG certification) all have a non-compensatory step.

---

## 2. MCDA theory that applies

### 2.1 The additive model and its hidden assumption
An additive value function V(x) = Σ_j w_j·v_j(x_j) exists only if the criteria are **mutually preferentially independent**: the trade-off between any two criteria must not depend on the levels of the others (Debreu, Keeney & Raiffa, Krantz et al., as summarised in [24] §6.10; book [30]). The OECD/JRC handbook calls this a very strong condition. It points out that linear aggregation assumes no synergies or conflicts between components [24].

In linear and in geometric aggregation, **weights are trade-offs (substitution rates), not importance coefficients**. When indicators are measured as intensities, the substitution rates equal the weights up to a constant (Munda & Nardo [28], via [24] §6.13). If you want weights to mean importance, you need a **non-compensatory** procedure [24]. Bouyssou [29] formalised compensation in MCDM **[metadata only]**.

> Applied to Q: "S has weight 0.30" does **not** mean security matters 30 %. It means 1 S-point can be swapped for 0.30/0.10 = 3 C-points, at every level of S.

### 2.2 The compensation spectrum (weighted power means)
For utilities u_j ∈ (0, 1] and weights w_j ≥ 0 with Σ w_j = 1:

```
M_p(u; w) = ( Σ_j w_j · u_j^p )^(1/p)        p ≠ 0
M_0(u; w) = Π_j u_j^(w_j)                    (weighted geometric mean, limit p→0)
M_-∞(u)   = min_j u_j                        (conjunctive / Rawlsian)
```

The power-mean inequality gives M_−∞ ≤ M_−1 ≤ M_0 ≤ M_1 ≤ M_+∞, with equality only when all u_j are equal. Switching from arithmetic to geometric can therefore only lower a score, and only for unbalanced profiles.

**Marginal rate of substitution.** Since ∂M_p/∂u_j ∝ w_j·u_j^(p−1):

```
MRS_jk = (w_j / w_k) · (u_j / u_k)^(p−1)
```

- For p = 1 (Q as proposed) the MRS is constant at w_j/w_k: full, constant compensation.
- For p = 0, MRS_jk = (w_j/u_j)/(w_k/u_k). It grows as u_j falls. With the teammate's weights, the MRS of S against C is 3.75 at S = 80, 6 at S = 50 and 15 at S = 20, with C = 100 (our computation). The handbook describes the same thing: geometric aggregation compensates less when values are low, and it rewards improving the weakest dimension more [24] §6.11.
- For p → −∞, only the worst dimension counts (no compensation, but also **weak monotonicity only**: improving any other dimension changes nothing).

Profiles on the 0–100 scale with the teammate's weights. The geometric and harmonic columns floor each u at 1 to avoid log 0 (our computation):

| Profile (S,F,P,M,C) | Arithmetic (Q) | Geometric | Harmonic p = −1 | Min |
|---|---|---|---|---|
| (100,100,100,100,100) | 100 | 100 | 100 | 100 |
| (70,70,70,70,70) | 70 | 70 | 70 | 70 |
| (0,100,100,100,100) | **70** | 25.1 | 3.3 | 0 |
| (40,100,100,100,100) | 82 | 76.0 | 69.0 | 40 |
| (75,100,100,100,100) | 92.5 | 91.7 | 90.9 | 75 |
| (100,100,0,100,100) | 80 | 39.8 | 4.8 | 0 |
| (100,100,100,100,0) | 90 | 63.1 | 9.2 | 0 |

The handbook gives its own example with equal weights: (21,1,1,1) and (6,6,6,6) tie under additive aggregation, while geometric aggregation scores them 2.14 and 6 [24] §6.11.

Real composite indices use this split. The UN **Human Development Index** combines its three dimension indices with a geometric mean, but averages the two education sub-indicators arithmetically because perfect substitution between them is considered acceptable [25]. That is the same "compensatory within a dimension, partly compensatory across dimensions" structure recommended in §7. HDI also uses **fixed min/max goalposts**, and the geometric mean cannot take zeros, so HDI handles zeros explicitly [25].

**Ordered Weighted Averaging (OWA)** [39] applies weights to *sorted* values, which interpolates between min, mean and max. It loses which dimension is weak, so it does not fit our case, where S has a special role.

### 2.3 Measurement-scale meaningfulness
Stevens [48] and Fenton [49] note that which statistics are permissible depends on the scale type. A statement is meaningful only if it survives every admissible change of scale.
- **Ordinal scales** (letter grades A–E, severity labels) allow strictly monotone transformations. Comparing *min* or *median* is meaningful. Comparing *weighted means* of ordinal grades is not, because a monotone relabelling can reverse the comparison. This is SQALE's argument for summing ratio-scale costs instead [7][8].
- **Ratio scales** with independent units per dimension allow x_j → a_j·x_j. Then M_0(a∘x) = (Π a_j^(w_j))·M_0(x), so **geometric-mean rankings do not change** under per-dimension rescaling. M_1 rankings do change unless every a_j is the same. In practice this means that, if utilities are ratio-normalised (x_j / x_ref,j), the choice of reference x_ref,j does not affect geometric-mean rankings (our derivation).
- **Interval or min–max utilities** depend on both goalposts. The weights then implicitly include the goalpost ranges (§6.2).

### 2.4 Rank reversal
- **Normalisation-induced.** If min/max come from the evaluated set itself, adding or removing an alternative can reverse rankings of the others. Example (our computation): two criteria, findings per kLOC (lower is better) and coverage % (higher is better), equal weights, min–max normalised within the set. With A = (1, 60), B = (3, 70), C = (5, 30): A = 0.875 > B = 0.75. Add an unrelated repo D = (21, 70): A = 0.875 < B = 0.95. **Fix: freeze the goalposts** on a versioned benchmark, as Quamoco [1] and HDI [25] do.
- **AHP-induced.** Belton & Gear [36] showed that AHP's eigenvector normalisation can reverse rankings when a copy of an alternative is added **[metadata only]**. This is another reason to avoid AHP-style *relative* scoring of repositories.

### 2.5 Weighting methods (formulas)
*Rank-based, when only an importance order is known*, for n criteria ranked 1 (most important) to n:
- **Rank-Order Centroid** [31][32]: w_j = (1/n)·Σ_{r=j..n} 1/r. This is the centroid of the order-consistent simplex {w₁ ≥ … ≥ w_n ≥ 0, Σ w = 1}, whose vertices are (1,0,…,0), (½,½,0,…), …, (1/n,…,1/n) [32]. Equivalently, it is the expected weight vector under a uniform prior on that region. Barron & Barrett found ROC more accurate than the other rank-based formulae in simulation [31]. For n = 5: **(0.4567, 0.2567, 0.1567, 0.0900, 0.0400)**. A Monte-Carlo check (mean of sorted Dirichlet(1,…,1) draws, N = 200 000) gives (0.457, 0.257, 0.157, 0.090, 0.040) (our computation).
- **Rank-Sum** [33]: w_j = 2(n+1−j)/(n(n+1)), giving (0.333, 0.267, 0.200, 0.133, 0.067) for n = 5.
- **Rank-Reciprocal** [33]: w_j = (1/j)/Σ_k(1/k), giving (0.438, 0.219, 0.146, 0.110, 0.088).
- **Teammate's weights** follow w_j ∝ (n+2−j) = (6,5,4,3,2)/20. They are *admissible* (they respect the order) and flatter than ROC. L1 distance to ROC = 0.327 (our computation).
- **SMARTS/SMARTER** [34] (Edwards & Barron) is the swing-weighting family that ROC came from **[metadata only]**.

*Subjective pairwise:* **AHP** [35]. Saaty's 1–9 pairwise scale; weights = principal eigenvector of the reciprocal matrix. Consistency ratio rule of thumb CR < 0.1 (0.2 is sometimes cited). AHP is compensatory, and its weights are trade-offs, not importance [24] §6.7.

*Objective, data-driven:* these set weights from how the data vary across a corpus, not from importance.
- **Entropy weight** [38] (formula as commonly stated; original not opened): p_ij = x_ij/Σ_i x_ij; e_j = −(1/ln m)·Σ_i p_ij·ln p_ij; d_j = 1 − e_j; w_j = d_j/Σ_k d_k.
- **CRITIC** [37] uses contrast intensity and conflict between criteria (from the paper's summary). Commonly stated as C_j = σ_j·Σ_k(1 − r_jk), w_j = C_j/Σ C_k **[formula not checked against the original]**.
- **PCA/FA weights** [24] §6.1: built from squared rotated loadings. They only correct for overlapping information, and they cannot be estimated when the indicators are uncorrelated.
- ⚠ **Danger for security.** In a corpus where most repositories have no security findings, σ_S is close to 0 and the entropy of S is close to its maximum. Both methods then give S a weight near 0, which is the opposite of the intended policy. Use objective methods only as a *diagnostic* (they show which dimensions actually separate repositories), never as policy weights.

### 2.6 Nominal versus effective weights
Paruolo, Saisana & Saltelli [27] measure a variable's actual importance in a composite with Pearson's correlation ratio (the "main effect", i.e. the first-order Sobol index S_j = Var(E[Q|u_j])/Var(Q)). They found that declared weights and main effects often differ a lot, because of variance differences and correlation. For a linear Q with independent u_j:

```
S_j = w_j² σ_j² / Σ_k w_k² σ_k²
```

So a dimension that rarely varies (S, in most PRs) has almost no influence on the *ranking*, even with the largest weight. When it does vary (a vulnerability appears), its effect is capped at w_S × (points the S formula deducts). That is an argument for putting the security signal in the **gate** rather than only in the score.

---

## 3. Missing data and incomplete evaluations

- **Why missing ≠ zero findings.** "Analyzer did not run" and "analyzer ran and found 0" are different observations. Coding the first as the second makes the absence of evidence look like evidence of quality. The failure is very likely *Not Missing At Random* in Rubin's taxonomy [50][24]: analyzers time out or crash more often on large, generated or unusual code, and coverage is missing when tests do not build. The handbook notes that NMAR cannot be tested for, that most imputation methods assume MCAR or MAR, and that NMAR has to be modelled explicitly [24] §1.3. Imputation (mean, zero, last value) is therefore not justified.
- **Partial-identification view.** Without imputation, the most you can state honestly is the set of values consistent with the observed data. For a monotone aggregator that set is an interval [Q_lo, Q_hi]: fill missing utilities with their worst (0 or ε) and best (1) values. This is exactly Quamoco's approach: best-case and worst-case values for missing data, with the resulting range expressing the uncertainty [1].
- **How existing gates handle it is inconsistent:**
  - Sonar's "Sonar way for agentic AI" gate **skips** (greys out) the Dependency Risks condition when the add-on licence is missing [17]. Missing becomes a silent pass.
  - Codacy's "Diff coverage is under" gate **flags** a PR whose diff coverage is ∅ (not applicable) [22]. Missing becomes a fail.
  - A Sonar community thread reports a gate passing with 0 % coverage on new code reported elsewhere. No root cause was posted [20].
  - Sonar's API has a `NONE` status for projects never analysed (per a staff reply quoted in a search summary **[unverified: summary only]** [21]).
  
  An explicit third state is the principled middle ground.
- **Vacuous versus unknown.** Sonar ignores coverage and duplication conditions until there are at least 20 new (coverable) lines [16]. That is a *precondition*: the condition is **not applicable** because there is nothing meaningful to measure. It is a different case from "the coverage tool failed", which is **unknown**. The gate has to keep the two apart (§9).

---

## 4. Quality gates in practice

### 4.1 SonarQube
- **Sonar way** (default) has four conditions on new code [16]: no new issues; all new Security Hotspots reviewed; new-code coverage ≥ 80.0 %; new-code duplication ≤ 3.0 %. **A single failing condition fails the gate.** PR analysis uses only the new-code conditions. Instead of "no new issues", a gate can use "Reliability/Security/Maintainability rating worse than A". The docs note this weaker form lets some debt through [16].
- **Clean-as-You-Code-compliant gate** [19]: 0 new issues (or all three ratings at A on new code), hotspots reviewed = 100 %, and coverage and duplication thresholds the user can configure. The docs advise against conditions on overall code.
- **Sonar way for agentic AI** [17]: on new code, no new reliability or security issues ≥ Low, no maintainability issues ≥ Medium, no dependency risks ≥ Low, coverage ≥ 80 %, duplication ≤ 3 %. It replaces the older "Sonar way for AI Code" gate.
- **Rating definitions** [18]: Security/Reliability A = 0 issues, B ≥ 1 minor, C ≥ 1 major, D ≥ 1 critical, E ≥ 1 blocker. Security-review rating is based on % of hotspots reviewed (A ≥ 80 %). Technical debt ratio = debt / (cost per line × LOC). Coverage = (CT + LC)/(B + EL). Duplicated density = duplicated lines / lines × 100.

### 4.2 Codacy and Code Climate (now Qlty)
- **Codacy** [22] gate rules: new issues over N (above a severity), new security issues over N, complexity over N, duplication (clones) over N, coverage variation under X (they suggest −0.10 % or lower), and diff coverage under X (PRs only; ∅ is flagged). No defaults are stated; an organisation-level gate policy applies.
- **Qlty / Code Climate** [23]: maintainability grade from technical debt ratio (A < 5 %, B 5–10 %, C 10–20 %, D 20–50 %, F ≥ 50 %), with development cost estimated by COCOMO. File grades use a logarithmic function of debt (formula not given). PR gates are go/no-go on newly introduced issues and coverage.

### 4.3 Where the numbers come from
The 80 % coverage and 3 % duplication thresholds are **vendor defaults**. I found no paper deriving them as optimal, and the Sonar docs cite none [19]. Treat them as policy parameters and include them in the sensitivity analysis.

### 4.4 Evidence that gates or their inputs relate to outcomes (all observational)
- **Clean as You Code, directly tested:** across 27 Apache projects (66,661 classes, 56,890 commits), cleaner *new* code was an efficient way to reduce technical-debt density. Projects with explicit quality policies committed clean new code more often [60]. The Sonar docs themselves give no empirical evidence [19].
- **Code health and outcomes:** across 39 proprietary codebases, low-quality code had 15× more defects and took 124 % longer to resolve issues in [64]. SIG star ratings were associated with faster issue resolution [13].
- **Caution about rule validity:** across 33 Apache Java projects, SonarQube issues had a significant but small effect on change-proneness and **no** effect on fault-proneness. The authors also found inconsistent type and severity classifications [61]. In another study, violations SonarQube labels as "bugs" were generally not fault-prone [62]. In real use, only about 13 % of SonarQube issues were resolved on average [63].
- **Coverage is a weak proxy:** once suite size is controlled for, coverage correlates only low to moderately with mutation-based effectiveness. The authors advise against using it as a quality target [65].
- **No controlled study found** showing that adding a gate improves later defect rates **[gap; search budget exhausted]**.

---

## 5. Statistical decisions under uncertainty

Most static-analysis measurements are deterministic for a given commit, so there is no sampling error. The uncertainty is in the **analyzer** (false negatives and false positives) and in **sampled measurements** (flaky reruns, mutation-score samples). Formulations:

1. **Hypothesis-test framing (Neyman–Pearson [52]).** Put the burden of proof on the change: H₀ = "the change is unacceptable" (e.g. θ ≥ θ₀), H₁ = "acceptable". Accept only when H₀ is rejected at level α, so **P(false accept) ≤ α**. With defect density or failure probability θ, accept iff UCB₁₋α(θ) < θ₀. With a "higher is better" score such as mutation score, accept iff LCB₁₋α ≥ θ₀.
2. **Binomial bounds.** Clopper–Pearson exact intervals [54]. Wilson [55] is better centred; Brown, Cai & DasGupta [56] compare them. Example (our computation), 95 % one-sided lower bound for an observed mutation score of 0.85: n = 20 gives 0.656, n = 100 gives 0.779, n = 200 gives 0.802. Against a threshold of 0.75, only the two larger samples can produce a confident PASS.
3. **Zero numerators ("rule of three" [57]).** After n independent trials with 0 failures, the exact one-sided 95 % upper bound is 1 − 0.05^(1/n) ≈ 3/n: 0.095 for n = 30 and 0.0099 for n = 300 (our computation). Applied to flaky tests, 30 clean reruns only bound the flake rate below about 10 %.
4. **Sequential testing (Wald SPRT [53]).** At each step, compute the log-likelihood ratio Λ_n and compare it with ln B and ln A, where A ≈ (1−β)/α and B ≈ β/(1−α). The result is **accept H₁, accept H₀ or continue sampling**. For α = 0.05 and β = 0.10: A = 18, B ≈ 0.105 (our computation). That three-way outcome lines up with our pass / fail / incomplete.
5. **Many conditions inflate false rejects.** With k independent conditions, each having false-reject rate α, the gate's false-reject rate is 1 − (1−α)^k ≤ kα. For α = 0.05: 14.3 % with k = 3, 26.5 % with k = 6, 33.7 % with k = 8 (our computation). False accepts for a change that is bad in exactly one dimension are *not* inflated. A conjunctive gate deliberately accepts more false rejects in exchange for fewer false accepts, which is the right asymmetry for security, as long as each condition has low noise.
6. **Limits.** Statistical testing cannot show ultra-high reliability within any feasible amount of testing (Butler & Finelli [58]; Littlewood & Strigini [59]). "0 findings from tools X, Y" means *no known findings*, not *secure*. With per-vulnerability recall r < 1, P(0 findings | k real vulnerabilities) = (1−r)^k under independence (our derivation). Label the certificate to match.

---

## 6. DELIVERABLE 1 — Critique of Q = 0.30S + 0.25F + 0.20P + 0.15M + 0.10C

**F1. Full, constant compensation.** The MRS between any two dimensions is constant, w_j/w_k (§2.2). One S-point always buys 3 C-points or 1.5 P-points. Concrete cases (our computation):
- S = 0 with everything else perfect gives Q = 70, the same as a uniformly mediocre (70, 70, 70, 70, 70).
- P = 0 (no tests at all) gives Q = 80.
- Q = 95 needs only S ≥ 83.3 when everything else is at 100. So if the S formula deducts fewer than 16.7 points per critical finding, an otherwise perfect repository with a critical vulnerability scores ≥ 95. The score cannot carry a veto by construction, so the teammate's choice to separate the decision is **mathematically required**, not just cautious.

**F2. Weights have no meaning independent of the utility functions (scale incommensurability).** ∂Q/∂x_j = w_j·u_j′(x_j). The trade-off the formula actually encodes depends on how raw measures become 0–100. Example: S = 100 − 25·(#high findings) and P = line coverage %. Then one high finding costs 0.30·25 = 7.5 Q-points, so **1 high vulnerability ≡ 37.5 coverage points** (our computation). Change the deduction from 25 to 10 and the same w_S = 0.30 now means 15 coverage points. Calibration and weights have to be justified together. The honest stakeholder question is "is one high vulnerability worth 37.5 points of coverage?", not "is security 30 %?" [24][28].

**F3. Ordinal inputs averaged as if cardinal.** If any of S, F, M or C come from letter grades (A–E) or severity labels mapped to numbers, averaging them is not meaningful: the ranking depends on the arbitrary numeric coding (§2.3; [7][48][49]).

**F4. Double counting.**
- *Shared rules or findings:* one defect reported by two analyzers, or classified under two dimensions (e.g. a resource leak that is both reliability and security), is counted twice. SQALE avoids this by design: each flaw appears exactly once [7]. When two collinear indicators enter with weights w₁ and w₂, the shared dimension effectively gets w₁ + w₂ [24].
- *Shared latent factor:* complexity and duplication tend to drive M, C and F together, and many OO metrics are confounded with size [66][67]. Var(Q) contains 2·w_F·w_M·ρ_FM·σ_F·σ_M, so a common factor's effective weight is larger than any nominal weight suggests [27].

**F5. Nominal weights ≠ effective influence.** For rankings, a dimension's influence is roughly w_j²σ_j²/Σ w_k²σ_k² (§2.6). If S is 100 for most repositories, the "most important" dimension barely affects rankings, while low-signal dimensions with high variance (e.g. C) dominate them [27].

**F6. Set-dependent normalisation causes rank reversal.** If 0–100 comes from min–max over the evaluated set, adding an unrelated repository can swap two others (example in §2.4). Fix the goalposts.

**F7. Decisions near a Q threshold depend on the weights.** Synthetic profile u = (60, 80, 70, 90, 85), threshold τ = 75 (our computation). Q = 74.0, so FAIL. With the other weights rescaled proportionally, the decision flips if w_C rises from 0.10 to 0.182, if w_S falls from 0.30 to 0.25, or if w_F rises from 0.25 to 0.375. Under ROC weights Q = 70.4 (§8.3).

**F8. Missing ≡ 0 or missing ≡ 100.** Both distort Q by up to w_j·100. With P missing, Q for the profile above could be anywhere in [60, 80] (arithmetic) (our computation). Any single number chosen from that range is arbitrary.

**F9. Arbitrary weights without derivation.** (0.30, …, 0.10) is the linear rule w_j ∝ n+2−j. It respects the stated order but has no derivation (unlike ROC's centroid argument [31][32]) and no stability analysis.

**What is right in the proposal:** the score is separated from the decision (matches [13][16][18]); there is a 3-state outcome (matches [1]'s range idea); thresholds are scoped to new code (matches [16][19], supported by [60]); and the dimensions follow ISO-like characteristics, so they are readable.

---

## 7. DELIVERABLE 2 — Recommended aggregation (keeps the teammate's structure)

Three layers: **(L1) a non-compensatory gate** (§9), **(L2) a partly compensatory certification score**, **(L3) transparency outputs**.

### 7.1 Leaf → utility (benchmark-calibrated, fixed goalposts)
For each measure m (densities per kLOC or per new kLOC, ratios, %), define a utility in [0, 1]:

```
lower-is-better:  u_m(x) = clamp( (x_max − x) / (x_max − x_min), 0, 1 )
higher-is-better: u_m(x) = clamp( (x − x_min) / (x_max − x_min), 0, 1 )
```

Set x_min and x_max with Quamoco's rule on a **frozen, versioned C# benchmark** [1]: Q1 and Q3 over non-zero values, IQR fences, and a jump function when fewer than 5 benchmark systems have non-zero values. Store the benchmark hash in every certificate so that the goalposts never depend on the set being evaluated (F6).

### 7.2 Utilities → dimension score u_j ∈ [0, 1]
- **Measures within a dimension:** arithmetic mean with ROC weights (compensation is acceptable *inside* a dimension, as with the HDI education sub-index [25]). Assign every rule or finding to **exactly one** dimension, and deduplicate findings across analyzers by (file, span, rule-family/CWE) (F4; [7]).
- **Components (files, methods) within a measure:** where per-component marks exist (e.g. per-method complexity), use **Squale soft-min** on marks IM_i ∈ [0, 3] [4]:

```
mark = − log_λ ( (1/n) Σ_i λ^(−IM_i) )
```

  Example: 95 files at 3 and 5 files at 0. Plain mean 2.85. Squale mark 2.24 at λ = 3, 1.35 at λ = 9, 0.88 at λ = 30 (our computation). Pick λ per dimension (high for S and F, low for C) and include λ in the sensitivity analysis.
- **S and F specifically:** keep a severity-weighted, ratio-scale "cost" (SQALE-style remediation or impact points, summed [7]) for the *score*. Gate the *count of confirmed critical/high findings on new code* separately in L1 (Sonar-style "worst severity" [18]).

### 7.3 Dimensions → Q (weighted geometric mean)

```
Q = 100 · Π_{j∈{S,F,P,M,C}} max(u_j, ε)^(w_j),     ε = 0.01
```

- **Weights:** ROC on the stated order, w = (0.457, 0.257, 0.157, 0.090, 0.040). The teammate's (0.30, 0.25, 0.20, 0.15, 0.10) can be kept as a published alternative. Q is reported under both, and the robustness check in §8.3 decides which decisions are weight-independent.
- **Why the geometric mean:**
  - It is idempotent and strictly increasing in each u_j > ε.
  - Its MRS grows as a dimension worsens (partial compensability) [24].
  - It is invariant to per-dimension ratio rescaling (§2.3).
  - It is the documented compromise when full non-compensation is too harsh but additivity is unacceptable [24][25].
- **ε** keeps Q defined when a dimension is 0. With ε = 0.01, a zero S scores Q ≈ 25 instead of 70 (teammate's weights; our computation). The actual block still comes from L1.
- **Optional generalisation:** M_p with p ∈ [−1, 1] as a single parameter for compensation level. Fix p = 0 for the certificate and vary p in the sensitivity analysis (OECD recommends treating the aggregation rule as an uncertain input [24] §1.7).

### 7.4 Dimension floors (SIG-style conjunctive layer)
Certification level L needs Q ≥ τ_L **and** u_j ≥ f_{j,L} for every j. This mirrors SIG's certification rule: every quality rating ≥ 2★ and overall ≥ 3★ [13]. Floors make "no dimension below an acceptable minimum" explicit, without the drowning effect of the pure min.

### 7.5 Incomplete evidence: interval Q
If any u_j is UNKNOWN:

```
Q_lo = Q(u with unknown u_j := ε),   Q_hi = Q(u with unknown u_j := 1)
```

Monotonicity guarantees that the true Q of any completion lies in [Q_lo, Q_hi] (Quamoco's best/worst-case range [1]). **Never report a point Q when the evidence is incomplete.**

### 7.6 Transparency outputs
For each dimension report u_j, w_j, the log-contribution w_j·ln u_j, its share of ln Q, and the "binding" dimension (argmin u_j). Also report the correlation matrix of dimensions on the benchmark, so reviewers can see likely double counting [24] §1.

---

## 8. DELIVERABLE 3 — Weight-sensitivity experiment

**Goal:** show that (a) gate decisions do not depend on the weights, and (b) certificate levels and rankings are stable, or flag where they are not. This follows the uncertainty and sensitivity analysis approach in the OECD/JRC handbook [24] §7 and Saisana et al. [26].

### 8.1 Inputs
- **Corpus:** the challenge repositories plus the frozen C# benchmark (N repositories or PRs), each with dimension utilities u_ij (including UNKNOWN flags).
- **Uncertain factors**, sampled independently:
  1. **Weights**, three regimes:
     - (W-a) *uninformed*: w ~ Dirichlet(1,1,1,1,1), uniform on the simplex [47].
     - (W-b) *order-constrained*: sort a Dirichlet(1) draw in descending order and assign it to S ≥ F ≥ P ≥ M ≥ C. This region's expectation is exactly the ROC vector [32] (confirmed by Monte Carlo above). It is the SMAA treatment of ordinal weight information [41][42][43].
     - (W-c) *local*: w ~ Dirichlet(κ·w₀) with w₀ the reference weights. Var(w_j) = w₀j(1−w₀j)/(κ+1) [47]. For w₀ = teammate's weights, κ = 100 gives SD ≈ (0.046, 0.043, 0.040, 0.036, 0.030) and κ = 50 gives SD ≈ (0.064, 0.061, 0.056, 0.050, 0.042) (our computation).
  2. **Aggregator exponent** p ∈ {1, 0.5, 0, −1} (discrete, uniform).
  3. **Squale λ** per dimension, from a small grid.
  4. **Goalposts:** bootstrap the benchmark and recompute Quamoco thresholds (data uncertainty).
  5. **Gate thresholds** (coverage 70/80/90 %, duplication 3/5 %) as policy factors.
- For Sobol indices with Dirichlet weights, sample **independent** Gamma(α_j) variates g_j and set w_j = g_j/Σg. The g_j are independent inputs, which the standard Sobol and Saltelli estimators assume [44][45][46].

### 8.2 Outputs per repository i and overall
- **Decision-flip probability** π_i = P(level or decision ≠ reference). Report the share of repositories with π_i < 0.05 ("robust").
- **Rank acceptability index** b_i^r = P(rank_i = r) (SMAA [41]) and the **average rank shift** R̄ = (1/N)·Σ_i |rank_ref(i) − rank(i)| [24].
- **Kendall τ / Spearman ρ** between sampled and reference rankings (distribution).
- **First-order and total Sobol indices** of Q (and of the decision indicator) for each factor group [44][45][46]. Compare dimension main effects with nominal weights (the Paruolo divergence [27]) to find dimensions whose stated importance is not realised.
- **Monte-Carlo precision:** with 10,000 draws, the standard error of any estimated probability is ≤ √(0.25/10 000) = 0.005 (our computation). Sobol estimation with the Saltelli design costs on the order of N·(k+2) model evaluations **[unverified exact cost; check against [45]/[46] before quoting]**, which is trivial for a closed-form Q.

### 8.3 Closed-form robustness checks (no simulation needed)
- **Weight stability intervals (one weight varied, others rescaled proportionally).** For linear Q, with A_j = Σ_{k≠j} w_k·u_k/(1−w_j), the decision flips at

  ```
  w_j* = (τ − A_j) / (u_j − A_j)
  ```

  Example: u = (60, 80, 70, 90, 85), τ = 75, teammate's weights. w_S* = 0.25, w_F* = 0.375, w_M* = 0.203, w_C* = 0.182 (our computation). The FAIL holds only while w_S > 0.25, w_F < 0.375, w_M < 0.203 and w_C < 0.182. Report these intervals alongside the decision.
- **Robust bounds over all order-consistent weights.** The region {w₁ ≥ … ≥ w₅ ≥ 0, Σ = 1} is a simplex with vertices v_m = (1/m, …, 1/m, 0, …, 0) [32]. A linear Q reaches its extremes at vertices, so

  ```
  Q_rob_lo = min_{m=1..5} (1/m) Σ_{j≤m} u_(j),   Q_rob_hi = max_{m} (1/m) Σ_{j≤m} u_(j)
  ```

  Here u_(j) is ordered by *importance rank* (S, F, P, M, C), not by value (our derivation). For the example: [60, 77]. Every order-consistent weighting gives Q between 60 and 77, so whether "Q ≥ 75" holds depends on the weighting: the decision is weight-fragile. For the geometric mean, apply the same argument to ln Q, since ln Q is linear in w.
- **Illustration** (synthetic profile above, N = 200 000, seed 13; our computation). P(pass at τ = 75) is 0.684 under W-a, 0.010 under W-b, 0.261 under W-c with κ = 50, 0.182 with κ = 100 and 0.100 with κ = 200. This shows why a Q threshold alone should not be the gate.

### 8.4 Acceptance criteria for the design
1. **L1 gate outcomes have π_i = 0 by construction** (they do not depend on weights). Verify this with the experiment.
2. Certificate levels should be robust (π_i < 0.05) for at least a stated share of repositories (choose the target before running). Fragile ones get "level L (weight-sensitive)" or a margin band.
3. Main effects should be ordered roughly like the nominal weights. If not, revisit the utility calibrations (F2, F5).

---

## 9. DELIVERABLE 4 — Formal 3-state gate

### 9.1 Objects
- Analyzers 𝒜. For each a ∈ 𝒜, a run record ρ_a ∈ {ok, absent, crashed, timeout, partial(s)}, where s ∈ [0, 1] is the share of in-scope files analysed.
- Conditions 𝒦 = {k₁, …, k_m}. Each k has: a set of analyzers it needs, D_k ⊆ 𝒜; a required completeness s_k (default 1); a precondition π_k (e.g. ≥ 20 new coverable lines, mirroring [16]); and a predicate φ_k over the measurements x (e.g. #confirmed_critical_new = 0, coverage_new ≥ 0.80, Q_lo ≥ τ).
- Truth values 𝕋 = {FAIL = 0, INCOMPLETE = ½, PASS = 1} with the order 0 < ½ < 1, i.e. the strong-Kleene algebra [51].

### 9.2 Condition evaluation

Let incomplete_k(e) mean ∃a ∈ D_k : ρ_a ≠ ok ∧ ¬(ρ_a = partial(s) ∧ s ≥ s_k).

```
v_k(e) =
  0   if φ_k is a count bound "#X ≤ n" and the findings already observed exceed n   (FAIL by witness: more evidence can only add findings)
  ½   else if incomplete_k(e)                                                         (UNKNOWN: evidence missing)
  1   else if ¬π_k(x)                                                                 (NOT APPLICABLE ⇒ vacuously PASS; logged as N/A)
  1   else if φ_k(x)                                                                  (PASS)
  0   otherwise                                                                       (FAIL)
```

The first line is what lets a partial SAST run that has already found a confirmed critical vulnerability fail the gate, instead of reporting "incomplete".

For **interval-valued** measures (Q with unknown dimensions), use v_k = 1 if Q_lo ≥ τ, 0 if Q_hi < τ, ½ otherwise.

For **sampled** measures with parameter θ and a "higher is better" threshold θ₀, use v_k = 1 if LCB₁₋α ≥ θ₀, 0 if UCB₁₋α < θ₀, ½ otherwise. Optionally collect more samples while the result is ½ (SPRT [53]).

### 9.3 Gate

```
G(e) = min_{k∈𝒦} v_k(e)           (strong-Kleene conjunction)
outcome = PASS if G = 1;  FAIL if G = 0;  INCOMPLETE if G = ½
```

The certificate shows the outcome, the list of FAIL conditions, the list of UNKNOWN conditions with their analyzer and reason, the N/A conditions, and [Q_lo, Q_hi].

### 9.4 Properties (with proof sketches)
- **P1. Missing never counts as zero findings.** An absent or failed analyzer gives ½, never 1. So G = 1 needs every required analyzer to have run with adequate completeness.
- **P2. A confirmed critical always blocks.** If any analyzer run, even a partial one, reports a confirmed critical finding on new code, then v_k = 0 for the condition #confirmed_critical_new = 0 (witness rule). So G = min(…, 0, …) = 0 whatever Q, the other conditions or the missing analyzers are (non-compensation; Sonar's "any condition fails" rule [16]). A FAIL that has been observed is decisive even when other evidence is missing.
- **P3. Agreement with all completions.** Assume each UNKNOWN condition could still turn out either PASS or FAIL. Then G = 1 iff every completion of the missing evidence passes; G = 0 iff every completion fails; G = ½ iff some completions pass and some fail. *Proof:* if some v_k = 0 (observed, or witnessed under partial evidence), every completion fails. If every v_k = 1, nothing is missing. Otherwise every observed condition passes and at least one is unknown; completing the unknowns as PASS gives PASS and completing one as FAIL gives FAIL. Strong-Kleene evaluation is exact here because the formula is a conjunction of separate atoms; it can be inexact for formulas with repeated or negated atoms, which this gate does not use.
- **P4. Monotone in information.** Adding evidence that is consistent with what is already known can move ½ to 0 or 1, but never 1 to 0 or 0 to 1 (strong-Kleene connectives are monotone in the information order). This is the property that makes "incomplete" safe to cache and retry.
- **P5. Separate from the score.** Q affects G only through explicitly declared conditions (e.g. Q_lo ≥ τ_L for a certification level). Weight changes cannot change outcomes driven by conditions that do not involve weights (π_i = 0 in §8.4).
- **P6. Error rates.** If each statistical condition is evaluated at level α, P(false accept) ≤ α for any single bad dimension. P(false reject) ≤ Σ_k α_k for a fully good change (§5). Choose α_k with this budget in mind.

### 9.5 Mapping to CI
Exit code 0 = PASS, 1 = FAIL, 2 = INCOMPLETE. The default policy is **fail-closed** (INCOMPLETE blocks merging), but INCOMPLETE is reported separately, so the remedy ("run analyzer X") differs from the remedy for FAIL ("fix finding Y"). A repository may label an analyzer *optional*; its conditions then leave 𝒦 explicitly and the certificate lists them as "not evaluated". This is the opposite of Sonar's silent skipping [17].

### 9.6 Suggested condition set for new code (thresholds are policy; vary them in §8)
1. #confirmed critical/high security findings = 0 (needs: SAST analyzers).
2. #new reliability findings with severity ≥ major = 0 (needs: Roslyn/Sonar-type analyzers).
3. Build succeeds and all tests pass. Flaky tests are handled with reruns and a rule-of-three bound [57].
4. Coverage on new coverable lines ≥ 80 %, precondition ≥ 20 new coverable lines [16]. Coverage is a weak proxy [65], so keep this as a floor, not a target.
5. Duplication on new lines ≤ 3 %, precondition ≥ 20 new lines [16].
6. All new security hotspots reviewed (if there is a hotspot concept) [16].
7. Certification: Q_lo ≥ τ_L and u_j ≥ f_{j,L} for all j (SIG-style [13]).

---

## 10. Open issues and items not verified
- The exact λ values Squale uses for hard, medium and soft weighting **[unverified]**. The λ ≈ 10 inference comes only from reproducing one worked example.
- QMOOD coefficients and normalisation **[unverified]**. ISO/IEC 25040 process steps **[unverified]**.
- The exact SIG risk-category percentile thresholds and the "issues resolved 3× faster for 4★ vs 2★" figure from Baggen et al. [12] **[unverified; only slides [13] read]**.
- Entropy and CRITIC formulas are given as commonly stated; the original papers were not opened.
- No controlled study found on the causal effect of quality gates (search budget exhausted).

---

## References

1. Wagner, S., Goeb, A., Heinemann, L., Kläs, M., Lampasona, C., Lochmann, K., et al. (2015). Operationalised product quality models and assessment: The Quamoco approach. *Information and Software Technology* 62:101–123. https://doi.org/10.1016/j.infsof.2015.02.009 — read via arXiv 1611.09230 (https://ar5iv.labs.arxiv.org/html/1611.09230): utility functions, ROC/Swing weights, weighted-sum aggregation, Appendix A thresholds, best/worst-case missing data, validation.
2. Wagner, S., Lochmann, K., Heinemann, L., Kläs, M., Trendowicz, A., Plösch, R., et al. (2012). The Quamoco product quality modelling and assessment approach. *ICSE 2012*, 1133–1142. https://doi.org/10.1109/ICSE.2012.6227106 — metadata.
3. Mordal-Manet, K., Balmas, F., Denier, S., Ducasse, S., Wertz, H., Laval, J., Bellingard, F., Vaillergues, P. (2009). The Squale Model – A Practice-based Industrial Quality Model. ICSM 2009 short paper. https://www.squale.org/quality-models-site/research-deliverables/WP1.3_ICSM-2009_ShortPaper.pdf — read.
4. Balmas, F., Bellingard, F., Denier, S., Ducasse, S., Laval, J., Mordal-Manet, K. (2009). Practices in the Squale Quality Model (Squale Deliverable 1.3). https://www.squale.org/quality-models-site/research-deliverables/WP1.3_Practices-in-the-Squale-Quality-Model_v1.pdf — read (§4.2 practice-mark formula and worked example).
5. Mordal-Manet, K., Laval, J., Ducasse, S., Anquetil, N., Balmas, F., Bellingard, F., et al. (2011). An Empirical Model for Continuous and Weighted Metric Aggregation. *CSMR 2011*, 141–150. https://doi.org/10.1109/CSMR.2011.20 — metadata.
6. Mordal, K., Anquetil, N., Laval, J., Serebrenik, A., Vasilescu, B., Ducasse, S. (2013). Software quality metrics aggregation in industry. *J. Softw. Evol. Process* 25(10):1117–1135. https://doi.org/10.1002/smr.1558 — abstract (https://research.tue.nl/en/publications/software-quality-metrics-aggregation-in-industry/).
7. Letouzey, J.-L., Ilkiewicz, M. (2012). Managing Technical Debt with the SQALE Method. *IEEE Software* 29(6):44–51. https://doi.org/10.1109/MS.2012.129 — read (accepted version: https://lists.uniroma2.it/index.html/arc/isssr/2014-01/msg00007/IEEE-SW-Managing-TD-with-SQALE-Accepted-version.pdf).
8. Letouzey, J.-L., Coq, T. (2010). The SQALE Analysis Model: An Analysis Model Compliant with the Representation Condition for Assessing the Quality of Software Source Code. *VALID 2010*, 43–48. https://doi.org/10.1109/VALID.2010.31 — metadata.
9. Heitlager, I., Kuipers, T., Visser, J. (2007). A Practical Model for Measuring Maintainability. *QUATIC 2007*, 30–39. https://doi.org/10.1109/QUATIC.2007.8 — metadata.
10. Alves, T. L., Ypma, C., Visser, J. (2010). Deriving metric thresholds from benchmark data. *ICSM 2010*. https://doi.org/10.1109/ICSM.2010.5609747 — abstract (partial).
11. Alves, T. L., Correia, J. P., Visser, J. (2011). Benchmark-Based Aggregation of Metrics to Ratings. *IWSM-Mensura 2011*, 20–29. https://doi.org/10.1109/IWSM-MENSURA.2011.15 — metadata.
12. Baggen, R., Correia, J. P., Schill, K., Visser, J. (2012). Standardized code quality benchmarking for improving software maintainability. *Software Quality Journal* 20(2):287–307. https://doi.org/10.1007/s11219-011-9144-9 — metadata.
13. Visser, J. (2011). Software Product Quality and its Effects (slides, SIG). https://homepages.cwi.nl/~jurgenv/teaching/evolution1213/slides/sig.pdf — read (quality profiles, 5/30/30/30/5 calibration, certification floors, effect factors).
14. Bansiya, J., Davis, C. G. (2002). A hierarchical model for object-oriented design quality assessment. *IEEE TSE* 28(1):4–17. https://doi.org/10.1109/32.979986 — metadata.
15. ISO/IEC 25040 — SQuaRE Evaluation process. https://www.iso.org/standard/35765.html — **[unverified: page blocked]**.
16. SonarSource. Introduction to quality gates (SonarQube Server docs). https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates — read.
17. SonarSource. Quality gate for agentic AI. https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/ai-code-assurance/quality-gate-for-agentic-ai — read.
18. SonarSource. Metric definitions. https://docs.sonarsource.com/sonarqube-server/user-guide/code-metrics/metrics-definition — read.
19. SonarSource. Clean as You Code (SonarQube 10.6 docs). https://docs.sonarsource.com/sonarqube-server/10.6/user-guide/clean-as-you-code — read.
20. Sonar Community. "Sonar scan runs show Passed even if no Coverage". https://community.sonarsource.com/t/sonar-scan-runs-show-passed-even-if-no-coverage/110713 — read.
21. Sonar Community. api/qualitygates/project_status statuses. https://community.sonarsource.com/t/api-qualitygates-project-status/84698 — **[unverified: seen only through a search summary]**.
22. Codacy. Adjusting quality gates. https://docs.codacy.com/repositories-configure/adjusting-quality-gates/ — read.
23. Qlty (formerly Code Climate Quality). Maintainability metrics https://docs.qlty.sh/cloud/maintainability/metrics.md ; Coverage https://docs.qlty.sh/coverage.md ; overview https://docs.qlty.sh/ — read.
24. Nardo, M., Saisana, M., Saltelli, A., Tarantola, S., Hoffmann, A., Giovannini, E. (2008). *Handbook on Constructing Composite Indicators: Methodology and User Guide*. OECD/JRC. https://doi.org/10.1787/9789264043466-en ; JRC record https://publications.jrc.ec.europa.eu/repository/handle/JRC47008 — read (PDF: §1.3, §1.5–1.7, §6.1, §6.7, §6.10–6.13, §7).
25. UNDP (2022). Human Development Report 2021/2022 — Technical notes. https://hdr.undp.org/sites/default/files/2021-22_HDR/hdr2021-22_technical_notes.pdf — read (HDI geometric mean, education arithmetic mean, goalposts).
26. Saisana, M., Saltelli, A., Tarantola, S. (2005). Uncertainty and sensitivity analysis techniques as tools for the quality assessment of composite indicators. *JRSS A* 168(2):307–323. https://doi.org/10.1111/j.1467-985X.2005.00350.x — abstract.
27. Paruolo, P., Saisana, M., Saltelli, A. (2013). Ratings and rankings: voodoo or science? *JRSS A* 176(3):609–634. https://doi.org/10.1111/j.1467-985X.2012.01059.x — abstract.
28. Munda, G., Nardo, M. (2009). Noncompensatory/nonlinear composite indicators for ranking countries: a defensible setting. *Applied Economics* 41(12):1513–1523. https://doi.org/10.1080/00036840601019364 — metadata (content via [24]).
29. Bouyssou, D. (1986). Some remarks on the notion of compensation in MCDM. *EJOR* 26(1):150–160. https://doi.org/10.1016/0377-2217(86)90167-0 — metadata.
30. Keeney, R. L., Raiffa, H. (1976; reissued 1993). *Decisions with Multiple Objectives*. Cambridge University Press. https://doi.org/10.1017/CBO9781139174084 — metadata.
31. Barron, F. H., Barrett, B. E. (1996). Decision Quality Using Ranked Attribute Weights. *Management Science* 42(11):1515–1523. https://doi.org/10.1287/mnsc.42.11.1515 — abstract (https://ideas.repec.org/a/inm/ormnsc/v42y1996i11p1515-1523.html).
32. Hatefi, M. A. (2023). An Improved Rank Order Centroid Method (IROC) for Criteria Weight Estimation. *Informatica* 34(2):249–270. https://doi.org/10.15388/23-INFOR507 — read (ROC formula, simplex vertices, uniform-simplex assumption).
33. Stillwell, W. G., Seaver, D. A., Edwards, W. (1981). A comparison of weight approximation techniques in multiattribute utility decision making. *OBHP* 28(1):62–77. https://doi.org/10.1016/0030-5073(81)90015-5 — metadata.
34. Edwards, W., Barron, F. H. (1994). SMARTS and SMARTER: Improved Simple Methods for Multiattribute Utility Measurement. *OBHDP* 60(3):306–325. https://doi.org/10.1006/obhd.1994.1087 — metadata.
35. Saaty, T. L. (1977). A scaling method for priorities in hierarchical structures. *J. Math. Psychology* 15(3):234–281. https://doi.org/10.1016/0022-2496(77)90033-5 — metadata (AHP details via [24] §6.7).
36. Belton, V., Gear, T. (1983). On a short-coming of Saaty's method of analytic hierarchies. *Omega* 11(3):228–230. https://doi.org/10.1016/0305-0483(83)90047-6 — metadata.
37. Diakoulaki, D., Mavrotas, G., Papayannakis, L. (1995). Determining objective weights in multiple criteria problems: The CRITIC method. *Computers & OR* 22(7):763–770. https://doi.org/10.1016/0305-0548(94)00059-H — metadata + summary.
38. Zou, Z., Yun, Y., Sun, J. (2006). Entropy method for determination of weight of evaluating indicators in fuzzy synthetic evaluation for water quality assessment. *J. Environmental Sciences* 18(5):1020–1023. https://doi.org/10.1016/S1001-0742(06)60032-6 — metadata.
39. Yager, R. R. (1988). On ordered weighted averaging aggregation operators in multicriteria decisionmaking. *IEEE TSMC* 18(1):183–190. https://doi.org/10.1109/21.87068 — metadata.
40. Butler, J., Jia, J., Dyer, J. (1997). Simulation techniques for the sensitivity analysis of multi-criteria decision models. *EJOR* 103(3):531–546. https://doi.org/10.1016/S0377-2217(96)00307-4 — metadata + summary (no-information / order / partial-information weight simulation).
41. Lahdelma, R., Hokkanen, J., Salminen, P. (1998). SMAA – Stochastic multiobjective acceptability analysis. *EJOR* 106(1):137–143. https://doi.org/10.1016/S0377-2217(97)00163-X — metadata.
42. Lahdelma, R., Salminen, P. (2001). SMAA-2: Stochastic Multicriteria Acceptability Analysis for Group Decision Making. *Operations Research* 49(3):444–454. https://doi.org/10.1287/opre.49.3.444.11220 — metadata; overview https://en.wikipedia.org/wiki/Stochastic_multicriteria_acceptability_analysis — read.
43. Tervonen, T., Figueira, J. R. (2008). A survey on stochastic multicriteria acceptability analysis methods. *J. Multi-Criteria Decision Analysis* 15(1–2):1–14. https://doi.org/10.1002/mcda.407 — metadata.
44. Sobol', I. M. (2001). Global sensitivity indices for nonlinear mathematical models and their Monte Carlo estimates. *Math. Comput. Simul.* 55(1–3):271–280. https://doi.org/10.1016/S0378-4754(00)00270-6 — metadata.
45. Saltelli, A. (2002). Making best use of model evaluations to compute sensitivity indices. *Comput. Phys. Commun.* 145(2):280–297. https://doi.org/10.1016/S0010-4655(02)00280-1 — metadata.
46. Saltelli, A., Ratto, M., Andres, T., Campolongo, F., Cariboni, J., Gatelli, D., et al. (2008). *Global Sensitivity Analysis: The Primer*. Wiley. https://doi.org/10.1002/9780470725184 — metadata.
47. Wikipedia. Dirichlet distribution. https://en.wikipedia.org/wiki/Dirichlet_distribution — read (flat Dirichlet = uniform on simplex; mean; variance).
48. Stevens, S. S. (1946). On the Theory of Scales of Measurement. *Science* 103(2684):677–680. https://doi.org/10.1126/science.103.2684.677 — metadata.
49. Fenton, N. (1994). Software measurement: a necessary scientific basis. *IEEE TSE* 20(3):199–206. https://doi.org/10.1109/32.268921 — metadata.
50. Rubin, D. B. (1976). Inference and missing data. *Biometrika* 63(3):581–592. https://doi.org/10.1093/biomet/63.3.581 — metadata (MCAR/MAR/NMAR as used in [24] §1.3).
51. *Stanford Encyclopedia of Philosophy*, "Many-Valued Logic". https://plato.stanford.edu/entries/logic-manyvalued/ — read (Kleene's ½ as undefined; min/max; 0 < ½ < 1).
52. Neyman, J., Pearson, E. S. (1933). On the problem of the most efficient tests of statistical hypotheses. *Phil. Trans. R. Soc. A* 231:289–337. https://doi.org/10.1098/rsta.1933.0009 — metadata.
53. Wald, A. (1945). Sequential Tests of Statistical Hypotheses. *Ann. Math. Statist.* 16(2):117–186. https://doi.org/10.1214/aoms/1177731118 — metadata.
54. Clopper, C. J., Pearson, E. S. (1934). The use of confidence or fiducial limits illustrated in the case of the binomial. *Biometrika* 26(4):404–413. https://doi.org/10.1093/biomet/26.4.404 — metadata.
55. Wilson, E. B. (1927). Probable Inference, the Law of Succession, and Statistical Inference. *JASA* 22(158):209–212. https://doi.org/10.1080/01621459.1927.10502953 — metadata.
56. Brown, L. D., Cai, T. T., DasGupta, A. (2001). Interval Estimation for a Binomial Proportion. *Statistical Science* 16(2):101–133. https://doi.org/10.1214/ss/1009213286 — metadata.
57. Hanley, J. A., Lippman-Hand, A. (1983). If Nothing Goes Wrong, Is Everything All Right? Interpreting zero numerators. *JAMA* 249(13):1743–1745. https://doi.org/10.1001/jama.1983.03330370053031 — metadata.
58. Butler, R. W., Finelli, G. B. (1993). The infeasibility of quantifying the reliability of life-critical real-time software. *IEEE TSE* 19(1):3–12. https://doi.org/10.1109/32.210303 — abstract.
59. Littlewood, B., Strigini, L. (1993). Validation of ultrahigh dependability for software-based systems. *CACM* 36(11):69–80. https://doi.org/10.1145/163359.163373 — metadata.
60. Digkas, G., Chatzigeorgiou, A., Ampatzoglou, A., Avgeriou, P. (2022). Can Clean New Code Reduce Technical Debt Density? *IEEE TSE* 48(5):1705–1721. https://doi.org/10.1109/TSE.2020.3032557 — abstract (arXiv 2010.09161).
61. Lenarduzzi, V., Saarimäki, N., Taibi, D. (2020). Some SonarQube issues have a significant but small effect on faults and changes. A large-scale empirical study. *JSS* 170:110750. https://doi.org/10.1016/j.jss.2020.110750 — abstract (https://arxiv.org/abs/1908.11590).
62. Lenarduzzi, V., Lomio, F., Huttunen, H., Taibi, D. (2020). Are SonarQube Rules Inducing Bugs? *SANER 2020*, 501–511. https://doi.org/10.1109/SANER48275.2020.9054821 — abstract (https://arxiv.org/abs/1907.00376).
63. Marcilio, D., Bonifácio, R., Monteiro, E., Canedo, E., Luz, W., Pinto, G. (2019). Are Static Analysis Violations Really Fixed? A Closer Look at Realistic Usage of SonarQube. *ICPC 2019*, 209–219. https://doi.org/10.1109/ICPC.2019.00040 — abstract.
64. Tornhill, A., Borg, M. (2022). Code Red: The Business Impact of Code Quality — A Quantitative Study of 39 Proprietary Production Codebases. *TechDebt 2022*, 11–20. https://doi.org/10.1145/3524843.3528091 — abstract (arXiv 2203.04374).
65. Inozemtseva, L., Holmes, R. (2014). Coverage is not strongly correlated with test suite effectiveness. *ICSE 2014*, 435–445. https://doi.org/10.1145/2568225.2568271 — read (abstract, PDF https://www.cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf).
66. El Emam, K., Benlarbi, S., Goel, N., Rai, S. N. (2001). The confounding effect of class size on the validity of object-oriented metrics. *IEEE TSE* 27(7):630–650. https://doi.org/10.1109/32.935855 — metadata.
67. Gil, Y., Lalouche, G. (2017). On the correlation between size and metric validity. *Empirical Software Engineering* 22(5):2585–2611. https://doi.org/10.1007/s10664-017-9513-5 — metadata.
68. Vasilescu, B., Serebrenik, A., van den Brand, M. (2011). You can't control the unfamiliar: A study on the relations between aggregation techniques for software metrics. *ICSM 2011*, 313–322. https://doi.org/10.1109/ICSM.2011.6080798 — metadata (component-to-system aggregation via mean vs inequality indices; cited for further reading).
69. Trendowicz, A., Kläs, M., Lampasona, C., Münch, J., Körner, C., Saft, M. (2010). Model-based Product Quality Evaluation with Multi-Criteria Decision Analysis. *IWSM/MetriKon/Mensura 2010*. https://arxiv.org/abs/1401.1913 — abstract.
