# Repeated runs: cost and sample size

How many times to run the same prompt so the result means something statistically, how to keep that from costing N times as much, and how to combine the runs into one change. Research notes for Katse's consensus and replica levels, gathered 2026-11-14. Nothing here is implemented yet.

## Recommendation (summary)

- **Don't use a fixed N. Sample until the agents agree.** Start with 3 agents. If they agree on behaviour (the same tests pass and fail), stop. Otherwise add 2 at a time, up to a cap of 8–10.
- **Diversity is worth more than extra samples.** Samples from the same model are correlated, so 20 of them carry the information of only a few. Vary the model, the mission and the plan, not just the temperature.
- **Explore once, sample many times.** One agent gathers the repo context, and every sample starts from it, sharing a cached prompt prefix.
- **Sample plans, not code.** Generate many cheap plans, cluster them, and implement one per distinct cluster.
- **Use a cheap model for samples and a strong model to judge and merge.**
- **Merge deterministically.** Keep the edits that several candidates share and that tests support. Avoid free-form LLM "merge everything" rewrites.
- Estimated cost (not measured): about **4–6× a single run**, instead of 20× for naive 20-way sampling, and with more real diversity.

## 1. How many runs are statistically significant

### Correlation caps what more samples can tell you
With pairwise correlation ρ between samples, n samples are worth roughly `n_eff = n / (1 + (n−1)·ρ)` independent ones, and `n_eff` can never exceed `1/ρ`. At ρ = 0.3, 20 samples are worth about 3 independent ones (my calculation). This "correlation ceiling" is described in [When More Sampling Hurts](https://www.alphaxiv.org/abs/2606.28661.md). Measurements on Gemini 2.5 show gains topping out around 10 paths and dropping past 15 while cost keeps rising linearly ([Self-Consistency Is Losing Its Edge, arXiv 2511.00751](https://arxiv.org/pdf/2511.00751)).

Model-generated code also has low algorithmic diversity. Heterogeneous models help more than raising the temperature ([Lee et al., EMNLP 2025 Findings](https://preview.aclanthology.org/new-sigs/2025.findings-emnlp.10/); [SimpleStrat](https://arxiv.org/pdf/2410.09038)). At low temperature, Gemini 2.0 Flash showed no gain beyond 5 samples on Verilog ([VerilogMonkey](https://arxiv.org/pdf/2509.16246)).

### Useful formulas (assuming independent agents; numbers are my own calculations)
- **To see an approach at least once** when it shows up with frequency p, with 95% confidence: `n ≥ ln(0.05) / ln(1 − p)`.
  - p = 50% → 5 agents · p = 30% → 9 · p = 20% → 14.
  - This is the number that matters for "take the best part of each run": rare good ideas need many samples. That is the argument for cheap plan sampling (section 2.3).
- **To claim a real majority** (95% two-sided Clopper–Pearson lower bound above 50%):
  - 5/5 is not enough (lower bound 0.478). You need 6/6 (0.541), 8/9 (0.518) or 9/10 (0.555). 8/10 is still not enough (0.444). *(Corrected on review: an earlier draft said 8/10.)*
  - 4/5 has a lower bound of about 0.28. Five agents show a trend but prove nothing.
- **Rule of three:** if 0 of n agents do something, its true rate is at most 3/n at 95% confidence.

### Does it depend on lines of code?
Indirectly. Single-attempt success drops as code gets longer and more complex ([arXiv 2407.06153](https://arxiv.org/pdf/2407.06153); [arXiv 2406.08731](https://arxiv.org/html/2406.08731v2)). I found no published formula that maps lines of code to a sample count.

What matters is the **number of independent decisions** (Katse's zones or change groups). To get all k zones right at once, the error budget is split across zones (Bonferroni), so the required N grows slowly, roughly with ln(k). Katse's existing replica rule, `min(6, 1 + change groups + high-risk groups)`, already scales with decision points, which is the right axis.

### Adaptive stopping beats a fixed N
- Adaptive-Consistency: up to 7.9× fewer samples with an average accuracy drop below 0.1%, across 17 reasoning and code datasets ([arXiv 2305.11860](https://arxiv.org/abs/2305.11860v1)).
- CONSOL uses a sequential probability ratio test to stop once one answer is significantly ahead ([overview](https://alphaxiv.org/overview/2503.17587v1)).
- Difficulty-aware allocation: adaptive best-of-k matched non-adaptive results with up to 50% less compute on math and code ([bandit allocation, arXiv 2506.12721](https://arxiv.org/pdf/2506.12721)).

## 2. Cost levers (highest impact first)

### 2.1 Explore once, share the context
In an agent harness, input tokens dominate, because every turn resends the context. CodeMonkeys pays once for codebase context retrieval and reuses it across many parallel samples ([arXiv 2501.14723](https://arxiv.org/pdf/2501.14723)). For Katse: one agent explores (relevant files, tests, notes), and the N samples start from that summary instead of each re-reading the repo.

### 2.2 Prompt caching
Gemini 2.5 and later have implicit caching enabled, with a 90% discount on cached tokens but no guaranteed saving. Explicit caching does guarantee it ([Gemini API optimization docs](https://ai.google.dev/gemini-api/docs/optimization); [implicit caching announcement](https://developers.googleblog.com/en/gemini-2-5-models-now-support-implicit-caching/)).

The design rule is to keep the **start** of the prompt identical across agents (tools, instructions, shared context) and put each agent's mission at the **end**. Temperature and topK are request parameters and don't break the cache. Check that `gemini-4-carbon` gets the same discount.

### 2.3 Sample plans, not code
PlanSearch generates observations and natural-language plans first and writes code last. It raised pass@200 from 60.6% (plain repeated sampling) to 77.0% on LiveCodeBench ([ICLR 2025, arXiv 2409.03733](https://arxiv.org/html/2409.03733v2)). A plan costs a few hundred tokens, while an agentic implementation costs tens of thousands. So: 15–20 plans, cluster them, implement one per distinct cluster (typically 3–5).

### 2.4 Cheap model for samples, strong model to judge
In Large Language Monkeys, 5 samples from a cheaper model solved more SWE-bench Lite issues than one sample from GPT-4o or Claude 3.5 Sonnet, at over 3× lower cost ([arXiv 2407.21787](https://arxiv.org/html/2407.21787v3)). For Katse: a Flash-class model and/or a low thinking level for drafts, and the top model with high thinking only for debate and merge. Thinking tokens bill as output.

### 2.5 Cluster by behaviour, not text
AlphaCode and CodeT group candidates by execution results ([CodeT, arXiv 2207.10397](https://arxiv.org/pdf/2207.10397)). Agentless drops patches that fail regression tests, normalizes the rest and majority-votes ([arXiv 2407.01489](https://arxiv.org/abs/2407.01489)). Running tests is nearly free compared with LLM calls, and it tells you how many truly distinct solutions exist before you pay for any debate.

### 2.6 Debate less
A sparse debate topology matched or beat fully connected debate with about 40% fewer tokens ([Google Research, EMNLP 2024 Findings](https://research.google/pubs/improving-multi-agent-debate-with-sparse-communication-topology/)). Pruning redundant viewpoints helps too ([S²-MAD, arXiv 2502.04790](https://arxiv.org/pdf/2502.04790)). Only representatives of distinct clusters should debate, never agents that already agree.

### 2.7 Batch API (50% off), for non-interactive runs only
Gemini's Batch API costs 50% of the standard price but can take up to 24 h ([docs](https://ai.google.dev/gemini-api/docs/optimization)). Whether it stacks with the cache discount is unconfirmed. Whether `candidateCount` bills input tokens only once is claimed only by third-party tutorials, not by Google, so test it before relying on it.

### Cost and accuracy reference points
- CodeMonkeys: 57.4% on SWE-bench Verified for about $2,300 total. Selection cost about $20 of that, context retrieval about $334 (about 15%). Coverage reached 69.8%, versus 45.8% for random selection ([arXiv 2501.14723](https://arxiv.org/html/2501.14723v1)).
- Selecting over the top 4 existing SWE-bench submissions scored 66.2%, above the best single member (same paper).

## 3. Combining runs: select or fuse deterministically

Free-form LLM fusion (asking a model to write one merged program) performed substantially worse in a 2026 comparison. It produced many malformed or unapplicable outputs and often failed to pick the correct existing patch.

**PatchFusion** splits candidates into edit atoms and keeps only the atoms several candidates share. It solved 426/500 on SWE-bench Verified and 236/300 on SWE-bench Multilingual, and every output line traces back to a candidate or to the repo ([arXiv 2607.01597](https://arxiv.org/pdf/2607.01597)). That traceability fits Katse's evidence-first approach and its per-zone heatmap. A large study also found judge-based selection beating MoA-style synthesis in all 42 tasks tested ([arXiv 2603.20324](https://arxiv.org/pdf/2603.20324)). Self-MoA, which aggregates samples from the single best model rather than mixing models, is the stronger synthesis variant ([arXiv 2502.00674](https://arxiv.org/abs/2502.00674)).

Only a good selection step turns a candidate pool into results ([Wisdom and Delusion of LLM Ensembles, arXiv 2510.21513](https://arxiv.org/html/2510.21513v2)). S* combines parallel samples, debugging rounds and adaptively generated distinguishing test inputs for selection ([arXiv 2502.14382](https://arxiv.org/html/2502.14382v1)).

## 4. Proposed pipeline for Katse

1. **Explore once** and build the shared context (cached prefix).
2. **15–20 plans** from a cheap model, each with a distinct mission at the end of the prompt.
3. **Cluster the plans** and pick one representative per cluster (3–5).
4. **Implement the representatives** with a Flash-class model, low thinking, cached prefix.
5. **Run the tests and cluster by behaviour.** If 3 agree, stop. Otherwise add 2 at a time, up to 8–10.
6. **Debate only between cluster representatives.**
7. **Fuse deterministically** with the top model: keep the edit atoms that several candidates share and tests support, trace each line to its source, and send whatever remains unresolved to the human reviewer.

Estimated cost about 4–6× a single run (estimate, not measured).

## Caveats
- Formula-based numbers assume independent agents. Real agents are correlated, so treat them as lower bounds on what's needed.
- Prices and discounts change. Check the current Gemini pricing page before relying on the figures.
- Several numbers come from secondary summaries of papers. Check the original PDFs before quoting them externally.

*Research by the Claude session "cost optimization / number of runs", 2026-11-14.*
