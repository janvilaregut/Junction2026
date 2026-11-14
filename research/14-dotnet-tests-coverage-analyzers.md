# 14 · MessagePack-CSharp: tests, coverage and analyzer evidence (base + 4 agent PRs)

Date: 2026-11-14 · Machine: macOS 27, Apple Silicon (osx-arm64), 18 cores, 64 GB
Base commit: `32258fdb` (`origin/HEAD` = `dependabot/nuget/develop/PolySharp-1.15.0`, the merge-base of all four `ju26-issue-*` branches; **not** `master`).

Everything in this report is measured. If something could not be measured, it is listed as missing, never as zero.
Machine-readable data: `out/dotnet/summary.json`. Raw files: `out/dotnet/<ref>/`.

## 1. Results

| ref | head | tests passed / failed / skipped (projects) | patch coverage (new src lines) | Wilson 95% CI | new analyzer results vs base (high-severity) | gate |
|---|---|---|---|---|---|---|
| base | 32258fdb | 1589 / 0 / 6 (8 of 8) | n/a | n/a | n/a (4314 active results) | n/a |
| 2129 | 083afd99 | 1602 / 0 / 6 (8 of 8) | **213 / 278 = 76.6%** | 71.3 – 81.2% | 42 (0) | **FAIL** (coverage) |
| 2234 | 9007cee1 | 1601 / 0 / 6 (8 of 8) | **13 / 18 = 72.2%** | 49.1 – 87.5% | 0 (0) | **FAIL** (coverage) |
| 2283 | 9df83c38 | 1592 / 0 / 6 (8 of 8) | **10 / 10 = 100%** | 72.2 – 100% | 1 (0) | PASS |
| 2297 | a0aa5ab2 | 1591 / 0 / 6 (8 of 8) | **14 / 14 = 100%** | 78.5 – 100% | 0 (0) | PASS |

The gate has three parts: 0 failing tests, at least 80% coverage of new code, and 0 new high-severity analyzer results. "High severity" means an unsuppressed SARIF result with `level=error` or category Security.

Things to keep in mind when reading the table:

* **Small samples.** The point estimates for 2283 and 2297 are 100%, but the Wilson lower bounds (72% and 78%) are below 80%. With 10 or 14 lines, the sample is too small to prove the 80% bar statistically. 2129's interval (71–81%) contains 80%.
* **Different coverage settings change the 2297 denominator.** If you use the repo's own CI settings (`azure-pipelines/test.runsettings` excludes `[GeneratedCode]`), the T4 templates are not measured. 2297's denominator then shrinks to 1 line (`TransformUtilities.cs:58`, covered). 2129 becomes 207/272 = 76.1%. Both views are in `summary.json` (`patch_coverage.repo_ci_view_excluding_generated_code`).
* **Verbatim-string lines count as executable in 2297.** Six of 2297's 14 lines are continuation lines of verbatim (`@"..."`) string literals inside `this.Write(...)` calls. Microsoft CodeCoverage reports every line of a multi-line sequence point, so they appear in the Cobertura report and count as executable.
* **Every failure is a coverage failure.** No branch fails the test or analyzer parts of the gate.

### 1.1 Tests (TRX + JUnit per project)

All 8 test projects that have `Microsoft.NET.Test.Sdk` were built and run on net8.0 for every ref:

| project | base | 2129 | 2234 | 2283 | 2297 |
|---|---|---|---|---|---|
| MessagePack.Tests | 991 (6 skipped) | 991 | 991 | 991 | 991 |
| MessagePack.Internal.Tests | 291 | 291 | 291 | 291 | 291 |
| MessagePack.SourceGenerator.Tests | 167 | 173 | 175 | 170 | 169 |
| MessagePack.Experimental.Tests (NUnit) | 95 | 95 | 95 | 95 | 95 |
| MessagePack.SourceGenerator.MapModeExecutionTests | 20 | 20 | 22 | 20 | 20 |
| MessagePack.SourceGenerator.ExecutionTests | 14 | 21 | 16 | 14 | 14 |
| MessagePack.GeneratedCode.Tests | 11 | 11 | 11 | 11 | 11 |
| MessagePack.AspNetCoreMvcFormatter.Tests | 6 | 6 | 6 | 6 | 6 |

* No test fails on any ref.
* The same 6 tests are skipped on every ref. They have `Skip` in the source: `ReactivePropertyTest.MiscTest`, `ReactivePropertyTest.ViewModelTest`, `UnionResolverTest.ConcreteClassUnion`, `UnionResolverTest.IL2CPPHint`, `MessagePackSerializerTypelessTests.DecimalShouldBeDeserializedAsDecimal` and `MessagePackSerializerTypelessTests.GuidShouldBeDeserializedAsGuid`.
* 2129 adds the helper library `tests/MessagePack.SourceGenerator.ExternalTypes`. It is not a test project and is consumed by ExecutionTests, which goes from 14 to 21 tests.
* There is no `MessagePack.Analyzers.CodeFixes.Tests` project in this repo. The code-fix tests live inside `MessagePack.SourceGenerator.Tests`.
* **`MessagePack.SourceGenerator.ExecutionTests` now builds and runs on every ref.** Earlier sessions marked it "does not compile". Section 3 has the cause and the fix.

### 1.2 Coverage per assembly

Coverage is the union of the 8 per-project Cobertura reports, merged by `analyze.py`.

| assembly | base line | base branch | 2129 | 2234 | 2283 | 2297 |
|---|---|---|---|---|---|---|
| MessagePack | 77.00% (13589/17647) | 67.7% | 77.04% | 77.00% | 77.03% | 77.03% |
| MessagePack.SourceGenerator (all) | 74.17% (3713/5006) | 69.7% | 74.28% (5277 lines) | 74.35% | 74.53% | 74.28% |
| MessagePack.SourceGenerator (excluding T4 `[GeneratedCode]`) | 81.69% | 71.5% | 81.30% | 81.92% | 82.17% | 81.80% |
| MessagePack.Analyzers.CodeFixes | 91.53% (346/378) | 78.1% | = | = | = | = |
| MessagePack.Annotations | 78.0% (39/50) | 50.0% | 76.5% (39/51) | 80.0% (40/50) | 78.0% | 78.0% |
| MessagePack.Analyzers | no code (packaging project, 0 .cs files): nothing to measure | | | | | |

The Experimental, Internal, UnityShims and AspNetCoreMvcFormatter assemblies are also in the reports (`summary.json`).

**Run-to-run noise.** MessagePack's source is identical on all refs, yet its covered-line count varies between 13589 and 13596. That is noise of at most 7 lines, about 0.04 percentage points (nondeterministic tests).

### 1.3 Patch coverage: where the uncovered new lines are

* **2129** (278 executable new lines; 65 uncovered; new-branch coverage 108/178 = 60.7%):
  * `GeneratedFormatterCollector.cs`: 137/197 covered. Uncovered lines: 78-80, 85, 90-93, 104-119, 121-125, 132-138, 140-141, 165-166, 172-178, 201-203, 211-212, 223-224, 263-264, 282-283, 289-290.
    * The whole `CreateContractlessMembers` path is untested.
    * So are several diagnostic exits, for example `NoDeserializingConstructor`.
  * `MessagePackGenerator.cs`: lines 73-75 uncovered. This is the `modelPerType.Add(generatedModel)` path. ExecutionTests do exercise it, but inside csc, where it is not instrumented (section 4).
  * `Attributes.cs`: line 176 uncovered (`SurrogateType` setter).
  * `ObjectSerializationInfo.cs`: line 168 uncovered.
  * `Utils/Constants.cs`: only consts, so no sequence points. It is not counted.
* **2234** (18 lines, 5 uncovered; branches 6/8): `TypeCollector.cs`
  * Line 1148: `continue` after the `DoNotMixStringAndIntKeys` diagnostic.
  * Lines 1179-1182: the `stringMembers.ContainsKey` duplicate-key guard after `KeysMustBeUnique`.
* **2283** (10/10 lines; branches 9/12) and **2297** (14/14 lines; branches 2/2): no uncovered new lines.

### 1.4 Static analysis (SARIF 2.1.0, Roslyn 4.12, `AnalysisMode=All`)

**How the counts are built.**
* Scope: 8 SARIF files per ref. That is `MessagePack` × {netstandard2.0, netstandard2.1, net8.0, net472} plus Annotations, SourceGenerator, Analyzers and Analyzers.CodeFixes.
* Deduplication: results repeated across target frameworks are counted once. For base, 15438 raw results become 4714 unique results.
* Counts below are for unsuppressed, active results. 400 more are suppressed in source.

**Base profile.**
* By severity: 4017 note, 297 warning, 0 error.
* By category (bucket):

  | bucket | results | of which warnings |
  |---|---|---|
  | Style | 2170 | 0 |
  | Compiler | 1388 | 0 (all CS1591 notes) |
  | Usage | 259 | 15 |
  | Design | 209 | 26 |
  | Performance | 171 | 170 |
  | Reliability | 45 | 15 |
  | Maintainability | 33 | 32 |
  | Other (Globalization) | 25 | 25 |
  | Naming | 14 | 14 |
  | **Security** | **0** | 0 |

* Top warnings: CA1852 (61), CA1810 (37), CA1510 (21), CA1822 (16), CA1307 (14), CA1720 (13), CA1813 (11), CA2201 (11), CA1032 (10).

**New results vs base.**
* Fingerprint: ruleId + repo-relative file + normalised message; line numbers ignored.
* When a fingerprint's count grows, the occurrences that sit on lines the branch added or modified are attributed as the new ones.
* Every new result below is on a changed line.

| ref | new | by level | by rule | high-severity |
|---|---|---|---|---|
| 2129 | 42 | 3 warning, 39 note | IDE0007 ×26, CS1591 ×8, IDE0028 ×4, **CA1859 ×2** (warning, Performance: `GeneratedFormatterCollector.cs:131,147`), **CA1813 ×1** (warning, Performance: unsealed `GeneratedMessagePackFormatterAttribute`, `Attributes.cs:166`), SA1101 ×1 | 0 |
| 2234 | 0 | – | – | 0 |
| 2283 | 1 | 1 note | SA1101 (`TypeCollector.cs:239`) | 0 |
| 2297 | 0 | – | – | 0 |

No branch removes any base finding (`resolved_vs_base_count = 0`).

## 2. Setup and exact commands

**Work area.**
* `corpus/dotnet/<ref>/`: one full local `git clone` of `corpus/messagepack-csharp` per ref, with `origin/ju26-issue-*` fetched.
  * Checkouts: `lab-base` at 32258fdb, and `lab-<n>` at `origin/ju26-issue-<n>`.
  * Full clones rather than worktrees, so the source repo is never written to and Nerdbank.GitVersioning has full history.
* Scripts and config (also copied to `out/dotnet/_lab/`):
  * `env.sh`
  * `run_ref.sh`
  * `lab.runsettings`
  * `lab-analysis.targets`
  * `merge_coverage.sh`
  * `analyze.py`

**Environment** (`env.sh`):
```bash
export DOTNET_ROOT="$HOME/.dotnet"; export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 MSBUILDDISABLENODEREUSE=1 DOTNET_CLI_UI_LANGUAGE=en
export ROSLYN412=$HOME/.nuget/packages/microsoft.net.compilers.toolset/4.12.0/build/Microsoft.Net.Compilers.Toolset.props
```

* `global.json` pins SDK 8.0.402, which is installed, so there is **no SDK override**.
* The Roslyn 4.12 compiler package was obtained with a NuGet restore of a throw-away project in the scratchpad: `<PackageDownload Include="Microsoft.Net.Compilers.Toolset" Version="[4.12.0]"/>`.
* `dotnet-coverage` 18.12.0 was installed as a global tool. It was only used for the reference merge (`coverage.merged.dotnet-coverage.xml`).

**Per test project** (`run_ref.sh`, run in each clone):
```bash
dotnet build tests/<P>/<P>.csproj -c Debug -p:CustomBeforeMicrosoftCommonProps=$ROSLYN412
dotnet test  tests/<P>/<P>.csproj --no-build -c Debug \
  --logger "trx;LogFileName=<P>.trx" --results-directory out/dotnet/<ref>/tests/<P> \
  --collect "Code Coverage;Format=cobertura" --settings lab.runsettings --blame-hang-timeout 10m
```

* `lab.runsettings` is a copy of `azure-pipelines/test.runsettings` with two changes:
  * Instrumentation is limited to `MessagePack*.dll`, excluding `*Tests.dll` and `*ExternalTypes.dll`.
  * The `GeneratedCodeAttribute` exclusion is removed, so the T4-preprocessed templates are measured.
* Coverage uses the repo's own engine: Microsoft.CodeCoverage via Microsoft.NET.Test.Sdk 17.12, the same as CI. The repo does not reference coverlet, and none was added.

**Analyzer build** (Release, full rebuild so every `CoreCompile` runs):
```bash
dotnet build src/MessagePack/MessagePack.csproj -c Release --no-incremental -p:CustomBeforeMicrosoftCommonProps=$ROSLYN412 \
  -p:CustomAfterMicrosoftCommonTargets=lab-analysis.targets -p:LabSarifDir=out/dotnet/<ref>/sarif \
  -p:EnableNETAnalyzers=true -p:AnalysisMode=All -p:TreatWarningsAsErrors=false
```

* `lab-analysis.targets` sets `<ErrorLog>$(LabSarifDir)/$(MSBuildProjectName).$(TargetFramework).sarif,version=2.1</ErrorLog>`.
  * Setting it inside a targets file avoids escaping the comma on the command line.
  * It gives one SARIF file per project and target framework. A single `-p:ErrorLog=` would be overwritten by each of MessagePack's 4 target frameworks.
* The repo's existing analyzers also run and appear in the SARIF: StyleCop, CSharpIsNullAnalyzer, PublicApiAnalyzers, Microsoft.CodeAnalysis.Analyzers, and IDE rules via `EnforceCodeStyleInBuild`.

**Aggregation.**
```bash
python3 -I out/dotnet/_lab/analyze.py
```

* Writes `summary.json`, the JUnit XML files and `coverage.merged.cobertura.xml`.
* Patch-coverage diff: `git diff --unified=0 --no-renames 32258fdb...HEAD -- src/`, counting `+` lines in `*.cs` files that are not test files.

**Timings.** All 5 refs ran in parallel, about 13 minutes wall clock in total (15:29 to 15:42). Per ref:
* Builds: about 150 s.
* Tests with coverage: about 60 s.
* Analyzer build: about 580 s. The 5 refs share one VBCSCompiler server; a single analyzer build alone takes 79 s.
* `analyze.py`: 12 s.

## 3. Problems hit and how they were solved

1. **ExecutionTests "does not compile"**, with `CS0117 'MyGeneratedCompositeResolver' does not contain a definition for 'Instance'`.
   * Root cause: warning `CS9057`. The source generator references Microsoft.CodeAnalysis **4.12** (`Directory.Packages.props`), but SDK 8.0.402 ships csc **4.11**. The compiler silently refuses to load the generator, so no code is generated.
   * Fix: inject the `Microsoft.Net.Compilers.Toolset` 4.12.0 compiler with `-p:CustomBeforeMicrosoftCommonProps=…/Microsoft.Net.Compilers.Toolset.props`. This needs no source edit and no SDK change.
   * Result: ExecutionTests, MapModeExecutionTests and GeneratedCode.Tests build and pass on all refs.
   * The same compiler is used for every build, including the analyzer builds, so results are comparable.
2. **No coverlet.** Central Package Management means you cannot add `coverlet.collector` from the command line. The repo's CI uses the Microsoft "Code Coverage" collector, which works on macOS arm64, so that was used instead.
3. **`dotnet-coverage merge` of Cobertura inputs gives unstable branch counts.** For the same unchanged MessagePack.dll, branches-valid came out as 3845–4053 against 4827 in every per-project report.
   * Fix: `analyze.py` does its own union per (assembly, file, line). Line union is exact; branch union is a lower bound.
   * The dotnet-coverage output is kept only as `coverage.merged.dotnet-coverage.xml`, for reference.
4. **Output names with user and host.** Microsoft CodeCoverage names files `<user>_<host>_<date>.cobertura.xml`, and TRX files carry `runUser` and `computerName`.
   * Attachments were renamed to `<project>.cobertura.xml`.
   * `runUser`, `computerName` and the hostname were redacted in TRX files and logs.
   * Absolute local paths remain in the Cobertura and SARIF files.
5. **Tracked files under `bin/`.** The repo tracks Unity `.meta` and `package.json` files there. Cleaning `bin/` in the base clone deleted them, and `git checkout -- bin` restored them. The clones have no other changes.
6. **Branch-wide diffs include test-resource churn.** 2297 touches 237 files, mostly `tests/**/Resources/*.g.cs` snapshots. Patch coverage only counts `src/**/*.cs` files that are not test files. `*.tt`, `*.md` and test files are listed under `changed_files_not_considered`.

## 4. What is incomplete or out of scope (recorded as missing, not zero)

* **Every measurement step succeeded on every ref.** Every build, test run, coverage collection and SARIF build exited with code 0. `incomplete` entries with `kind: "failure"` are empty for all refs.
* `kind: "scope_limit"` entries, the same for every ref:
  * **Generator code run inside the compiler is not instrumented.** ExecutionTests, MapModeExecutionTests and GeneratedCode.Tests run the generator inside csc at build time. Patch coverage of generator code therefore comes only from the in-process `MessagePack.SourceGenerator.Tests`, and is a lower bound. Example: 2129's `MessagePackGenerator.cs:73-75`.
  * **Not run on macOS:** net472 test targets (Windows only) and the Unity test suites.
  * **Not analysed:** src projects outside `src/MessagePack` and its references. These are ImmutableCollection, ReactiveProperty, AspNetCoreMvcFormatter, Experimental, UnityShims and SourceGenerator.Unity. No PR touches them.
  * **Merged branch coverage is a lower bound** (see problem 3).
  * **`*.tt` changes are measured through their checked-in preprocessed `.cs` files.**
  * **Flakiness was not measured.** Each test ran once per ref. Run-to-run line noise on unchanged code is at most 7/17647 lines.
* `MessagePack.Analyzers` has no source files, so it has no coverage. That is "nothing to measure", not 0%.

## 5. Files

* `out/dotnet/summary.json`: for each ref, `tests`, `coverage`, `patch_coverage`, `analyzers` (by_category, by_rule, by_severity, new_vs_base), `gate` and `incomplete`.
* `out/dotnet/<ref>/tests/<project>/<project>.{trx,junit.xml,cobertura.xml}`
* `out/dotnet/<ref>/coverage.merged.cobertura.xml`
* `out/dotnet/<ref>/sarif/<project>.<tfm>.sarif`
* `out/dotnet/<ref>/logs/*.log`, `status.tsv` (exit code and seconds per step), `commands.txt`
* `out/dotnet/_lab/`: scripts and config to reproduce. Run `run_ref.sh <ref>` for each ref, then `python3 -I analyze.py`.
