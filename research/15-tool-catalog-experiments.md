# 15 — Tool-catalog experiments: coverage, recall, overlap and cost of AI-free analysers on MessagePack-CSharp

Date: 2026-11-14. Scope: empirical evidence for the AI-free code-quality certifier (Junction 2026, Tieto "Earned Trust in AI Code").
Everything here is reproducible from `experiments/tools/` (commands in section 9). This file is rendered by
`experiments/tools/render_report.py` from `experiments/tools/report_template.txt` and `out/tools/summary.json`
(machine-readable results). Raw native reports: `out/tools/<ref>/` (SARIF 2.1.0 where the tool supports it).

## 0. Bottom line

* **Secrets are close to solved by the standard catalog, and one tool is nearly enough.** On 30 seeded fake secrets
  (8 formats, in C# literals and 4 config formats) gitleaks found 30/30 (Wilson 95% CI 89–100%), trufflehog 28/30
  (79–98%), betterleaks 26/30 (70–95%), detect-secrets 24/30 (63–90%), trivy 15/30 (33–67%), semgrep `p/secrets`
  12/30 (25–58%). Noise floor on the real tree: 0 findings for every secret tool except detect-secrets (31
  high-entropy strings).
* **Dependency scanning on a modern .NET repo comes down to which manifest formats each tool reads.** No scanner reads
  every format: trivy reads `Directory.Packages.props` and `packages.config` but not `.csproj` versions (6/9 seeded
  vulnerable packages), osv-scanner reads `.csproj` versions and `packages.config` but extracts 0 packages from
  `Directory.Packages.props` (6/9), syft/grype read none of them (0/9; they only see checked-in DLLs). Union 9/9. On
  the real tree only trivy reports the one vulnerable direct pin (NuGet.Protocol 6.8.0, GHSA-g4vj-cjjj-v7hg).
  Transitive dependencies are invisible to all of them without a lockfile or a restore.
* **Pattern SAST for C# is weak.** 30 textbook insecure snippets (10 classes x 3): best single tool semgrep `p/csharp`
  incl. tests 8/30 (27%, CI 14–44%); CodeQL `csharp-security-and-quality` 1/30 (3%, CI 1–17%; 7/30 if its
  non-security quality alerts are counted); `p/security-audit` 0/30 (it has no C# rules). Union 9/30 (30%, CI 17–48%).
  Seven of ten classes (MD5/SHA1, Process.Start, XML DTD, `new Random()` tokens, hard-coded password comparison,
  disabled certificate validation, Path.Combine traversal) were never flagged by any security rule.
* **Real vulnerabilities: 0 of 15.** No SAST/secret/pattern rule (semgrep p/csharp, p/default, p/security-audit,
  p/secrets, CodeQL security, trivy, gitleaks, betterleaks, trufflehog, detect-secrets) produced a finding within ±5
  lines of the code changed by the fixes of the 15 OSV advisories for MessagePack (recall 0/15, CI 0–20%). The CWE
  classes involved (674 recursion, 407/328 hash collisions, 770/789/409 unbounded allocation, 125/20 LZ4 bounds,
  502/470 typeless deserialization, 1188 insecure default, 1325, 190, 121) are not covered by any rule in the catalog.
  Quality signals (lizard CCN>15, CPD, CodeQL quality) land near vulnerable lines at roughly the chance rate.
* **Duplication:** exact (type-1) clones 7/7 for CPD, type-3 clones (1–2 inserted statements) 6/6 at 50 tokens,
  **type-2 clones (renamed identifiers) 0/7 for every tool**; CPD's `--ignore-identifiers` is accepted but has no effect
  for C#. Best: CPD-50 13/20 (65%, CI 43–82%).
* **Overlap and capture–recapture:** secret scanners overlap heavily (Jaccard gitleaks–trufflehog 0.92 on the seeded
  tree) and share blind spots, so pairwise Lincoln–Petersen/Chapman estimates come out too low. Checked against the
  known 30 seeded secrets they return 22–31, several with 95% CIs that exclude the truth (e.g. betterleaks–detect-secrets
  26 [26, 26]). For clones every pair estimates 10–13.3 against a true 20, because all tools miss type-2 clones. On
  real code CR is mostly undefined (m = 0). Treat CR numbers as lower bounds, never as "what remains".
* **Silent zero-coverage failures are the main operational risk** (section 2). In some layouts semgrep, osv-scanner and
  jscpd each returned exit 0 or empty results without scanning anything. semgrep also skips `tests/` by default, and
  CodeQL writes `obj/` into the source tree. A certifier must check coverage (files scanned) per tool, not just exit
  codes.
* **Cost is negligible except for CodeQL and CPD-50:** every catalog tool except CodeQL runs in under 15 s on the
  73 KLOC C# tree. CPD at 50 tokens peaks at about 2.8 GB RSS. CodeQL (build-mode none) takes about 3 min and 12 GB
  RSS. See E4.

## 1. Setup

* Machine: Apple M5 Max, 64 GB, macOS (arm64), no Docker, no sudo. The machine was shared with another lab agent
  running dotnet builds (load average 8–29 during the runs), so wall-clock numbers are indicative; E4 uses medians of
  3 repetitions.
* Corpus: MessagePack-CSharp. Each ref was copied out read-only with `git archive <ref> | tar -x` into
  `corpus/tools/refs/<ref>`, so every tool sees the same bytes and no `.git` directory. "Changed-only" trees contain
  only the files the branch added or modified (`git diff --name-only --diff-filter=AM origin/HEAD...<branch>`).

| ref | commit | files changed vs base |
|---|---|---|
| base (origin/HEAD) | 32258fdb | – |
| ju26-issue-2129 | 083afd99 | 28 |
| ju26-issue-2234 | 9007cee1 | 4 |
| ju26-issue-2283 | 9df83c38 | 4 |
| ju26-issue-2297 | a0aa5ab2 | 237 (mostly generated `.g.cs` snapshot resources) |

Base size (scc): 681 C# files, 73,308 C# code lines; 865 files / 87,468 code lines in all languages.

### Tools

| tool | version | install | categories | status |
|---|---|---|---|---|
| gitleaks | 8.30.1 | brew | secret | ran (`dir` mode, `--redact`) |
| betterleaks | 1.10.1 | brew | secret | ran (`dir`, `--redact`, validation off) |
| trufflehog | 3.99.9 | brew | secret | ran (`filesystem`, `--no-verification`) |
| detect-secrets | 1.5.0 | pip in `corpus/tools/venv` | secret | ran (`scan --all-files`) |
| trivy | 0.76.2 | brew | dependency, secret, misconfig | ran (`fs --scanners vuln,secret,misconfig`) |
| osv-scanner | 2.7.1 | brew | dependency | ran (`scan source -r --no-ignore`) |
| syft | 1.57.1 | brew | SBOM (CycloneDX JSON) | ran |
| grype | 0.121.3 (DB schema v6.1.10, built 2026-11-14) | brew | dependency | ran on the syft SBOM and on `dir:` |
| semgrep | 1.185.0 | brew; rules fetched once from `semgrep.dev/c/p/<pack>` | sast, secret | ran: `p/csharp` (27 rules), `p/security-audit` (225 rules, 0 C#), `p/secrets` (52), `p/default` (1073, 35 C#) |
| PMD CPD | 7.29.0 | brew | duplication | ran (`--minimum-tokens 100` and `50`, xml+csv) |
| jscpd | 4.3.0 | `npm install jscpd@4` (local) | duplication | ran (`--min-tokens 100` and `50`, json) |
| scc | 4.1.0 | brew | size, per-file complexity | ran (json, by file) |
| lizard | 1.26.0 | pre-installed `.venv` | per-function complexity | ran (csv + xml) |
| OpenSSF Scorecard | 5.6.0 | brew | supply-chain hygiene | ran in `--local` mode only (11 of 18 checks) |
| CodeQL | 2.27.4 + `codeql/csharp-queries` 1.11.0 | brew cask + pack download | sast, quality | ran (build-mode none, `csharp-security-and-quality`) through an arm64 shim (section 2) |
| PMD rules for C# | – | – | – | **not applicable**: PMD 7 has no C# rule module |
| SonarQube Community | – | – | – | **incomplete**: C# needs SonarScanner for .NET around an MSBuild build (out of scope here) |

Semgrep rule-pack SHA-256 prefixes (for reproducibility): `p-csharp` f834ed6c7a42fbb6, `p-default` 266175c7c9d262df, `p-secrets` d1afb323ed493cf9, `p-security-audit` 83d7cde9157b3c79.

## 2. Silent-failure pitfalls found during setup (relevant to any automated certifier)

1. **semgrep scanned 0 files and exited 0** when the target directory sat inside a git-ignored folder of an enclosing
   repository, because it uses `git ls-files`. Fix: `--no-git-ignore`. Second trap: semgrep then climbs to the
   enclosing repo to look for `.semgrepignore`; a tree-local ignore file needs `--semgrepignore-v2 --project-root <tree>`.
2. **semgrep's built-in default ignore list skips `tests/`**: `p/csharp` scanned 317 of 681 C# files (`src`,
   `benchmark` and `sandbox` only), and `p/default` 566 of 948 files. The `*-all` variants in this report turn this off
   with an empty `.semgrepignore` (681 and 948 files). 6 of the 30 seeded SAST snippets are in `tests/`.
3. **jscpd silently ignores any path that contains a dot-directory** (our absolute path contains `/.claude/`): exit 0,
   no report, 0.24 s. Fix: run it from inside the tree with `.` as the path.
4. **osv-scanner honours the enclosing repo's `.gitignore`** and reported "no package sources found" (exit 128). With
   `--no-ignore` it parses `Directory.Packages.props` but extracts 0 packages (it does not support central package
   management) and skips 98 `PackageReference`s that have no version. On the real tree it finds only the Unity
   `packages.config` (6 packages, no advisories), so its effective dependency coverage there is nil.
5. **CodeQL's C# extractor ships for x86-64 only** ("Bad CPU type in executable"); Rosetta 2 is not installed and
   installing it needs admin rights. We ran it by deleting the bundled x64 runtime, making the extractor
   framework-dependent and running it on an arm64 .NET 10 runtime installed in the work area
   (`experiments/tools/codeql_arm64.sh`). Extraction succeeded (73,152 LOC baseline; the extractor fetched the NuGet
   dependencies itself).
6. **CodeQL build-mode none writes `obj/` (project.assets.json) into the source root.** The first seeded run of the
   other tools picked these files up, and detect-secrets jumped from 31 to 1,193 findings. The script now extracts from
   a scratch copy. All affected runs were deleted and repeated on clean trees; the numbers in this report are the
   clean ones.
7. **CPD's `--ignore-identifiers` and `--ignore-literals` are accepted with `--language cs` but have no effect**: the
   output is identical to plain CPD-100 on both base and seeded.
8. **syft and grype read none of the NuGet manifest formats used here.** All 29 of grype's base findings come from
   checked-in MessagePack 1.4.3 / 1.6.0.3 DLLs in `sandbox/PerfBenchmarkDotNet` and `benchmark/`, plus one GitHub
   Action.
9. trufflehog has no redact option, so its `Raw`/`RawV2` fields are replaced by hashes after each run. Seeded runs are
   also scrubbed of every seeded value, because GitHub push protection would block correctly formatted fake tokens.

## 3. E1 — baseline on base and the four AI branches

Findings per tool and ref (all categories). scc and syft produce metrics and an SBOM, not findings. osv-scanner's 0 on
the real refs means it parsed the manifests it supports and found no advisory:

| tool | base | ju26-issue-2129 | ju26-issue-2234 | ju26-issue-2283 | ju26-issue-2297 | seeded |
|---|---|---|---|---|---|---|
| betterleaks | 0 | 0 | 0 | 0 | 0 | 27 |
| codeql | 813 | 814 | 813 | 813 | 813 | 833 |
| cpd-100 | 865 | 865 | 865 | 865 | 882 | 887 |
| cpd-100-ignore-ids | 865 | 865 | 865 | 865 | 882 | 887 |
| cpd-50 | 6997 | 6999 | 7003 | 6997 | 7321 | 7064 |
| detect-secrets | 31 | 31 | 31 | 31 | 31 | 68 |
| gitleaks | 0 | 0 | 0 | 0 | 0 | 34 |
| grype | 29 | 29 | 29 | 29 | 29 | 29 |
| grype-dir | 29 | 29 | 29 | 29 | 29 | 29 |
| jscpd-100 | 648 | 648 | 648 | 648 | 662 | 662 |
| jscpd-50 | 1724 | 1730 | 1724 | 1726 | 1746 | 1746 |
| lizard | 70 | 72 | 70 | 70 | 70 | 72 |
| osv-scanner | 0 | 0 | 0 | 0 | 0 | 9 |
| scc | 0 | 0 | 0 | 0 | 0 | 0 |
| scorecard | 23 | 23 | 23 | 23 | 23 | 23 |
| semgrep-csharp | 0 | 0 | 0 | 0 | 0 | 6 |
| semgrep-csharp-all | 0 | 0 | 0 | 0 | 0 | 8 |
| semgrep-default | 32 | 32 | 32 | 32 | 32 | 50 |
| semgrep-default-all | 32 | 32 | 32 | 32 | 32 | 53 |
| semgrep-secrets | 0 | 0 | 0 | 0 | 0 | 11 |
| semgrep-secrets-all | 0 | 0 | 0 | 0 | 0 | 11 |
| semgrep-security-audit | 0 | 0 | 0 | 0 | 0 | 0 |
| semgrep-security-audit-all | 0 | 0 | 0 | 0 | 0 | 0 |
| syft | 0 | 0 | 0 | 0 | 0 | 0 |
| trivy | 3 | 3 | 3 | 3 | 3 | 26 |
| trufflehog | 0 | 0 | 0 | 0 | 0 | 26 |

Branch deltas, for tools run on both refs. "New/gone" is the line-insensitive fingerprint multiset difference vs base;
"changed-only run" is the same tool run on a tree that contains only the changed files ("–" = not run on that tree):

| branch | tool | total | new vs base | gone vs base | in changed files | changed-only run |
|---|---|---|---|---|---|---|
| ju26-issue-2129 | codeql | 814 | 1 | 0 | 11 | – |
| ju26-issue-2129 | cpd-100 | 865 | 0 | 0 | 2 | 2 |
| ju26-issue-2129 | cpd-100-ignore-ids | 865 | 0 | 0 | 2 | – |
| ju26-issue-2129 | cpd-50 | 6999 | 2 | 0 | 10 | 10 |
| ju26-issue-2129 | jscpd-100 | 648 | 0 | 0 | 6 | 2 |
| ju26-issue-2129 | jscpd-50 | 1730 | 6 | 0 | 19 | 14 |
| ju26-issue-2129 | lizard | 72 | 2 | 0 | 4 | 4 |
| ju26-issue-2234 | codeql | 813 | 0 | 0 | 13 | – |
| ju26-issue-2234 | cpd-100 | 865 | 0 | 0 | 8 | 8 |
| ju26-issue-2234 | cpd-100-ignore-ids | 865 | 0 | 0 | 8 | – |
| ju26-issue-2234 | cpd-50 | 7003 | 6 | 0 | 31 | 30 |
| ju26-issue-2234 | lizard | 70 | 0 | 0 | 3 | 3 |
| ju26-issue-2283 | codeql | 813 | 0 | 0 | 13 | – |
| ju26-issue-2283 | cpd-100 | 865 | 0 | 0 | 8 | 8 |
| ju26-issue-2283 | cpd-100-ignore-ids | 865 | 0 | 0 | 8 | – |
| ju26-issue-2283 | cpd-50 | 6997 | 0 | 0 | 25 | 24 |
| ju26-issue-2283 | jscpd-50 | 1726 | 2 | 0 | 8 | 8 |
| ju26-issue-2283 | lizard | 70 | 0 | 0 | 3 | 3 |
| ju26-issue-2297 | codeql | 813 | 0 | 0 | 25 | – |
| ju26-issue-2297 | cpd-100 | 882 | 18 | 1 | 355 | 369 |
| ju26-issue-2297 | cpd-100-ignore-ids | 882 | 18 | 1 | 355 | – |
| ju26-issue-2297 | cpd-50 | 7321 | 341 | 17 | 1747 | 1675 |
| ju26-issue-2297 | jscpd-100 | 662 | 17 | 3 | 353 | 374 |
| ju26-issue-2297 | jscpd-50 | 1746 | 33 | 11 | 713 | 748 |
| ju26-issue-2297 | lizard | 70 | 0 | 0 | 4 | 4 |

Observations:
* None of the four AI branches introduces a secret, dependency or security finding (all secret scanners, trivy,
  osv-scanner, semgrep and CodeQL security report 0 new).
* ju26-issue-2129 adds two functions with CCN>15 (lizard: `GeneratedFormatterCollector.cs` lines 35 and 147, a new
  file), one CodeQL quality alert (`cs/linq/missed-where`, `MessagePackGenerator.cs:70`) and a few small 50-token
  clones. ju26-issue-2297 adds 18 CPD-100 and 341 CPD-50 duplicate occurrences, almost all in generated `*.g.cs`
  snapshot test resources. That duplication is expected, which argues for excluding generated test fixtures.
* For file-local tools (secret scanners, lizard), changed-only runs agree with the "findings in changed files" of the
  full run. Clone detectors differ by design: a clone of unchanged code cannot be seen in a changed-only tree.
* Real-tree findings worth noting:
  * trivy flags NuGet.Protocol 6.8.0 (GHSA-g4vj-cjjj-v7hg, low) and 2 Dockerfile misconfigurations.
  * scorecard (local mode) scores 6.2, with Pinned-Dependencies 0, Token-Permissions 0, SAST 0 and Fuzzing 0.
  * CodeQL raises 813 quality alerts and 0 security alerts.
  * semgrep `p/default`'s 32 findings are all GitHub Actions rules in `.github/` (17 `run-shell-injection`, 13 mutable
    action tags, 1 `secrets-inherit`, 1 Dependabot cooldown). They overlap with scorecard's Pinned-Dependencies and
    Token-Permissions warnings (Jaccard 0.375, section 5). `p/csharp` reports nothing on the real C# code.
  * detect-secrets raises 31 high-entropy strings: Unity `.meta` GUIDs and hashes, all false positives judging by the
    top files.

## 4. E2 — seeded-defect ground truth (recall per tool)

**Design.** `experiments/tools/seed_defects.py` (seed 20261114) wrote the ground truth to
`out/tools/seeded/ground_truth.json`: 89 items, each in a different file, none inside a preprocessor `#if`.
* 30 fake secrets:
  * AWS key id + secret (4)
  * GitHub classic PAT with a valid CRC32 checksum (4)
  * Slack bot token (4)
  * Stripe `sk_live_` (4; 24 or 99 chars)
  * RSA private key PEM (3; freshly generated from the seed, 2048-bit PKCS#1)
  * HS256 JWT (4)
  * SQL connection string with a high-entropy password (4)
  * Azure storage connection string (3)

  20 are `private const string` fields in C# classes; 10 are in new config files (appsettings JSON, user-secrets JSON,
  Web.config XML, Azure Pipelines YAML, `.env`). All values are random, and the ground truth stores only their SHA-256.
* 9 known-vulnerable NuGet packages, each checked against `api.osv.dev/v1/query` at seeding time, in three manifest
  formats:
  * `Directory.Packages.props`: Newtonsoft.Json 12.0.1 (GHSA-5crp-9r3c-p9vr), System.Text.Encodings.Web 4.5.0
    (GHSA-ghhp-997w-qr28), System.Net.Http 4.3.0 (GHSA-7jgj-8wvc-jh57).
  * A non-CPM `.csproj` with explicit versions: Microsoft.Data.SqlClient 1.1.0, System.Text.RegularExpressions 4.3.0,
    System.IdentityModel.Tokens.Jwt 5.6.0.
  * `packages.config`: SharpZipLib 1.2.0, log4net 2.0.9, YamlDotNet 4.3.1.
* 30 insecure snippets, inserted as new methods in existing classes together with the `using`s they need. Ten classes,
  three textbook variants each, all taking their input from method parameters:
  * BinaryFormatter deserialisation
  * MD5/SHA1 for passwords or signatures
  * DES/RC2
  * SQL built by string concatenation
  * Process.Start with concatenated input
  * XML parsing with DTD processing or XmlUrlResolver
  * `new Random()` for tokens or keys
  * hard-coded password comparison
  * a certificate validation callback that returns true
  * Path.Combine with user input
* 20 clones of existing 12–45-line methods (110–450 tokens), placed in other files: 7 exact copies, 7 with consistently
  renamed identifiers (method, parameters, locals), 6 with 1–2 inserted statements.

**Matching rule.** An item counts as detected if a finding of the same category lies in the same file and overlaps
lines [start−2, end+2]. For dependencies, the finding must name the same package and version with any advisory, in any
manifest. Two variants are also reported:
* "strict" (clones only): the clone's partner occurrence must lie in the source method.
* "any category": findings of other categories also count, e.g. a secret scanner flagging a hard-coded password.

The noise floor is the number of findings of that category on the unmodified base.

| tool | category | detected | recall | Wilson 95% CI | strict | base findings (noise floor) |
|---|---|---|---|---|---|---|
| gitleaks | secret | 30/30 | 100% | [89, 100] | 30 | 0 |
| betterleaks | secret | 26/30 | 87% | [70, 95] | 26 | 0 |
| trufflehog | secret | 28/30 | 93% | [79, 98] | 28 | 0 |
| detect-secrets | secret | 24/30 | 80% | [63, 90] | 24 | 31 |
| trivy | secret | 15/30 | 50% | [33, 67] | 15 | 0 |
| trivy | dependency | 6/9 | 67% | [35, 88] | 6 | 1 |
| semgrep-secrets | secret | 12/30 | 40% | [25, 58] | 12 | 0 |
| semgrep-secrets-all | secret | 12/30 | 40% | [25, 58] | 12 | 0 |
| semgrep-default | secret | 12/30 | 40% | [25, 58] | 12 | 0 |
| semgrep-default | sast | 5/30 | 17% | [7, 34] | 5 | 32 |
| semgrep-default-all | secret | 14/30 | 47% | [30, 64] | 14 | 0 |
| semgrep-default-all | sast | 6/30 | 20% | [10, 37] | 6 | 32 |
| grype | dependency | 0/9 | 0% | [0, 30] | 0 | 29 |
| grype-dir | dependency | 0/9 | 0% | [0, 30] | 0 | 29 |
| osv-scanner | dependency | 6/9 | 67% | [35, 88] | 6 | 0 |
| semgrep-csharp | sast | 6/30 | 20% | [10, 37] | 6 | 0 |
| semgrep-csharp-all | sast | 8/30 | 27% | [14, 44] | 8 | 0 |
| semgrep-security-audit-all | sast | 0/30 | 0% | [0, 11] | 0 | 0 |
| codeql | sast | 1/30 | 3% | [1, 17] | 1 | 0 |
| cpd-100 | duplication | 10/20 | 50% | [30, 70] | 10 | 865 |
| cpd-50 | duplication | 13/20 | 65% | [43, 82] | 13 | 6997 |
| cpd-100-ignore-ids | duplication | 10/20 | 50% | [30, 70] | 10 | 865 |
| jscpd-100 | duplication | 8/20 | 40% | [22, 61] | 8 | 648 |
| jscpd-50 | duplication | 12/20 | 60% | [39, 78] | 10 | 1724 |

Union of all tools per category:

| category | detected | recall | CI | never detected |
|---|---|---|---|---|
| secret | 30/30 | 100% | [89, 100] |  |
| dependency | 9/9 | 100% | [70, 100] |  |
| sast | 9/30 | 30% | [17, 48] | SAST-01, SAST-03, SAST-05, SAST-06, SAST-09, SAST-10, SAST-11, SAST-14, SAST-15, SAST-17, SAST-18, SAST-19, SAST-22, SAST-23, SAST-24, SAST-25, SAST-26, SAST-27, SAST-28, SAST-29, SAST-30 |
| duplication | 13/20 | 65% | [43, 82] | DUP-08, DUP-09, DUP-10, DUP-11, DUP-12, DUP-13, DUP-14 |

Per subtype:

*secret* (cells = items detected):

| subtype | n | gitleaks | betterleaks | trufflehog | detect-secrets | trivy | semgrep-secrets | semgrep-secrets-all | semgrep-default | semgrep-default-all |
|---|---|---|---|---|---|---|---|---|---|---|
| aws | 4 | 4 | 4 | 4 | 4 | 0 | 4 | 4 | 4 | 4 |
| azure_storage | 3 | 3 | 3 | 3 | 3 | 2 | 0 | 0 | 0 | 0 |
| connstring_password | 4 | 4 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| github_pat | 4 | 4 | 4 | 4 | 4 | 1 | 0 | 0 | 0 | 0 |
| jwt | 4 | 4 | 4 | 2 | 4 | 2 | 2 | 2 | 2 | 4 |
| private_key_pem | 3 | 3 | 3 | 3 | 3 | 3 | 1 | 1 | 1 | 1 |
| slack | 4 | 4 | 4 | 4 | 2 | 3 | 1 | 1 | 1 | 1 |
| stripe | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 | 4 |

*dependency* (cells = items detected):

| subtype | n | trivy | grype | grype-dir | osv-scanner |
|---|---|---|---|---|---|
| cpm-props | 3 | 3 | 0 | 0 | 0 |
| csproj-version | 3 | 0 | 0 | 0 | 3 |
| packages.config | 3 | 3 | 0 | 0 | 3 |

*sast* (cells = items detected):

| subtype | n | semgrep-default | semgrep-default-all | semgrep-csharp | semgrep-csharp-all | semgrep-security-audit-all | codeql |
|---|---|---|---|---|---|---|---|
| binaryformatter | 3 | 3 | 3 | 3 | 3 | 0 | 0 |
| cert_validation_disabled | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| hardcoded_password | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| insecure_random | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| path_traversal | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| process_start | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| sql_concat | 3 | 2 | 3 | 2 | 3 | 0 | 0 |
| weak_cipher | 3 | 0 | 0 | 1 | 2 | 0 | 1 |
| weak_hash | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| xml_dtd | 3 | 0 | 0 | 0 | 0 | 0 | 0 |

*duplication* (cells = items detected):

| subtype | n | cpd-100 | cpd-50 | cpd-100-ignore-ids | jscpd-100 | jscpd-50 |
|---|---|---|---|---|---|---|
| type1 | 7 | 7 | 7 | 7 | 5 | 6 |
| type2 | 7 | 0 | 0 | 0 | 0 | 0 |
| type3 | 6 | 3 | 6 | 3 | 3 | 6 |

Notes:
* **Secrets.** Everyone finds the secrets in config files (10/10 for gitleaks, betterleaks, trufflehog, detect-secrets
  and trivy). All the differences are in C# string literals (trivy 5/20, semgrep 4–6/20, detect-secrets 14/20).
  Connection-string passwords depend most on the tool: gitleaks 4/4 and trufflehog 4/4, but betterleaks,
  detect-secrets, trivy and semgrep 0/4.
* **SAST.**
  * semgrep `p/csharp` catches BinaryFormatter 3/3, SQL concatenation 3/3 (taint from `string` parameters) and DES/RC2
    2/3. Its default ignore list costs it the 2 hits that are in `tests/`.
  * CodeQL found only DES (`cs/weak-encryption`). Its default suites have no query for BinaryFormatter (the
    `cs/unsafe-deserialization` query is low-precision and excluded), and its taint queries (SQL, command and path
    injection) need remote-flow sources, which method parameters are not. The `csharp-security-extended` suite
    returned the same 2 alerts.
  * Outside the sast category, CodeQL's quality query `cs/path-combine` hit all 3 Path.Combine seeds, and
    detect-secrets' keyword plugin hit 2/3 hard-coded passwords (both counted under "any category").
* **Duplication.** All four detectors find exact copies. Inserted statements only break the 100-token windows, and
  renamed identifiers defeat every detector (0/7). Each clone run also raises 8–42 extra unmatched occurrences, because
  CPD reports the same seeded region against several similar originals.

## 5. E3 — normalisation, deduplication, overlap, capture–recapture

`experiments/tools/normalise.py` converts every native report to one schema:
`{tool, rule_id, category, cwe, severity, file, start_line, end_line, message, fingerprint}`, plus package, version
and advisories for dependency findings and the clone group for duplication findings.

Category mapping:

| source | category |
|---|---|
| secret scanners | secret |
| trivy | by result class: vuln → dependency, secret → secret, misconfig → sast |
| semgrep `p/secrets` and rules with `.secrets.` in the id | secret |
| other semgrep rules | sast |
| CodeQL alerts tagged `security` | sast |
| other CodeQL alerts | style |
| CPD, jscpd | duplication (one finding per occurrence) |
| lizard functions with CCN>15 | complexity |
| scorecard "Warn" details that name a file | sast (supply-chain) |

Severity uses CVSS/security-severity bands where available, otherwise the SARIF level (error → high, warning → medium,
note → low). Secrets are always high.

Deduplication (`analyze.py`) runs union-find over findings of the same category in the same file whose line ranges
overlap with ±2 lines of tolerance. Dependency findings cluster on (package, version, any shared advisory id or alias).
One representative per tool family is used: semgrep `p/default` incl. tests for sast, and `p/secrets` incl. tests for
secrets.

Base tree:

*secret*: 31 raw findings → 30 clusters (duplicate ratio 3%). Clusters per tool: gitleaks 0, betterleaks 0, trufflehog 0, detect-secrets 30, trivy 0, semgrep-secrets-all 0. Clusters seen by 1 tool: 30.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| gitleaks vs detect-secrets | 0.000 | 0 | 30 | 0 | ∞ (m=0) | 30.0 | [30, 30.0] |
| betterleaks vs detect-secrets | 0.000 | 0 | 30 | 0 | ∞ (m=0) | 30.0 | [30, 30.0] |
| trufflehog vs detect-secrets | 0.000 | 0 | 30 | 0 | ∞ (m=0) | 30.0 | [30, 30.0] |
| detect-secrets vs trivy | 0.000 | 30 | 0 | 0 | ∞ (m=0) | 30.0 | [30, 30.0] |
| detect-secrets vs semgrep-secrets-all | 0.000 | 30 | 0 | 0 | ∞ (m=0) | 30.0 | [30, 30.0] |

*dependency*: 30 raw findings → 30 clusters (duplicate ratio 0%). Clusters per tool: trivy 1, grype 29, osv-scanner 0. Clusters seen by 1 tool: 30.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| trivy vs grype | 0.000 | 1 | 29 | 0 | ∞ (m=0) | 59.0 | [30, 116.81] |
| trivy vs osv-scanner | 0.000 | 1 | 0 | 0 | ∞ (m=0) | 1.0 | [1, 1.0] |
| grype vs osv-scanner | 0.000 | 29 | 0 | 0 | ∞ (m=0) | 29.0 | [29, 29.0] |

*sast*: 57 raw findings → 33 clusters (duplicate ratio 42%). Clusters per tool: semgrep-default-all 21, codeql 0, trivy 1, scorecard 23. Clusters seen by 1 tool: 21, 2 tools: 12.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| semgrep-default-all vs codeql | 0.000 | 21 | 0 | 0 | ∞ (m=0) | 21.0 | [21, 21.0] |
| semgrep-default-all vs trivy | 0.000 | 21 | 1 | 0 | ∞ (m=0) | 43.0 | [22, 85.13] |
| semgrep-default-all vs scorecard | 0.375 | 21 | 23 | 12 | 40.25 | 39.62 | [32, 48.83] |
| codeql vs trivy | 0.000 | 0 | 1 | 0 | ∞ (m=0) | 1.0 | [1, 1.0] |
| codeql vs scorecard | 0.000 | 0 | 23 | 0 | ∞ (m=0) | 23.0 | [23, 23.0] |
| trivy vs scorecard | 0.000 | 1 | 23 | 0 | ∞ (m=0) | 47.0 | [24, 93.05] |

*duplication*: 10234 raw findings → 807 clusters (duplicate ratio 92%). Clusters per tool: cpd-100 345, jscpd-100 310, cpd-50 771, jscpd-50 644. Clusters seen by 1 tool: 149, 2 tools: 345, 3 tools: 21, 4 tools: 292.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| cpd-100 vs jscpd-100 | 0.804 | 345 | 310 | 292 | 366.27 | 366.26 | [363, 370.21] |
| cpd-100 vs cpd-50 | 0.448 | 345 | 771 | 345 | 771.0 | 771.0 | [771, 771.0] |
| cpd-100 vs jscpd-50 | 0.427 | 345 | 644 | 296 | 750.61 | 750.41 | [726.83, 774.0] |
| jscpd-100 vs cpd-50 | 0.400 | 310 | 771 | 309 | 773.5 | 773.49 | [772, 777.27] |
| jscpd-100 vs jscpd-50 | 0.481 | 310 | 644 | 310 | 644.0 | 644.0 | [644, 644.0] |
| cpd-50 vs jscpd-50 | 0.753 | 771 | 644 | 608 | 816.65 | 816.64 | [809.59, 823.68] |

*complexity*: 70 raw findings → 58 clusters (duplicate ratio 17%). Clusters per tool: lizard 58. Clusters seen by 1 tool: 58.

*style*: 813 raw findings → 431 clusters (duplicate ratio 47%). Clusters per tool: codeql 431. Clusters seen by 1 tool: 431.

Seeded tree (real + seeded findings):

*secret*: 181 raw findings → 58 clusters (duplicate ratio 68%). Clusters per tool: gitleaks 25, betterleaks 22, trufflehog 23, detect-secrets 52, trivy 10, semgrep-secrets-all 8. Clusters seen by 1 tool: 32, 2 tools: 5, 3 tools: 3, 4 tools: 5, 5 tools: 9, 6 tools: 4.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| gitleaks vs betterleaks | 0.808 | 25 | 22 | 21 | 26.19 | 26.18 | [26, 27.09] |
| gitleaks vs trufflehog | 0.920 | 25 | 23 | 23 | 25.0 | 25.0 | [25, 25.0] |
| gitleaks vs detect-secrets | 0.328 | 25 | 52 | 19 | 68.42 | 67.9 | [58, 79.07] |
| gitleaks vs trivy | 0.400 | 25 | 10 | 10 | 25.0 | 25.0 | [25, 25.0] |
| gitleaks vs semgrep-secrets-all | 0.320 | 25 | 8 | 8 | 25.0 | 25.0 | [25, 25.0] |
| betterleaks vs trufflehog | 0.731 | 22 | 23 | 19 | 26.63 | 26.6 | [26, 28.34] |
| betterleaks vs detect-secrets | 0.370 | 22 | 52 | 20 | 57.2 | 57.05 | [54, 62.61] |
| betterleaks vs trivy | 0.455 | 22 | 10 | 10 | 22.0 | 22.0 | [22, 22.0] |
| betterleaks vs semgrep-secrets-all | 0.364 | 22 | 8 | 8 | 22.0 | 22.0 | [22, 22.0] |
| trufflehog vs detect-secrets | 0.293 | 23 | 52 | 17 | 70.35 | 69.67 | [58, 82.58] |
| trufflehog vs trivy | 0.435 | 23 | 10 | 10 | 23.0 | 23.0 | [23, 23.0] |
| trufflehog vs semgrep-secrets-all | 0.348 | 23 | 8 | 8 | 23.0 | 23.0 | [23, 23.0] |
| detect-secrets vs trivy | 0.170 | 52 | 10 | 9 | 57.78 | 57.3 | [53, 66.66] |
| detect-secrets vs semgrep-secrets-all | 0.154 | 52 | 8 | 8 | 52.0 | 52.0 | [52, 52.0] |
| trivy vs semgrep-secrets-all | 0.286 | 10 | 8 | 4 | 20.0 | 18.8 | [14, 26.6] |

*dependency*: 47 raw findings → 42 clusters (duplicate ratio 11%). Clusters per tool: trivy 9, grype 29, osv-scanner 9. Clusters seen by 1 tool: 37, 2 tools: 5.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| trivy vs grype | 0.000 | 9 | 29 | 0 | ∞ (m=0) | 299.0 | [38, 686.81] |
| trivy vs osv-scanner | 0.385 | 9 | 9 | 5 | 16.2 | 15.67 | [13, 20.61] |
| grype vs osv-scanner | 0.000 | 29 | 9 | 0 | ∞ (m=0) | 299.0 | [38, 686.81] |

*sast*: 65 raw findings → 41 clusters (duplicate ratio 37%). Clusters per tool: semgrep-default-all 27, codeql 2, trivy 1, scorecard 23. Clusters seen by 1 tool: 29, 2 tools: 12.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| semgrep-default-all vs codeql | 0.000 | 27 | 2 | 0 | ∞ (m=0) | 83.0 | [29, 176.34] |
| semgrep-default-all vs trivy | 0.000 | 27 | 1 | 0 | ∞ (m=0) | 55.0 | [28, 108.89] |
| semgrep-default-all vs scorecard | 0.316 | 27 | 23 | 12 | 51.75 | 50.69 | [38, 64.11] |
| codeql vs trivy | 0.000 | 2 | 1 | 0 | ∞ (m=0) | 5.0 | [3, 9.8] |
| codeql vs scorecard | 0.000 | 2 | 23 | 0 | ∞ (m=0) | 71.0 | [25, 150.76] |
| trivy vs scorecard | 0.000 | 1 | 23 | 0 | ∞ (m=0) | 47.0 | [24, 93.05] |

*duplication*: 10359 raw findings → 821 clusters (duplicate ratio 92%). Clusters per tool: cpd-100 362, jscpd-100 323, cpd-50 787, jscpd-50 655. Clusters seen by 1 tool: 147, 2 tools: 347, 3 tools: 22, 4 tools: 305.

| pair | Jaccard | n1 | n2 | m | Lincoln–Petersen | Chapman N̂ | 95% CI |
|---|---|---|---|---|---|---|---|
| cpd-100 vs jscpd-100 | 0.803 | 362 | 323 | 305 | 383.36 | 383.35 | [380, 387.37] |
| cpd-100 vs cpd-50 | 0.460 | 362 | 787 | 362 | 787.0 | 787.0 | [787, 787.0] |
| cpd-100 vs jscpd-50 | 0.439 | 362 | 655 | 310 | 764.87 | 764.68 | [741.36, 788.01] |
| jscpd-100 vs cpd-50 | 0.409 | 323 | 787 | 322 | 789.44 | 789.44 | [788, 793.11] |
| jscpd-100 vs jscpd-50 | 0.493 | 323 | 655 | 323 | 655.0 | 655.0 | [655, 655.0] |
| cpd-50 vs jscpd-50 | 0.756 | 787 | 655 | 621 | 830.09 | 830.07 | [823.25, 836.89] |

*complexity*: 72 raw findings → 60 clusters (duplicate ratio 17%). Clusters per tool: lizard 60. Clusters seen by 1 tool: 60.

*style*: 831 raw findings → 438 clusters (duplicate ratio 47%). Clusters per tool: codeql 438. Clusters seen by 1 tool: 438.

**Checking capture–recapture against the seeded truth** (only clusters that match a seeded item, so the true N is
known):

| category | true N | pair | n1 | n2 | m | LP | Chapman | 95% CI |
|---|---|---|---|---|---|---|---|---|
| secret | 30 | gitleaks vs betterleaks | 30 | 26 | 26 | 30.0 | 30.0 | [30, 30.0] |
| secret | 30 | gitleaks vs trufflehog | 30 | 28 | 28 | 30.0 | 30.0 | [30, 30.0] |
| secret | 30 | gitleaks vs detect-secrets | 30 | 24 | 24 | 30.0 | 30.0 | [30, 30.0] |
| secret | 30 | gitleaks vs trivy | 30 | 15 | 15 | 30.0 | 30.0 | [30, 30.0] |
| secret | 30 | gitleaks vs semgrep-secrets-all | 30 | 12 | 12 | 30.0 | 30.0 | [30, 30.0] |
| secret | 30 | betterleaks vs trufflehog | 26 | 28 | 24 | 30.33 | 30.32 | [30, 31.54] |
| secret | 30 | betterleaks vs detect-secrets | 26 | 24 | 24 | 26.0 | 26.0 | [26, 26.0] |
| secret | 30 | betterleaks vs trivy | 26 | 15 | 15 | 26.0 | 26.0 | [26, 26.0] |
| secret | 30 | betterleaks vs semgrep-secrets-all | 26 | 12 | 12 | 26.0 | 26.0 | [26, 26.0] |
| secret | 30 | trufflehog vs detect-secrets | 28 | 24 | 22 | 30.55 | 30.52 | [30, 32.14] |
| secret | 30 | trufflehog vs trivy | 28 | 15 | 15 | 28.0 | 28.0 | [28, 28.0] |
| secret | 30 | trufflehog vs semgrep-secrets-all | 28 | 12 | 12 | 28.0 | 28.0 | [28, 28.0] |
| secret | 30 | detect-secrets vs trivy | 24 | 15 | 14 | 25.71 | 25.67 | [25, 27.73] |
| secret | 30 | detect-secrets vs semgrep-secrets-all | 24 | 12 | 12 | 24.0 | 24.0 | [24, 24.0] |
| secret | 30 | trivy vs semgrep-secrets-all | 15 | 12 | 8 | 22.5 | 22.11 | [19, 27.37] |
| sast | 30 | semgrep-csharp-all vs semgrep-default-all | 8 | 6 | 6 | 8.0 | 8.0 | [8, 8.0] |
| sast | 30 | semgrep-csharp-all vs codeql | 8 | 1 | 0 | ∞ | 17.0 | [9, 33.63] |
| sast | 30 | semgrep-default-all vs codeql | 6 | 1 | 0 | ∞ | 13.0 | [7, 25.7] |
| duplication | 20 | cpd-100 vs jscpd-100 | 10 | 8 | 8 | 10.0 | 10.0 | [10, 10.0] |
| duplication | 20 | cpd-100 vs cpd-50 | 10 | 13 | 10 | 13.0 | 13.0 | [13, 13.0] |
| duplication | 20 | cpd-100 vs jscpd-50 | 10 | 12 | 9 | 13.33 | 13.3 | [13, 14.52] |
| duplication | 20 | jscpd-100 vs cpd-50 | 8 | 13 | 8 | 13.0 | 13.0 | [13, 13.0] |
| duplication | 20 | jscpd-100 vs jscpd-50 | 8 | 12 | 8 | 12.0 | 12.0 | [12, 12.0] |
| duplication | 20 | cpd-50 vs jscpd-50 | 13 | 12 | 12 | 13.0 | 13.0 | [13, 13.0] |

How to read this:
* Lincoln–Petersen and Chapman assume the two tools detect independently. When two tools share a blind spot, their
  overlap m is larger than independence predicts and both estimators underestimate N, often with confidence intervals
  that exclude the truth. Shared blind spots here: connection-string passwords for betterleaks, detect-secrets, trivy
  and semgrep; type-2 clones for all clone detectors; most SAST classes for semgrep and CodeQL.
* The estimator is only informative for pairs of tools that work differently. Even then it estimates what this family
  of techniques can see, not what remains undetected.
* On the real tree most pairs have m = 0, so the estimates are degenerate: Chapman reduces to (n1+1)(n2+1)−1.
* The ±2-line clustering also merges adjacent secrets (the AWS id/secret pair, consecutive config keys), so cluster
  counts are lower than item counts.

**Complexity agreement.** scc reports complexity per file only, so lizard and scc can be compared only at file level. Over 563 C# files, lizard's sum of (CCN−1) and scc's file Complexity correlate with Pearson r = 0.8691 and Spearman ρ = 0.826. They match exactly in 35% of files (median absolute difference 1; mean 11.79 vs 10.38). 118 files have scc complexity but no lizard function. As a per-function reference, lizard was also compared with a tree-sitter McCabe count (the lab's own `qlab.complexity.cyclomatic`) on 4217 matched functions: Pearson 0.97, Spearman 0.9637, identical CCN in 91.3% of functions (lizard higher in 6.0%, lower in 2.7%). Above the CCN>15 threshold, lizard flags 61 functions, tree-sitter 50, and both 45.

## 6. E4 — cost

Timing: median of 3 sequential repetitions (machine shared with another lab agent; load average 4.7-8.4 during the benchmark). KLOC denominator: 73.308 (C# code lines (scc) of the base tree / 1000). CodeQL is a single run (database creation + analysis). scc counts are
metrics, not findings, and syft produces an SBOM with no findings.

| tool | category | wall s (median) | peak RSS MB | findings base | per KLOC | findings seeded |
|---|---|---|---|---|---|---|
| scc | size/complexity | 0.03 | 39.4 | 0 | 0.0 | 0 |
| betterleaks | secret | 0.18 | 90.8 | 0 | 0.0 | 27 |
| gitleaks | secret | 0.28 | 79.0 | 0 | 0.0 | 34 |
| trivy | dependency+secret+misconfig | 0.54 | 166.9 | 3 | 0.041 | 26 |
| syft | sbom | 0.62 | 180.0 | 0 | 0.0 | 0 |
| trufflehog | secret | 0.73 | 217.1 | 0 | 0.0 | 26 |
| osv-scanner | dependency | 0.87 | 56.9 | 0 | 0.0 | 9 |
| grype | dependency | 0.95 | 70.6 | 29 | 0.396 | 29 |
| grype-dir | dependency | 0.97 | 183.1 | 29 | 0.396 | 29 |
| scorecard | supply-chain | 1.05 | 71.9 | 23 | 0.314 | 23 |
| lizard | complexity | 1.10 | 59.2 | 70 | 0.955 | 72 |
| cpd-100-ignore-ids | duplication | 1.52 | 646.0 | 865 | 11.8 | 887 |
| cpd-100 | duplication | 2.34 | 607.5 | 865 | 11.8 | 887 |
| detect-secrets | secret | 2.82 | 42.9 | 31 | 0.423 | 68 |
| jscpd-50 | duplication | 3.42 | 495.1 | 1724 | 23.517 | 1746 |
| semgrep-secrets | secret | 3.89 | 220.9 | 0 | 0.0 | 11 |
| semgrep-secrets-all | secret | 3.94 | 224.5 | 0 | 0.0 | 11 |
| jscpd-100 | duplication | 3.94 | 472.7 | 648 | 8.839 | 662 |
| semgrep-csharp | sast | 4.29 | 319.7 | 0 | 0.0 | 6 |
| semgrep-csharp-all | sast | 4.55 | 306.3 | 0 | 0.0 | 8 |
| semgrep-security-audit | sast | 4.68 | 217.0 | 0 | 0.0 | 0 |
| semgrep-security-audit-all | sast | 4.72 | 224.4 | 0 | 0.0 | 0 |
| cpd-50 | duplication | 7.97 | 2829.4 | 6997 | 95.447 | 7064 |
| semgrep-default | sast | 11.88 | 370.7 | 32 | 0.437 | 50 |
| semgrep-default-all | sast | 12.55 | 386.2 | 32 | 0.437 | 53 |
| codeql | sast+quality | 185.62 | 11780.6 | 813 | 11.09 | 833 |

## 7. E5 — real-vulnerability ground truth

**Advisories.** `experiments/tools/e5_real_vulns.py` writes the ground truth to
`out/tools/e5/vuln_ground_truth.json`. OSV lists 15 advisories for the MessagePack NuGet packages: 13 package names were
queried, and MessagePack, MessagePack.ImmutableCollection, .ReactiveProperty, .UnityShims and .Unity have entries.

**Fixing commits.**
* GHSA-7q36 and GHSA-qhrr: taken from the OSV references.
* The 13 advisories fixed in 3.1.7/2.5.301 have no commit references in OSV. They were attributed to the per-CWE
  commits merged in PR #2274 (for example "Reject invalid DateTime ext lengths for CWE-789" and "Use iteration for
  skipping msgpack structures for CWE-674"). Each advisory's attribution and the evidence for it are stored in the
  ground truth.

**Vulnerable snapshots.** All the 2026 per-CWE commits share the parent 06ea2495, which is therefore the last
vulnerable v3 code. The other snapshots are 14aabf68 (before 3.1.9), 9be35840 (before 3.0.214-rc.1) and 7e5558fd
(before 2.1.90). The four snapshots were exported with `git archive` into `corpus/tools/e5/`.

**Vulnerable lines.** The lines each fix changed in product `.cs` files under `src/` (tests excluded), in the parent
commit's coordinates. A pure insertion is anchored at its insertion point.

**Scan and matching.** Each snapshot was scanned with gitleaks, betterleaks, trufflehog, detect-secrets, trivy, semgrep
`p/csharp`, `p/default`, `p/security-audit` and `p/secrets` (all incl. tests), CodeQL security-and-quality, lizard,
CPD-100 and jscpd-100. A hit is any finding in a vulnerable file within ±5 lines of a vulnerable line. "Expected by
chance" is a Monte-Carlo estimate of the hits we would get if each advisory's line pattern were moved to a random
offset in a random product C# file of the same snapshot. It calibrates the overlap rule for tools that report densely.

| tool view | advisories hit (±5 lines) | Wilson 95% CI | expected by chance |
|---|---|---|---|
| semgrep-csharp-all | 0/15 | [0, 20] | 0.0 |
| semgrep-default-all | 0/15 | [0, 20] | 0.0 |
| semgrep-security-audit-all | 0/15 | [0, 20] | 0.0 |
| codeql-security | 0/15 | [0, 20] | 0.0 |
| codeql-all | 4/15 | [11, 52] | 3.42 |
| trivy-misconfig | 0/15 | [0, 20] | 0.0 |
| gitleaks | 0/15 | [0, 20] | 0.0 |
| betterleaks | 0/15 | [0, 20] | 0.0 |
| trufflehog | 0/15 | [0, 20] | 0.0 |
| detect-secrets | 0/15 | [0, 20] | 0.0 |
| trivy-secret | 0/15 | [0, 20] | 0.0 |
| semgrep-secrets-all | 0/15 | [0, 20] | 0.0 |
| lizard | 5/15 | [15, 58] | 2.6 |
| cpd-100 | 2/15 | [4, 38] | 2.92 |
| jscpd-100 | 2/15 | [4, 38] | 2.61 |
| codeql-style | 4/15 | [11, 52] | 3.5 |

| advisory | CWE | vulnerable snapshot | vuln. lines | tools with a finding within ±5 lines |
|---|---|---|---|---|
| GHSA-2f33-pr97-265q | CWE-1188 | v3.1.4-20-g06ea2495 | 3 | — |
| GHSA-2x83-8g95-xh59 | CWE-407 | v3.1.4-20-g06ea2495 | 8 | — |
| GHSA-382j-8mxh-c7x2 | CWE-1188, CWE-125, CWE-190, CWE-407… | v3.1.4-20-g06ea2495 | 3 | — |
| GHSA-4qm4-8hg2-g2xm | CWE-328 | v3.0.208-rc.1-4-g9be35840 | 135 | codeql-all, codeql-style, lizard |
| GHSA-7q36-4xx7-xcxf | CWE-121 | v2.0.335-113-g7e5558fd | 430 | codeql-all, codeql-style, cpd-100, jscpd-100, lizard |
| GHSA-cj9g-3mj2-g8vv | CWE-674 | v3.1.4-20-g06ea2495 | 93 | codeql-all, codeql-style, lizard |
| GHSA-cxmj-83gh-fp49 | CWE-770 | v3.1.4-20-g06ea2495 | 11 | — |
| GHSA-hv8m-jj95-wg3x | CWE-20 | v3.1.4-20-g06ea2495 | 42 | codeql-all, codeql-style, cpd-100, jscpd-100, lizard |
| GHSA-q2h6-ghwm-5qm8 | CWE-407 | v3.1.4-20-g06ea2495 | 1 | — |
| GHSA-qhmf-xw27-6rqr | CWE-470, CWE-502 | v3.1.4-20-g06ea2495 | 12 | — |
| GHSA-qhrr-8q5h-9q3h | CWE-1325 | v3.1.8-34-g14aabf68 | 6 | — |
| GHSA-v72x-2h86-7f8m | CWE-409, CWE-770 | v3.1.4-20-g06ea2495 | 23 | — |
| GHSA-vh6j-jc39-fggf | CWE-674 | v3.1.4-20-g06ea2495 | 73 | lizard |
| GHSA-w567-gjr2-hm5j | CWE-770 | v3.1.4-20-g06ea2495 | 5 | — |
| GHSA-wfr3-xj75-pfwh | CWE-674 | v3.1.4-20-g06ea2495 | 7 | — |

* **Security rules: 0/15 (Wilson 95% CI 0–20%).** Every CWE in the advisories has 0 hits: 674 (×4), 407 (×3),
  770 (×3), 1188 (×2), 409 (×2), 470 (×2), 502 (×2), 121, 125, 1325, 190, 20, 328 and 789. These are resource-exhaustion
  and protocol-parsing defects (recursion depth, hash flooding, attacker-controlled lengths) for which the catalog has
  no rules. The semgrep and CodeQL C# rules target injection, crypto API misuse and deserialisation gadgets in
  application code.
* Quality signals overlap vulnerable code at about the chance rate: lizard 5 hits vs 2.6 expected, CodeQL quality
  4 vs 3.5, CPD-100 2 vs 2.9. There is no evidence that they localise these vulnerabilities beyond the fact that
  complex code is everywhere.
* **Dependency ground truth** (`out/tools/e5/e5_dependency_ground_truth.json`): the base `Directory.Packages.props` pins 59 distinct (package, version) pairs, counting conditional item groups and the 4 `GlobalPackageReference`s. Querying OSV for each pair finds 1 vulnerable direct pin(s): NuGet.Protocol@6.8.0. Detected by trivy 1/1, grype 0/1, osv-scanner 0/1. Transitive dependencies (for example those of Microsoft.AspNetCore.Mvc.Core 2.2.5) are not covered: the repository has no `packages.lock.json`, and resolving them needs a `dotnet restore`, which belongs to the build agent.

## 8. Caveats

* Seeded recall depends on the seeding design: textbook snippets with parameter inputs, one item per file, random fake
  secrets in common formats. Real defects are less canonical, and E5 shows how much less. Sample sizes are small
  (3 per SAST class, 3–4 per secret format), hence the wide Wilson intervals.
* Each language used a single carrier style for secrets: all config-file secrets were in new files, and all C#
  secrets were `const` fields.
* The "expected detectors" in the ground truth are expectations from rule documentation, written before the runs; they
  are not used for scoring.
* Matching by line overlap can credit an unrelated finding near a seed. Per-category matching, the strict variant for
  clones and the reported noise floor reduce that risk. The ±5 window in E5 is deliberately generous and is calibrated
  with the chance model.
* We attributed the 3.1.7 advisories to commits ourselves, using the CWEs named in the commit subjects. GHSA-382j lists
  9 CWEs but its text describes the DateTime stackalloc issue; it was mapped to that commit plus the CWE-190 commit.
* Wall-clock numbers come from a shared, loaded machine (another agent was building .NET). Medians of 3 reduce that
  noise but do not remove it. Peak RSS is the largest single process (`/usr/bin/time -l`), not the sum over a process
  tree.
* CodeQL ran through a non-standard arm64 shim and in build-mode none (no compilation), which lowers precision for
  type-dependent queries. Scorecard ran without a token (local checks only). SonarQube was not run.
* osv-scanner, trivy and grype results depend on their advisory databases as of 2026-11-14.

## 9. Reproduce

```bash
# from the lab repo root
brew install gitleaks betterleaks trufflehog osv-scanner trivy syft grype semgrep pmd scc scorecard
brew install --cask codeql
python3 -m venv corpus/tools/venv && corpus/tools/venv/bin/pip install detect-secrets
(mkdir -p corpus/tools/npm && cd corpus/tools/npm && npm init -y && npm install jscpd@4)
for p in csharp security-audit secrets default; do curl -sL -o corpus/tools/semgrep-rules/p-$p.yml https://semgrep.dev/c/p/$p; done
TRIVY_CACHE_DIR=corpus/tools/cache/trivy trivy fs --download-db-only
GRYPE_DB_CACHE_DIR=corpus/tools/cache/grype grype db update
experiments/tools/codeql_arm64.sh setup
# trees (repeat for each branch)
git -C corpus/messagepack-csharp archive origin/HEAD | tar -x -C corpus/tools/refs/base
.venv/bin/python experiments/tools/seed_defects.py --base corpus/tools/refs/base --out corpus/tools/seeded \
    --truth out/tools/seeded/ground_truth.json --values corpus/tools/seeded-secret-values.json --verify-osv
# E1/E2 runs (per ref)
python3 experiments/tools/run_tools.py --target corpus/tools/refs/base --out out/tools/base
python3 experiments/tools/run_tools.py --target corpus/tools/seeded --out out/tools/seeded \
    --redact-values corpus/tools/seeded-secret-values.json --tools <default list>,cpd-100-ignore-ids
experiments/tools/codeql_arm64.sh analyze corpus/tools/refs/base corpus/tools/codeql-db/base out/tools/base
# E5
python3 experiments/tools/e5_real_vulns.py prepare    # then run_tools.py + codeql_arm64.sh on corpus/tools/e5/<sha>
# analysis
experiments/tools/normalise_all.sh
.venv/bin/python experiments/tools/analyze.py
python3 experiments/tools/e5_real_vulns.py evaluate && python3 experiments/tools/e5_real_vulns.py deps
python3 experiments/tools/bench.py --reps 3
python3 experiments/tools/summarize.py && python3 experiments/tools/render_report.py
```

Do not commit `corpus/` (the seeded tree and the side file of fake secret values). The native reports under
`out/tools/seeded/` have been scrubbed of every seeded value.
