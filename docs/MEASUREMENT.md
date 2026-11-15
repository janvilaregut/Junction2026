# Measurement · how trust is measured, not asserted

The challenge asks us to show that **reverts and incidents don't rise as review time falls**, that **AI findings are real and accepted**, the **time to merge**, and the **share routed to humans**. This page says what Katse measures, where it is computed, and what we measured on the four Tieto branches, including what we can't claim yet.

## The safety condition

> **Review time may only go down while escapes don't go up.**

An escape is a revert or incident traced back to a signed change. One escape **withdraws trust from that area** and sends it back to probation: full reads plus a second reviewer.

## What Katse measures

All of these are computed from each review's brief and the trust ledger ([server/ledger.js](../server/ledger.js)). Nothing is a model's opinion.

| Metric | Definition | Answers the judges' question |
|---|---|---|
| **Read ratio** | lines in the residue ÷ lines changed | *Does review time fall?* |
| **Share routed to a full read** | changes in the *full read* lane ÷ all changes | *Share routed to humans* |
| **Seeded defects** | bugs injected into changed lines, sorted into caught by tests / landed in what the human reads / would escape | *Are AI findings real?* (measured without waiting for production) |
| **Findings acted on** | owner answers that weren't "accept" ÷ all answers | *Are AI findings accepted / useful?* |
| **Reviewer stability** | the same PR at the same commit, reviewed twice, lands in the same lane | *Can we trust the reviewer itself?* |
| **Escapes per area** | reverts/incidents after merge, by code area | *Do incidents rise?* |
| **Area trust state** | probation → earned after **5** clean sign-offs → withdrawn on **1** escape | *Trust earned per area, withdrawn after escapes* |
| **Time to sign** | minutes from report to signature | *Time to merge* |
| **Cost** | tokens and minutes per review, reserved before each call and reconciled with provider usage | *How would this scale?* |
| **Verified progress** | `Σw(verified) / Σw(changed)`, `w = 1 + 4·impact`, fixed denominator. Reading or model agreement never moves it | *How much of the change is actually backed by evidence?* |

## What we measured on the four Tieto branches

| Branch | Lines changed | Human reads | Lane / recommendation |
|---|---|---|---|
| #2297 | 1,392 | **32** (2.3%) | targeted read + 1 question |
| #2283 | 228 | **29** (12.7%) | ready for human approval, 2 questions |
| #2234 | 266 | sent back | insufficient evidence: requirement too vague |
| #2129 | 1,043 | **450** (full read of the code) | full read: new public API |

- **Read ratio, excluding the change sent back:** 511 of 2,663 lines → **19%**. Without #2129, which is a deliberate full read, it is **61 of 1,620 lines → 4%**.
- **Share routed to a full read:** 1 of 4 changes. **Sent back:** 1 of 4.
- **Seeded defects on #2283 (Deep):** 4 seeded, **3 caught by tests**, 1 survivor reported to the human (line 985, outside the changed tokens; see [Lessons 7](LESSONS.md#7-seeded-defects-that-mean-nothing)).
- **Tests with teeth:** #2283 3/3 red→green; #2297 2/2; #2234 **only 4/10** (4 pass without the change, 2 can't run); #2129 6/14 (8 can't run).
- **The proof layer attacked on purpose** (`npm run math:selftest`): real functions were mutated in ways that change behaviour, and we counted how many the maths wrongly certified as "can't change behaviour". The answer was **0 of 14,538** on Katse's own repo and **0 of 6,314** on the C# repo (95% upper bound 0.021% and 0.047%).
- **Attention:** on #2297 the maths layer narrows **1,307 changed lines to 55 worth reading**, with no model involved.
- **Rebuild vs direct diff review at the same 300 s budget** (#2283, early version): direct 95 s / 13.9k tokens, rebuild 137 s / 45.2k tokens. Each produced one executable test, both repeating an existing case. **This experiment shows no advantage for rebuilding yet**, and we report it anyway.
- **False accusation control:** a planted false bug was refuted by executing it, so 0 fake findings survived.
- **Reviewer stability:** in 5 of 6 repeated reviews at the same commit and depth, the lane was the same. The exception is #2283 in full mode, where the lane moved from *you decide* to *reproduced* **between two pipeline versions**. Moving to deeper evidence can also change a lane (#2234: quick = *send back*, full = *you decide*, both with "insufficient evidence").
- **Cost:** Standard review of #2283 took **4 min 29 s and 40,247 tokens**. Deep took 11 min and 114k tokens. Maths layer: the whole graph in **475 ms**, no model.
- **Katse's own test suite:** 470/470 pass on macOS (15 Nov). On Windows (14 Nov): 455/456, with one POSIX-only skip.

## What we cannot claim yet

- **Escapes:** nothing reviewed here has been merged, so **0 escapes means nothing yet**. The ledger is ready to record them per area.
- **Time to sign:** no real owner has signed a Tieto PR, so there is no time-to-sign baseline.
- **Rebuilding vs reading at the same budget:** one early experiment found no advantage. It needs a proper benchmark.
- **Scale:** four PRs, a few machines.

## How a team would roll it out

1. **Shadow mode.** Katse writes its brief next to normal human review. Compare the lanes with what reviewers actually found, and record seeded-defect catch rates per area.
2. **Probation areas.** An area moves to *residue-only* review after 5 clean sign-offs. A second person spot-checks while it's on probation.
3. **Watch the safety condition.** Track read ratio and time-to-sign against reverts and incidents per area. One escape withdraws trust from that area automatically.
4. **Audit the reviewer.** Re-review a random sample of commits to measure stability, and keep injecting seeded defects to measure catch rate.
