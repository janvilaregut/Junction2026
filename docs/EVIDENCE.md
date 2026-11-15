# Evidence · the sample change and its trust brief

This is the reference walkthrough the challenge asks for: **one agent-written change with its requirement ID**, what the AI **found**, what it **refused to decide** and why, and how the evidence lets a **named human accept the change without a full read**.

- **Sample change:** Tieto branch `ju26-issue-2283` (head `9df83c38`, base `32258fdb`)
- **Requirement ID:** [MessagePack-CSharp/MessagePack-CSharp#2283](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2283), *"Generator and analyzer crash with IndexOutOfRangeException on a closed generic struct from a referenced assembly"*
- **Size:** 4 files, +225 / −3 lines (228 changed)
- **Raw report:** [evidence/ju26-issue-2283-mwg8tdv2.json](evidence/ju26-issue-2283-mwg8tdv2.json). Every claim below points to an artifact in it. The tool's first UI was in Spanish, so some labels inside the raw JSON are Spanish (*reproducido* = reproduced, *parcial* = partial, *no ejecutado* = not run).

> The demo video uses a small synthetic branch (`easy/lz4-guards`) so the idea fits in a few seconds. The numbers on this page come from Tieto's own branch.

---

## 1. The contract: what the requirement actually asks

Before judging any code, Katse rebuilds a short **contract** from the requirement. Every expectation must cite a sentence that is **literally** in the source (checked by string search).

| ID | Expected behaviour | Quoted source | Critical |
|---|---|---|---|
| **E1** | The generator emits a resolver without `IndexOutOfRangeException` when a `[MessagePackObject]` has a closed generic struct member from a referenced assembly | *"A clean build, with a generated resolver in `app`."* (issue #2283) | yes |
| **E2** | The analyzer doesn't throw `IndexOutOfRangeException` (AD0001) in the same case | *"Analyzer 'MessagePack.SourceGenerator.Analyzers.MsgPack00xMessagePackAnalyzer' threw an exception of type 'System.IndexOutOfRangeException'"* (issue #2283) | yes |
| **E3** | Existing generic formatter generation keeps working | existing test `RecursiveGenerics_Direct` (base code) | no (inferred) |

## 2. What the AI found, all of it executed

| Claim | Result | Evidence |
|---|---|---|
| Merges cleanly on the pinned base and compiles | **Reproduced** | build log, .NET SDK 8.0.402 |
| The PR's 3 new tests **fail on the base and pass with the change** (red→green) | **Reproduced, 3/3** | `red.log` |
| Doesn't break existing tests | **Reproduced**: 170/170 (Standard), **174/174** (Deep run `mwgpjs3o`) | suite logs / TRX |
| Seeded defects in the changed lines are caught | **3 of 4** (Deep). The survivor at line 985 is reported, not hidden | `mutation.json` |
| Independent rebuilds from the base (blind, no PR visible, fresh history) | **2 alternatives built**: C1 Gemini Hydrogen, C2 NVIDIA Nemotron in run `mwgfnpkl`. In the raw report above Nemotron was offline, so the report states the substitution and counts no cross-family diversity | candidate patches + Entire checkpoints |
| Executable attack A1: *"a closed multi-parameter readonly struct with `[SerializationConstructor]` from a referenced assembly makes it throw"* | **Refuted**: passes on the original and on both candidates | evidence `157950fa`, `229623d7`, `d4515288` |
| Alternatives vs original | Both alternatives **fail** `ClosedGenericStruct_FromMetadataReference_UnkeyedMember`, which the **original passes**. Audit note: the PR handles a case the rebuilds missed | suite logs |
| Node probe: a unique failure injected into `GetObjectInfo` | The test turns red, so it really exercises that method | probe artifact |
| A planted **false** accusation | **Thrown out by running it** | acceptance control |

## 3. What the AI refused to decide, and why

Katse **does not decide** things the requirement doesn't settle. It turns them into questions for the owner.

| Open question | Why the AI won't decide it | Options for the owner |
|---|---|---|
| **The change silently drops diagnostics** at `TypeCollector.cs:1441`. Its own comment says *"they are dropped here"* | The issue asks for the crash to stop. It **never asks to silence anything**. Silencing is a product decision: if it hides a real error, nobody will see it | Accept as is · send back to the author · split into another change |
| **Regions no rebuild produced** (`TypeCollector.cs:239`, `1429–1451`) | No independent rebuild made this change, so the requirement doesn't force it. It may be intended scope or overreach | Accept · send back · split |

**Recommendation shown to the owner:** *Ready for human approval*, which **is not an approval**. The rubric reads **7/10** and every point is shown: contract 4/4, regressions 3/3, risk groups attacked 0.67/2 (1 of 3), independent repetition 0/1. The rubric is explicitly *"evidence, not a probability that there are no bugs"*.

## 4. What was not checked, and why

Always visible, never hidden behind a green tick:

- **NativeAOT and trimming**: the requirement mentions them, and the sandbox has no AOT job.
- **Windows** and **.NET 10**: the requirement mentions them, and the sandbox ran macOS with SDK 8.0.402.
- **The other 7 test projects** in the repo: only the affected projects run.
- **The original author's prompt**: the commit carries no Entire session, so the intent was rebuilt from the issue.
- **Performance** (no benchmarks) and **deep security** (only rules on sensitive zones).
- **Three changed functions still pending** in the graph: only 27% of the weighted executable scope is verified, so **a global sign-off is blocked** until the owner reviews or verifies them.

## 5. What the human reads and signs

| | |
|---|---|
| Lines changed | **228** |
| Residue to read | **29 lines** in 4 spots (`TypeCollector.cs` 239, 985, 1077, 1429–1451) |
| Questions to answer | **2** (the silent drop, the unrequested regions) |
| Area trust | `src/MessagePack.SourceGenerator/CodeAnalysis`: **probation**, 0/5 clean sign-offs, so a second reviewer audits |

The named owner signs a statement that contains:

1. **What was checked, and by what:** the build, red→green 3/3, 174 regression tests, 3/4 seeded defects, attack A1 refuted on original and two alternatives from two model families, and a probe on `GetObjectInfo`.
2. **What was not checked, and why:** the list in section 4.
3. **The residual risk they accept**, in their own words, e.g. *"I accept that diagnostics for types located outside the current compilation are dropped, as documented in MsgPack004.md; AOT and Windows remain unverified."*

The signature is bound to commit `9df83c38` and the report hash, and it **expires if the branch moves**. Katse never merges.

## 6. Cost and time (real, on a laptop)

| Run | Depth | Time | Tokens | Result |
|---|---|---|---|---|
| `ju26-issue-2283-mwgfnpkl` | Standard, Nemotron active | 4 min 29 s | 40,247 | 171/171 original; ready for human approval |
| `ju26-issue-2283-mwgpjs3o` | Deep | 11 min 05 s | 114,151 | 174/174; 3/3 red→green; 3/4 mutants |
| `ju26-issue-2283-mwgpzdzn` | Standard continuation | 4 min 23 s | 20,024 | 175/175; 9/10 rubric, 3 nodes still pending |

---

## The other three Tieto branches: different lanes, different reasons

Each was reviewed the same way. Raw reports are in [evidence/](evidence/).

| Branch · requirement | Size | What Katse found | Refused to decide / sent back | Human reads |
|---|---|---|---|---|
| `ju26-issue-2297` · [#2297](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2297) | 237 files, 1,392 lines | 228 generated files are the same 3-line block repeated; **one snapshot changes differently**. 2/2 new tests red→green, 169 regressions pass | The whole change sits inside `#if !NETSTANDARD2_0 && !NETFRAMEWORK`, but the issue says "all generated code". Only one target can run, so the owner is asked whether the exclusion is intended | **32 of 1,392 lines** (2%) |
| `ju26-issue-2234` · [#2234](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2234) | 4 files, 266 lines | **4 of 10 new tests already pass without the change** (no teeth). 2 tests can't run here (their project doesn't build even without the PR, so not blamed on the change). 175 regressions pass | **The requirement is 149 characters with no expected behaviour or repro**, so passing tests only prove the code does what the agent decided. Verdict: *insufficient evidence*, *clarify the requirement*. Also: local Gemma was unavailable, so **privacy blocked every cloud call** (fail-closed) | Send back to clarify |
| `ju26-issue-2129` · [#2129](https://github.com/MessagePack-CSharp/MessagePack-CSharp/issues/2129) | 28 files, 1,043 lines | **New public API** (`GeneratedMessagePackFormatterAttribute`, `GeneratedFormatterRequest`) and new diagnostic IDs. 6/14 new tests red→green, 8 can't run here, 173 regressions pass | Public API design is a product decision: **full read**. The judge also records an unresolved ambiguity in the requirement (how keys are set for types in assemblies without MessagePack), and one attack was invalid (context limit), reported as such | **Full read**, 450 lines of residue, in the order the report gives |

**Across the four:** one change reaches *ready for human approval*, one is sent back for a better requirement, one needs a full read because of public API, and one gets a targeted 2% read plus a question. The same tool says **"don't trust this yet"** as readily as "this is fine".
