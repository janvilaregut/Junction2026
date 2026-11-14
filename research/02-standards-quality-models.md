# 02 — Industrial / standardized quality models that turn best practices into math

Scope: models that already define (a) which best practices matter, (b) an exact metric per practice, (c) thresholds, (d) an aggregation into a score, and (e) some validation evidence. Target use: an AI-free, tree-sitter-based C# certifier for MessagePack-CSharp and 4 agent-written PR branches.

Conventions:
- Every number below was read in the cited primary source during this session unless marked **[unverified]**.
- "Cumulative" thresholds mean "% of LOC in units with metric > X" (each row includes all worse rows).
- Reference numbers `[n]` point to the list at the end.

---

## 0. TL;DR — the reusable numbers

### 0.1 SIG risk profiles (the most directly reusable scheme)

Method: classify every unit (C#: method/constructor) into a risk band, weight by its LOC, and get the **% of system LOC per band** (a "quality profile"). Then compare the cumulative percentages with the star caps. Averages are deliberately avoided because metric distributions are power-law shaped [1].

**Current official 4-star caps (SIG/TÜV NORD CERT Guidance for Producers v18.1, 31 Mar 2026)** [6]

| Property | Unit-level metric | Max % of LOC allowed for 4 stars (cumulative) |
|---|---|---|
| Unit size | LOC per unit | >15 LOC: **48.0%** · >30: **24.2%** · >60: **9.1%** |
| Unit complexity | McCabe per unit | >5: **20.7%** · >10: **7.5%** · >25: **1.1%** |
| Unit interfacing | #parameters per unit | ≥3: **15.4%** · ≥5: **3.4%** · ≥7: **0.9%** |
| Module coupling | incoming dependencies (fan-in) per module (file) | >10: **9.7%** · >20: **5.3%** · >50: **1.8%** |
| Duplication | redundant LOC (Type-1 clones ≥6 lines, whitespace-insensitive) | ≤ **5.8%** redundant |
| Component independence | % LOC in modules with no incoming cross-component deps ("hidden") | ≥ **94.5%** |
| Component entanglement | normalized combination of communication density + violation degree | ≤ **0.075** |

**2015 4-star caps (book "Building Maintainable Software", quoting the 2015 SIG/TÜViT criteria)** [5]

| Property | Max % of LOC for 4 stars |
|---|---|
| Unit size | >60 LOC: 6.9% · >30: 22.3% · >15: 43.7% (i.e., ≥56.3% in units ≤15 LOC) |
| Unit complexity | McCabe >25: 1.5% · >10: 10.0% · >5: 25.2% (≥74.8% at McCabe ≤5) |
| Unit interfacing | >7 params: 0.7% · ≥5: 2.7% · ≥3: 13.8% (≥86.2% with ≤2 params) |
| Module coupling (fan-in) | 51+: 6.6% · 21–50: 13.8% · 11–20: 21.6% · 1–10: no constraint |
| Duplication | redundant ≤ 4.6% |
| Component independence | exposed (interface) code ≤ 14.2% |
| Component balance | #top-level components close to 9 (6–12); adjusted Gini of component sizes ≤ 0.71 |
| Volume | ≤ 20 man-years rebuild value (Java only ≈ 175,000 LOC) |

**Original 2007 star table (Heitlager et al.; McCabe bands 1–10 / 11–20 / 21–50 / >50, non-cumulative per band)** [1]

| Rank | max moderate | max high | max very high |
|---|---|---|---|
| ++ | 25% | 0% | 0% |
| + | 30% | 5% | 0% |
| o | 40% | 10% | 0% |
| − | 50% | 15% | 5% |
| −− | otherwise | | |

**Benchmark-calibrated full star table for unit complexity (Alves, Correia, Visser 2011; risk bands McCabe ]0,6] ]6,8] ]8,14] >14; cumulative; 100-system benchmark)** [4]

| Stars | max % LOC ≥ moderate | max % ≥ high | max % very-high |
|---|---|---|---|
| ★★★★★ | 17.9% | 9.9% | 3.3% |
| ★★★★ | 23.4% | 16.9% | 6.7% |
| ★★★ | 31.3% | 23.8% | 10.6% |
| ★★ | 39.1% | 29.8% | 16.7% |
| ★ | — | — | — |

(Values decoded from two slides of the author's talk; see §1.3 for the caveat.)

**Star calibration rule**: thresholds are tuned so systems in the benchmark distribute **5% / 30% / 30% / 30% / 5%** over 5★/4★/3★/2★/1★ [3][7]. Internal continuous scores run 0.5–5.5 [8]. Certification needs ≥3★ overall and ≥2★ per sub-characteristic [3][7].

### 0.2 SonarQube (Sonar way)

- Technical debt ratio = technical debt / (cost to develop 1 line × LOC), default **30 min/line** [12].
- Maintainability rating: **A ≤5%**, B 5–<10%, C 10–<20%, D 20–<50%, **E ≥50%** [12].
- Cognitive Complexity rule S3776: default **15** per method (C#: **3** per property accessor) [15]; remediation = 5 min + 1 min per point above threshold [16].
- Duplicated block (C# and other non-Java languages): **≥100 successive duplicated tokens spanning ≥10 lines** [12].
- Quality gate "Sonar way" on new code: 0 new issues (ratings A), 100% hotspots reviewed, coverage **≥80%**, duplication **≤3%** [13].
- C# rule defaults (sonar-dotnet source): S1541 cyclomatic **10**, S107 params **7**, S138 method lines **80**, S134 nesting **3**, S1067 boolean operators per expression **3**, S104 file lines **1000** [17].

### 0.3 Code Climate (classic) → Qlty

Classic defaults (as encoded in Qlty's migration code) [21]: argument-count **4**, complex-logic **4**, method-complexity **5** (cognitive), return-statements **4**, nested-control-flow **4**, file-lines **250**, identical/similar code **15** (Qlty migration default). method-count **20** and method-lines **25** are commonly cited classic defaults **[unverified]**.
Rating: technical-debt ratio (remediation time / estimated rewrite time via COCOMO) → **A <5%, B 5–10%, C 10–20%, D 20–50%, F ≥50%** [20].

### 0.4 ISO/IEC 5055 (CISQ) maintainability defaults [10][11]

McCabe **>20**, parameters **>7**, file **>1000 LOC**, fan-out **>5**, inheritance depth **>7**, children **>10**, concrete-class multiple inheritance **>1**, data/file operations per callable **>7**, commented-out code **>2%**, copy-paste **>10%** of a callable's instructions, horizontal layers outside **[4, 8]**. Score = plain count of violations (optionally divided by Automated Function Points).

### 0.5 CodeScene Code Health

Score 10.0 (healthy) → 1.0; categories healthy / warning / alert with cut-offs **8.0** and **4.0** [23]. Files aggregated by **LOC-weighted average** [22]. Code Red (39 codebases, 30,737 files): Alert files had **15×** more defects (3.70 vs 0.25 per file), **124%** longer time-in-development, **9×** longer max cycle time than Healthy files [23].

---

## 1. SIG / Software Improvement Group maintainability model

### 1.1 Origin: Heitlager, Kuipers, Visser (QUATIC 2007) [1]

**Design requirements** (stated in the paper): technology-independent measures, straightforward definition and computation, understandable by non-technical staff, and enabling root-cause analysis. The paper rejects the Maintainability Index (MI = 171 − 5.2 ln(HV) − 0.23 CC − 16.2 ln(LOC) + 50 sin(√(2.46·COM))) because it is not traceable, uses averages that hide high-risk outliers, and relies on Halstead Volume, which has no agreed definition of operator/operand for Java or C#.

**Unit definition**: the smallest piece of code that can be executed and tested individually; in Java or C# a unit is a method.

**Properties → ISO 9126 sub-characteristics (Fig. 3)**

| | volume | complexity per unit | duplication | unit size | unit testing |
|---|---|---|---|---|---|
| analysability | x | | x | x | x |
| changeability | | x | x | | |
| stability | | | | | x |
| testability | | x | | x | x |

**Volume** (LOC = non-comment, non-blank lines; converted to man-years via SPR backfiring tables):

| rank | man-years | Java KLOC | Cobol KLOC | PL/SQL KLOC |
|---|---|---|---|---|
| ++ | 0–8 | 0–66 | 0–131 | 0–46 |
| + | 8–30 | 66–246 | 131–491 | 46–173 |
| o | 30–80 | 246–665 | 491–1,310 | 173–461 |
| − | 80–160 | 655–1,310 (sic; 665 above) | 1,310–2,621 | 461–922 |
| −− | >160 | >1,310 | >2,621 | >922 |

**Complexity per unit**: McCabe bands from the SEI: 1–10 simple/low risk; 11–20 moderate; 21–50 high; >50 untestable/very high. Aggregation = % of LOC in units of each band (e.g., 500 LOC of high-risk units in a 10,000 LOC system → 5%). Rating table in §0.1. The paper states the boundaries came from experience and matched expert opinion.

**Duplication**: % of all code occurring more than once in equal blocks of **at least 6 lines**; leading whitespace ignored; otherwise exact string matching.

| rank | duplication |
|---|---|
| ++ | 0–3% |
| + | 3–5% |
| o | 5–10% |
| − | 10–20% |
| −− | 20–100% |

**Unit size**: LOC per unit, with risk categories and scoring "similar to complexity" but different thresholds. The 2007 paper does not give the numbers.

**Unit test coverage**: ++ 95–100%, + 80–95%, o 60–80%, − 20–60%, −− 0–20%. The number of asserts is used only to sanity-check coverage, with no rating scheme.

**Aggregation**: sub-characteristic score = weighted average (equal weights by default) of the ranks of the properties marked in the matrix. The overall score is the average of the sub-characteristics, but the authors "do not attribute much added value to such a single score."

### 1.2 Threshold derivation: Alves, Ypma, Visser (ICSM 2010) [2]

**Benchmark**: 100 OO systems (Java proprietary 60 = 8,435K LOC; Java OSS 22 = 2,756K; C# proprietary 17 = 794K; C# OSS 1 = 10K; total ≈ 12M LOC). Sizes range from 3K to about 800K LOC. Outlier systems were removed after expert validation. The rule of thumb is 1.5·IQR above the upper quantile of the median.

**Six-step method** (this is the algorithm to copy for calibrating on our own C# corpus):
1. Metrics extraction: for each system and each entity (method), record (metric value, weight = entity LOC).
2. Weight ratio: entity LOC / system LOC, so each system sums to 100%.
3. Entity aggregation: a weighted histogram per system (weight per metric value).
4. System aggregation: normalize by number of systems and sum, so every system counts equally regardless of size.
5. Weight-ratio aggregation: sort metric values ascending and take the maximal metric value representing 1%, 2%, …, 100% of the pooled weight (a weighted quantile function).
6. Threshold derivation: pick the quantiles. SIG uses **70% / 80% / 90%** → low (0–70%), moderate (70–80%), high (80–90%), very high (>90%).

**Derived thresholds (Table IV)**

| Metric | 70% | 80% | 90% |
|---|---|---|---|
| Unit complexity (McCabe) | 6 | 8 | 14 |
| Unit size (LOC) | 30 | 44 | 74 |
| Module inward coupling (file fan-in) | 10 | 22 | 56 |
| Module interface size (#methods per file) | 29 | 42 | 73 |
| **Unit interfacing (#params)**, quantiles 80/90/95% | 2 | 3 | 4 |

Notes: the paper's §III example says "6, 8 and 15" while §IV and Table IV say 14. Unit interfacing uses 80/90/95% because its variability appears late. The authors claim the method is resilient to outliers and system size, and that adding systems shifts thresholds only slightly. Validation in the paper is representativeness: the derived thresholds re-classify benchmark code at about 70/10/10/10%.

### 1.3 Aggregating risk profiles to star ratings: Alves, Correia, Visser (IWSM-Mensura 2011) [4]

This is the two-level approach: measurements → **risk profile** (first level, using the 2010 thresholds) → **rating** (second level, using per-star caps on the cumulative risk profile, calibrated against the benchmark to the 5/30/30/30/5 distribution). The calibrated unit-complexity table is in §0.1.

Caveat on the numbers: they come from the first author's 2011 seminar slides [4b]. The slide PDF's font encoding is scrambled. Values were decoded by matching two slides (p. 8 plain and p. 29 encoded), which give the same 12 numbers (17.9/9.9/3.3, 23.4/16.9/6.7, 31.3/23.8/10.6, 39.1/29.8/16.7). The slide's worked example is a profile with low 74.2%, moderate 7.1%, high 8.8%, very high 9.9% (cumulative 25.8/18.7/9.9). It is rated **2.68** (displayed as 3★). That shows ratings are continuous (interpolated) inside a star band. The exact interpolation formula is **[unverified]**: the paper itself (DOI 10.1109/IWSM-MENSURA.2011.15) is paywalled and was not read.

### 1.4 Standardized benchmarking and certification: Baggen, (Correia), Schill, Visser 2010/2012 [3]

- The workshop version (SQM 2010) was read in full. The journal version (Software Quality Journal 20(2):287–307, DOI 10.1007/s11219-011-9144-9) has the same scope but is paywalled.
- Key metrics chosen: volume, McCabe complexity, code redundancy, coupling. All can be computed down to unit level for drill-down.
- Benchmark (Feb 2010): >500 evaluations, about 75% proprietary, 45 languages.
- **Calibration**: thresholds tuned yearly so systems follow a **⟨5, 30, 30, 30, 5⟩ %** distribution over the 5 quality levels.
- **Certification (TÜViT Trusted Product Maintainability)**: ≥2★ on every sub-characteristic and ≥3★ on overall maintainability, plus a documented top-level component description.
- Benchmark averages (Table I): OOP (Java, C#) redundant lines **11.8%**, decision density (McCabe/LOC) **20.0%**; Web 30.1% / 5.7%; 4GL 32.1% / 6.5%; SQL-like 28.6% / 7.9%; C/C++ 16.2% / 12.9%.
- Evaluation follows ISO/IEC 14598 (later 25040). The laboratory follows ISO/IEC 17025, with evaluator and quality officer roles kept separate.

### 1.5 "Building Maintainable Software — Ten Guidelines for Future-Proof Code" (Visser et al., O'Reilly 2016; Java and C# editions) [5]

The full Java edition was read (complimentary PDF from SIG). Ten guidelines with their operational limits:

| # | Guideline | Operational rule in the book | SIG system property |
|---|---|---|---|
| 1 | Write short units of code | unit ≤ **15 LOC** | Unit size |
| 2 | Write simple units of code | ≤ **4 branch points** per unit (= McCabe ≤ 5). Java branch points: `if`, `case`, `?`, `&&`, `||`, `while`, `for`, `catch` | Unit complexity |
| 3 | Write code once | do not copy code; clones = Type-1 ≥ 6 lines, import-only clones excluded | Duplication |
| 4 | Keep unit interfaces small | ≤ **4 parameters** per unit (extract parameter objects) | Unit interfacing |
| 5 | Separate concerns in modules | avoid large modules; hide implementation behind interfaces | Module coupling (fan-in) |
| 6 | Couple architecture components loosely | minimize code exposed to other components | Component independence |
| 7 | Keep architecture components balanced | number of top-level components close to **9 (6–12)**, roughly equal size | Component balance |
| 8 | Keep your codebase small | avoid growth, actively reduce size | Volume |
| 9 | Automate tests | test framework; rule of thumb ≥ **80% line coverage**, about as much test code as production code | (Testability) |
| 10 | Write clean code | 7 rules: no unit-level smells, no bad comments, no commented-out code, no dead code, no long identifiers, no magic constants, no badly handled exceptions | — |

**Rating details from the chapter sidebars (2015 criteria)**: see the 2015 table in §0.1. Additional definitions:
- **Duplication**: redundant LOC = (occurrences − 1) × clone length. For example, a 10-line fragment that occurs 3 times gives 20 redundant and 10 non-redundant lines.
- **Module coupling**: fan-in of every method is computed, and a module's fan-in = sum over its methods.
- **Component independence**: hidden code = modules with no incoming dependencies from other components (outgoing calls allowed). Interface code = modules with incoming or throughput dependencies.
- **Component balance** = (score for number of components) × (size uniformity).
  - Component-count score is 1.0 at 9 components, decreasing linearly to 0 at 1 component. It is corrected upward above 17 components, based on the 95th percentile of the benchmark.
  - Uniformity uses the **adjusted Gini coefficient**.
- **Volume**: man-month/man-year rebuild value (LOC normalized by language productivity).
- **Testability** = aggregate of unit complexity, component independence, and volume.

**Overall aggregation (Appendix A)**: property ratings via benchmark (top 5% = 5★, next 30% = 4★, …) → sub-characteristics as weighted averages of their mapped properties → maintainability as weighted average of the 5 sub-characteristics. Mapping (consistent with [7]):

| Sub-characteristic (ISO 25010) | System properties |
|---|---|
| Analysability | Volume, Duplication, Unit size, Component balance |
| Modifiability | Duplication, Unit complexity, Module coupling |
| Testability | Volume, Unit complexity, Component independence |
| Modularity | Module coupling, Component balance, Component independence (+ Component entanglement since later criteria) |
| Reusability | Unit size, Unit interfacing |

Book-internal inconsistencies:
- The module-coupling text says 21.8% while its table says 21.6%.
- Table 5-1's caption says "unit size" although the table is unit interfacing.
- The top interfacing row is "more than seven", whereas 2026 uses "7 or more".

Empirical claim in the book: issue resolution and enhancements are **twice as fast in 4★ systems as in 2★ systems** (SIG data).

### 1.6 Current official criteria (2021 → 2026)

**SIG/TÜViT Evaluation Criteria Trusted Product Maintainability v13.0 (26 May 2021)** [7]:
- Sub-characteristics follow ISO/IEC 25010: analysability, modifiability, testability, modularity, reusability.
- 9 product properties: volume, duplication, unit complexity, unit size, unit interfacing, module coupling, component balance, component independence, **component entanglement**.
- Unit = smallest executable part (methods/functions). Module = grouping of related units. Unit interfacing = number of parameter declarations. Module coupling = number of incoming dependencies.
- Multi-language systems: measured per language, then combined weighted by relative volume.
- Calibration rules: the benchmark must exceed 10M LOC across varied languages and industries and be curated by experts. Property-level stars approximately follow 5/30/30/30/5. Weights of properties→sub-characteristics and sub-characteristics→maintainability are set by structured expert elicitation.
- Certificate: maintainability ≥3★, each sub-characteristic ≥2★, documentation present.

**SIG/TÜV NORD CERT Guidance for Producers v18.1 (31 Mar 2026)** [6] gives the 4★ caps in §0.1 plus these definitions:
- Unit = smallest **named** piece of executable code (methods for C#). Anonymous constructs (e.g., lambdas) are not units.
- Module = delimited group of declarations, generally a file.
- Duplication = fragment ≥6 LOC repeated literally (modulo whitespace).
- McCabe = number of decision points (+1).
- Interface size = number of formal parameters.
- Coupling = number of incoming dependencies, such as invocations, per module.
- Component entanglement:
  - communication density = communication lines / connected components;
  - violation degree = Σ weights of violating lines (direct cycles, indirect cycles, transitive dependencies; each line counted once, in that order) / total line weight;
  - both are normalized by the benchmark maxima and combined (combination formula not given).

**2026 model changes** [9]:
- **Volume removed** from the maintainability rating.
- System properties are aggregated to the overall rating with a **power mean** instead of the arithmetic mean, so one high property rating pulls less. The exponent is not published **[unverified]**.
- Yearly recalibration continues.

**Sigrid rating semantics** [8]:
- 1–5★ with a 5/30/30/30/5 distribution; internally 0.5–5.5; 2.5–3.5 ⇒ 3★ = market average.
- Displayed with two decimals, rounded down (1.49 → 1★).
- The benchmark has >10,000 industry systems, rebalanced yearly.
- Vendor claims: 4★ systems have about half the maintenance cost of 2★ systems, and development speed up to 4× faster.

**Drift 2015 → 2026 (4★ caps)**:

| Property | 2015 | 2026 |
|---|---|---|
| Unit size (>15 / >30 / >60) | 43.7 / 22.3 / 6.9 % | 48.0 / 24.2 / 9.1 % |
| Unit complexity (>5 / >10 / >25) | 25.2 / 10.0 / 1.5 % | 20.7 / 7.5 / 1.1 % |
| Unit interfacing (≥3 / ≥5 / ≥7 or >7) | 13.8 / 2.7 / 0.7 % | 15.4 / 3.4 / 0.9 % |
| Duplication (redundant) | 4.6 % | 5.8 % |
| Component independence (hidden) | ≥85.8 % | ≥94.5 % |
| Module coupling | per-band 21.6 / 13.8 / 6.6 % (11–20 / 21–50 / 51+) | cumulative 9.7 / 5.3 / 1.8 % (>10 / >20 / >50) |

The cut-points (15/30/60 LOC; McCabe 5/10/25; params 3/5/7; fan-in 10/20/50) are stable. Only the caps move with yearly benchmark recalibration. The bands differ from Alves 2010 (McCabe 6/8/14, LOC 30/44/74), which were superseded.

### 1.7 Better Code Hub (SIG's former free GitHub service) [5c]

It used the same 10 guidelines. Compliance per guideline came from the SIG benchmark ("over 8 billion lines of code in more than 180 different technologies"), calibrated yearly, and the score was "x/10 guidelines compliant". Per-guideline thresholds were not published on the page read; they are presumably the 4★ caps above **[unverified]**.

### 1.8 Validation evidence for the SIG model

| Study | Design | Finding |
|---|---|---|
| Luijten & Visser 2010 (SQM) — cited by [3] | open-source systems, issue trackers | maintainability ratings correlate positively with defect-resolution speed |
| Bijlsma, Ferreira, Luijten, Visser 2012, SQJ (DOI 10.1007/s11219-011-9140-0) [3b] | issue resolution, defects and enhancements | "all but one of the metrics of the SIG quality model show a significant positive correlation" with resolution speed (abstract) |
| Book [5] | SIG data | 4★ resolves issues/enhancements 2× as fast as 2★ |
| Sigrid docs [8] | vendor | 4★ ≈ half the maintenance cost of 2★, up to 4× faster development |
| Alves 2010 [2] | 100 systems | thresholds are representative of the chosen quantiles and stable |

---

## 2. ISO/IEC 25010 — maintainability sub-characteristics

Definitions as quoted from ISO/IEC 25010:2011 §4.2.7 in [7]:

| Sub-characteristic | ISO 25010 definition (abridged) | Typical code-level proxies (SIG mapping) |
|---|---|---|
| Modularity | composed of discrete components such that a change to one has minimal impact on others | module coupling, component balance, independence, entanglement |
| Reusability | an asset can be used in more than one system or in building other assets | unit size, unit interfacing |
| Analysability | effectiveness/efficiency of assessing change impact, diagnosing deficiencies, identifying parts to modify | volume, duplication, unit size, component balance |
| Modifiability | can be modified without introducing defects or degrading quality | duplication, unit complexity, module coupling |
| Testability | test criteria can be established and tests performed | volume, unit complexity, component independence |

Maintainability itself is "the degree of effectiveness and efficiency with which a product or system can be modified by the intended maintainers".

ISO/IEC 25010:2023 has 9 product characteristics: functional suitability, performance efficiency, compatibility, interaction capability (formerly usability), reliability, security, maintainability, flexibility (formerly portability), safety [18]. The arc42 page read listed modularity, reusability, analysability, and modifiability under maintainability. Whether **testability** is retained in the 2023 edition was not verified this session **[unverified]**, though SIG's 2021 criteria use all five.

ISO 25010 defines no thresholds. It is the vocabulary that the SIG and CISQ models plug numbers into.

---

## 3. ISO/IEC 5055:2021 and the CISQ / OMG automated maintainability measure

### 3.1 Lineage

- **OMG ASCMM 1.0** (Automated Source Code Maintainability Measure, formal/16-01-01, Dec 2015): 20 rules ASCMM-MNT-1…20 [10].
- **OMG ASCQM 1.0** (Automated Source Code Quality Measures): CWE-based, merges security, reliability, performance efficiency, and maintainability [11].
- **ISO/IEC 5055:2021** adopts ASCQM. Its maintainability category §7.1 lists **29 CWEs** (7.1.1–7.1.29) [19]. CWE category **CWE-1307** "CISQ Quality Measures – Maintainability" (view CWE-1305, 2020) mirrors it [14].

### 3.2 Scoring

- The base measure is the **unweighted sum of violation counts** of all measure elements across the whole application. Component-level scoring was rejected because many violations span components [10].
- Severity weighting was rejected because all included weaknesses are considered severe.
- For benchmarking, divide by size; OMG recommends **Automated Function Points**, but LOC is allowed [10].
- Thresholds may be changed, but then results "cannot be compared or benchmarked" against default-threshold data [10].

### 3.3 Maintainability weaknesses (ISO 5055 §7.1) with default thresholds

Thresholds are from the ASCQM table [11], ASCMM Table 6.1 [10], and CWE entries [14].

| CWE | Weakness | Default threshold | Best practice |
|---|---|---|---|
| 407 | Inefficient algorithmic complexity | — | performance-aware code |
| 478 | Missing default case in switch | — | defensive control flow |
| 480 | Use of incorrect operator | — | correctness |
| 484 | Omitted break in switch | — | correctness |
| 561 | Dead code | — | clean code |
| 570 / 571 | Expression always false / true | — | clean code |
| 783 | Operator precedence logic error | — | clarity |
| 1041 | Use of redundant code (copy-paste) | > **10%** of a callable's instructions copy-pasted (ASCQM). ASCMM-MNT-19 gives no default | DRY |
| 1045 / 1079 / 1087 | Virtual-destructor issues | — (C++-specific) | — |
| 1047 | Modules with circular dependencies | any cycle | acyclic architecture |
| 1048 | Callable with large number of outward calls (fan-out) | > **5** references | low coupling |
| 1051 | Hard-coded network resource config | — | configuration |
| 1052 | Excessive hard-coded literals in initialization | — (no number) | no magic constants |
| 1054 | Layer-skipping call | any | layered architecture |
| 1055 | Multiple inheritance from concrete classes | > **1** | composition over inheritance |
| 1062 | Parent class references child class | any | proper abstraction |
| 1064 | Too many parameters | > **7** | small interfaces |
| 1074 | Excessively deep inheritance | > **7** parent classes | shallow hierarchies |
| 1075 | Unconditional control transfer outside switch (goto) | any | structured programming |
| 1080 | Source file too long | > **1000** LOC | small modules |
| 1084 | Excessive file/data access operations per callable | > **7** | separation of concerns |
| 1085 | Excessive commented-out code | > **2%** (ASCQM table and CWE) | clean code |
| 1086 | Class with too many child classes | > **10** | balanced hierarchies |
| 1090 | Method accessing member element of another class | any | encapsulation |
| 1095 | Loop condition value updated inside loop | any | clarity |
| 1121 | Excessive McCabe cyclomatic complexity | > **20** | simple units |
| (ASCMM-MNT-9) | Number of horizontal layers outside range | min **4**, max **8** | architecture |

Notes:
- ASCQM's detailed pattern section gives `MaxPercentageOfCommentedOutCode = 5%`, contradicting the 2% in its own summary table and in CWE-1085 [11]. The CWE page (2%) was used above.
- ASCQM also defines module design complexity (default 10) and essential complexity (default 5) parameters [11]. Whether they are in ISO 5055's maintainability list was not checked **[unverified]**.
- ASCMM-MNT-15 "Public member element" and MNT-20 "Unreachable callable" exist in the 2015 OMG version [10].

Validation: none is claimed in the specs. ASCMM §1.6 says the measure "is a correlated measure rather than an absolute measure" [10].

---

## 4. SonarQube / SonarSource

### 4.1 Maintainability rating (SQALE-derived)

- Technical debt = Σ remediation effort (minutes) of maintainability issues. Each rule carries a remediation function. 1 day = 8 h [12].
- `sqale_debt_ratio` = technical debt / (cost to develop one line × LOC). The default development cost is **30 min per LOC** (configurable `sonar.technicalDebt.developmentCost`) [12].
- `sqale_rating` (Maintainability rating), SonarQube Server 2026.5 [12]:

| Rating | Debt ratio |
|---|---|
| A | ≤ 5% |
| B | ≥ 5% to < 10% |
| C | ≥ 10% to < 20% |
| D | ≥ 20% to < 50% |
| E | ≥ 50% |

Older 9.7 docs express the grid as 0–0.05 / 0.06–0.1 / 0.11–0.20 / 0.21–0.5 / 0.51–1 and the cost as 0.06 days/line. These were seen only in a search-result summary, not fetched.

- Reliability and security ratings are worst-issue based: A = 0 issues; B = at least one minor/low; C = major/medium; D = critical/high; E = blocker [12].
- The **SQALE method** (J.-L. Letouzey, "SQALE Method Definition Document" v1.x) is the origin of these indices. The original document is no longer at sqale.org (the domain now hosts unrelated content), so SQALE-specific grids and characteristic ordering are **[unverified]** here.

### 4.2 Complexity

- **Cyclomatic complexity** = 1 + number of conditional branches. Each function starts at 1. For Java the counted constructs are `if`, `for`, `while`, `case`, `&&`, `||`, `?`, `->` [12].
- **Cognitive Complexity** (G. Ann Campbell, white paper v1.7, 29 Aug 2023) [24]. Three principles: ignore readable shorthand (e.g., `?.`, `??`); +1 for each break in linear flow; extra increment for nesting. Increments (Appendix B):
  - +1 for each of: `if`, `else if`, `else`, ternary, `switch` (one increment for the whole switch), `for`/`foreach`, `while`/`do while`, `catch`, `goto LABEL` / `break LABEL` / `continue LABEL`, each **sequence** of like binary logical operators, each method in a recursion cycle.
  - Nesting level increases inside: `if`, `else if`, `else`, ternary, `switch`, loops, `catch`, and nested methods/lambdas.
  - Nesting increment (equal to the current depth) applies to: `if`, ternary, `switch`, loops, `catch`. It does **not** apply to `else`/`else if` (hybrid increments).
  - `try`/`finally` are ignored, and early `return` is not penalized.
- Rule **S3776** "Cognitive Complexity of methods should not be too high": default `threshold = 15`, and `propertyThreshold = 3` for C# property accessors (from sonar-dotnet `CognitiveComplexityBase.cs`) [15]. Severity Critical; remediation is linear with offset, 5 min + 1 min per point over the threshold [16].

### 4.3 Duplication

- Non-Java languages (including C#): a duplicated block needs **≥100 successive duplicated tokens**, spread over at least **10 lines** (30 for COBOL, 20 for ABAP) [12].
- Java: ≥10 successive duplicated statements regardless of tokens or lines.
- Indentation and string-literal differences are ignored.
- `duplicated_lines_density = duplicated_lines / lines × 100` [12].

### 4.4 Quality gates (new-code focused) [13][13b]

| Gate | Conditions on new code |
|---|---|
| **Sonar way** (default) | issues = 0 (equivalently, reliability, security, and maintainability ratings must be A); security hotspots reviewed = 100%; coverage ≥ 80.0%; duplicated lines ≤ 3.0% |
| **Sonar way for agentic AI** (replaces "Sonar way for AI Code") | 0 reliability issues ≥ Low; 0 security issues ≥ Low; 0 maintainability issues ≥ Medium; 0 dependency risks ≥ Low (if Advanced Security); coverage ≥ 80%; duplication ≤ 3% |

### 4.5 C# rule defaults (sonar-dotnet source, `analyzers/src/SonarAnalyzer.Core/Rules/*Base.cs`) [17]

| Rule | Meaning | Default |
|---|---|---|
| S3776 | Cognitive complexity per method / per property accessor | 15 / 3 |
| S1541 | Cyclomatic complexity per function | 10 |
| S107 | Max parameters | 7 |
| S138 | Max lines of code per method | 80 |
| S134 | Max control-flow nesting depth | 3 |
| S1067 | Max conditional operators per expression | 3 |
| S104 | Max lines per file | 1000 |

### 4.6 Validation evidence

- **Cognitive Complexity**: Muñoz Barón, Wyrich, Wagner, ESEM 2020 [25]. Meta-analysis of about 24,000 understandability evaluations of 427 snippets from 10 studies. Pooled correlation with comprehension time is **0.54** (positive). With subjective understandability ratings it is **−0.29** (more complex → rated less understandable). Results with correctness and physiological measures were mixed. The authors call it the first validated, purely code-based understandability metric.
- **SonarQube rules vs faults**: Lenarduzzi, Lomio, Huttunen, Taibi, SANER 2020 [26]. 21 Java projects, SZZ labelling. Only 25 of 202 Java rules showed relatively low fault-proneness. Sonar "bug" rules were generally not fault-prone, and the predictive power of Sonar's model was "extremely low". This is a caution against treating rule-violation counts as validated defect predictors.

---

## 5. Code Climate Quality (classic) → Qlty

### 5.1 The classic 10 maintainability checks

The classic docs (`docs.codeclimate.com`) now redirect to Qlty. Defaults are taken from Qlty's migration code, which encodes the classic defaults (`qlty-config/src/migration/checks.rs`) [21].

| Classic check | Measures | Classic default | Source |
|---|---|---|---|
| argument-count | parameters per function | 4 | [21] |
| complex-logic | boolean operators in one expression | 4 | [21] |
| file-lines | lines per file | 250 | [21] |
| method-complexity | cognitive complexity per function | 5 | [21] (Qlty multiplies by 1.1 when migrating) |
| method-count | methods per class | 20 | **[unverified]** |
| method-lines | lines per method | 25 | **[unverified]** |
| nested-control-flow | nesting depth | 4 | [21] |
| return-statements | returns per function | 4 | [21] |
| similar-code | structurally similar duplicate (AST "mass" threshold, language-specific) | Qlty migration uses 15 | [21] |
| identical-code | syntactically identical duplicate | Qlty migration uses 15 | [21] |

### 5.2 Qlty current defaults

Two first-party sources disagree:

| smell key | docs.qlty.sh `qlty.toml` reference [20b] | `qlty-config/default.toml` on main [21b] |
|---|---|---|
| boolean_logic | 5 | 4 |
| nested_control_flow | 5 | 5 |
| function_parameters | 5 | 6 |
| return_statements | 6 | 6 |
| file_complexity | 50 | 50 |
| function_complexity (cognitive) | 15 | 18 |
| identical_code (min lines) | 12 | 15 |
| similar_code (min lines) | 12 | 15 |
| duplication.nodes_threshold (min AST nodes) | 50 | 64 |

`default.toml` has no C#-specific threshold overrides; it only filters `using` directives from duplication.

### 5.3 Rating formula [20]

- Technical Debt = Σ remediation minutes of all smells (structure + duplication).
- Technical Debt Ratio = TD / estimated effort to rewrite the code from scratch, where the effort comes from **Basic COCOMO** (person-months).
- Project grade: **A < 5%**, **B 5–10%**, **C 10–20%**, **D 20–50%**, **F ≥ 50%**. This is the same breakpoint structure as Sonar.
- File and directory grades use "a logarithmic function based on the total Technical Debt". The function is not published.
- Coverage grade: A ≥ 90%, B 80–90%, C 70–80%, D 60–70%, F < 60%.
- The legacy Code Climate **GPA** (0–4 scale) letter mapping is **[unverified]**.
- Validation: none published by the vendor (none found).

---

## 6. CodeScene Code Health

### 6.1 Definition [22][23]

- Proprietary aggregate of **25+ factors** from source code. Score from **10.0** (healthy) down to **1.0**.
- Category cut-offs (Code Red paper): "the cut-off point for healthy code is **8.0**, for alert **4.0**", with warning in between. The cut-offs were chosen by CodeScene's team against a baseline library of hand-scored examples [23].
- The docs show Green / Yellow / Red categories without numeric ranges [22].
- Code Health incorporates elements of the ISO 5055 maintainability section plus design-level smells [23].
- Factors listed in the docs [22]:
  - Module level: low cohesion (LCOM4), brain class/God class, developer congestion, complex code by former contributors, lines of code.
  - Function level: brain method/God function, DRY violations (duplicated logic changed together), complex method (cyclomatic), primitive obsession, large method.
  - Implementation level: nested complexity, bumpy road, complex conditional, large assertion blocks, duplicated assertion blocks.
- Default numeric thresholds per factor are not public in the pages read **[unverified]**. The docs only show example overrides (cyclomatic warning 10, nesting warning 3).
- **Aggregation**: codebase score = **LOC-weighted average** of file scores. Docs example: scores 2.0 / 10.0 / 10.0 with LOC 5000 / 100 / 10 give a plain mean of 7.33 and a weighted mean of 2.18 [22].
- Decline/improvement alerts trigger on changes of ≥ 0.1 [22].

### 6.2 Validation: Tornhill & Borg, "Code Red", TechDebt 2022 [23]

- Data: 39 proprietary codebases (mean 171 kLOC), 6–12 months of Jira and git data, **30,737 files**. Files: Healthy 27,352 (88.99%), Warning 3,035 (9.87%), Alert 350 (1.14%).
- Construct check: Pearson r between raw Code Health and average issue resolution time per file is **−0.58**. For added LoC it is only **0.13**.

| Measure (per file) | Healthy | Warning | Alert | Test / effect size |
|---|---|---|---|---|
| Avg Jira defects | 0.25 | 0.94 | 3.70 | Kruskal-Wallis χ²(2)=1645.05; Cohen's d (H vs A) = 0.73 |
| Avg time-in-development (min) | 7,815.6 | 13,934.6 | 17,544.5 | ANOVA F(2,30734)=742.56; d = 0.45 |
| Avg max time-in-development (min) | 15,111.9 | 34,024.5 | 129,940.3 | F(2,30734)=1399.55; d = 0.96 |

Headline results: Alert vs Healthy has **15×** defects, **+124%** time-in-development (Warning already +78%), and **9×** longer max time-in-development (Warning >2×). The time comparisons use Yeo-Johnson-normalized scaled averages.

Follow-ups by the same group:
- Borg, Pruvost, Mones, Tornhill, TechDebt 2024 [27]: a doubled dataset and a value model showing non-linear, increasing returns at the top of the Code Health scale.
- Borg, Ezzouhri, Tornhill, ICSME 2024 "Ghost Echoes Revealed": benchmarks Code Health vs SonarQube's TD index vs Maintainability Index on the Schnappinger et al. human-rated maintainability dataset; the authors report that Code Health performed best (as summarized in [28]; the paper itself was not read).

These are vendor-affiliated authors.

---

## 7. Synthesis for our C# certifier

### 7.1 Practice → metric → threshold candidates (all from verified sources)

| Best practice | Unit of localization | Metric | SIG 2026 cut-points / 4★ cap | Sonar C# | Code Climate classic | ISO 5055 |
|---|---|---|---|---|---|---|
| Short units | method | LOC (non-blank, non-comment) | 15 / 30 / 60; caps 48.0 / 24.2 / 9.1 % | 80 | 25 [unverified] | — |
| Simple units | method | McCabe (decision points + 1) | 5 / 10 / 25; caps 20.7 / 7.5 / 1.1 % | 10 | — | 20 |
| Understandable control flow | method | Cognitive Complexity | — | 15 (accessors 3) | 5 | — |
| Shallow nesting | method | max nesting depth | — | 3 | 4 | — |
| Simple conditions | expression | #boolean operators | — | 3 | 4 | — |
| Small interfaces | method | #parameters | 3 / 5 / 7; caps 15.4 / 3.4 / 0.9 % | 7 | 4 | 7 |
| Write code once | block | Type-1 clones ≥ 6 lines (SIG) or ≥ 100 tokens & ≥ 10 lines (Sonar) | redundant ≤ 5.8 % | new-code dup ≤ 3 % | 15 (mass/lines) | copy-paste > 10 % of a callable |
| Separate concerns / small modules | class/file | fan-in per file; file LOC | fan-in 10 / 20 / 50; caps 9.7 / 5.3 / 1.8 % | file ≤ 1000 | file ≤ 250 | file ≤ 1000; fan-out ≤ 5 |
| Loose component coupling | namespace/project | % hidden code; cycles | hidden ≥ 94.5 %; entanglement ≤ 0.075 | — | — | no module cycles (CWE-1047) |
| Balanced components | top-level components | count (ideal 9, 6–12) × adjusted Gini | Gini ≤ 0.71 (2015) | — | — | — |
| Clean code | line/method | commented-out code, dead code, magic literals, generic catch | — (book rules) | various rules | — | commented-out > 2 %; dead code; literals |
| Automated tests | system | line coverage | ≥ 80 % rule of thumb (book) | new code ≥ 80 % | A ≥ 90 % | — |
| Inheritance sanity | class | DIT, NOC | — | — | — | DIT ≤ 7, NOC ≤ 10 |

### 7.2 Aggregation lessons that transfer directly

1. **Never average unit metrics.** Use LOC-weighted risk profiles, as SIG and CodeScene do with LOC weighting [1][22]. A violating unit's LOC is the natural weight for the heatmap.
2. **Two-level thresholds.**
   - Level 1, unit → risk band: cut-points at weighted quantiles 70/80/90 (Alves 2010).
   - Level 2, profile → stars: per-star caps on cumulative percentages, calibrated so a reference corpus lands at 5/30/30/30/5.
   - Both levels can be recomputed on our own corpus (MessagePack-CSharp plus other C# OSS) with the 6-step algorithm in §1.2. This gives a transparent, statistically defined calibration.
3. **Debt-ratio grading** (Sonar/Qlty) is an alternative single scale: Σ remediation minutes / (LOC × 30 min) → A–E with breakpoints 5/10/20/50 %. It depends on arbitrary per-rule remediation constants, so it is weaker for "earned trust" than benchmark percentiles.
4. **Violation counts** (ISO 5055) are simple and size-normalizable (per KLOC). The spec itself admits the result is "correlated", not absolute.
5. **Sub-characteristic roll-up**: use the SIG mapping table (§1.5) with equal weights (Heitlager default). Optionally use a power mean (SIG 2026) so one strong property cannot hide a weak one.
6. **Validation template**: correlate property ratings with outcome proxies.
   - SIG used issue-resolution speed with Spearman correlation.
   - CodeScene used defects, time-in-development, and max time per file, with Kruskal-Wallis / ANOVA plus Cohen's d.
   - Muñoz Barón used a meta-analysis of human comprehension data.
   - For our PR branches, analogous proxies are reviewer comments, follow-up fix commits, and test failures.

### 7.3 C#-specific measurement notes

- **Units**: methods, constructors, and property/indexer accessors with bodies, plus local functions (named). Lambdas and anonymous methods are not units under SIG's "smallest named piece" definition [6]. Sonar treats property accessors separately (threshold 3) [15].
- **McCabe for C#**: SIG counts decision points; the book's Java list is `if`, `case`, `?`, `&&`, `||`, `while`, `for`, `catch`. For C#, adding `foreach`, `do`, `??`, `?.`, switch-expression arms, and pattern `when`/`and`/`or` is an implementation decision **[not specified by sources]**. Document whichever choice is made. Cognitive Complexity explicitly ignores `??` and `?.` [24].
- **Duplication**: SIG requires ≥6 identical lines (whitespace-insensitive), excluding blocks made only of import statements (C# `using`). Sonar requires ≥100 tokens and ≥10 lines. Both are trivially implementable with tree-sitter tokens.

---

## 8. Discrepancies and open items

- Alves 2010: §III says McCabe thresholds 6/8/**15**, while §IV/Table IV say 6/8/**14**. The 2011 slides use 14.
- Heitlager 2007 volume table prints "655–1,310" for Java (−) after "246–665" (o). This is a typo in the source.
- Book module-coupling 4★ cap: text says 21.8%, table says 21.6%. The 2015 module coupling bands look per-band, while the 2026 bands are cumulative.
- ASCQM: commented-out code cap is 2% (summary table, CWE-1085) vs 5% (pattern section).
- Qlty: docs defaults ≠ `default.toml` defaults (§5.2).
- ISO 25010:2023: testability's presence among the maintainability sub-characteristics was not verified this session.
- Unverified: Code Climate classic method-count 20 / method-lines 25; legacy GPA mapping; SIG continuous-rating interpolation formula; SIG 2026 power-mean exponent; CodeScene per-factor thresholds; SQALE original grids.
- Heitlager 2007 DOI: commonly 10.1109/QUATIC.2007.8, but Semantic Scholar metadata for that DOI shows a different title, so it is **[unverified]**. The PDF [1] was read directly.

---

## 9. References (all accessed 14 Nov 2026)

1. Heitlager, I., Kuipers, T., Visser, J. "A Practical Model for Measuring Maintainability – a preliminary report." 6th Int. Conf. on the Quality of Information and Communications Technology (QUATIC 2007), IEEE CS, pp. 30–39. PDF: https://www.di.uminho.pt/~joost/publications/HeitlagerKuipersVisser-Quatic2007.pdf
2. Alves, T.L., Ypma, C., Visser, J. "Deriving Metric Thresholds from Benchmark Data." ICSM 2010. DOI: 10.1109/ICSM.2010.5609747. PDF copy: https://list.inf.unibe.ch/hyperkitty/list/moose-dev@list.inf.unibe.ch/message/5JKRBNHFQI3AFFUZJELPGASSYK4HWQPO/attachment/4/Alves101.pdf
3. Baggen, R., Schill, K., Visser, J. "Standardized Code Quality Benchmarking for Improving Software Maintainability." SQM 2010 workshop. PDF: https://webarchive.di.uminho.pt/wiki.di.uminho.pt/twiki/pub/Personal/Joost/PublicationList/SQM2010-StandardizedCodeQuality.pdf. Journal version: Baggen, Correia, Schill, Visser, Software Quality Journal 20(2):287–307 (2012), DOI: 10.1007/s11219-011-9144-9 (metadata only).
   3b. Bijlsma, D., Ferreira, M., Luijten, B., Visser, J. "Faster issue resolution with higher technical quality of software." Software Quality Journal (2012). DOI: 10.1007/s11219-011-9140-0. Abstract via TU Delft repository: https://repository.tudelft.nl/islandora/object/uuid%3Ae4b319c4-dade-4883-80fb-f04da6b25a02/datastream/OBJ/download
4. Alves, T.L., Correia, J.P., Visser, J. "Benchmark-Based Aggregation of Metrics to Ratings." IWSM-Mensura 2011. DOI: 10.1109/IWSM-MENSURA.2011.15 (metadata only).
   4b. Alves, T.L. Seminar slides, HASLab, Univ. Minho, 20 Jul 2011: https://webarchive.di.uminho.pt/wiki.di.uminho.pt/twiki/pub/Personal/Tiago/Publications/2011-07-20_HASLab_UMinho.pdf
5. Visser, J., van Eck, P., van der Leek, R., Rigal, S., Wijnholds, G. *Building Maintainable Software: Ten Guidelines for Future-Proof Code* (Java ed.). O'Reilly, 2016 (1st release Dec 2015). Complimentary PDF: https://www.softwareimprovementgroup.com/resources/building-maintainable-software (the preface states a C# edition also exists). O'Reilly listing: https://www.oreilly.com/library/view/building-maintainable-software/9781491955987/ (returned HTTP 403; not read).
   5c. Better Code Hub description: https://pybit.es/articles/bettercodehub/
6. SIG / TÜV NORD CERT. "Evaluation Criteria Trusted Product Maintainability: Guidance for Producers", Version 18.1 (31 Mar 2026): https://softwareimprovementgroup.com/wp-content/uploads/SIG-TUViT-Evaluation-Criteria-Trusted-Product-Maintainability-Guidance-for-producers.pdf
7. SIG / TÜViT. "Evaluation Criteria Trusted Product Maintainability", Version 13.0 (26 May 2021): https://www.softwareimprovementgroup.com/wp-content/uploads/SIG-TUViT-Evaluation-Criteria-Trusted-Product-Maintainability.pdf
8. Sigrid documentation, "Approach" (star ratings, benchmark): https://docs.sigrid-says.com/getting-started/approach.html; quality model index: https://docs.sigrid-says.com/reference/sig-quality-models.html
9. Sigrid documentation, "Key changes in the 2026 model": https://docs.sigrid-says.com/reference/quality-model-documents/2026-model-changes.html; SIG blog "Maintainability Model 2024 update": https://www.softwareimprovementgroup.com/maintainability-model-2024-update/
10. OMG. *Automated Source Code Maintainability Measure (ASCMM)* v1.0, formal/16-01-01 (Dec 2015): https://www.omg.org/spec/ASCMM/1.0/PDF (spec page https://www.omg.org/spec/ASCMM/1.0/)
11. OMG. *Automated Source Code Quality Measures (ASCQM)* v1.0: https://www.omg.org/spec/ASCQM/1.0/PDF
12. SonarSource. "Metrics definition", SonarQube Server 2026.5: https://docs.sonarsource.com/sonarqube-server/user-guide/code-metrics/metrics-definition
13. SonarSource. "Introduction to quality gates" (Sonar way), SonarQube Server 2026.5: https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates
    13b. SonarSource. "Quality gates for AI code" (Sonar way for agentic AI): https://docs.sonarsource.com/sonarqube-server/quality-standards-administration/ai-code-assurance/quality-gates-for-ai-code
14. MITRE CWE. CWE-1307 "CISQ Quality Measures – Maintainability": https://cwe.mitre.org/data/definitions/1307.html; entries CWE-1080 (https://cwe.mitre.org/data/definitions/1080.html), 1064, 1074, 1086, 1048, 1084, 1085, 1041, 1052, 1121 (same URL pattern).
15. SonarSource sonar-dotnet, `CognitiveComplexityBase.cs`: https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.Core/Rules/CognitiveComplexityBase.cs
16. SonarSource sonar-dotnet, rule metadata S3776: https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/rspec/cs/S3776.json
17. SonarSource sonar-dotnet rule base classes (FunctionComplexityBase S1541, TooManyParametersBase S107, MethodsShouldNotHaveTooManyLinesBase S138, FunctionNestingDepthBase S134, ExpressionComplexityBase S1067, FileLinesBase S104): https://raw.githubusercontent.com/SonarSource/sonar-dotnet/master/analyzers/src/SonarAnalyzer.Core/Rules/
18. arc42 Quality Model, ISO/IEC 25010 page: https://quality.arc42.org/standards/iso-25010
19. ISO/IEC 5055:2021 preview (table of contents), VDE Verlag: https://assets.vde-verlag.de/iec-normen/preview-pdf/info_isoiec5055%7Bed1.0%7Den.pdf
20. Qlty docs, "Maintainability Metrics and Ratings": https://docs.qlty.sh/cloud/maintainability/metrics.md; "Code Smells": https://docs.qlty.sh/code-smells.md
    20b. Qlty docs, `qlty.toml` reference: https://docs.qlty.sh/cli/qlty-toml.md
21. Qlty source, classic Code Climate check migration: https://raw.githubusercontent.com/qltysh/qlty/main/qlty-config/src/migration/checks.rs
    21b. Qlty source, default config: https://raw.githubusercontent.com/qltysh/qlty/main/qlty-config/default.toml
22. CodeScene docs, "Code Health": https://codescene.io/docs/guides/technical/code-health.html
23. Tornhill, A., Borg, M. "Code Red: The Business Impact of Code Quality – A Quantitative Study of 39 Proprietary Production Codebases." TechDebt 2022. DOI: 10.1145/3524843.3528091. arXiv: https://arxiv.org/abs/2203.04374
24. Campbell, G.A. "Cognitive Complexity – a new way of measuring understandability", SonarSource white paper v1.7 (29 Aug 2023): https://www.sonarsource.com/docs/CognitiveComplexity.pdf
25. Muñoz Barón, M., Wyrich, M., Wagner, S. "An Empirical Validation of Cognitive Complexity as a Measure of Source Code Understandability." ESEM 2020. DOI: 10.1145/3382494.3410636. arXiv: https://arxiv.org/abs/2007.12520
26. Lenarduzzi, V., Lomio, F., Huttunen, H., Taibi, D. "Are SonarQube Rules Inducing Bugs?" SANER 2020. arXiv: https://arxiv.org/abs/1907.00376
27. Borg, M., Pruvost, I., Mones, E., Tornhill, A. "Increasing, not Diminishing: Investigating the Returns of Highly Maintainable Code." TechDebt 2024. arXiv: https://arxiv.org/abs/2401.13407
28. Borg, M., Larsson, M., Breid, P., Hagatulah, N. "QUPER-MAn: Benchmark-Guided Target Setting for Maintainability Requirements" (2025), arXiv: https://arxiv.org/pdf/2508.15512. Cites Borg, Ezzouhri, Tornhill, "Ghost Echoes Revealed…", ICSME 2024, pp. 678–688.
