# Concept card · Katse

> **AI reviews. A named human stays accountable.**
> Katse does not ask an AI whether a change *looks* right. It **reproduces** the change and keeps only the part that does not reproduce for a person to read and sign.

---

## 1. Recommendation

**Don't read the change. Reproduce it.**

A change written by an agent is cheap to produce, so it is also cheap to produce again. Science trusts a result when another lab repeats it. Banking trusts the books when two independent ledgers reconcile. Katse does the same for code:

- Whatever a machine can **independently reproduce or prove** is backed by executable evidence.
- Whatever does **not** reproduce is the **residue**. The named owner reads the residue, answers the open questions and signs. Nobody has to read the rest line by line.

Review stops scaling with **lines** and starts scaling with **decisions**.

## 2. How the "PR review factory" works: four layers

Cheapest and most certain first. Each layer shrinks what the human has to read.

| # | Layer | What it does | Who decides |
|---|---|---|---|
| 1 | **Privacy** | Gemma 4 runs **on the laptop** and swaps secrets and internal names for aliases before any code reaches a cloud model. If the scan cannot finish, nothing is sent (fail-closed). | Local model |
| 2 | **Maths** | Builds the call graph straight from git, ranks every function by blast radius (PageRank), proves edits that cannot change behaviour, and runs deterministic checks (leaked keys, silenced errors, untested code). Same input, same answer. | **No AI** |
| 3 | **Reproduce** | Goes back to the **intent** (the Entire prompt behind the commit, else the issue, else the commit message). Independent agents from **two model families** rebuild the change **blind** from that intent. Same result means reproduced. A difference sends in a judge, who must **quote the requirement sentence** that decides it, checked by plain string search. Tests must go red→green, and seeded bugs must be caught. | AI, checked by execution and by string search |
| 4 | **You** | A **named engineer** reads only the residue, answers each open question, writes the residual risk they accept, and signs. The signature is bound to the commit and the report hash. **Katse never merges.** | **The human owner** |

## 3. Principles

1. **Reproduce, don't read.** Rebuilding is cheap. Reading every line does not scale.
2. **Evidence is executable, or it isn't evidence.** Every claim links to a test run, a log, a proof or a quoted sentence.
3. **Consensus directs attention. It never approves.** Agreement between models only tells you where *not* to look first.
4. **Models can add doubt, never remove it.** A model can open a question. It cannot close one or turn a node green.
5. **The AI says what it refused to decide, and why.** "Insufficient evidence" and "send back" are valid results.
6. **A named human signs:** what was checked, what was not, and the risk they accept.
7. **Depth follows readable rules, not a score.** Public API, security, or an area with a past escape always gets a full read.
8. **Trust is earned per area and withdrawn after an escape.** The reviewer itself is measured too.
9. **Provenance first.** Every agent change should carry its requirement ID and, ideally, its prompt.
10. **Your code never leaves raw.** Privacy is checked before the cloud, not promised after.

## 4. How it balances the five forces

| Force | Mechanism |
|---|---|
| **Risk** | Named rules route each change to a lane: *reproduced*, *residue only*, *you decide*, *full read*, *send back*. Public API, security and withdrawn areas always get a full read. |
| **Hallucination** | No claim without something executed behind it. Blind rebuilds in a copy with no git history. Judge quotes are string-checked. A planted false accusation is refuted by running it. |
| **Transparency** | Three lists are always visible: **checked**, **not checked**, **not decided**. Each item links to its artifact. |
| **Confidence** | Discrete states (*reproduced*, *partial*, *fails*, *not run*), never a bare confidence percentage. The 0–10 rubric always shows its components and is never an approval. |
| **Quality** | Tests with teeth: red on the base and green with the change, seeded mutations, cross-tests between independent rebuilds, and a failure injected into each method to prove the test notices. |

## 5. Who owns the decision

**One named human.** Katse has no "approve" button and never merges. To sign, the owner must:

1. answer every open question (accept, send back, or split the change),
2. confirm what they read,
3. write, in their own words, the residual risk they accept.

The signature records **what was checked (and by what)**, **what was not checked (and why)** and **the accepted risk**. It is tied to the commit SHA and the report hash, and it **expires as soon as the branch moves**.

## 6. How trust is measured

| Metric | What it tells you |
|---|---|
| **Lines read ÷ lines changed** | Human attention per change. Example: Tieto #2297, 32 of 1,392 lines. |
| **Share routed to a full human read** | How much work still needs full attention. |
| **Seeded defects:** caught by tests / routed to the human / would escape | Whether the tests and the reviewer catch known bugs, without waiting for production incidents. |
| **Findings acted on** | Open questions where the owner did *not* just click "accept", which shows the findings are real. |
| **Reviewer stability** | The same commit reviewed twice must land in the same lane. |
| **Escapes per area** (reverts, incidents) | Five clean sign-offs earn an area trust. One escape withdraws it. |
| **Time to sign / cost per review** | Standard review on #2283: about 4.5 min and about 40k tokens. |

**Safety condition:** review time may only go down while escapes don't go up.

Details: [docs/MEASUREMENT.md](docs/MEASUREMENT.md).

## 7. Trade-offs

| We gain | We pay |
|---|---|
| Human attention goes only where the risk is | Compute and tokens for every rebuild (about 40k tokens per Standard review) |
| Evidence anyone can re-run | The report lands minutes after the PR, not seconds |
| Hidden decisions surface (overreach, silent drops, missing targets) | It needs a requirement that says what "correct" means |
| Works with any git repository, no vendor lock-in | Comparing rebuilds is token-level, and equivalent code written differently shows as "different" |

## 8. Limits (and what would make us distrust our own output)

- **Correlated agreement.** Agents from the same model share blind spots. We mix model families, and consensus never approves. *Distrust the result if every rebuild came from one family.*
- **Big redesigns.** Nobody rebuilds 1,000 lines the same way. The change falls back to maths plus a full read.
- **What the sandbox can't run** (performance, other OS/targets, deep security) is listed as **not checked**, never as "passed".
- **A vague requirement can't be fixed by reviewing.** The change is sent back. *Distrust the result if there is no clear requirement and no saved prompt.*
- **Tests without teeth.** *Distrust the result if the new tests also pass without the change*, or if seeded bugs survive outside what the human reads.
- **A non-deterministic reviewer.** *Distrust the result if the same commit lands in different lanes twice.*
- **Automation bias.** People may sign without looking. The signature costs effort, and a second person audits while an area is on probation.
- **Not yet proven at scale.** Measured on four Tieto PRs on a few machines, with no real merges yet, so "0 escapes" proves nothing so far.

---

Evidence on the sample change: [docs/EVIDENCE.md](docs/EVIDENCE.md) · Failure modes: [docs/LESSONS.md](docs/LESSONS.md) · Decision log: [docs/DECISIONS.md](docs/DECISIONS.md)
