# 17 — History-based experiments (E4, E5, E7)

All three experiments mine version history. They are deterministic and re-runnable. Scripts live in `experiments/`, results in `out/experiments/` and caches in `out/cache/` (gitignored).

**Corpus:**
- MessagePack-CSharp (`corpus/messagepack-csharp`; base line `origin/HEAD` = 32258fdb, 2025-03-01).
- 12 benchmark repos cloned with full history into `corpus/history/`: Polly, Dapper, FluentValidation, Humanizer, Newtonsoft.Json, CsvHelper, StackExchange.Redis, Autofac, Moq, RestSharp, Serilog, Spectre.Console.

Every measurement comes from `qlab` (read-only import). Snapshots are read with `git cat-file --batch`; nothing is checked out.

**Bug-fix labelling** (`experiments/history.py`):
- A keyword regex on the commit subject (fix/bug/crash/regression/defect/hang/leak/exception/wrong/incorrect/broken/faulty).
- False friends are excluded: prefix, fixture, "code fix", fix build/ci/typo/test/style/docs/readme/pack/version, dependabot, bump.
- This label is **noisy**. Herbold et al. find about half of keyword/SZZ labels are not real bug fixes (see research/07 [30]). Treat every bug-fix result as indicative.

Renames are followed (`git log -M`, rename limit 200k), so v2→v3 file moves in MessagePack keep their T0 identity.

---

## E4 — Predictive validity (do the metrics predict future bug-fix activity?)

`experiments/e4_predictive.py` runs per repo; `experiments/e4_meta.py` pools across repos.

**Design:**
- **Snapshot:** T0 is the first-parent commit about 24 months before HEAD (primary, as specified), with 36 months as a sensitivity window.
- **Unit:** a production `.cs` file at T0.
- **Outcome:** number of non-merge bug-fix commits after T0 touching the file (and, as a second outcome, all changes).
- **Predictors:** qlab on the whole T0 tree. File SLOC, Σ/max cyclomatic, Σ/max cognitive, max nesting, max unit SLOC, max parameters, Type-1/Type-2/any duplicated-line fraction (cross-file clones included), magic density, naming-violation density, documentation coverage, dead-code density, error-handling violations, max LCOM4, max CBO, and file-graph centrality (in/out degree, PageRank d=0.85, Brandes betweenness). Prior churn (12 months before T0) is also a control.
- **Statistics:** Spearman; partial Spearman controlling log SLOC; logistic `has_fix ~ log SLOC + log1p(prior churn) + z(metric)` with a likelihood-ratio test and AUC; BH correction.
- **Meta-analysis:** DerSimonian–Laird random effects over Fisher-z partial correlations (var ≈ 1.06/(n−3)). Repos are included when they have ≥8 files with and ≥8 files without a fix.

### MessagePack alone (24 m, T0 = 04e202f4, 2023-01-10)

140 prod files; 28 had at least one bug-fix commit (137 bug-fix commits out of 1151 commits after T0). AUC was 0.705 for size only and 0.709 with churn added.
- Only **size** is significant after BH (ρ = 0.29, q = 0.005).
- Σcyclomatic (ρ 0.25), Σ/max cognitive (0.27/0.22), max nesting (0.26), max LCOM4 (0.29), betweenness (0.22) and prior churn (0.20) are significant raw but vanish once size is controlled (**size-redundant**).
- **PageRank: ρ = 0.10, partial 0.09, no association.** Duplication, magic numbers, naming, docs, dead code and error handling: no association.
- Low power: 28 positive files. Hence the cross-repo pooling below.

### Pooled meta-analysis

| window | repos | files | files with ≥1 fix |
|---|---|---|---|
| 24 m | 9 | 2,281 | 310 |
| 36 m | 12 | 2,937 | 948 |

Pooled partial correlation with future bug-fix count, controlling for size (random effects, BH q):

| predictor | 24 m r\|size [95% CI], q | 36 m r\|size [95% CI], q | raw r (36 m) | verdict |
|---|---|---|---|---|
| **size (SLOC)** | 0.27 [0.18, 0.35] | 0.33 [0.26, 0.40] | 0.33 | strongest single predictor in every repo (12/12 positive) |
| prior churn | 0.06 [−0.01, 0.13], q 0.25 | **0.18 [0.09, 0.26], q 0.002** | 0.27 | adds over size (36 m) |
| max CBO (coupling) | **0.10 [0.05, 0.14], q 0.0002**, I² 0 | 0.05 [−0.02, 0.13], q 0.65 | 0.14 | adds over size in 24 m (9/9 repos positive); not in 36 m |
| betweenness | **0.08 [0.04, 0.12], q 0.003** | 0.05 [−0.04, 0.15], q 0.66 | 0.15 | adds over size in 24 m only |
| out-degree (efferent) | 0.08 [0.02, 0.14], q 0.08 | **0.07 [0.02, 0.11], q 0.04** | 0.22 | small, adds over size in 36 m |
| Type-1 duplication | −0.05 [−0.09, 0.00] | 0.08 [0.01, 0.15], q 0.13 | 0.14 | size-redundant / inconsistent |
| Σ/max cyclomatic, Σ/max cognitive, max nesting, max unit SLOC, params | ≈0 (−0.05…0.03) | ≈0 (−0.05…0.03) | 0.19–0.26 | **size-redundant** (raw significant, gone after size) |
| LCOM4, naming density, error handling | 0.02–0.07, n.s. | 0.01–0.04, n.s. | 0.12–0.15 | size-redundant |
| **PageRank** | 0.04 [−0.00, 0.08], q 0.20 | **0.00 [−0.10, 0.11], q 0.93** | **−0.006** | **no association, raw or adjusted** |
| in-degree (afferent) | 0.04, n.s. | 0.01, n.s. | 0.003 | no association |
| doc coverage, magic numbers, dead code, Type-2 dup | n.s. | n.s. (magic −0.09 [−0.18, −0.01], q 0.17) | ≈0 | no association |

**Answer to the teammate's hypothesis ("PageRank/connectivity is not a good main risk criterion"):**
- **Supported for PageRank and in-degree.** Across 12 repos and about 2,900 files, PageRank has essentially zero raw correlation with future bug-fix activity (r = −0.006) and zero size-adjusted correlation (r = 0.004).
- **But "connectivity" is not uniform.** Outward coupling (CBO, out-degree) and brokerage (betweenness) carry a small signal beyond size: partial r ≈ 0.05–0.10, significant in one window each, and 9/9 repos positive for CBO in the 24 m window. Being *depended upon* (PageRank, in-degree) predicts nothing. *Depending on many things* predicts a little.
- **Size and change history dominate.** Size r ≈ 0.3; prior churn adds r ≈ 0.18 in the 36 m window.

**What this means for scoring.** Complexity metrics are strongly size-confounded at file level, consistent with El Emam 2001 and Gil & Lalouche 2017. They should be reported *next to* size ("complex for its size") rather than sold as independent defect predictors. The in-sample AUC gain of any single metric over size+churn is ≤0.04.

---

## E5 — Known groups: do refactoring commits improve the measures?

`experiments/e5_refactoring.py`.

**Data:** 997 commits whose subject matches `refactor|clean ?up|simplif|dedup|de-dup|extract (method|class)|remove duplicat|tidy`, over all 13 repos. That gives 4,888 (file, commit) pairs of production files present before and after, aggregated into 756 commits.

**Measures:** before vs after, file level. Paired one-sided Wilcoxon (after < before), rank-biserial effect (>0 means improvement), Holm correction. Most pairs are neutral (the file is touched, but this measure doesn't move).

| measure | commit level: improved / worse / neutral | p (Holm) | rank-biserial | file level p (Holm), rbc |
|---|---|---|---|---|
| SLOC | 383 / 204 / 169 | 1.9e−9 | 0.30 | 2.8e−15, 0.20 |
| Σ cyclomatic | 227 / 157 / 372 | 2.2e−3 | 0.20 | 1.0e−3, 0.12 |
| max cyclomatic | 71 / 32 / 653 | 3.7e−4 | **0.43** | 1.2e−2, 0.15 |
| Σ cognitive | 236 / 111 / 409 | 1.7e−8 | **0.36** | 7.9e−9, 0.24 |
| max nesting | 36 / 10 / 710 | 2.2e−3 | **0.53** | 4.2e−5, 0.33 |
| mean unit SLOC | 330 / 201 / 225 | 2.9e−8 | 0.29 | 3.0e−3, 0.09 |
| within-file Type-2 dup fraction | 169 / 202 / 385 | 0.86 | 0.01 | 0.94, 0.01 |
| magic-number density | 114 / 167 / 475 | 0.97 | −0.13 | 0.94, −0.01 |
| naming-violation density | 219 / 215 / 322 | 0.86 | 0.03 | 0.94, 0.02 |

**Interpretation (tracking validity, IEEE 1061):**
- When developers say they refactor, the **size and complexity** measures move in the expected direction, significantly and with medium effect at commit level (rbc 0.3–0.5). This is evidence that those metrics track what developers perceive as simplification.
- Generic refactoring commits do **not** improve within-file duplication, magic numbers or naming. Those metrics are therefore not validated by this test.
- The DRY-intent subgroup (dedup/duplicate/extract/reuse) is too small: 19 commits, 75 files, only 15 with any change in within-file duplication. Its duplication effect is n.s. (p_Holm 0.78, rbc 0.22).
- Caveat: cross-file deduplication cannot be seen in a per-file measure.
- The simplify-intent subgroup (113 commits) shows max cyclomatic rbc 0.28 (raw p 0.016) and Σ cognitive 0.20 (raw p 0.04), both n.s. after Holm.
- Unpaired Cliff's δ is ≈0 everywhere. Between-file heterogeneity swamps the within-file change, which is why the paired statistic is the right one.

---

## E7 — Is textual duplication shared *knowledge*? Clone co-change and the rule of three

`experiments/e7_clone_cochange.py` (36-month window, all 13 repos pooled; per-repo results in the JSON).

**Clone classes at T0:**
- Type-1/2 classes come from `qlab.dry.detect`, analyzer defaults: 50 normalised tokens, ≥6 lines. They are mapped to the methods that contain them (≥3 shared code lines).
- That gives 642 clone classes with ≥2 member units, out of 17,309 units.
- Giant template families exist (classes of 181 and 195 formatter methods in MessagePack), so at most 30 pairs per class are sampled.
- For each clone pair, up to 5 control pairs are drawn: same unit u plus a non-clone unit w from the same file (else the same namespace), with SLOC within ±30% of the partner.

**Replay:**
- Every non-merge commit after T0 is replayed. A unit "changes" when its exact token sequence differs between parent and commit.
- Variant **all commits**, and variant **focused commits** (≤10 files touched; this excludes mass reformatting/sweep commits).

| | all commits | focused commits (≤10 files) |
|---|---|---|
| clone pairs: co-change P(both \| ≥1) | **0.63** [0.61, 0.64] | **0.38** [0.36, 0.41] |
| matched control pairs | 0.39 [0.38, 0.40] | 0.105 [0.098, 0.113] |
| odds ratio (Fisher, one-sided) | 2.6, p ≈ 1e−207 | **5.2, p ≈ 1e−124** |
| pair-level mean difference (permutation p, bootstrap CI) | +0.25 [0.23, 0.27], p < 0.0002 | +0.30 [0.27, 0.33], p < 0.0002 |
| inconsistent evolution (one member changes, partner never) | 0.17 vs 0.34 control (OR 0.40) | 0.50 vs 0.81 control (OR 0.24) |
| repos where clone co-change > control | 13/13 | 13/13 |

MessagePack alone (focused): clone co-change 0.49 vs control 0.20 (OR 3.8, p ≈ 4e−20).

**What the co-change results say:**
- **On "DRY is about knowledge, not text":** textual clones found by the token detector *do* behave like shared knowledge. They change together 3–5× more often (odds) than equally sized neighbouring code, in every repository.
- So the syntactic measure is a valid proxy for the knowledge-duplication the principle cares about.
- It is not a perfect proxy: in focused commits half of the active clone pairs still evolve inconsistently. That is either independent knowledge (the teammate's point) or forgotten updates; the data cannot tell which.

**Rule of three:**

| | classes of 2 | classes of ≥3 | test |
|---|---|---|---|
| class-level partial-change rate, all commits (Juergens: a commit touches some but not all members) | 0.33 (180 classes, 320 events) | **0.65** (229 classes, 536 events) | Mann–Whitney p = 5e−9 |
| same, focused commits | 0.45 (103 classes) | **0.86** (127 classes) | p = 1e−13 |
| pair co-change, focused | 0.55 | 0.36 | OR 0.46, p = 6e−6 |
| pair inconsistency, focused | 0.26 | 0.53 | OR 3.1, p = 3e−7 |

- Clone classes with **three or more** members are changed inconsistently about **twice as often** as pairs.
- Partial updates become the norm, which is exactly the maintenance risk the rule of three warns about.
- So the data support treating ≥3 repetitions as more serious than 2 ("abstract on the third").
- Part of this is combinatorial: more members means a commit is less likely to touch all of them. That *is* the mechanism of the risk, though.

**Bug-fix involvement:**
- Logistic regression on units that changed at all: `bugfix ~ log SLOC + in_class_of_2 + in_class_of_3plus`.
- All commits: n = 8,717, LR p = 0.002; OR 1.46 (pairs), 1.23 (≥3).
- Focused commits: n = 2,694, p = 0.0001; OR 0.86 (pairs), **0.63** (≥3).
- The sign flips with the sweep filter, so there is **no consistent evidence** here that cloned code attracts more bug fixes once size is controlled. The co-change and inconsistency findings are the robust ones.

---

## Caveats (apply to all three)

1. **Bug-fix labels are keyword-based and noisy** (about half of such labels can be wrong; research/07). E4 and the bug-fix part of E7 are indicative, not conclusive. Co-change (E7) and refactoring deltas (E5) do not depend on bug labels.
2. **Observational:** no causal claims. Size confounding is controlled explicitly. Other confounders (developer, component age, test coverage) are not.
3. **Per-repo heterogeneity is high** for several predictors (I² 0.6–0.9), so pooled effects are averages over different projects.
4. **Syntactic analysis only** (tree-sitter): type dependencies are name-based, and `#if` blocks are resolved for a net8.0 configuration.
5. **E4's in-sample AUC gains are optimistic.** The partial correlations and LR tests are the primary evidence.
6. **E5 measures within-file effects only.** Refactorings that move code across files show up as size reductions here.
7. The MessagePack-only E4 analysis has low power (28 positive files). The pooled analysis is the one to cite.

## Files

- `experiments/history.py`: git and labelling helpers.
- `experiments/e4_predictive.py` and `experiments/e4_meta.py`: write `out/experiments/e4_predictive_<repo>_<24|36>m.json` and `out/experiments/e4_meta.json`.
- `experiments/e5_refactoring.py`: writes `out/experiments/e5_refactoring.json`; rows are cached in `out/cache/e5_rows.json`.
- `experiments/e7_clone_cochange.py`: writes `out/experiments/e7_clone_cochange_pooled_36m.json`; per-repo histories are cached in `out/cache/e7_*`.
- `corpus/history/`: 12 full-history clones (gitignored via `corpus/`).
