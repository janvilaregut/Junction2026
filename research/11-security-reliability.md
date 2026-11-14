# 11 — Measuring Security and Reliability of C# code deterministically (no AI)

Research note for the quality-lab certifier (Junction 2026, Tieto "Earned Trust in AI Code").
Target: MessagePack-CSharp plus 4 agent-written PR branches. Proposed dimensions: Security 30 %,
Reliability 25 %. Blocking rules: 0 new critical/high vulnerabilities, 0 new blocker bugs. Interchange: SARIF 2.1.0.
Outcomes: pass / fail / incomplete.

Date of research: 2026-11-14. Every number below has a numbered reference. Things I could not check
are marked **[unverified]**. Numbers I computed myself (simulations, Bayesian arithmetic, counts on
downloaded files) are marked **(computed)**, and the method is shown so it can be re-run.

> Note on method: the shared web-search budget ran out partway through. After that I only fetched
> primary-source URLs directly (docs, arXiv abstracts, raw files, the OSV API). A few leads I could not
> confirm are listed in §9.

---

## 0. TL;DR

1. **The C# SAST stack is free, deterministic and emits SARIF:** Roslyn NetAnalyzers (94 security rules
   [1], 21 reliability rules [2]), CodeQL C# (44 queries in the default suite, 55 in security-extended [12]),
   and Semgrep CE (`p/csharp` = 27 rules, computed from the registry API [20]). **But none of the 94 CA
   security rules are on by default** [3][9]. You must set `AnalysisModeSecurity=All` [4].
2. **Dependency vulnerabilities:** use NuGetAudit warning codes NU1901–NU1904, which map directly to
   low/moderate/high/critical [26], and/or OSV `querybatch` with ecosystem `NuGet` [28][29] (tested live).
   Map CVSS scores to severity with the FIRST bins: 0.1–3.9 low, 4.0–6.9 medium, 7.0–8.9 high,
   9.0–10.0 critical [32][33].
3. **Secrets:** detect-secrets entropy limits are Base64 4.5 and Hex 3.0 [37]. gitleaks ships 222 rules, and
   its `generic-api-key` rule uses entropy 3.5 [38]. **Maths caveat (computed):** a uniformly random 20-character
   Base64 secret can *never* exceed 4.5 bits/char (its maximum is log2 20 = 4.32). Meanwhile every random 32-hex
   GUID exceeds 3.0. The MessagePack repo has 252 GUID-like strings.
4. **Accuracy is the weak point.** In the largest verified real-world study, 7 free Java SAST tools detected only
   **12.7 %** of real vulnerabilities, and **70.9 %** went undetected even with all 7 combined [41]. A single tool
   warned in the vulnerable functions for only **52 %** of vulnerability-contributing commits, and at least
   **76 %** of those warnings were irrelevant [42]. Precision *can* be high: SonarQube had 0.99 and another
   tool 0.94 on OpenMRS [43]. **"0 findings" is weak evidence of absence.** The negative likelihood ratio
   is about 0.48–0.87, so a 10 % prior risk only falls to about 5–9 % (computed, §6.3).
5. **Target-specific blind spot:** OSV lists 15 advisories for the `MessagePack` NuGet package [35]. The
   most frequent CWEs are 674 (uncontrolled recursion, 4×), 407 (algorithmic complexity, 3×) and 770
   (unbounded allocation, 3×). **No CodeQL C# query (default or extended) and no Semgrep `p/csharp` rule
   carries any of these CWE tags** [12][20]. The corpus snapshot (develop, `3.0-rc.1`, Mar 2025) falls inside
   the affected range of about 13 of these advisories according to OSV. That makes it a ready-made
   ground-truth set for measuring our own recall (§6.4).
6. **Scoring:** use a non-compensatory, Sonar-style worst-severity rating (A–E) [24] as a cap, combined
   with a saturating count penalty that uses Scorecard-style risk weights 10 / 7.5 / 5 / 2.5 [53]. Gate
   on **new** findings only (SARIF `baselineState = "new"` [56]). Return **incomplete** when a tool fails or
   reports `executionSuccessful = false` [56]. Count *new suppressions* as findings to stop agents from
   gaming the gate. Roslyn SARIF records `#pragma` and `SuppressMessage` suppressions [7].

---

## 1. Design principles for a deterministic security/reliability measurement

- **Determinism.** SAST tools are deterministic for a fixed tool version, rule set and input. Elder et al.
  state outright that "SAST tools are deterministic, producing the same alerts for each run" [43]. The
  non-deterministic inputs are **vulnerability databases**: OSV and GHSA change daily [26][28], and the
  Semgrep registry changes too. Pin everything and record a snapshot:
  - .NET SDK: MessagePack pins `8.0.402` in `global.json` (read from corpus).
  - Analyzer version: the SDK-bundled NetAnalyzers, or pin the `Microsoft.CodeAnalysis.NetAnalyzers` package [3].
  - Semgrep rules: download the YAML once and pin it by hash. For example, `p/csharp` downloaded 2026-11-14
    has SHA-256 `87622e79…a69965` (computed).
  - gitleaks config: SHA-256 `e163e53b…329caf` (computed).
  - OSV: store raw responses plus the `modified` timestamps they return [28].
- **Diff-awareness.** Sonar's built-in "Sonar way" quality gate is defined on *new code*: "No new issues
  are introduced", "All new Security Hotspots are reviewed", new-code coverage ≥ 80 %, and new-code
  duplication ≤ 3 % [25]. SARIF 2.1.0 has `result.baselineState ∈ {new, unchanged, updated, absent}`.
  Its stated purpose is "a measurement of how many new results were introduced in the run" [56].
- **Completeness is a first-class output.** In SARIF, a run with `executionSuccessful = false` or an
  error-level `toolExecutionNotification` means "the results cannot be assumed to be complete" [56].
  That is exactly the **incomplete** outcome.
- **Interchange.** SARIF 2.1.0 [56] carries the fields we need:
  - `level ∈ {none, note, warning, error}`
  - `kind ∈ {pass, open, review, informational, notApplicable, fail}` (`open` = the tool could not decide;
    `review` = a human must decide)

---

## 2. SECURITY — static analysis tools for C#

### 2.1 Roslyn / Microsoft.CodeAnalysis.NetAnalyzers (in the .NET SDK)

**Inventory.** The Security category has **94 rules** (counted from the docs source [1]):

- CA21xx/CA23xx (28): deserialization and data, for example CA2100 SQL review, CA2153 corrupted-state
  exceptions, and CA2300–CA2362.
- CA3xxx (16): injection and XML, for example CA3001 SQL injection, CA3003 path injection, CA3006 command
  injection, CA3075 insecure DTD, CA3077.
- CA5xxx (50): cryptography, TLS and config, for example CA5350 weak and CA5351 broken crypto algorithms,
  CA5359 certificate validation disabled, CA5394 insecure randomness, CA5390 hard-coded key, and
  CA5385 RSA key < 2048.

**Rules most relevant to a serializer library like MessagePack** (all from [1]):

| Rule(s) | What it flags |
|---|---|
| CA2300 / CA2301 / CA2302 | BinaryFormatter use / Deserialize without Binder / Binder possibly null |
| CA2305, CA2310–CA2312, CA2315 | LosFormatter, NetDataContractSerializer (with/without binder), ObjectStateFormatter |
| CA2321 / CA2322 | JavaScriptSerializer with SimpleTypeResolver |
| CA2326–CA2330 | Newtonsoft.Json `TypeNameHandling` ≠ None and insecure `JsonSerializerSettings` |
| CA2350–CA2362 | DataSet/DataTable in deserialized graphs (RCE risk) |
| CA5360, CA5362, CA5367 | dangerous methods in deserialization, reference cycles, pointer fields in serializable types |
| CA2153, CA5394 | corrupted-state exception handling, insecure randomness |

Microsoft's own position: "`BinaryFormatter` is insecure and can't be made secure". Starting in .NET 9 the
in-box implementation throws on use. SoapFormatter, LosFormatter, NetDataContractSerializer and
ObjectStateFormatter are listed as equally dangerous because they "perform unrestricted polymorphic
deserialization" [10]. CA2300's page says it is *not* enabled by default. The companion CA2301 page
warns that restricting types with a `SerializationBinder` cannot prevent all attacks [8].

**Caveat for MessagePack:** these rules target *BCL and Newtonsoft* serializers. None of them models
MessagePack's own `Typeless` API, which its README calls "similar to `BinaryFormatter`". Nor do they model
the `MessagePackSecurity.UntrustedData` mode. The README warns that the typeless disallow-list "is not and
cannot be exhaustive" and that UntrustedData "merely hardens against some common attacks" [36]. For this
target, a custom deterministic check is needed. For example, a Semgrep or Roslyn rule that flags new
`MessagePackSerializer.Typeless.*` / `TypelessContractlessStandardResolver` usage and deserialization calls
that pass no `.WithSecurity(MessagePackSecurity.UntrustedData)` options. That rule is our proposal, not an
existing one.

**Enablement (critical detail).** Only a small set of rules is enabled as warnings by default. For
.NET 8/9/10 that set contains **no Security-category rule**. The defaults are interoperability, performance,
reliability (CA2013, CA2014, CA2015, CA2017, CA2018, CA2021, plus CA2022 from .NET 9 and CA2023 from
.NET 10) and usage rules [3].

Per-rule docs confirm "Enabled by default in .NET 10: No" for CA2300, CA5394, CA2153, CA2000, CA2007,
CA2008 and CA1031 [9]. The relevant switches [3][4]:

- `AnalysisMode` ∈ {None, Default, Minimum, Recommended, All}. `All` enables all rules as build warnings,
  except some legacy and code-metrics rules [3].
- Category-specific: `<AnalysisModeSecurity>All</AnalysisModeSecurity>` and `<AnalysisModeReliability>All`.
  "If you omit this property for a particular category of rules, it defaults to the AnalysisMode value" [4].
- MessagePack already sets `AnalysisLevel=latest`, `EnforceCodeStyleInBuild=true` and StyleCop
  (read from corpus `Directory.Build.props` / `Directory.Packages.props`). So turning on
  `AnalysisMode=All` globally would flood the run with style and design noise. **Recommend category
  modes: Security=All and Reliability=All.**
- For .NET Standard / .NET Framework targets, analysis must be switched on with `EnableNETAnalyzers=true` [3].
  The core MessagePack project multi-targets `netstandard2.0;netstandard2.1;net8.0;net472` (read from corpus).

**SARIF emission** [5][7][57]:

```xml
<ErrorLog>$(MSBuildProjectDirectory)/../../sarif/$(MSBuildProjectName).$(TargetFramework).sarif,version=2.1</ErrorLog>
```

- Valid versions are "1", "2" and "2.1". **The default is "1"**, and "2" and "2.1" both mean SARIF 2.1.0 [5].
- The separator can be `,` or `;` [5]. On the command line it must be percent-encoded:
  `dotnet build -p:ErrorLog=log.json%2Cversion=2.1` [6].
- Command-line global properties are literal strings. In a multi-target build, one fixed file name will
  be overwritten per TFM. Inject a per-project/per-TFM path through an imported props/targets file
  (for example via MSBuild's `CustomAfterMicrosoftCommonTargets` hook) **[hook name unverified in this
  research]**.
- The Roslyn SARIF v2 logger writes `ruleId`, `level`, `message`, `locations` and rule
  `properties.category`. **It writes suppressed diagnostics too**, with `suppressions:[{kind:"inSource"}]`
  and `properties.suppressionType ∈ {"Pragma Directive", "SuppressMessageAttribute", "DiagnosticSuppressor"}` [7].
  That lets us count new suppressions (anti-gaming, §7.5).
- **It never emits `security-severity` or CWE tags** [7]. We must map CA rule IDs to severity ourselves (§7.1).

### 2.2 CodeQL for C#

- **Licence:** the CodeQL CLI terms allow analysis of an "Open Source Codebase" (OSI-approved licence).
  Database generation for automated analysis or CI/CD is allowed only for open-source code hosted on
  GitHub.com. Closed-source code needs a paid GitHub Advanced Security licence [16].
  MessagePack-CSharp is MIT-licensed (`PackageLicenseExpression` = MIT in corpus).
- **Suites:** `default` / `code-scanning` ("highly precise … few false positive"),
  `security-extended` (= default plus lower precision/severity queries) and `security-and-quality`
  (= extended plus maintainability/reliability queries) [13].
- **C# counts:** 44 queries in default and 55 in security-extended (11 extended-only) [12]. The default
  suite includes:
  - "Deserialization of untrusted data" (CWE-502) and "Deserialized delegate" (CWE-502)
  - "Unvalidated local pointer arithmetic" (CWE-119/120/122/788)
  - "Untrusted XML is read insecurely" (CWE-611/827/776)
  - ReDoS (CWE-1333/730/400)
  - Weak encryption / ECB / insufficient key size (CWE-327/326)
  - SQL, LDAP, XPath, command and path injection [12]

  The extended-only queries include "Serialization check bypass" (CWE-20) and thread-unsafe
  `ICryptoTransform` use (CWE-362) [12]. I could not verify the count for security-and-quality.
- **Commands** [14][15]:

  ```
  codeql database create db-cs --language=csharp --build-mode=none        # or --command='dotnet build /t:rebuild'
  codeql database analyze db-cs codeql/csharp-queries:codeql-suites/csharp-security-extended.qls \
         --format=sarif-latest --output=codeql.sarif [--download]
  ```

  For C#, `--build-mode` accepts `none` and `autobuild` (the default) [14]. `none` builds the database
  without compiling. A build-based database contains generated code, while a `none` database lacks it.
  GitHub does not quantify the accuracy difference [14]. **Use a traced build for the gate when it is
  feasible.**
- **Severity metadata:**
  - `@precision ∈ {low, medium, high, very-high}` "broadly indicates the proportion of query results that
    are true positives" [17].
  - `@problem.severity ∈ {error, warning, recommendation}` [17].
  - `@security-severity` (0.0–10.0) is computed by grouping "all CVEs reported by the CWEs assigned to the
    security query" and taking **the 75th percentile of their CVSS scores** [18]. It is mapped to:
    critical > 9.0, high 7.0–8.9, medium 4.0–6.9, low 0.1–3.9 [19].

  **This is a deterministic, published severity-derivation method we can reuse for Roslyn and Semgrep
  rules via their CWE mapping.**

### 2.3 Semgrep CE (open source)

- **Ruleset sizes (computed from the registry API, 2026-11-14)** [20]:

  | Ruleset | Total rules | C# rules |
  |---|---|---|
  | `p/csharp` | 27 | 27 |
  | `p/default` | 1,073 | 33 |
  | `p/security-audit` | 225 | **0** |

  So `p/security-audit` adds nothing for C#. The C# rulesets that Semgrep's docs list for CE are
  `p/default`, `p/csharp` and `p/gitlab` [21].
- **`p/csharp` content** [20]:
  - Rules: `csharp-sqli` (taint); insecure BinaryFormatter / SoapFormatter / NetDataContract /
    LosFormatter / FsPickler deserialization; ReDoS (with and without infinite timeout); XXE (3 rules);
    unsafe `Path.Combine`; stack-trace disclosure; JWT without expiry validation; LDAP and XPath
    injection; mass assignment; ECB mode; weak RNG for key generation; weak RSA padding; X509
    subject-name validation; and others.
  - Severities: 6 ERROR, 19 WARNING, 2 INFO. Confidence: 5 HIGH, 22 MEDIUM.
  - CWE tags: 502 (5×), 611 (3×), 327, 1333 (2× each), and single tags for 22, 89, 90, 94, 209, 295,
    338, 347, 548, 613, 643, 706, 780, 862, 915 (computed).
  - `p/default` additionally contains C# rules for SSRF, OS command injection, Newtonsoft, fastJSON and
    JavaScriptSerializer deserialization, `TypeFilterLevel.Full`, `MemoryMarshal.CreateSpan`, and others [20].
- **Analysis depth:** CE does "single-file, cross-function constant propagation" and "single-function
  taint analysis". Interfile and interprocedural analysis are Pro-only, and "many framework specific
  Pro rules will fail to return findings if run on Semgrep CE" [21].
- **Command** [22]:

  ```
  semgrep scan --config ./pinned/csharp.yml --metrics=off --sarif --sarif-output=semgrep.sarif \
               [--baseline-commit <base_sha>] [--error]
  ```

  Exit codes: 0 = ok, 1 = findings with `--error`, 2 = fatal [22]. Treat exit codes ≥ 2 as
  **incomplete**.

### 2.4 Other C# analyzers

- **Security Code Scan:** "Vulnerability Patterns Detector for C# and VB.NET". It does taint analysis
  with configurable sources and sinks, and has a standalone `security-scan` runner [23]. The repository
  page showed no archive notice. Release recency and SARIF support were not visible **[unverified]**.
- **SonarAnalyzer.CSharp / SonarQube C#:** rule counts by type (bug, vulnerability, hotspot) could not be
  retrieved, because rules.sonarsource.com now redirects to a marketing page **[unverified]**. Sonar's
  ratings are documented and reused in §7 [24].

### 2.5 Coverage against MessagePack's real vulnerability history (computed)

OSV returns 15 advisories for NuGet `MessagePack` [35]. Their CWE tags (from `database_specific.cwe_ids`):

| CWE | # advisories | Example |
|---|---|---|
| 674 Uncontrolled recursion | 4 | GHSA-vh6j-jc39-fggf "MessagePackReader.Skip can recurse without enforcing maximum object graph depth" (HIGH) |
| 407 Inefficient algorithmic complexity | 3 | GHSA-2x83-8g95-xh59 ExpandoObject quadratic insertion |
| 770 Allocation without limits | 3 | GHSA-cxmj-83gh-fp49 multi-dim array allocation from unchecked dimensions |
| 502 / 470 Unsafe deserialization / reflection | 2 / 2 | GHSA-qhmf-xw27-6rqr typeless restrictions don't recurse into arrays/generics |
| 1188, 409, 125, 190, 789, 328, 121, 20, 1325 | 1–2 each | LZ4 decompression issues, insecure default, hash collisions… |

Exact CWE-ID overlap between this history set (14 distinct CWEs) and the tools' rule tags (computed):

- **CodeQL C# default + extended:** {502, 20} = 2 of 14. The CWE-20 match is superficial: it is the
  "Serialization check bypass" query [12].
- **Semgrep `p/csharp`:** {502} = 1 of 14 [20].
- **NetAnalyzers:** no CWE tags, and no rule covers recursion depth or allocation size [1][2].

**Interpretation:** for a serializer, the dominant real vulnerability classes are resource exhaustion
(recursion depth, allocation size, hash flooding). Taint-style SAST does not model these. A "0 SAST
security findings" result on a MessagePack PR therefore says almost nothing about those classes.
**Recommendation:** add deterministic, purpose-built checks to the certifier, and label them as
heuristics:

- new recursive methods on reader paths that lack a depth counter
- `new T[n]` / `ArrayPool.Rent(n)` where `n` is read from the input stream with no upper-bound check
- new `Dictionary` construction that does not use the security-provided comparer

The corpus also uses `stackalloc` in 9 files (computed). CA2014 (stackalloc in loops) is a default-on
reliability rule [3].

---

## 3. SECURITY — dependency (SCA) vulnerabilities

### 3.1 NuGetAudit and `dotnet package list --vulnerable`

- NuGetAudit runs during `restore` (from .NET 8 SDK 8.0.100) [26]. Properties [26]:
  - `NuGetAudit` (default true)
  - `NuGetAuditLevel` (default low)
  - `NuGetAuditMode` ∈ {direct, all}. It defaults to `all` only for `net10.0+` targets and to `direct`
    otherwise. **Set `all`** to include transitive packages.
- **Warning codes give severity directly** [26]:

  | Code | Meaning |
  |---|---|
  | NU1901 | low |
  | NU1902 | moderate |
  | NU1903 | high |
  | NU1904 | critical |
  | NU1900 | error talking to the source → **incomplete** |
  | NU1905 | audit source provides no vulnerability DB → **incomplete** |

  The data source for nuget.org is the GitHub Advisory Database [26]. These NU codes land in the same
  SARIF error log as the analyzer results: an easy gate.
- Machine-readable list [27]:

  ```
  dotnet list package --vulnerable --include-transitive --format json      # .NET ≤ 9 syntax
  dotnet package list --vulnerable --include-transitive --format json      # .NET 10 syntax
  ```

  `--include-transitive` is not the default and "should be included" [26]. Microsoft's note on
  "No security vulnerabilities found": it only means none were known "at the present moment", because
  "the advisory database can be updated at any time" [26]. That is the dependency-side version of
  *absence of evidence*.
- `NuGetAuditSuppress` items silence individual advisories [26]. **A new suppression in a PR diff should
  count as a finding** (§7.5).

### 3.2 OSV.dev API and OSV-Scanner

- `POST https://api.osv.dev/v1/querybatch` with `{"queries":[{"package":{"name":…,"ecosystem":"NuGet"},"version":…}]}` [28].
  - It returns **only `id` and `modified`** per vulnerability. Details come from `GET /v1/vulns/{id}`
    (inferred from the API structure [28]).
  - Pagination kicks in above 1,000 vulns per query or 3,000 per batch [28].
  - The ecosystem string is exactly `NuGet` [29].
- **Live test (2026-11-14)** [35]:
  - MessagePack 2.1.80 → 14 advisories; 2.5.187 → 12; System.Text.Json 8.0.0 → 2.
  - Example result: `GHSA-vh6j-jc39-fggf` (CVE-2026-48506, HIGH, `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H`).
- **Severity in OSV** is a list of `{type: CVSS_V2|CVSS_V3|CVSS_V4|Ubuntu, score: <vector string>}` [29].
  It is a *vector*, not a number. To bin deterministically:
  1. Compute the base score with a CVSS library. RedHat's `cvss` package (v3.6) implements CVSS v2/v3/v4 [34].
  2. Bin with FIRST's qualitative scale. It is identical for v3.1 and v4.0: None 0.0, Low 0.1–3.9,
     Medium 4.0–6.9, High 7.0–8.9, Critical 9.0–10.0 [32][33].
  3. Fallback: GHSA records carry `database_specific.severity` (e.g. "MODERATE"). This is a
     database-specific field, not part of the OSV standard [29][35].
- The GitHub Advisory DB ties its four levels to CVSS and supports CVSS 3.1 and 4.0. It also carries
  EPSS scores, which are a separate exploit-likelihood measure. Unreviewed advisories do not raise
  Dependabot alerts [31].
- **OSV-Scanner** reads .NET `deps.json`, `packages.config` and `packages.lock.json`. The page does *not*
  list `.csproj` or `Directory.Packages.props` [30]. MessagePack uses Central Package Management
  (`Directory.Packages.props`, from corpus), so you either generate lock files
  (`RestorePackagesWithLockFile=true` **[unverified property name in this research]**) or use the
  `dotnet list package … --format json` output and call `querybatch` directly. **Recommend the latter**
  (pure Python, no extra binary).

### 3.3 How to gate dependency findings

- Attribute each advisory to the diff: did the PR add or upgrade the package so that it is now affected?
  Only those count as **new** (Sonar "new code" logic [25]; SARIF `baselineState` [56]).
- Blocking: any **new** advisory with CVSS base ≥ 7.0 (high/critical) [32][33]. Equivalently, any new
  NU1903/NU1904 [26].
- Record the DB snapshot (the `modified` timestamps [28]). Re-running later can change the verdict, so
  the certificate must say "as of <timestamp>".

---

## 4. SECURITY — secrets detection (math and precision)

### 4.1 The entropy heuristic

Shannon entropy per character of a string s with symbol frequencies pᵢ: **H(s) = −Σ pᵢ log₂ pᵢ**.
detect-secrets implements exactly this, summing `-p_x * math.log(p_x, 2)` over the charset [37].

- **detect-secrets defaults:** `Base64HighEntropyString(limit=4.5)` and `HexHighEntropyString(limit=3.0)` [37].
  For all-digit hex strings the score is reduced by `1.2 / log2(len)` to cut false positives from
  numbers [37]. Limits are configurable; the README shows `'limit': 5.0` [37].
- **gitleaks** default config [38] (computed from the file):
  - 222 `[[rules]]`.
  - Entropy values used: 2 (49 rules), 3 (53 rules), 3.5 (8 rules), 4 (14 rules), 4.5 (3 rules), others.
  - `generic-api-key` = keyword regex (access|auth|api|credential|creds|key|passw(or)d|secret|token…)
    **plus** entropy ≥ 3.5.
  - Supports a baseline (`--baseline-path`), `--report-format sarif`, and `gitleaks git --log-opts="A..B"`
    for commit ranges.
- **TruffleHog:** "over 800 secret types" in one section and "over 700 credential detectors" in another
  [39]. Detection is pattern-based, with optional `--filter-entropy`. Results are verified / unverified /
  unknown, and **verification calls live third-party APIs** [39]. For a deterministic, privacy-preserving
  gate use `--no-verification`. Verification is non-deterministic because the network and token state
  change, and it sends candidate secrets off-box.

### 4.2 What the thresholds mean mathematically (computed)

Empirical entropy is bounded: **H(s) ≤ log₂ min(n, |Σ|)** for length n and alphabet Σ. Monte-Carlo with
20,000 uniformly random strings per row (seed 42):

| Alphabet / threshold | n | mean H | P(H > threshold) |
|---|---|---|---|
| Base64 (64) / 4.5 | 16 | 3.78 | 0.000 (max 4.00) |
| Base64 / 4.5 | 20 | 4.04 | 0.000 (max 4.32) |
| Base64 / 4.5 | 24 | 4.25 | 0.054 |
| Base64 / 4.5 | 32 | 4.56 | 0.659 |
| Base64 / 4.5 | 40 | 4.78 | 0.981 |
| Hex (16) / 3.0 | 8 | 2.59 | 0.000 (max = 3.0, strict >) |
| Hex / 3.0 | 12 | 2.98 | 0.545 |
| Hex / 3.0 | 16 | 3.21 | 0.832 |
| Hex / 3.0 | 32 | 3.61 | 1.000 |
| GUIDv4 32-hex | 32 | 3.61 | **1.000** |

Consequences:

1. **Recall hole for short secrets.** A truly random Base64 token of ≤ 22 chars can never trip 4.5,
   because 2^4.5 ≈ 22.6.
2. **Systematic false positives in .NET repos.** Every random GUID trips the hex detector. Project GUIDs
   in `.sln`/`.csproj` and test IDs are everywhere: there are 252 GUID-like strings in the MessagePack
   corpus (computed).
3. **Long identifiers are close to threshold.** C# identifiers such as `DynamicObjectResolver` score
   4.07 bits/char (computed). This is why gitleaks pairs entropy with keyword context.

The corpus also intentionally commits `opensource.snk`, a strong-name key file. It is public by design
for OSS, but key-file rules may flag it. Allow-list it explicitly in config and document why.

### 4.3 Empirical accuracy of secret scanners

Basak et al. (ESEM 2023) evaluated 9 tools (5 open-source, 4 proprietary) on a benchmark [40]:

- **Best precision:** GitHub Secret Scanner 75 %, Gitleaks 46 %, Commercial X 25 %.
- **Best recall:** Gitleaks 88 %, SpectralOps 67 %, TruffleHog 52 %.

So even the best tool has either about a 25 % false-discovery rate or about 12 % misses.

**Gate recommendation:**

- **block** on hits from provider-specific regex rules (high precision)
- **review**, not block, on entropy-only or `generic-api-key` hits (SARIF `kind:"review"` [56])
- **block** on any new allow-list or baseline entry added in the PR

---

## 5. RELIABILITY for C#

### 5.1 Compiler nullable analysis

- With `<Nullable>enable</Nullable>` (9 MessagePack projects enable it, from corpus), the compiler emits
  CS86xx warnings [11]:
  - CS8600 converting null to non-nullable
  - CS8602 dereference of a possibly null reference
  - CS8603 possible null return
  - CS8604 possible null argument
  - CS8618 non-nullable member uninitialized on constructor exit
  - CS8625 null literal to non-nullable
  - CS8655 non-exhaustive switch on null, and others
- `<WarningsAsErrors>nullable</WarningsAsErrors>` turns all nullability warnings into errors [5].
- **Soundness caveat:** Microsoft acknowledges false positives (for example, a private helper null-check
  the compiler cannot see). The analysis "can't always deduce" method ordering or exception paths, and
  the `!` operator force-suppresses [11]. So it is neither sound nor complete.
- **Metric:** new CS86xx warnings, plus new `!` (null-forgiving) usages in the diff. The latter is our
  anti-gaming proposal.

### 5.2 CA Reliability category and exception/disposal rules

**The Reliability category (21 rules)** [2]:

- CA2000 dispose before losing scope
- CA2002 lock on weak identity
- CA2007 do not directly await a Task (ConfigureAwait)
- CA2008 TaskScheduler
- CA2009
- CA2011 property assigned in its own setter
- CA2012 ValueTask misuse
- CA2013 ReferenceEquals on value types
- CA2014 stackalloc in loops
- CA2015
- CA2016 forward CancellationToken
- CA2017 logging parameter-count mismatch
- CA2018 BlockCopy count
- CA2019
- CA2020
- CA2021 Cast/OfType incompatible types
- CA2022 inexact Stream.Read
- CA2023
- CA2024
- CA2025 IDisposable passed into un-awaited tasks
- CA2026

**Microsoft's default-on (warning) subset** is CA2013, CA2014, CA2015, CA2017, CA2018, CA2021, plus
CA2022 (.NET 9) and CA2023 (.NET 10) [3]. Microsoft enables these for everyone, so they are a principled,
non-arbitrary candidate set for "**blocker/high**" reliability findings.

**Exception-handling anti-patterns** live in other categories [9]:

| Rule | Category | Default |
|---|---|---|
| CA1031 catch general exception | Design | off |
| CA2200 rethrow to preserve stack | Usage | **warning** |
| CA2201 reserved exception types | Usage | off |
| CA1065 exceptions in unexpected locations | Design | off |
| CA2219 raise in exception clause | Usage | suggestion |

**Disposal rules** [9]:

| Rule | Category | Default |
|---|---|---|
| CA2000 | Reliability | off |
| CA1001 | Design | off |
| CA1063 | Design | off |
| CA2213 | Usage | off |
| CA2215 | Usage | off |

CA2000 works on a single method at a time. Expect false positives on ownership-transfer patterns
**[not quantified in sources I could verify]**.

CA2007 (ConfigureAwait) is library-appropriate, and MessagePack is a library. It is high-volume, so
weight it as low/minor.

### 5.3 ISO/IEC 5055 (CISQ) Reliability and Security measures

- ISO/IEC 5055 measures Security, Reliability, Performance Efficiency and Maintainability using CWE-based
  weakness counts. These "may then be transformed into comparative measures such as the density of
  weaknesses or the sigma level" [52].
- **CWE-1306** "CISQ Quality Measures – Reliability" has 34 member CWEs [50], including:
  - 252 unchecked return value
  - 390 error detected without action
  - 404 improper resource shutdown
  - 476 null dereference
  - 662 improper synchronization
  - 665 improper initialization
  - 672 use after release
  - 681/682 numeric conversion and calculation
  - 703 improper exception handling
  - 704 incorrect cast
  - 835 infinite loop
  - 908 uninitialized resource
  - 1066/1070 serialization control
  - 1088 synchronous remote access without timeout
  - and others
- **CWE-1308** "CISQ Quality Measures – Security" has 34 members [51], including:
  - 22, 77, 79, 89, 90, 91, 99 (injection family)
  - 129 array index validation
  - 134 format string
  - **502 deserialization**
  - 606 unchecked loop condition
  - 611 XXE
  - 643 XPath
  - 732 permissions
  - 778 insufficient logging
  - **789 memory allocation with excessive size**
  - 798 hard-coded credentials
  - 835 infinite loop
  - and others

  (The ISO measure counts parent and child CWEs. I could not retrieve CISQ's full PDF list **[unverified]**.)
- **Practical C# mapping (proposal):**

  | CWE | Mapped C# tool signals |
  |---|---|
  | 476 | CS8602/CS8603/CS8604 |
  | 404 / 772 | CA2000 / CA1001 / CA2213 |
  | 703 / 390 | CA1031, CA2200, empty catch blocks (custom) |
  | 662 | CA2002 |
  | 681 / 682 / 190 | CA2020, checked-arithmetic heuristics |
  | 252 | CA1806 **[category unverified]** / CA2022 |
  | 835 | CA2011 (self-recursive setter) |
  | 502 | CA23xx / CodeQL / Semgrep |
  | 611 | CA3075 / CA3077 / CodeQL / Semgrep |
  | 789 / 770 | custom rule (§2.5) |

### 5.4 SonarQube reliability and security ratings (formulas)

From Sonar's metric definitions [24]. The scale is driven by the **worst** open issue:

| Rating | Standard Experience (`reliability_rating`) | MQR mode (`software_quality_reliability_rating`) |
|---|---|---|
| A | 0 bugs | "0 or more info issues" |
| B | ≥ 1 minor bug | "at least one low issue" |
| C | ≥ 1 major bug | "at least one medium issue" |
| D | ≥ 1 critical bug | "at least one high issue" |
| E | ≥ 1 blocker bug | "at least one blocker issue" |

- The **security rating** is identical, using vulnerabilities instead of bugs [24].
- **Security review rating** (share of hotspots reviewed): A ≥ 80 %, B 70–80 %, C 50–70 %, D 30–50 %,
  E < 30 %. Hotspots are now deprecated [24].
- The maintainability rating uses the technical-debt ratio (A ≤ 5 %, B 5–10 %, C 10–20 %, D 20–50 %,
  E ≥ 50 %) [24]. That is out of scope here.
- Property: these ratings are **non-compensatory and count-insensitive**. One blocker gives E whatever
  the code size, and 1,000 minors still give B.

### 5.5 Empirical validity of "bug" rules as reliability predictors

- Lenarduzzi, Lomio, Huttunen, Taibi (SANER 2020) studied 21 projects and 202 SonarQube Java rules.
  Violations SonarQube classifies as "bugs" were generally *not* fault-prone, and SonarQube's
  fault-prediction power was "extremely low" [48].
- Lomio, Moreschini, Lenarduzzi (2021 preprint) studied 33 Java projects with 77,932 commits (40,890
  fault-inducing). Only 14 of 174 violated rules had importance > 1 %, and together they accounted for
  30 % of fault-proneness importance. The other 165 were negligible [49].
- **Implication:** rule-count reliability scores have weak *predictive* validity for faults. Weight
  compiler errors, nullable warnings and Microsoft's default-on correctness rules (which flag definite
  misuse) above style-like rules. Pair this with the Tests dimension, which another workstream covers.

---

## 6. How much can "0 vulnerabilities" be trusted? Empirical accuracy

### 6.1 Studies with numbers

| Study | Setting | Key numbers |
|---|---|---|
| Li et al., ESEC/FSE 2023 [41] | 7 free/OSS Java SAST tools (from 161 candidates); synthetic + real-world benchmarks | "only **12.7 %** of real-world vulnerabilities can be detected"; combining all tools, **70.9 %** remain undetected |
| Charoenwet et al., ISSTA 2024 [42] | C/C++; 319 real vulns, 815 vuln-contributing commits (VCCs), 92 projects | a single SAST tool warned in vulnerable functions for **52 %** of VCCs; **≥ 76 %** of warnings in vulnerable functions irrelevant to the VCC; 22 % of VCCs missed due to rule limitations; ranking by SAST warnings improved precision by 12 % and recall by 5.6 % |
| Elder et al., arXiv 2022 (EMSE preprint) [43] | OpenMRS (3,985,596 LOC Java); SMPT/EMPT/DAST/SAST | SAST found the most vulns (823); precision SonarQube 0.99 (4 FP / 698 alerts), SAST-2 0.94 (16 FP / 264); **but of 185 vulns found by exploratory pen-testing, 157 were found by no other technique**; "EMPT found more severe vulnerabilities" |
| Esposito, Falaschi, Falessi, arXiv 2024 [44] | Synthetic Java; 1.5 M test executions | SAST tools show "high precision but low recall"; narrow vulnerability-type coverage |
| Basak et al., ESEM 2023 [40] | 9 secret scanners | best precision 75 %; best recall 88 % |
| Johnson et al., ICSE 2013 [45] | 20 developer interviews | all found the tools beneficial, but "false positives and the way in which the warnings are presented" are barriers to use |
| Ami et al., IEEE S&P 2024 [46] | 20 practitioner interviews | 17 findings on SAST perceptions. The title quote: "False negative – that one is going to kill you" |
| Kang, Aw, Lo, ICSE 2022 [47] | Actionable-warning ML | earlier high scores were inflated by data leakage and duplication; the techniques' performance was "overoptimistic" |

**C#-specific evidence:** NIST SARD hosts *Juliet C# 1.3* (NSA Center for Assured Software, 28,942 test
cases, 105 CWEs, Aug 2020) and a "C# Vulnerability Test Suite" (32,003 cases) [55]. I found **no
peer-reviewed precision/recall study of C# SAST tools on these suites or on real C# CVEs** within the
budget **[gap]**. OWASP Benchmark covers Java and Python only [54].

Juliet-style results are synthetic. Li et al. explicitly report that good synthetic-benchmark performance
did not carry over to real-world vulnerabilities [41].

### 6.2 Reading the numbers honestly

- **Precision** of curated rules can be high. In Elder et al. it was 0.94–0.99 [43], and CodeQL's default
  suite is designed for "few false positive" results [13]. A *positive* high-severity finding from a
  high-precision rule is therefore reasonable grounds to **block**.
- **Recall** is low and varies by class: about 13 % to 52 % on real vulnerabilities [41][42], and roughly
  0 % structurally for classes no rule models, such as MessagePack's recursion and allocation DoS (§2.5).
  So a **"pass"** must be worded as "no known-pattern findings", never "secure".

### 6.3 Bayesian view of a zero-finding result (computed)

Let r = recall (sensitivity) and sp = specificity on clean code. The negative likelihood ratio is
**LR⁻ = (1 − r) / sp**. Taking sp ≈ 1 is the optimistic case. Posterior odds = prior odds × LR⁻.

| Recall source | LR⁻ | prior 5 % → | prior 10 % → | prior 30 % → |
|---|---|---|---|---|
| r = 0.127 (Li et al. [41]) | 0.873 | 4.4 % | 8.8 % | 27.2 % |
| r = 0.291 (Li et al., all tools combined [41]) | 0.709 | 3.6 % | 7.3 % | 23.3 % |
| r = 0.52 (Charoenwet et al., one tool [42]) | 0.480 | 2.5 % | 5.1 % | 17.1 % |

A clean SAST run reduces the odds that a vulnerability is present by only about 13–52 %. The certificate
should print this: "Security evidence: absence of findings from tools {…} covering CWE set {…}; expected
recall on real-world vulnerabilities 13–52 % [41][42]."

### 6.4 Measuring our own recall on the target (recommended experiment)

According to OSV's affected ranges, about 13 of the 15 MessagePack advisories affect versions `3.0` up
to `3.1.7`/`3.1.9` [35]. The corpus `develop` snapshot is `3.0-rc.1` (commit `32258fdb`, 2025-03-01). So
it very likely contains the vulnerable code for most of them. Whether each vulnerable code path is
present at that commit still needs checking **[unverified]**.

Run the full pipeline on this snapshot and count how many of these advisories produce a finding at the
right file or function. That gives an **empirical, target-specific recall** to report next to the
literature figures, and it can be demonstrated live.

---

## 7. From findings to a 0–100 score and a gate (formulas)

Everything in this section is a **design proposal** built from the referenced components. Parameter values
are tunable and are **not** empirical constants.

### 7.1 Severity normalisation (deterministic)

Map every finding to s ∈ {critical, high, medium, low, info}:

| Source | Rule |
|---|---|
| CodeQL | `security-severity` → GitHub bins (> 9.0 critical; 7.0–8.9 high; 4.0–6.9 medium; 0.1–3.9 low) [19]; non-security queries: `problem.severity` error → high, warning → medium, recommendation → low |
| Dependencies | CVSS base score computed from the OSV vector [29][34] → FIRST bins [32][33]; fallback GHSA label (CRITICAL/HIGH/MODERATE/LOW) [35]; NU1904/1903/1902/1901 → critical/high/medium/low [26] |
| Semgrep | prefer the CWE-based method below; otherwise ERROR → high, WARNING → medium, INFO → low (our mapping; Semgrep severities from [20]) |
| Roslyn CA | curated table keyed by rule ID → CWE → severity via **the same 75th-percentile-of-CVSS-per-CWE method GitHub uses for CodeQL** [18]; pin the resulting table in the repo. Reliability: Microsoft default-on correctness rules [3] → high ("blocker"); other Reliability/Usage rules → medium; CA2007 → low |
| Secrets | provider-specific regex hit → critical; generic/entropy-only → `review` (no score impact until confirmed) |
| Compiler | any build error → run is **incomplete** (no analysis possible), not "fail" |

Deduplicate across tools using the key (CWE or rule family, file, line ± 2), keeping the max severity.
Build fingerprints like GitHub's `primaryLocationLineHash` (rule ID + hash of the normalised source line),
because Roslyn SARIF has no `partialFingerprints` [7][19]. Then assign `baselineState` [56].

### 7.2 Gate (three outcomes)

```
INCOMPLETE if any mandatory tool: exit code indicates fatal error (Semgrep ≥2 [22]);
           SARIF run has executionSuccessful=false or an error-level toolExecutionNotification [56];
           build failed for any TFM; NU1900/NU1905 (no vulnerability data) [26];
           OSV unreachable.
FAIL       if  N_new[critical] + N_new[high] > 0           (security: code + deps + confirmed secrets)
           or  N_new_blocker_bugs > 0                       (reliability: default-on correctness rules [3])
           or  new suppressions of any of the above (pragma / SuppressMessage / NoWarn /
               NuGetAuditSuppress / secrets allow-list)     [7][26]
           or  weighted score < threshold (set by the team)
PASS       otherwise. Always report the evidence-strength caveat (§6.3).
```

### 7.3 Security sub-score S_sec ∈ [0, 100]

Use **non-compensatory components** (weakest link). A leaked key is not offset by clean SAST:

```
S_sec = min( S_code, S_deps, S_secrets )

S_x   = min( Cap(worst_new_severity_x),  100 · exp( − Σ_s w_s · N_new,s,x / τ ) )
```

- **Cap(·)** follows the Sonar rating idea [24]: A (none or info) → 100, B (low) → 85, C (medium) → 70,
  D (high) → 40, E (critical) → 20. The numbers are tunable. Under §7.2, D and E already cause FAIL, but
  the score still feeds the dashboard.
- **Weights** w = {critical 10, high 7.5, medium 5, low 2.5, info 0} reuse OpenSSF Scorecard's risk weights
  [53], which are published, round and monotone.
  - An alternative is CVSS bin midpoints (9.5 / 8.0 / 5.45 / 2.0) from [32].
  - Scorecard's own Vulnerabilities check uses **score = max(0, 10 − #vulns)** (from its source) [53].
    That is a linear version of the same idea.
- **τ (saturation constant)** is set once by calibration. For example, run the pipeline on upstream
  `master` and choose τ so the baseline's *existing* findings map to the score the team considers
  "acceptable legacy". Or set τ = 20, so one new medium (w = 5) gives 100·e^(−0.25) ≈ 78 and four new
  mediums give ≈ 37.
- **Why exponential rather than linear:** it is bounded, never negative, and has diminishing marginal
  penalty, so a flood of the same rule does not dominate. **Why min with the cap:** the cap enforces the
  worst-issue logic. Averages can hide one severe issue, which is the main critique of compensatory
  quality indices.
- **Density option (ISO 5055 style [52]):** for whole-repo certification rather than PRs, replace the
  count by weighted density D = Σ w_s N_s / KLOC. Use 100·exp(−D/D₀), with D₀ = the baseline repo's
  density. PR diffs are often under 0.5 KLOC, where density is unstable, so **use counts for PRs and
  density for repo snapshots**.

### 7.4 Reliability sub-score S_rel ∈ [0, 100]

```
S_rel = min( Cap(worst_new_bug_severity),
             100 · exp( − ( Σ_s w_s · N_new,s  +  w_null · N_new_CS86xx  +  w_bang · N_new_nullforgiving ) / τ_rel ) )
```

- Blocker/high are Microsoft's default-on correctness rules [3] (CA2011 can be added: a self-assigning
  setter is infinite recursion [2]).
- Medium: other Reliability-category and exception/disposal rules [2][9].
- w_null (for example 2.5) and w_bang (for example 1) are low weights that reflect the documented false
  positives of nullable analysis [11] and the weak fault-predictive validity of rule counts [48][49].

### 7.5 Anti-gaming (important for agent-written PRs)

Agents optimising for a green build tend to suppress rather than fix. Treat all of the following as
findings at the severity of the suppressed rule:

- new `#pragma warning disable`, `[SuppressMessage]` or `DiagnosticSuppressor` (all visible in Roslyn
  SARIF v2 `suppressions[]` with `suppressionType` [7])
- new `<NoWarn>` entries [5]
- `.editorconfig` severity downgrades
- new `NuGetAuditSuppress` items [26]
- new gitleaks/detect-secrets baseline or allow-list entries [38][37]
- new `null!` / `!` operators [11]

The corpus already contains 140 `#pragma warning disable` lines under `src/` (computed). So only the
**delta** is meaningful.

### 7.6 Evidence-strength annotation (non-scored, always printed)

```
coverage_cwe = |CWE(tools) ∩ CWE(relevant set)| / |CWE(relevant set)|
```

Here *relevant set* is CWE-1306 ∪ CWE-1308 [50][51] ∪ the target's historical advisory CWEs [35]. For
MessagePack, exact-ID overlap with its advisory CWEs is 2/14 for CodeQL and 1/14 for Semgrep `p/csharp`
(§2.5, computed). Report this next to the literature recall (13–52 % [41][42]), so a "pass" carries its
uncertainty explicitly.

---

## 8. Command cookbook for MessagePack-CSharp

```bash
# 0) Toolchain pinned by repo: .NET SDK 8.0.402 (global.json). Record versions of every tool.

# 1) Roslyn security + reliability analyzers -> SARIF 2.1.0 per project/TFM
#    (inject via an imported .props/.targets so $(MSBuildProjectName)/$(TargetFramework) expand per project)
#    <EnableNETAnalyzers>true</EnableNETAnalyzers>
#    <AnalysisModeSecurity>All</AnalysisModeSecurity>
#    <AnalysisModeReliability>All</AnalysisModeReliability>
#    <ErrorLog>$(SarifDir)/$(MSBuildProjectName).$(TargetFramework).sarif,version=2.1</ErrorLog>
#    <NuGetAuditMode>all</NuGetAuditMode>
dotnet build MessagePack.sln -c Release -p:NuGetAuditMode=all    # NU190x land in the same SARIF

# 2) Dependency list -> OSV querybatch (pure Python)
dotnet list MessagePack.sln package --vulnerable --include-transitive --format json > deps-vuln.json
dotnet list MessagePack.sln package --include-transitive --format json > deps-all.json
#   POST https://api.osv.dev/v1/querybatch {"queries":[{"package":{"name":N,"ecosystem":"NuGet"},"version":V},...]}
#   then GET /v1/vulns/{id}; compute CVSS base with `cvss` (CVSS3/CVSS4); bin per FIRST.

# 3) CodeQL (MIT-licensed OSS repo; see licence terms)
codeql database create db-cs --language=csharp --command='dotnet build MessagePack.sln /t:rebuild'
codeql database analyze db-cs codeql/csharp-queries:codeql-suites/csharp-security-extended.qls \
       --format=sarif-latest --output=codeql.sarif

# 4) Semgrep CE with pinned rules
semgrep scan --config ./pinned/semgrep-csharp.yml --config ./pinned/semgrep-default-csharp.yml \
       --metrics=off --sarif --sarif-output=semgrep.sarif --baseline-commit "$BASE_SHA"

# 5) Secrets on the PR commit range only, offline
gitleaks git --log-opts="$BASE_SHA..$HEAD_SHA" --report-format sarif --report-path gitleaks.sarif .
trufflehog git file://. --since-commit "$BASE_SHA" --no-verification --json > trufflehog.json   # optional
```

Then merge the SARIF runs, fingerprint, diff against the base commit's runs, set `baselineState`, apply
§7.1–7.5, and emit one SARIF 2.1.0 log plus the certificate.

---

## 9. Open items / unverified

- I could not find "Lenarduzzi et al. 2023 'Does code quality matter?'". The closest verified works are
  [48] (SANER 2020) and [49] (2021 preprint).
- "Elder et al. 2024": I could only verify the 2022 arXiv preprint [43]. Its manuscript header indicates a
  journal submission. The final venue and year are **[unverified]**.
- I could not retrieve:
  - SonarC# rule counts by type
  - Security Code Scan maintenance status and SARIF support
  - the CodeQL C# `security-and-quality` query count
  - CISQ's full parent+child CWE list for ISO 5055
- The MSBuild property names `CustomAfterMicrosoftCommonTargets` (for injecting ErrorLog per project)
  and `RestorePackagesWithLockFile` are well-known, but I did not re-verify them in this session.
- Sadowski et al. (Google, CACM 2018) and Tricorder (ICSE 2015) are often cited for an "effective false
  positive < 10 %" target. I could not verify that figure from accessible pages **[unverified]**.
- No peer-reviewed C# SAST precision/recall study was found (Juliet C# 1.3 exists [55]). §6.4 proposes
  measuring recall on the target ourselves.

---

## References

1. Microsoft Learn — Security rules (code analysis). https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/security-warnings ; source: https://github.com/dotnet/docs/blob/main/docs/fundamentals/code-analysis/quality-rules/security-warnings.md
2. Microsoft Learn — Reliability rules (code analysis). https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/reliability-warnings
3. Microsoft Learn — Code analysis in .NET (enabled rules per version, AnalysisMode, EnableNETAnalyzers). https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/overview
4. Microsoft Learn — MSBuild properties, `AnalysisMode<Category>`. https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props (source: https://github.com/dotnet/docs/blob/main/docs/core/project-sdk/msbuild-props.md)
5. Microsoft Learn — C# compiler options: errors and warnings (ErrorLog, WarningsAsErrors nullable). https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/errors-warnings
6. dotnet/docs issue #27872 — percent-encoding ErrorLog version on command line. https://github.com/dotnet/docs/issues/27872
7. Roslyn source — SarifV2ErrorLogger.cs. https://source.dot.net/Microsoft.CodeAnalysis/CommandLine/SarifV2ErrorLogger.cs.html
8. Microsoft Learn — CA2300 and CA2301. https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2300 ; https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2301
9. dotnet/docs — individual rule pages (category / "Enabled by default in .NET 10"), e.g. ca1031.md, ca2000.md, ca2007.md, ca2200.md, ca5394.md. https://github.com/dotnet/docs/tree/main/docs/fundamentals/code-analysis/quality-rules
10. Microsoft Learn — Deserialization risks in use of BinaryFormatter and related types. https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-security-guide
11. Microsoft Learn — Nullable reference type warnings. https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/nullable-warnings
12. GitHub Docs — CodeQL C# built-in queries. https://docs.github.com/en/code-security/reference/code-scanning/codeql/codeql-queries/csharp-built-in-queries
13. GitHub Docs — CodeQL query suites. https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-query-suites
14. GitHub Docs — Preparing your code for CodeQL analysis (build modes). https://docs.github.com/en/code-security/codeql-cli/getting-started-with-the-codeql-cli/preparing-your-code-for-codeql-analysis
15. GitHub Docs — Analyzing your code with CodeQL queries. https://docs.github.com/en/code-security/codeql-cli/getting-started-with-the-codeql-cli/analyzing-your-code-with-codeql-queries
16. GitHub CodeQL CLI licence (Terms and Conditions). https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md ; see also https://docs.github.com/en/code-security/concepts/code-scanning/codeql/about-the-codeql-cli
17. CodeQL query metadata style guide. https://github.com/github/codeql/blob/main/docs/query-metadata-style-guide.md
18. GitHub Changelog (2021-07-19) — CodeQL code scanning: new severity levels for security alerts. https://github.blog/changelog/2021-07-19-codeql-code-scanning-new-severity-levels-for-security-alerts/
19. GitHub Docs — SARIF support for code scanning. https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
20. Semgrep Registry API (downloaded 2026-11-14): https://semgrep.dev/api/registry/rulesets/csharp , …/rulesets/default , …/rulesets/security-audit
21. Semgrep Docs — C# support. https://docs.semgrep.dev/languages/csharp
22. Semgrep Docs — CLI reference. https://docs.semgrep.dev/cli-reference
23. Security Code Scan repository. https://github.com/security-code-scan/security-code-scan
24. SonarQube Server docs — Metric definitions. https://docs.sonarsource.com/sonarqube-server/latest/user-guide/code-metrics/metrics-definition/
25. SonarQube Server docs — Introduction to quality gates. https://docs.sonarsource.com/sonarqube-server/latest/quality-standards-administration/managing-quality-gates/introduction-to-quality-gates/
26. Microsoft Learn — Auditing package dependencies for security vulnerabilities (NuGetAudit). https://learn.microsoft.com/en-us/nuget/concepts/auditing-packages
27. Microsoft Learn — dotnet package list / dotnet list package. https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-package-list
28. OSV.dev API — POST /v1/querybatch. https://google.github.io/osv.dev/post-v1-querybatch/
29. OSV Schema. https://ossf.github.io/osv-schema/
30. OSV-Scanner — Supported languages and lockfiles. https://google.github.io/osv-scanner/supported-languages-and-lockfiles/
31. GitHub Docs — About the GitHub Advisory database. https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database
32. FIRST — CVSS v3.1 Specification Document (Table 14, qualitative severity). https://www.first.org/cvss/v3.1/specification-document
33. FIRST — CVSS v4.0 Specification Document (Table 22). https://www.first.org/cvss/v4.0/specification-document
34. RedHatProductSecurity/cvss (PyPI `cvss` 3.6, CVSS2/3/4). https://github.com/RedHatProductSecurity/cvss
35. OSV API live queries, 2026-11-14: `POST https://api.osv.dev/v1/query {"package":{"name":"MessagePack","ecosystem":"NuGet"}}` and `/v1/querybatch` (MessagePack 2.1.80, 2.5.187; System.Text.Json 8.0.0). Advisory pages e.g. https://osv.dev/vulnerability/GHSA-vh6j-jc39-fggf
36. MessagePack-CSharp README — Security / Typeless sections. https://github.com/MessagePack-CSharp/MessagePack-CSharp/blob/master/README.md#security
37. Yelp detect-secrets — `high_entropy_strings.py` and README. https://github.com/Yelp/detect-secrets/blob/master/detect_secrets/plugins/high_entropy_strings.py
38. gitleaks — default `config/gitleaks.toml` and README. https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
39. TruffleHog README. https://github.com/trufflesecurity/trufflehog
40. S. K. Basak, J. Cox, B. Reaves, L. Williams, "A Comparative Study of Software Secrets Reporting by Secret Detection Tools", ESEM 2023. arXiv:2307.00714. https://arxiv.org/abs/2307.00714
41. K. Li, S. Chen, L. Fan, R. Feng, H. Liu, C. Liu, Y. Liu, Y. Chen, "Comparison and Evaluation on Static Application Security Testing (SAST) Tools for Java", ESEC/FSE 2023, pp. 921–933. DOI 10.1145/3611643.3616262 (abstract via https://researchportal.scu.edu.au/esploro/outputs/conferenceProceeding/Comparison-and-Evaluation-on-Static-Application/991013214783302368)
42. W. Charoenwet, P. Thongtanunam, V.-T. Pham, C. Treude, "An Empirical Study of Static Analysis Tools for Secure Code Review", ISSTA 2024. arXiv:2407.12241. https://arxiv.org/abs/2407.12241
43. S. Elder, N. Zahan, R. Shu, M. Metro, V. Kozarev, T. Menzies, L. Williams, "Do I really need all this work to find vulnerabilities? An empirical case study comparing vulnerability detection techniques on a Java application", arXiv:2208.01595 (2022). https://arxiv.org/abs/2208.01595
44. M. Esposito, V. Falaschi, D. Falessi, "An Extensive Comparison of Static Application Security Testing Tools", arXiv:2403.09219 (2024). https://arxiv.org/abs/2403.09219
45. B. Johnson, Y. Song, E. Murphy-Hill, R. Bowdidge, "Why Don't Software Developers Use Static Analysis Tools to Find Bugs?", ICSE 2013, pp. 672–681. DOI 10.1109/ICSE.2013.6606613. https://research.google/pubs/why-dont-software-developers-use-static-analysis-tools-to-find-bugs/
46. A. S. Ami, K. Moran, D. Poshyvanyk, A. Nadkarni, "'False negative – that one is going to kill you': Understanding Industry Perspectives of Static Analysis based Security Testing", IEEE S&P 2024. arXiv:2307.16325. https://arxiv.org/abs/2307.16325
47. H. J. Kang, K. L. Aw, D. Lo, "Detecting False Alarms from Automatic Static Analysis Tools: How Far are We?", ICSE 2022. arXiv:2202.05982. https://arxiv.org/abs/2202.05982
48. V. Lenarduzzi, F. Lomio, H. Huttunen, D. Taibi, "Are SonarQube Rules Inducing Bugs?", SANER 2020. arXiv:1907.00376. https://arxiv.org/abs/1907.00376
49. F. Lomio, S. Moreschini, V. Lenarduzzi, "Fault Prediction based on Software Metrics and SonarQube Rules. Machine or Deep Learning?", arXiv:2103.11321 (2021). https://arxiv.org/abs/2103.11321
50. MITRE CWE-1306 — CISQ Quality Measures – Reliability. https://cwe.mitre.org/data/definitions/1306.html
51. MITRE CWE-1308 — CISQ Quality Measures – Security. https://cwe.mitre.org/data/definitions/1308.html
52. CISQ — Code Quality Standards (ISO/IEC 5055). https://www.it-cisq.org/standards/code-quality-standards/
53. OpenSSF Scorecard — README "Aggregate Score" (risk weights 10/7.5/5/2.5) and `checks/evaluation/vulnerabilities.go` (score = 10 − #vulns, min 0). https://github.com/ossf/scorecard ; https://github.com/ossf/scorecard/blob/main/checks/evaluation/vulnerabilities.go
54. OWASP Benchmark project (Java and Python test suites; Youden-index scoring). https://owasp.org/www-project-benchmark/
55. NIST SARD — Test suites (Juliet C# 1.3, ID 110: 28,942 cases, 105 CWEs; C# Vulnerability Test Suite, ID 105: 32,003 cases). https://samate.nist.gov/SARD/test-suites ; https://samate.nist.gov/SARD/test-suites/110
56. OASIS — SARIF v2.1.0 (§3.20.14 executionSuccessful, §3.27.9 kind, §3.27.10 level, §3.27.24 baselineState). https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
57. G. Meziantou, "How to output a SARIF file from a .NET project". https://www.meziantou.net/how-to-output-a-sarif-file-from-a-dotnet-project.htm
