# Lessons log · failure modes we saw

Everything below really happened while building Katse and running it on the four Tieto branches. It comes in three parts:

- **A.** Failures of **our own reviewer**. These matter most for the question *"What would make you not trust your own output?"*
- **B.** Failures the reviewer **found in the agent-written changes**.
- **C.** What we **still don't know**.

---

## A. Failures of the reviewer (ours)

### 1. The "blind" agents escaped their isolated copy

**What happened.** In the first full run, the three agents that were supposed to rebuild the change *blind* worked inside the original repository. They created four test files and modified another. That repository contains the PR branches, so they could have seen the answer.

**Why.** We set each agent's working directory but not the `PWD` environment variable, which still pointed at the server folder. The agent CLI trusts `PWD`.

**How it was detected.** Not by the tool. A human noticed it in the agent logs because the rebuilds took longer than expected. Without that, the report would have presented non-independent rebuilds as "independent".

**What changed.** Three layers, because one is not enough:
- `PWD` is always set when a process is launched.
- Every agent runs inside an OS sandbox that cannot read or write the original repository, other runs, or Katse's own files.
- The original repository's state is compared before and after. If it changed, **all** rebuilds are discarded and the report says so.

**Lesson.** "Blind" is a property of the environment, not of the prompt. It has to be checked, not assumed.

### 2. Half-finished rebuilds counted as rebuilds

**What happened.** In the second full run, all three agents ran out of free quota after writing a single test and fixing nothing. The tool counted that as three rebuilds and concluded "0 of 4 regions match" and "the PR's tests fail in 3 of 3 rebuilds". That was false: the rebuilds did not diverge, they were incomplete.

**How it was detected.** Suspicion: three agents touching one file in 85 seconds have not fixed a code-generator bug. The logs said "Free usage limit reached".

**What changed.**
- Every agent answers a minimal request before starting. One that doesn't respond doesn't take part, and the report says why.
- Agent errors and timeouts are detected.
- A rebuild only counts if it **changes product code, compiles and passes its own tests**. The rest are listed as discarded, with the reason.

**Lesson.** Agreement and disagreement only mean something between finished work. Without this gate, an infrastructure failure looks like a finding.

### 3. The model that should only write text edited the repository

**What happened.** The judge only has to *word* questions. It was called with `opencode run`, without a sandbox, from a folder inside the project. The CLI treated it as a coding task, found the reviewed repository and wrote the PR's code into it. The isolation check missed it because it only watched the rebuild stage, and the judge runs later.

**How it was detected.** At the end of the session, `git status` on the original repository showed a file modified at exactly the time the judge ran.

**What changed.**
- Text-only calls run in an empty temporary folder, with the CLI's read-only agent, inside a sandbox that denies all writes.
- We tested it on purpose by asking a model to write to the repository. It tried, and the system blocked it.
- The original repository is compared at the start and end of the **whole** review. If it changed, the report is marked untrustworthy and the lane becomes "send back".

**Lesson.** Every agent call is code execution, even when you only ask for text. Isolation has to cover every call, not just the ones you expect to write.

### 4. We blamed the PR for a failure that already existed

**What happened.** The first review of #2234 sent the PR back as "does not compile". The test project that failed to compile also fails **without** the PR in this environment.

**What changed.** If something fails to compile or a test fails with the PR, it is checked on the base first. Anything that already failed is removed from the verdict and listed under "not checked" as "not attributable to the change". The exception is projects the PR itself adds: those are its responsibility.

**Lesson.** A reviewer that accuses falsely loses trust as fast as one that lets bugs through.

### 5. The base branch was not the obvious one

**What happened.** The challenge branches do not come from `master`. They come from the repository's default branch, which is 235 commits behind. Compared with `master`, every PR would have looked huge and full of conflicts.

**What changed.** The base is detected from `origin/HEAD`, always shown on screen, and can be changed.

### 6. Tests the sandbox can't run

**What happened.** Two of the ten new tests in #2234 live in the project that doesn't compile here, so they can't be run.

**What changed.** They show as **"not run"**, never as "pass", and they create a question for the human: *have you seen these pass elsewhere?*

### 7. Seeded defects that mean nothing

**What happened.** In #2283 one seeded defect survives at line 985. The mutation removed a `?.` from part of the line the PR didn't touch and that is never null in the tests. It is noise.

**What we do.** It is shown as it is, with the operator and line, for the human to judge. A surviving mutant is a question, not an accusation. Pending improvement: mutate only the tokens the PR changed.

### 8. Rebuild diversity depends on what is installed

**What happened.** The Claude CLI session had expired, so the rebuilds were done with three free models from a single provider.

**What we do.** The report says which models were used and how many rebuilds finished. If all of them come from the same model family, that is a stated reason to distrust the agreement. Since then, NVIDIA Nemotron is used as a second family.

### 9. A provider was down and the tool quietly swapped it

**What happened.** NVIDIA/Verda didn't respond in some runs. The fallback used another Gemini model in its place, so the "two model families" were really one.

**What changed.** The substitution is written in the report and the UI. It no longer counts as cross-family diversity. In the 14 Nov run Nemotron took part for real, with no substitution.

### 10. The defender didn't know our own test adapter

**What happened.** A Deep review of #2283 stopped at 7/10 because a test was disputed. The model defending it didn't know about the test adapter Katse adds to compile the scenario.

**What changed.** The adapter's real implementation is now included in the context. An independent check with Nemotron then admitted the same test (5.5 s, 5,757 tokens). The historical report was not rewritten.

### 11. An attack died on the context limit

**What happened.** In #2129 the final attack was invalid before it ran: 35,872 estimated input tokens against a 16,000 limit.

**What we do.** It is reported as "invalid test, context limit", never as a pass. The verdict stays at **insufficient evidence**. Large changes need a smaller, scoped context, which is why the graph lets you review one function at a time.

### 12. No local model, so no cloud call (fail-closed worked)

**What happened.** On a machine where the local Gemma model wasn't running, the strict-privacy reviews of #2234 and #2297 could not scan the code.

**What we do.** Nothing was sent to the cloud. The report lists *"Privacy blocked cloud transmission: local Gemma unavailable"* under pending evidence, and the verdict is **insufficient evidence**, not an approval. This is the intended behaviour: privacy failures block, they don't leak.

### 13. A failure in an alternative is not a failure of the original

**What happened.** In #2283 both rebuilt alternatives failed `ClosedGenericStruct_FromMetadataReference_UnkeyedMember` (two `MsgPack004` diagnostics where zero are expected). The original PR passed it.

**What we do.** A candidate-only failure is an audit note, not a defect of the PR. It shows that **finishing a review doesn't make a candidate correct**, and that the PR handled a case the rebuilds missed.

### 14. Demo provenance is partly staged, and we say so

**What happened.** The Tieto branches carry no saved prompts. To show the Entire layer in the demo, the `easy/*` demo branches were seeded with checkpoint fixtures.

**What we do.** Those fixtures are marked `seeded` in the code. The Tieto reports always say *"Original author prompt: not available, intent rebuilt from the requirement"*.

---

## B. Failures the reviewer found in the changes

### 15. Tests that test nothing (#2234)

Of the 10 new tests, **4 also pass without the change**. Run against the base, they are green. A test that doesn't fail before the change doesn't show the change is needed. Reading the diff, they look reasonable; you only see it by running them without the code.

### 16. The change does more than the requirement asks (#2283)

The issue asks for the crash to stop. The change also **drops** every diagnostic whose location isn't in the current compilation, and documents that as a rule. The code says so in its own comment ("they are dropped here"), and the *silences existing behaviour* rule flags it. That is a product decision the requirement never mentions, so **Katse refuses to decide it and asks the owner**.

### 17. A hidden anomaly in a mechanical change (#2297)

237 files. 228 are generated snapshots where the same 3-line block repeats 402 times. **One** of them also changes differently. By hand, that anomaly gets lost. The human reads **32 lines out of 1,392**.

### 18. The requirement says "everywhere", the change excludes targets (#2297)

The issue asks for the attribute on all generated code. The change wraps it in `#if !NETSTANDARD2_0 && !NETFRAMEWORK`. The sandbox compiles only one target, so the other side of the `#if` never ran. It becomes a question and a "not checked" item.

### 19. A requirement that doesn't say what's correct (#2234)

The issue is 149 characters long. It says the analyzer "doesn't work" and that it used to. There is no expected behaviour and no repro steps. Even if the tests pass, they only show the code does what the agent decided. Lane: **send back**.

### 20. New public surface (#2129)

A new public attribute, a new public type and four diagnostic IDs. There is no shortcut: a **full read** of the 450 lines of residue. The report only orders the reading, and the judge records an unresolved ambiguity in the requirement (how keys are specified for types in assemblies without a MessagePack dependency).

---

## C. What we still don't know

- **Real escapes.** Nothing has been merged, so "0 escapes" proves nothing yet.
- **Whether token-level comparison misjudges.** Two equivalent changes written differently can show as "different". Cross-tests only partly compensate.
- **Cost at scale.** We have measurements for four PRs on a few machines.
- **Whether rebuilding beats direct review at the same budget.** That has not been shown experimentally yet.
