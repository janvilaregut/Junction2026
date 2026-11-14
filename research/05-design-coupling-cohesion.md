# 05 — Design-level practices: SOLID, cohesion/coupling, acyclic dependencies, modularity, Law of Demeter, encapsulation

Scope: how to turn design principles into **formal, AI-free, syntax-computable metrics** for C# (tree-sitter, no Roslyn semantic model), with per-class / per-line localization for a heatmap, thresholds, and the empirical evidence behind each one. Target corpus: MessagePack-CSharp plus agent-written PRs.

Verification convention: every factual claim is tied to a numbered reference (§12). A reference is **[V]** if I read the primary text (or the authors' own technical-report version), **[V-sec]** if checked through a reliable secondary source (tool documentation, lecture notes, catalogue abstract), and **[unverified]** if I could not open any source for it. No numbers were invented. Note: the shared web-search budget ran out partway through. The SOLID-specific literature (SRP/ISP/DIP metric papers) is therefore covered less thoroughly than the rest, and is flagged where that matters.

---

## 0. Executive summary (what to build)

| Practice | Recommended primary metric | Formula (short) | Flag threshold (source) | Evidence strength | Syntax-only C#? |
|---|---|---|---|---|---|
| Single Responsibility / cohesion | **LCOM4** (Hitz & Montazeri) + **TCC** (Bieman & Kang) | LCOM4 = number of connected components of the method graph; TCC = NDC/NP | LCOM4 ≥ 2 → "split candidate" [12]; TCC < 1/3 (God Class rule) [30][32] | Weak for faults. Cohesion is "not very successful" in the meta-analysis [6] | Yes (field/property access by name; merge partials) |
| Low coupling (class) | **CBO** (unique type references, both directions) + **RFC** | CBO = \|types coupled\|; RFC = \|M ∪ R\| | 9 (Shatnawi 2010 via [15]); 14 (Sahraoui 2000 via [13]); Ca > 20 "bad" [36]; CA1506: 95 per type [16] | **Strongest** of all OO metrics: CBO/RFC/WMC "++" across contexts [6]; CBO survives size control [8]; CBO best in Mozilla [4] | Approximate (declared types, `new`, base list, generics, static receivers) |
| Size/complexity of class | **WMC** (sum of cyclomatic complexity) | Σ CC(m) | WMC ≥ 47 "very high", L&M Java (via [33]) | Strong [6] (but confounded with size [8]) | Yes |
| God Class / SRP smell | **Marinescu detection strategy** | ATFD > FEW ∧ WMC ≥ VERY HIGH ∧ TCC < 1/3 | FEW = 3 to 5; VERY HIGH = 47 (Java) [32][33] | Antipattern classes are more change- and fault-prone [34][35] | Yes (ATFD approximate) |
| Encapsulation | **Public mutable fields** per class (NOPF) | count of `public` non-const fields | good 0; regular 1 to 10; bad > 10 [36] | Benchmark-derived only (no fault link) | Yes |
| Inheritance | **DIT / NOC** (in-repo) | longest base chain / direct subclasses | DIT ≥ 5 (CA1501 [17]); ≥ 6 (NDepend [14]); typical 2 [36] | **Ineffective** for fault prediction [6][4] | Partial (external bases unknown) |
| Law of Demeter | **Train-wreck count** and max call-chain depth per method | invocations on objects returned by other invocations | no validated threshold. Advisory only | Indirect (via RFC [2]); Message Chains is a catalogued smell [29][35] | Yes |
| Acyclic Dependencies (ADP) | **Tarjan SCCs** on the namespace graph and the type graph | #non-trivial SCC, size of largest SCC, % of nodes in cycles | 0 namespace cycles (principle [19]) | Core (cyclic) files have 3.4× the defects of periphery files [22] | Yes (given dependency graph) |
| Stable Dependencies / Abstractions | **Martin I, A, D** per namespace | I = Ce/(Ca+Ce); A = abstract/total; D = \|A+I−1\| | D > 0.7 "might be problematic" [14] | Design heuristic. No fault validation found | Yes |
| System modularity | **Propagation cost** (MacCormack) + **core–periphery** (VFI/VFO) | PC = density of the reflexive transitive closure | relative (trend / benchmark) | Linux 5.16% vs Mozilla 17.35% [21]; core 3.4× defects, 50% productivity drop [22] | Yes |
| Modularity (option-value) | **Decoupling Level** (Mo et al.) | layered DRH formula (§6.3) | ~60% of 129 projects fall between 46% and 75% [24] | More stable than PC across releases [24] | Yes, but needs DRH clustering |
| Component balance | **CB = SB × (1 − Gini)** (SIG) | SB is piecewise linear in the number of components, with μ=8, ω=16 | relative | Spearman ρ = 0.80 vs expert analyzability ratings [26] | Yes (namespaces or projects) |
| Dependency-inversion (DIP) | *proposed*: abstraction ratio of injected dependencies | interfaces/abstract ÷ all repo-type deps in fields + ctor params | none (unvalidated) | none found (search budget exhausted) | Yes |
| Interface segregation (ISP) | *proposed*: interface size + IUC (Romano & Pinzger) | IUC = mean fraction of an interface's methods used per client [unverified definition] | none validated | [37] metadata only | Partial |

Key methodological finding: **control for class size**. El Emam et al. report that after accounting for size, only 4 of 24 OO metrics remained associated with fault-proneness, and only two (both coupling metrics: CBO and ACMIC) were useful for prediction [8]. Any validation of our certifier must report partial effects net of LOC.

---

## 1. The CK suite (Chidamber & Kemerer 1994)

### 1.1 Definitions
Reference [1]: Chidamber & Kemerer, *A Metrics Suite for Object Oriented Design*, IEEE TSE 20(6):476–493, 1994. The definitions below are as operationalized by Basili et al. [2] **[V]** and by tool documentation [12][13] **[V-sec]**.

- **WMC (Weighted Methods per Class)**: WMC(C) = Σ_{m ∈ M(C)} c(m). CK deliberately leave the complexity c unspecified. Common variants: c ≡ 1 (WMC = number of methods, as in [2]), c = LOC, c = McCabe CC. Radjenović et al. note that WMC is therefore "more of a size or complexity metric" depending on the implementation [6] **[V]**. Inherited methods are excluded [2][13].
- **DIT (Depth of Inheritance Tree)**: the length of the longest path from the class to the root. With multiple inheritance, Basili et al. used the number of ancestors [2]. For .NET, Aivosto counts only implementation inheritance (not interfaces) and gives a direct `System.Object` subclass DIT = 1 [13].
- **NOC (Number of Children)**: the number of immediate subclasses [2][13].
- **CBO (Coupling Between Object classes)**: the number of other classes a class is coupled to. A class is coupled to another if it uses its methods or instance variables, in either direction, with each class counted once [2][13]. Microsoft's "class coupling" (≈ CBO) counts unique types reached "through parameters, local variables, return types, method calls, generic or template instantiations, base classes, interface implementations, fields defined on external types, and attribute decoration" [15] **[V]**. This is the most useful operational definition for C#.
- **RFC (Response For a Class)**: RFC = |RS|, with RS = M ∪ ⋃_i R_i, where M is the class's own methods and R_i is the set of methods called directly by method i [13]. Basili et al. used "the number of functions directly invoked by member functions or operators of a class" [2]. RFC* follows the call tree transitively [13].
- **LCOM (CK, a.k.a. LCOM1)**: for methods M_1..M_n with instance-variable sets I_i, let P = {(i,j) : I_i ∩ I_j = ∅} and Q = {(i,j) : I_i ∩ I_j ≠ ∅}. Then LCOM = |P| − |Q| if |P| > |Q|, else 0 [2][12][36] **[V]**.

### 1.2 Validation evidence

**Basili, Briand & Melo 1996** [2] **[V]** (UMD tech report CS-TR-3443, published as IEEE TSE 22(10):751–761):
- Setup: 8 medium-sized information systems with identical requirements, built in C++ by student teams; 180 classes; logistic regression on "a fault was detected in the class".
- Univariate results:
  - WMC: "somewhat significant (p = 0.06) overall", rising to p = 0.0003 for new or extensively modified classes and p = 0.001 for UI classes.
  - DIT: very significant (p = 0.0000); R² goes from 0.06 to 0.13 on new/modified classes.
  - RFC: very significant (p = 0.0000); R² goes from 0.06 to 0.24 (new/modified) and 0.36 (UI).
  - NOC: significant, but in the **opposite** direction to the one expected (larger NOC, lower fault probability), which the authors attribute to reuse.
  - **LCOM: "insignificant in all cases"**, blamed on the definition flooring to 0. Descriptive stats: median 0, mean 9.70, max 426.
  - CBO: significant, most strongly for UI classes (p = 0.0000, R² = 0.17).
- Conclusion: five of the six CK metrics appear useful for predicting class fault-proneness, and they beat "traditional" code metrics on this data set.
- Descriptive medians (useful sanity anchors): WMC 9.5, DIT 0, RFC 19.5, NOC 0, CBO 5 (Table 1).
- Caveat in reading the paper's tables: the dependent variable is coded Y = 1 for "no fault", so negative coefficients mean *more* faults.

**Gyimóthy, Ferenc & Siket 2005** [3] **[V-sec]** (IEEE TSE 31(10):897–910, DOI 10.1109/TSE.2005.112): CK metrics computed for Mozilla and checked against Bugzilla bug counts with regression and machine-learning methods. The detailed outcome comes from the follow-up on the same Mozilla data, **Siket 2008** [4] **[V-sec]**: of 58 class-level metrics, 17 were useful predictors. **CBO was the strongest, only slightly ahead of NOI (number of outgoing invocations) and RFC.** Coupling metrics were best overall, complexity and size also did well, and **all inheritance metrics were statistically insignificant**.

**Subramanyam & Krishnan 2003** [5] **[V-sec]** (IEEE TSE 29(4):297–310): on industrial C++ and Java data, a subset of CK metrics is significantly associated with defects **even after controlling for size**, but **the effects differ between the two languages**. Our implication: thresholds calibrated on Java should not be copied blindly to C#.

**El Emam, Benlarbi, Goel & Rai 1999** [8] **[V]** (NRC Canada ERB-1063, C++ telecom system):
- The report recalls the authors' earlier demonstration that "after controlling for class size, all the metrics that were studied were no longer associated with fault-proneness".
- In the new study, of 24 OO metrics "only four are associated with fault-proneness after accounting for the influence of size, and only two are useful for the construction of prediction models… Both are coupling metrics: CBO and ACMIC".

**Radjenović, Heričko, Torkar & Živkovič 2013** [6] **[V]** (systematic review, IST 55(8):1397–1418; 106 studies, 1991–2011):
- Usage: OO metrics in 49% of studies, traditional metrics in 27%, process metrics in 24%. CK usage counts: NOC 53, DIT 52, RFC 51, LCOM 50, CBO 48, WMC 44.
- Effectiveness (Table 5): **CBO, RFC and WMC rated "++" overall** and in every subgroup (pre/post-release, small/large, procedural/OO). LOC rated "+" overall. LCOM "0" overall ("+" only in small and pre-release studies). DIT "0". **NOC "0" overall and "−" in some contexts** ("occasionally inverse significant").
- Text: "The CBO, WMC and RFC were reported to be the best from the CK metrics suite. The coupling metrics were reported to be better than inheritance and cohesion metrics." DIT and NOC "were assessed as ineffective OO metrics". LCOM had conflicting results. MOOD and QMOOD "do not promise much".
- Process metrics (churn, changes, age, change-set size) beat static code metrics for post-release faults.

**Isong & Ekabua** [7] **[V-sec]** (IJSEKE 23(10), 2013; expanded arXiv 1601.01447, 2016): 29 empirical studies; "complexity, coupling and size were found to be strongly related to FP".

**Bottom line for the certifier:** weight coupling (CBO/RFC) and complexity (WMC) highest. Treat cohesion as a design/refactoring signal (SRP localization) rather than a fault predictor. Treat DIT/NOC as informational only.

---

## 2. Cohesion metrics (SRP operationalization)

Let a class C have methods M (|M| = m) and attributes A (|A| = a). μ(A_k) is the number of methods that access attribute A_k.

| Metric | Definition | Range / direction | Source |
|---|---|---|---|
| LCOM1 (CK) | \|P\| − \|Q\| if positive, else 0 | 0..∞, lower is better | [1][2][12] |
| LCOM2 (as named by Aivosto/NDepend) | 1 − Σ_k μ(A_k) / (m·a) | 0..1, lower is better | [12][14] |
| LCOM3 = **LCOM\* = LCOM-HS** (Henderson-Sellers) | (m − Σ_k μ(A_k)/a) / (m − 1) | 0..2, lower is better; 0 = every method touches every attribute; >1 indicates attributes unused by methods or used only externally | [10] via [12][14] |
| **LCOM4** (Hitz & Montazeri 1995) | number of connected components of the undirected graph G = (M, E), where (m_i, m_j) ∈ E iff they share an attribute **or** one calls the other | 1 = cohesive; k ≥ 2 = k separable parts; 0 = no methods | [9] via [11b][12] |
| **TCC** (Bieman & Kang 1995) | NDC / NP, where NP = N(N−1)/2 over visible methods and NDC = number of directly connected pairs (sharing an attribute, also through intra-class call trees) | 0..1, higher is better | [11] via [12] |
| **LCC** | (NDC + NIC) / NP, where NIC counts indirectly connected pairs (transitive closure of "connected") | 0..1, TCC ≤ LCC | [11] via [12] |

Notes, all **[V-sec]**:
- **Naming confusion.** Hitz & Montazeri's graph metric is called LCOM3 in some academic papers and LCOM4 in tools such as Aivosto [12]. Henderson-Sellers' measure is called LCOM\*, LCOM3 or "LCOM HS" depending on the source [12][14]. Our spec should state formulas, not names.
- **Aivosto's LCOM4 counting rules** (VB/.NET): property accessors count as methods; inherited members are ignored; empty procedures are dropped; constructors and destructors are ignored. UI forms and controls typically score high for design reasons [12].
- **LCOM4 vs TCC/LCC:** LCOM4 treats auxiliary leaf methods (those touching no attribute) as cohesive, while TCC/LCC treat them as unconnected [12].
- **Briand, Daly & Wüst 1998** (*A unified framework for cohesion measurement in OO systems*, EMSE 3:65–117) is the canonical formal comparison of these measures. I could confirm the bibliographic record **[V-sec]** but not its content (scanned PDF). Its detailed property analysis is **[unverified]** here.

### 2.1 Thresholds
- **LCOM4 ≥ 2** → the class "could be split into that many smaller classes" [12]. This is the cleanest SRP signal because it yields a **constructive localization**: each component is a candidate responsibility.
- **TCC < 1/3**: used inside the God Class strategy [30][32]. Aivosto suggests TCC < 0.5 and LCC < 0.5 indicate non-cohesive classes [12]. The UFMG lecture notes suggest 0.33 or 0.25 to find non-cohesive classes [32].
- **LCOM-HS > 1.0 with NbFields > 10 and NbMethods > 10** "should be avoided". **LCOM2 > 0.8** with the same size guards "might be problematic" (NDepend defaults for .NET) [14] **[V-sec]**.
- **LCOM1 benchmark** (Ferreira et al. 2012, 40 Java programs, more than 26,000 classes): good 0, regular 1 to 20, bad > 20. LCOM follows a heavy-tailed (power-law-like) distribution [36] **[V]**.

### 2.2 Recommendation for SRP
Primary: **LCOM4** (computed on the C# method–member graph) with size guards: report only when the class has ≥ 2 non-trivial members of each kind. Secondary continuous score: **TCC** (for gradients and the God Class rule). Use **LCOM-HS** only for NDepend comparability.

Evidence caveat: cohesion metrics have weak or conflicting fault-prediction evidence [2][6]. Present SRP as a design-quality dimension with explicit "split suggestions", not as a defect predictor.

### 2.3 C# operationalization (tree-sitter)
- **Nodes:** `method_declaration`, `property_declaration` accessors (or the property as one node), `indexer_declaration`, `event_declaration` accessors, `operator_declaration`. Exclude `constructor_declaration` and destructors (Aivosto rule [12]); include them in a variant for sensitivity analysis.
- **Attributes:** `field_declaration` variables, plus **auto-properties** (`{ get; set; }` with no bodies). Auto-properties are fields semantically; if treated as methods, every getter/setter becomes its own component and LCOM4 is inflated.
- **Edges:**
  - Method body references a member by **unqualified identifier** that is not shadowed by a parameter or local (scope analysis within the method is purely syntactic), or by `this.X`.
  - Invocation of a sibling method by name (`invocation_expression` whose `function` is an `identifier` or `this.X`). Overloads are ambiguous; connect to all same-name overloads.
- **Partial types:** merge all `partial` declarations of the same fully qualified name before computing. MessagePack-CSharp `src/` has 60 `partial` type declarations, so this matters.
- **Static vs instance:** compute on instance members; record static-only utility classes separately, since they are often legitimately "LCOM4 = number of methods".
- **Generated code:** exclude files containing `<auto-generated>` (11 such files in MessagePack `src/`) and T4 outputs (15 `.tt` templates).
- **Heatmap localization:** paint each method's line span by component id. The largest component is "main responsibility"; the lines of the other components are "extractable".

---

## 3. Class-level coupling: CBO, RFC, Ca/Ce, Law of Demeter

### 3.1 CBO thresholds (all .NET-relevant)
| Threshold | Meaning | Source |
|---|---|---|
| 9 | "most effective" acceptable-risk threshold (Shatnawi 2010, IEEE TSE 36(2)) | quoted in Microsoft Learn [15] **[V-sec]** |
| > 14 | "too high" (Sahraoui, Godin & Miceli, ICSM 2000) | Aivosto [13] **[V-sec]** |
| Ca: good ≤ 1, regular 2 to 20, bad > 20 | afferent couplings, Java benchmark | Ferreira et al. [36] **[V]** |
| TypeCe > 50 | "depends on too many other types" | NDepend [14] |
| 95 (type), 40 (member) | CA1506 default (counts unique type references) | Microsoft [16] **[V]** |

Recommendation: compute **CBO_out** (efferent unique types) and **CBO_in** (afferent) on the syntactic type graph (§9). Flag at **percentiles of the in-repo distribution** (Lanza & Marinescu style AVG + STDEV, §8.2) and report the fixed literature values (9 and 14) as reference lines.

### 3.2 RFC (approximate)
RFC_syn = |own methods| + |distinct invoked member names| (an invoked name is keyed by receiver expression text + method name, since types are unknown). Basili's R² of up to 0.36 for RFC [2] and its "++" rating [6] justify including it, though our syntactic version is an approximation.

### 3.3 Law of Demeter (LoD)
**Formal statement** (Lieberherr, Holland & Riel, OOPSLA '88, pp. 323–334) [28] **[V-sec]**. A method m of object a may invoke methods only of:
1. a itself;
2. m's parameters;
3. objects created within m;
4. a's attributes;
5. globals accessible in m's scope.

The **class form** (allowed classes: this class, argument classes, immediate part classes, classes instantiated in f) is "efficiently computable". The **object form** is undecidable statically [28b] **[V-sec]**.

**Syntactic metric ("train wreck"):**
- For each `invocation_expression` whose `function` is a `member_access_expression` whose `expression` is itself an `invocation_expression` (or an element access or member access on one), count one LoD violation. Calls on returned objects are what the "use only one dot" rule forbids [28].
- Per method: **LoDv(m)** = number of such calls, and **chain depth** = maximum number of consecutive call links.
- Per class: Σ LoDv, normalized per KLOC.

**False-positive control** (heuristics, unvalidated):
- Do not count namespace or type qualification (`System.Text.Encoding.UTF8`): drop prefixes that resolve to a `using` namespace or a known type name, and use `qualified_name` vs member-access context.
- Whitelist fluent APIs whose calls return the same receiver type: LINQ operators, `StringBuilder.Append*`, `Span/Memory.Slice`, builder patterns where the method returns `this`. Repo-internal "returns this" can be detected syntactically (`return this;`).

**Evidence:**
- **Indirect only.** Following LoD tends to lower RFC, which Basili et al. link to fewer faults, but it can raise WMC through wrapper methods [28] **[V-sec]**.
- "Message Chains" is a catalogued coupler smell whose remedy (Hide Delegate) trades against "Middle Man" [29].
- Message Chain appears to be among the 13 smell types in Palomba et al.'s large study, where smelly classes were more change- and fault-prone [35]. A search-result summary of that abstract mentions Message Chain + Refused Bequest co-occurrence, but I did not read the smell list in the full text, so this is **[V-sec, weak]**.
- I found **no validated numeric threshold**. Report as advisory: severity is proportional to chain depth ≥ 2.

---

## 4. Encapsulation and inheritance

### 4.1 Encapsulation
- **NOPF / NOPA** (number of public fields) per class. Benchmark thresholds: good 0, regular 1 to 10, bad > 10 [36] **[V]**. For C#, count `field_declaration` with `public` (or `protected`, `internal` as variants) **excluding `const`**. `static readonly` fields of immutable types are a gray zone; report them separately.
- **Public interface size:** number of public methods; good 0 to 10, regular 11 to 40, bad > 40 [36] **[V]**.
- **Data Class** (Lanza & Marinescu): a class that exposes data through public attributes and accessors but has little behavior. The commonly cited rule is WOC < 1/3 ∧ ((NOPA + NOAM > FEW ∧ WMC < HIGH) ∨ (NOPA + NOAM > MANY ∧ WMC < VERY HIGH)) **[unverified — book not accessed]**. The UFMG lecture notes I verified [32] list God Class, God Method, Feature Envy, Shotgun Surgery and Refused Bequest, but not Data Class.
- **MOOD AHF/MHF** (attribute/method hiding factors; Abreu & Carapuça 1994, JSS 26(1):87–96. The citation is verified via [2]'s reference list, the formulas are **[unverified]**). Radjenović et al. found little evidence for MOOD in fault prediction [6]. Do not prioritize.

### 4.2 Inheritance
- DIT thresholds: CA1501 fires at **5 or more levels** (excluding `System.*` types; configurable) [17] **[V]**. NDepend: **DIT ≥ 6** "might be hard to maintain" (it counts `System.Object`) [14]. Aivosto cites ≤ 5 (VS.NET documentation) and sometimes up to 8 [13]. Ferreira: typical value 2 [36].
- NOC: no consensus threshold. Evidence is inverse or unreliable [2][6].
- **Refused Bequest** (an LSP proxy; Lanza & Marinescu) [32] **[V-sec]**:
  - Child ignores the bequest: (NProtM_parent > FEW ∧ BUR < 1/3) ∨ BOvR < 1/3.
  - **AND** child is not trivially small: (AMW > AVG ∨ WMC > AVG) ∧ NOM > AVG.
  - Computable when parent and child are both in the repo.
- Weighting: low. Inheritance metrics are the least predictive group [4][6].

---

## 5. Package / namespace metrics (Martin), SDP, SAP, ADP

### 5.1 Definitions
Robert C. Martin, *Agile Software Development: Principles, Patterns and Practices*, 2002 (originally the 1994 "OO Design Quality Metrics" paper) [18] **[V-sec]**. For a package (here: a C# namespace, or a csproj assembly):
- **Ca** (afferent) = number of classes outside the package that depend on classes inside it.
- **Ce** (efferent) = number of classes inside the package that depend on classes outside it.
- **I = Ce / (Ca + Ce)** ∈ [0,1] (0 = maximally stable).
- **A = N_abstract / N_types** (abstract classes + interfaces over all types).
- **D = |A + I − 1|** ∈ [0,1]. Some tools use the unnormalized D′ = |A + I − 1| / √2 [18].

NDepend uses the same I and A at assembly level, defines Relational Cohesion H = (R + 1)/N (good range 1.5 to 4.0), and says assemblies with **normalized D > 0.7 "might be problematic"** [14] **[V-sec]**.

### 5.2 Principles as checkable predicates
- **SDP (Stable Dependencies Principle):** every dependency edge X → Y should satisfy I(Y) ≤ I(X). Metric: **SDP-violation ratio** = |{(X,Y) ∈ E : I(Y) > I(X)}| / |E|. Localization: the type references (lines) realizing the offending edges. (Formula is my operationalization of Martin's principle; I found no validation study.)
- **SAP (Stable Abstractions Principle):** stable packages should be abstract. Operationalized by D (main-sequence distance).
- **ADP (Acyclic Dependencies Principle):** "the dependency graph of packages or components should have no cycles". Cycles can always be broken by applying DIP or by extracting a new package [19] **[V-sec]**.

### 5.3 ADP measurement (Tarjan)
Compute SCCs with Tarjan's algorithm: O(|V| + |E|), and it emits SCCs in reverse topological order of the condensation DAG (Tarjan 1972, SIAM J. Comput. 1(2):146–160) [20] **[V-sec]**. Report:
- n_cyc = number of SCCs with |S| ≥ 2 (plus self-loops if relevant);
- **largest SCC size** |S_max| and its share |S_max| / |V|;
- fraction of nodes in cycles, Σ_{|S|≥2} |S| / |V|;
- for localization: the **edges inside each SCC**, ranked by weight (number of type references). The lowest-weight intra-SCC edges are the cheapest cut candidates (heuristic feedback-arc approximation).

Evidence: the "core" in MacCormack/Sturtevant is defined via the largest cyclic group plus high visibility. Core files carried **3.4×** the defects of peripheral files (§6.2) [22]. Additional studies on cycles and change-proneness exist (e.g., Oyetoyan et al. SANER 2015) **[unverified]**.

Gate rule for PRs: **"no new namespace-level cycle; no growth of |S_max| at type level"**. This is binary, explainable and deterministic.

---

## 6. Architecture-level modularity

### 6.1 Propagation cost (MacCormack, Rusnak & Baldwin 2006)
Source: Management Science 52(7):1015–1030; definitions read in the authors' HBS working paper 05-016 [21] **[V]**.
- Let D be the binary N×N dependency matrix (DSM). The **visibility matrix** is V = bool(Σ_{n=0}^{N} Dⁿ). The n = 0 term is included, "implying that a change to an element will always affect itself". Entries are binarized, and powers stop at N because cycles do not converge. Equivalently, V is the **reflexive transitive closure**.
- **Fan-Out Visibility** of i = (Σ_j V_ij) / N. **Fan-In Visibility** of j = (Σ_i V_ij) / N.
- **Propagation Cost** PC = (1/N²) Σ_ij V_ij (= mean VFO = mean VFI): "the proportion of elements that could be affected, on average, when a change is made to one element".
- Reference numbers: Linux **5.16%** vs first Mozilla **17.35%**; the Mozilla redesign dropped PC to **2.78%**. DSM densities were 3.4 (Linux) vs 2.4 (Mozilla) dependencies per 1000 file pairs. So density alone misleads, and PC captures the *pattern* [21].
- Caveats: PC is size-sensitive. In Mo et al.'s data, 70% of 46 projects with more than 1,000 files had PC < 20%, versus about 48% of 62 smaller projects. PC also varies across releases more than DL [24] **[V-sec]**. Use it for trend and delta comparisons on the same system, not as an absolute cross-project grade.

### 6.2 Core–periphery (Baldwin, MacCormack & Rusnak 2014; Sturtevant 2013)
Classification [22] **[V]** (Sturtevant's MIT thesis, supervised by MacCormack):

| VFI | VFO | Class | Meaning |
|---|---|---|---|
| low | low | peripheral | does not influence and is not influenced by much of the system |
| high | low | utility | relied on by many, self-contained |
| low | high | control | orchestrates many others |
| high | high | **core** | highly integral clusters, often large cycles |

"High" and "low" are cut at the "cliffs" in the rank-ordered VFI/VFO distributions [22]. The 2014 Research Policy paper classifies whole systems by the size of the largest cyclic group, reports results across 1,286 releases of 17 applications, and finds most releases core–periphery [23] **[V-sec, abstract level]**.

Evidence [22] **[V]**:
- Expected bug fixes per file versus peripheral files: "utility files have 48% more defects, control files have 2.4 times as many defects, and core files have 3.4 times as many defects".
- A core file with a high McCabe score is expected to have **8×** the defects of a low-McCabe peripheral file.
- System level: architectural-complexity differences could account for a **50% drop in productivity**, a **three-fold increase in defect density**, and an **order-of-magnitude increase in staff turnover** (single firm, 8 releases).
- Sanity anchor: 10,000 random DSMs with 12 nodes and 47 arcs had mean PC 93.84%, versus 56.25% for the equivalent hierarchy of modules.

Recommendation: compute VFI/VFO on the **type graph** (or file graph). Classify with a deterministic cut: median split or the largest-gap ("cliff") rule. Paint core types red in the heatmap. This is the most defensible "architecture heat" signal with empirical backing.

### 6.3 Decoupling Level (Mo, Cai, Kazman, Xiao & Feng, ICSE 2016, pp. 499–510)
Formula from the patent text (US 11,422,800) [24] **[V-sec]**. I checked it against the four worked examples in the same text: 4×25-file modules → 50%, 2×50-file → 41%, 1×100-file → 35%. All match with a reciprocal log₅ factor.

Prerequisite: cluster the files into a **Design Rule Hierarchy (DRH)** with layers L_1..L_n, each layer partitioned into modules.

- DL = Σ_{i=1}^{n} DL_{L_i}
- For upper layers (i < n): DL_{L_i} = Σ_{M_j ∈ L_i} (#Files(M_j) / #AllFiles) × (1 − #Deps(M_j) / #LowerLayerFiles), where #Deps(M_j) is the number of lower-layer files that directly or indirectly depend on M_j.
- For the last layer: DL_{L_n} = Σ_{M_j ∈ L_n} SizeFactor(M_j), where
  - SizeFactor(M_j) = #Files(M_j) / #AllFiles if #Files(M_j) ≤ 5;
  - SizeFactor(M_j) = #Files(M_j) / #AllFiles × 1/log₅(#Files(M_j)) otherwise.

Empirical [24] **[V-sec]**:
- 108 open-source and 21 industrial projects; about 60% have DL between 46% and 75%.
- Average about 60% (open source) and about 54% (industrial); highest observed 93%.
- DL (and the related Independence Level) are much more stable across releases than PC.
- The paper claims a larger DL means bugs and changes are more localized; the abstract-level claim is verified, the full statistical tables were not read.

Feasibility: DRH clustering is non-trivial (design-rule identification, then layering). A syntax-only approximation: take the condensation DAG of SCCs and layer it by longest path from sources, treating SCC-components as modules. This is **our approximation, not the published algorithm**, so label it "DL-approx". Recommended priority: **optional / stretch**.

### 6.4 Newman modularity Q (on dependency graphs)
Q = (1/2m) Σ_vw [A_vw − k_v k_w / (2m)] δ(c_v, c_w) = Σ_i (e_ii − a_i²) for undirected graphs (Newman 2006, PNAS 103(23)) [25] **[V-sec]**.

Use: evaluate how well the **declared** namespace partition matches the type-dependency graph (symmetrize edges). Higher Q means namespaces are internally dense and externally sparse.

Caveats [25]: there is a resolution limit, and the standard formula is for undirected graphs. No software-quality validation found. Use as a descriptive and comparative score only.

### 6.5 Component Balance (Bouwers, Correia, van Deursen & Visser, WICSA 2011)
Source: TUD-SERG-2011-005 [26] **[V]**.
- **SB(n)** (System Breakdown) with optimum μ and cut-off ω:
  - SB(n) = (n − 1)/(μ − 1) if n ≤ μ;
  - SB(n) = (ω − n)/(ω − μ) if μ < n < ω;
  - SB(n) = 0 if n ≥ ω.
- **CSU = 1 − Gini({volume(c)})**, where volume(c) is the sum of module sizes (e.g., LOC).
- **CB = SB(|C|) × CSU**. The product was chosen because the metric must be conjunctive.
- Calibration from SIG's repository: **μ = 8** (most common number of components) and **ω = 16** (95th percentile).
- Validation: Spearman **ρ = 0.80 (p = 6.4×10⁻⁴)** between CB and expert analyzability ratings.
- Applies to one decomposition level at a time.

For C#: components = top-level namespaces under the root (e.g., `MessagePack.Formatters`, `.Resolvers`, `.Internal`, …) or csproj projects; volume = LOC. MessagePack `src/` has about 20 distinct namespaces, so per-layer application is needed.

---

## 7. SOLID → metrics map (with honesty about evidence)

| Principle | Metric(s) we can compute | Literature status |
|---|---|---|
| **S**RP | LCOM4 (components), TCC, God Class strategy; number of distinct "concern clusters" | LCOM4/TCC defined [9][11]; God Class strategy [30][32]; antipattern classes more change/fault-prone [34][35]; cohesion alone weak for faults [6] |
| **O**CP | *proposed*: count of type-switches (`switch`/`is` on type patterns over repo types); modification breadth in PR deltas (classes touched per feature) | No validated metric found **[search incomplete]** |
| **L**SP | Refused Bequest [32]; *proposed*: overrides whose body is only `throw new NotSupportedException/NotImplementedException` | Refused Bequest is one of the catalogued smells; validation via [34][35] (antipatterns generally) |
| **I**SP | interface size (#members); *proposed*: implementers throwing NotImplemented for some members; **IUC** (Interface Usage Cohesion, Romano & Pinzger, ICSM 2011, pp. 303–312, DOI 10.1109/ICSM.2011.6080797 [37]) | Bibliographic record **[V-sec]**. Exact IUC formula and its finding (reported as the best predictor of change-prone Java interfaces) **[unverified]**. Abdeen et al. (ICSM 2013) interface-design metrics **[unverified]** |
| **D**IP | Martin A, I, D at namespace level [18]; SDP-violation ratio (§5.2); *proposed* class-level **abstraction ratio** AR(C) = \|repo-type deps of C via fields / ctor params / properties that are interfaces or abstract\| ÷ \|all repo-type deps via those slots\|, plus **concrete-new count** (`object_creation_expression` of non-trivial repo classes inside methods, excluding DTOs/value types/exceptions) | Martin metrics are design heuristics with no fault validation found; AR is our construction (unvalidated) |

Recommendation: for the challenge ("Earned Trust"), present SRP (LCOM4/TCC), DIP (A/I/D, SDP) and ADP (SCC) as **principle checks**. Present CBO/RFC/WMC/core-periphery as the **empirically validated risk signals**. Label the proposed metrics (OCP, ISP-implementer, AR) as **experimental** until our own validation (§8) supports them.

---

## 8. Detection strategies, thresholds and validation protocol

### 8.1 Marinescu / Lanza & Marinescu detection strategies
A detection strategy is a composed logical condition over metric filters: absolute or relative comparators combined with AND/OR [32] **[V-sec]**. Strategies with verified forms [32] (Lanza & Marinescu 2006, Springer, DOI 10.1007/3-540-39538-5):
- **God Class:** ATFD > FEW ∧ WMC ≥ VERY HIGH ∧ TCC < 1/3.
- **God (Brain) Method:** LOC > HIGH(class)/2 ∧ CYCLO ≥ HIGH ∧ NOAV > MANY.
- **Feature Envy:** ATFD > FEW ∧ LAA < 1/3 ∧ FDP ≤ FEW. Here LAA = locality of attribute accesses and FDP = number of foreign data providers.
- **Shotgun Surgery:** CM > MANY ∧ CC > MANY (changing methods / changing classes).
- **Refused Bequest:** see §4.2.

Numeric values:
- **WMC VERY HIGH = 47** and **ATFD FEW = 5**, as implemented by a tool that cites L&M Table A.2 (45 Java projects) [33] **[V-sec]**. The UFMG notes give ATFD FEW = 3 as a "generally-accepted meaning" example [32]. I recommend FEW ∈ {3, 5} with sensitivity analysis.
- The 2004 ICSM paper ("Detection strategies: metrics-based rules for detecting design flaws") describes the method using relative filters (TopValues / BottomValues). A same-year CSMR paper on history-enhanced detection uses different God Class cut-offs. Treat **47 as a Java-calibrated value**; I could not open the 2004 paper itself.
- Lanza & Marinescu statistical thresholds [32] **[V-sec]**: Low = AVG − STDEV, High = AVG + STDEV, Very High = 1.5 × High, from 45 Java and 37 C++ projects.

| | Low | Avg | High | Very High |
|---|---|---|---|---|
| CYCLO/LOC, Java | 0.16 | 0.20 | 0.24 | 0.36 |
| LOC/method, Java | 7 | 10 | 13 | 19.5 |
| NOM/class, Java | 4 | 7 | 10 | 15 |
| CYCLO/LOC, C++ | 0.20 | 0.25 | 0.30 | 0.45 |
| LOC/method, C++ | 5 | 10 | 16 | 24 |
| NOM/class, C++ | 4 | 9 | 15 | 22.5 |

  (Consistency check: 47 ≈ 15 NOM_VeryHigh × ~3.1 CYCLO per method. That derivation is my inference, not the source's statement.)
- **For C#: recompute AVG/STDEV on our own benchmark** (MessagePack-CSharp plus the other .NET repos in `corpus/`) rather than reusing Java numbers. Subramanyam & Krishnan's language-dependence finding supports this [5].

### 8.2 Threshold policy (recommended)
1. **Principle gates** (binary, no calibration needed): no new namespace cycle; no growth of the largest type-level SCC; no new class with LCOM4 ≥ 2 *and* NOM ≥ NOM_High.
2. **Benchmark-relative grades:** for each metric, compute the in-corpus distribution and grade by AVG ± STDEV (L&M [32]) or by frequency bands (Ferreira [36]: "good" = most common values, "regular" = low-frequency, "bad" = rare). Coupling and LCOM distributions are heavy-tailed [36], so prefer **quantiles** over mean ± SD (a methodological inference). SIG's LOC-weighted quantile approach (Alves, Ypma & Visser, ICSM 2010) is the standard reference for that design **[unverified — PDF not reachable]**.
3. **Literature reference lines** displayed alongside: CBO 9 / 14; Ca > 20; NOPF > 10; public methods > 40; DIT ≥ 5; D > 0.7; WMC ≥ 47; TCC < 1/3.

### 8.3 Statistical validation protocol (how to "earn trust")
Grounded in how the validated studies did it [2][4][8]:
1. **Ground truth:** mine MessagePack-CSharp git history. Label a class or file as "fault-prone" if touched by bug-fix commits (message keywords or issue links); also count changes (change-proneness, as in Khomh [34]).
2. **Univariate logistic regression** of fault-prone (0/1) on each metric (as in Basili [2] and Siket [4]). Report the odds ratio per standard deviation, p-value and McFadden R².
3. **Size control (mandatory):** add log(LOC) as a covariate, or use partial Spearman. El Emam's result is that most OO metrics lose significance after this [8]. Report which of our metrics *add* information beyond size.
4. **Ranking quality:** AUC / Spearman ρ of the metric against bug-fix counts. For architecture metrics, compare defect rates per core/periphery class (replicating Sturtevant's ratios [22]).
5. **Multiple-testing control** (Benjamini–Hochberg) across about 20 metrics.
6. **Metamorphic sanity tests** (deterministic, no history needed): merging two unrelated classes must raise LCOM4 and lower TCC; adding a back-edge between two namespaces must create an SCC and raise PC; introducing a `public` field must raise NOPF. These guarantee the metrics behave as defined (a construct-validity argument that suits an AI-free certifier).

---

## 9. What is computable from syntax only (tree-sitter-c-sharp), and how

Node types available in the tree-sitter-c-sharp grammar [39] **[V]**:
- Declarations and directives: `using_directive`, `namespace_declaration`, `file_scoped_namespace_declaration`, `class_declaration`, `struct_declaration`, `interface_declaration`, `record_declaration`, `enum_declaration`, `base_list`, `field_declaration` (with `variable_declaration` and field `type`), `property_declaration` (`type`, `name`, `accessors`), `method_declaration` (`returns`, `name`, `type_parameters`, `parameters`, `body`), `constructor_declaration`, `parameter` (`type`, `name`).
- Expressions: `object_creation_expression` (`type`), `implicit_object_creation_expression`, `invocation_expression` (`function`, `arguments`), `member_access_expression` (`expression`, `name`), `conditional_access_expression`, `typeof_expression` (`type`), `cast_expression` (`type`), `is_pattern_expression`, `as`/`is` expressions.
- Names and other: `qualified_name` (`qualifier`, `name`), `generic_name` and `type_argument_list`, `predefined_type`, `attribute` (`name`), `modifier`.
- `this` and `base` are anonymous keywords, not named nodes.

### 9.1 Building the type-dependency graph without a semantic model
1. **Symbol table:**
   - Collect every type declaration with its fully qualified name: namespace from block or file-scoped declarations (MessagePack `src/` uses both: 137 block-namespace files and 48 file-scoped files), plus nesting path and generic arity.
   - Merge partials.
   - Record kind (class, struct, interface, record, enum, delegate) and the `abstract` / `static` / `sealed` modifiers (needed for A and for DIP).
2. **Reference extraction per type**, collecting type-name occurrences from:
   - the `base_list`;
   - field, property, event and indexer types;
   - method return and parameter types;
   - explicit local `variable_declaration` types (not `var`);
   - `object_creation_expression` types;
   - `type_argument_list` contents;
   - `typeof`, cast, `is`/`as`/pattern types;
   - `catch` declarations; `default(T)`; array, nullable and tuple element types;
   - `attribute` names (also try the name + "Attribute" suffix);
   - **static receivers**: `X.Member` where `X` is an identifier that is not a local, parameter or member and matches a known type name.
3. **Name resolution heuristic:** a simple name resolves in this order: (a) nested types of the enclosing type chain; (b) types in the current namespace and its parents; (c) types in namespaces imported by `using` / `global using` (MessagePack `src/` has 12 `global using` lines); (d) `using` aliases; (e) `using static`.
   - Drop `predefined_type` and in-scope type parameters.
   - If several candidates remain, either connect to all with weight 1/k or mark the reference ambiguous (report the count).
4. **Edge weights** = number of references (used to rank cut candidates in SCCs and in heatmap intensity).

**Known under-approximations** (document them in the certificate):
- `var` locals and method-return types are invisible.
- Extension methods, implicit conversions, `dynamic`, reflection and source-generated code are not seen.
- Overload resolution is impossible, so calls are matched by name.
- Inherited members from external bases are unknown.

These bias CBO/RFC **downward** but consistently across versions, which is acceptable for **delta (PR) analysis**. Basili et al. themselves adapted CK definitions to their language and noted they are "not language independent" [2].

### 9.2 Computability matrix
| Metric | Syntax-only fidelity | Notes |
|---|---|---|
| WMC (CC-weighted), NOM, LOC | exact | already in `qlab/complexity.py` scope |
| LCOM1/2/HS/4, TCC, LCC | high | intra-class only; member access by name + scope analysis |
| NOPF, public-method count | exact | modifiers |
| DIT, NOC (in-repo) | medium | base-class vs interface ambiguity in `base_list`: use the declared kind for repo types; for external names use the `I[A-Z]` naming convention as a fallback heuristic |
| CBO, Ca/Ce (type level) | medium (under-approx.) | §9.1 |
| RFC | low–medium | name-level calls |
| ATFD / LAA / FDP | low–medium | foreign property access `x.P` with unknown type of `x`. Approximate via declared types of fields, parameters and explicit locals |
| Martin I, A, D; SDP ratio | medium–high | aggregated from the type graph, so less sensitive to individual misses |
| SCC / ADP, propagation cost, VFI/VFO, core–periphery | medium–high | graph-level; robust to small edge losses except where the missed edge closes a cycle |
| Component Balance | exact | namespace or project + LOC |
| Modularity Q | medium–high | from type graph + namespace partition |
| DL | medium | needs DRH (approximation, §6.3) |
| LoD train wrecks | high | purely syntactic, with whitelist heuristics |

---

## 10. Heatmap localization (per class / per line)

| Signal | Line-level anchor |
|---|---|
| LCOM4 components | line spans of the methods in non-principal components |
| TCC / God Class | class header + the members contributing to ATFD (foreign accesses) |
| CBO | lines containing references to each coupled type (weight = 1 / number of occurrences of that type in the class, so each type contributes 1 in total) |
| LoD | the `invocation_expression` spans of train wrecks |
| NOPF | `field_declaration` lines |
| ADP / SCC | for each intra-SCC edge, the lines realizing the type references (the `using` directive plus the use sites); highlight minimal cut candidates |
| SDP violations | lines realizing edges X → Y with I(Y) > I(X) |
| Core–periphery | whole-type shading by class (core = red, control = orange, utility = yellow, peripheral = neutral) |
| PR delta | differences in all the above between base and head; new cycles and new core members are emphasized |

---

## 11. Antipatterns / smells: evidence of impact

- **Khomh, Di Penta, Guéhéneuc & Antoniol 2012** (EMSE 17(3):243–275, DOI 10.1007/s10664-011-9171-y) [34] **[V-sec, abstract]**:
  - 13 antipatterns in 54 releases of ArgoUML, Eclipse, Mylyn and Rhino.
  - In almost all releases, classes participating in antipatterns are more change- and fault-prone.
  - **Size alone cannot explain** the higher odds.
  - Structural changes affect more antipattern classes.
- **Palomba, Bavota, Di Penta, Fasano, Oliveto & De Lucia 2018** (EMSE 23(3):1188–1221, DOI 10.1007/s10664-017-9535-z) [35] **[V-sec, abstract]**:
  - 395 releases of 30 open-source projects; 17,350 manually validated instances of 13 smell types.
  - Smells tied to long or complex code (e.g., Complex Class) are the most diffused.
  - Smelly classes have significantly higher change- and fault-proneness than smell-free classes.
- **Zimmermann & Nagappan 2008** (ICSE) [27] **[V-sec]**: on Windows Server 2003, network measures on dependency graphs gave about 10 percentage points higher recall than complexity metrics, and identified 60% of the binaries developers considered critical, about twice as many as complexity metrics. This supports using **graph-level coupling** (§5–6), not just per-class counts.

---

## 12. References

Verification tags: [V] primary or author full text read; [V-sec] verified via secondary or official abstract; [unverified].

1. Chidamber, S.R., Kemerer, C.F. (1994). A Metrics Suite for Object Oriented Design. IEEE TSE 20(6):476–493. DOI 10.1109/32.295895. Record: https://dspace.mit.edu/handle/1721.1/48424 (working paper). Author PDF (scanned; not text-extractable): https://sites.pitt.edu/~ckemerer/CK%20research%20papers/MetricForOOD_ChidamberKemerer94.pdf **[V-sec]**
2. Basili, V.R., Briand, L.C., Melo, W.L. (1996). A Validation of Object-Oriented Design Metrics as Quality Indicators. IEEE TSE 22(10):751–761. Tech-report version CS-TR-3443 read in full: https://www.cs.umd.edu/~basili/publications/technical/T102.pdf **[V]**
3. Gyimóthy, T., Ferenc, R., Siket, I. (2005). Empirical Validation of Object-Oriented Metrics on Open Source Software for Fault Prediction. IEEE TSE 31(10):897–910. DOI 10.1109/TSE.2005.112. https://www.inf.u-szeged.hu/~ferenc/publication/gfs05 **[V-sec]**
4. Siket, I. (2008). Evaluating the effectiveness of object-oriented metrics for bug prediction. Periodica Polytechnica EE 52(3–4):177–186. https://pp.bme.hu/ee/article/view/868 **[V-sec]**
5. Subramanyam, R., Krishnan, M.S. (2003). Empirical Analysis of CK Metrics for Object-Oriented Design Complexity: Implications for Software Defects. IEEE TSE 29(4):297–310. DOI 10.1109/TSE.2003.1191795. https://experts.illinois.edu/en/publications/empirical-analysis-of-ck-metrics-for-object-oriented-design-compl/ **[V-sec]**
6. Radjenović, D., Heričko, M., Torkar, R., Živkovič, A. (2013). Software fault prediction metrics: A systematic literature review. IST 55(8):1397–1418. DOI 10.1016/j.infsof.2013.02.009. Author version read: https://gup.ub.gu.se/file/127150 **[V]**
7. Isong, B., Ekabua, O. (2013). A systematic review of the empirical validation of object-oriented metrics towards fault-proneness prediction. IJSEKE 23(10). Expanded version: https://arxiv.org/abs/1601.01447 **[V-sec]**
8. El Emam, K., Benlarbi, S., Goel, N., Rai, S. (1999). A Validation of Object-Oriented Metrics. NRC Canada ERB-1063. https://www.ehealthinformation.ca/web/default/files/wp-files/10631.pdf **[V]**. The related El Emam et al. 2001, "The confounding effect of class size on the validity of object-oriented metrics", IEEE TSE 27(7), is **[unverified]** directly.
9. Hitz, M., Montazeri, B. (1995). Measuring coupling and cohesion in object-oriented systems. Proc. Int. Symp. on Applied Corporate Computing. Via (11b) and (12) **[V-sec]**
10. Henderson-Sellers, B. (1996). Object-Oriented Metrics: Measures of Complexity. Prentice Hall. LCOM\* formula via (12) and (14) **[V-sec]**
11. Bieman, J.M., Kang, B.-K. (1995). Cohesion and reuse in an object-oriented system. Proc. ACM SSR'95 / SIGSOFT SEN pp. 259–262. DOI reported as 10.1145/223427.211856 (sources disagree). TCC/LCC via (12) **[V-sec]**
    - 11b. Analizo LCOM4 documentation: https://metacpan.org/pod/Analizo::Metric::LackOfCohesionOfMethods **[V-sec]**
12. Aivosto Project Analyzer — Cohesion metrics (LCOM1–4, TCC, LCC): https://aivosto.com/project/help/pm-oo-cohesion.html **[V-sec]**
13. Aivosto Project Analyzer — Chidamber & Kemerer metrics (thresholds: DIT ≤ 5, CBO > 14 per Sahraoui et al. 2000): https://www.aivosto.com/project/help/pm-oo-ck.html **[V-sec]**
14. NDepend — Code Metrics definitions and thresholds (.NET): https://www.ndepend.com/docs/code-metrics **[V-sec]**
15. Microsoft Learn — Code metrics: Class coupling (cites Shatnawi 2010, IEEE TSE 36(2): CBO = 9): https://learn.microsoft.com/en-us/visualstudio/code-quality/code-metrics-class-coupling **[V]**
16. Microsoft Learn — CA1506 Avoid excessive class coupling (95 per type, 40 per member): https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1506 **[V]**
17. Microsoft Learn — CA1501 Avoid excessive inheritance (threshold 5): https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1501 **[V]**
18. Martin, R.C. (2002). Agile Software Development: Principles, Patterns and Practices (and the 1994 "OO Design Quality Metrics" paper). Formulas via https://en.wikipedia.org/wiki/Software_package_metrics **[V-sec]**
19. Acyclic dependencies principle (Martin, "Granularity"): https://en.wikipedia.org/wiki/Acyclic_dependencies_principle **[V-sec]**
20. Tarjan, R.E. (1972). Depth-first search and linear graph algorithms. SIAM J. Comput. 1(2):146–160. DOI 10.1137/0201010. Via https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm **[V-sec]**
21. MacCormack, A., Rusnak, J., Baldwin, C.Y. (2006). Exploring the Structure of Complex Software Designs: An Empirical Study of Open Source and Proprietary Code. Management Science 52(7):1015–1030. HBS WP 05-016 read: https://www.hbs.edu/ris/Publication%20Files/05-016.pdf **[V]**
22. Sturtevant, D.J. (2013). System Design and the Cost of Architectural Complexity. PhD thesis, MIT. https://dspace.mit.edu/handle/1721.1/79551. Full text read: https://dsmsuite.github.io/external/CostOfComplexityReport.pdf **[V]**
23. Baldwin, C., MacCormack, A., Rusnak, J. (2014). Hidden structure: Using network methods to map system architecture. Research Policy 43(8):1381–1397. https://econpapers.repec.org/RePEc:eee:respol:v:43:y:2014:i:8:p:1381-1397 **[V-sec]**
24. Mo, R., Cai, Y., Kazman, R., Xiao, L., Feng, Q. (2016). Decoupling Level: A New Metric for Architectural Maintenance Complexity. ICSE 2016, pp. 499–510. https://bibtex.github.io/ICSE-2016-MoCKXF.html. Formula and empirical numbers from patent US 11,422,800: https://patents.google.com/patent/US11422800 **[V-sec]**. Paper PDF (TLS error, not read): https://www.cs.drexel.edu/~yc349/papers/2016/icse2016-DL.pdf
25. Newman, M.E.J. (2006). Modularity and community structure in networks. PNAS 103(23). DOI 10.1073/pnas.0601602103. Via https://en.wikipedia.org/wiki/Modularity_(networks) **[V-sec]**
26. Bouwers, E., Correia, J.P., van Deursen, A., Visser, J. (2011). Quantifying the Analyzability of Software Architectures. WICSA 2011. TUD-SERG-2011-005 read: https://repository.tudelft.nl/file/File_1c425f06-1325-4429-a83f-744af8b81317 **[V]**
27. Zimmermann, T., Nagappan, N. (2008). Predicting defects using network analysis on dependency graphs. ICSE 2008. https://www.microsoft.com/en-us/research/publication/predicting-defects-using-network-analysis-on-dependency-graphs/ **[V-sec]**
28. Lieberherr, K., Holland, I., Riel, A. (1988). Object-Oriented Programming: An Objective Sense of Style. OOPSLA '88, pp. 323–334. Via https://en.wikipedia.org/wiki/Law_of_Demeter **[V-sec]**
    - 28b. Northeastern Demeter project, general formulation: https://www2.ccs.neu.edu/research/demeter/demeter-method/LawOfDemeter/general-formulation.html **[V-sec]**
29. Message Chains smell (after Fowler, *Refactoring*): https://refactoring.guru/smells/message-chains **[V-sec]**
30. Marinescu, R. (2004). Detection Strategies: Metrics-Based Rules for Detecting Design Flaws. ICSM 2004. Copy hosted in UFMG course materials (not read in full): https://homepages.dcc.ufmg.br/~figueiredo/disciplinas/2015a/sqm/paper06charles.pdf **[V-sec, partial]**
31. Lanza, M., Marinescu, R. (2006). Object-Oriented Metrics in Practice. Springer. DOI 10.1007/3-540-39538-5. Via (32) and (33) **[V-sec]**
32. Figueiredo, E. (UFMG) lecture notes on Lanza & Marinescu:
    - Detection Strategies: https://homepages.dcc.ufmg.br/~figueiredo/disciplinas/lectures/detection-strategy_v01.pdf **[V]**
    - Metrics and Thresholds: https://homepages.dcc.ufmg.br/~figueiredo/disciplinas/lectures/metrics-thresholds_v01.pdf **[V]**
33. cha-core God Class plugin (implements L&M with WMC VeryHigh = 47, ATFD Few = 5, TCC < 1/3, citing L&M Table A.2): https://docs.rs/crate/cha-core/1.0.7/source/src/plugins/god_class.rs **[V-sec]**
34. Khomh, F., Di Penta, M., Guéhéneuc, Y.-G., Antoniol, G. (2012). An exploratory study of the impact of antipatterns on class change- and fault-proneness. EMSE 17(3):243–275. DOI 10.1007/s10664-011-9171-y. https://publications.polymtl.ca/15173/ **[V-sec]**
35. Palomba, F., Bavota, G., Di Penta, M., Fasano, F., Oliveto, R., De Lucia, A. (2018). On the diffuseness and the impact on maintainability of code smells: a large scale empirical investigation. EMSE 23(3):1188–1221. DOI 10.1007/s10664-017-9535-z. https://repository.tudelft.nl/record/uuid:230f66ba-8c64-410e-899a-fcbeb9b8f190 **[V-sec]**
36. Ferreira, K.A.M., Bigonha, M.A.S., Bigonha, R.S., Mendes, L.F.O., Almeida, H.C. (2012). Identifying thresholds for object-oriented software metrics. JSS 85:244–257. DOI 10.1016/j.jss.2011.05.044. https://www.llp.dcc.ufmg.br/Publications/Journal2012/JSS-journal.pdf **[V]**
37. Romano, D., Pinzger, M. (2011). Using Source Code Metrics to Predict Change-Prone Java Interfaces. ICSM 2011, pp. 303–312. DOI 10.1109/ICSM.2011.6080797. https://research.tudelft.nl/en/publications/using-source-code-metrics-to-predict-change-prone-java-interfaces **[V-sec metadata; IUC details unverified]**
38. Abreu, F.B., Carapuça, R. (1994). Candidate metrics for object-oriented software within a taxonomy framework. JSS 26(1):87–96. Citation verified via (2)'s reference list; MOOD formulas **[unverified]**
39. tree-sitter-c-sharp grammar: https://raw.githubusercontent.com/tree-sitter/tree-sitter-c-sharp/master/grammar.js **[V]**

**Not verified, mentioned only as pointers:**
- Alves, Ypma & Visser, ICSM 2010, "Deriving metric thresholds from benchmark data".
- Briand, Wüst, Daly & Porter, JSS 2000, "Exploring the relationships between design measures and software quality in OO systems".
- Briand, Daly & Wüst 1998 cohesion framework (content).
- Oyetoyan et al., SANER 2015, circular dependencies and change-proneness.
- Mo et al., WICSA 2015, hotspot patterns.
- Abdeen, Sahraoui & Shata, ICSM 2013, interface design metrics.
- Shatnawi 2010 (used only as quoted by [15]).
- Sahraoui, Godin & Miceli 2000 (used only as quoted by [13]).

---

## Appendix A — Corpus facts used in this note (measured locally, MessagePack-CSharp `src/`, excluding `obj/`)
- 190 `.cs` files. Largest: `Resolvers/DynamicObjectResolver.cs` (2,161 lines), `Formatters/PrimitiveFormatter.cs` (1,996 lines).
- 60 `partial` type declarations (so partials must be merged before computing cohesion).
- 137 files with block namespaces and 48 with file-scoped namespaces (the parser must support both).
- 12 `global using` lines (they must feed name resolution).
- 11 files marked `auto-generated`; 15 `.tt` T4 templates (exclude generated outputs from design metrics).
- About 20 distinct namespaces. The most populated: `MessagePack` (41 file-level declarations), `MessagePack.Formatters` (30), `MessagePack.Internal` (26), `MessagePack.Resolvers` (23), `MessagePack.SourceGenerator.CodeAnalysis` (19).
