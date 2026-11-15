# Running Katse

Katse is a **reference implementation** that illustrates the concept, not a product. It runs locally with `npm start` and reviews any git repository. The executable pipeline (build, tests, attacks) targets **C#/.NET**, tuned on the Tieto MessagePack repo.

## Requirements

- **Node 22.15+** (tested on 24) and **Git**
- **.NET SDK 8.0.402** (from the Tieto repo's `global.json`). `~/.dotnet` is detected too
- Optional:
  - **Local Gemma 4** for the privacy layer: oMLX on Mac, or [Ollama](https://ollama.com) on Windows/Linux
  - **Entire** for AI-session provenance (installed into the repo, with a pinned checksum)
- Model keys in `.env.local`, which git ignores. **Never commit keys.**

## Quick start

```bash
npm ci
cp .env.example .env.local      # fill GEMINI_API_KEY (and VERDA_INFERENCE_KEY for NVIDIA Nemotron)
npm start                       # http://localhost:4173
```

Then, in the UI:

1. **Pick a project → "Or clone from a URL"** and enter `https://github.com/te-industry-tech-office/junction26-messagepack-csharp.git`. Katse makes its own copy under `workspace/`.
2. Open branch **`ju26-issue-2283`**. The maths layer (graph, colours, sizes) appears in about a second, with no AI.
3. Click an amber function → **Review with agents**, or open **Review & sign** and choose **Quick / Standard / Deep**.
4. Read the residue, answer the open questions and sign. Katse never merges.

Demo branches used in the video: `npm run demo:cases` (add `-- --reset` to start clean).

## Privacy layer (local Gemma 4)

```dotenv
# .env.local
KATSE_PRIVACY_MODE=strict                    # every cloud call must pass the local scan
KATSE_GEMMA_URL=http://127.0.0.1:8000/v1     # oMLX on Mac (OpenAI-compatible)
# KATSE_GEMMA_URL=http://127.0.0.1:11434     # Ollama, model gemma4:e2b-it-qat
KATSE_PRIVATE_TERMS=InternalName,client.internal
```

```bash
npm run check:privacy     # must print status: passed, mode: strict, scanned chunks > 0
```

Only loopback endpoints are accepted. If the scan is incomplete or unsure, **nothing is sent** and the review waits.

## Command line and API

```bash
node server/cli.js workspace/messagepack-csharp ju26-issue-2283 --completo   # full review from the terminal
```

```http
POST /api/projects/:id/verify   { "pr": "in:ju26-issue-2283", "options": { "mode": "completo", "profile": "standard" } }
POST /api/projects/:id/verify   { "baseRef": "...", "proposedRef": "...", "requirement": "...", "options": { "profile": "deep" } }
POST /api/projects/:id/runs/:run/continue   { "profile": "deep" }
```

Each run writes its full evidence file to `data/runs/<project>/<run>/artifacts/`: contract, patches, sessions, test logs/TRX, budget, verdict and an integrity manifest. Examples are in [evidence/](evidence/).

## Checks

```bash
npm test                  # Katse's own test suite
npm run test:controls     # planted regression + planted false accusation on #2283 (labelled as controls)
npm run math:selftest     # attacks the proof layer: counts behaviour-changing edits wrongly certified (must be 0)
npm run doctor            # providers, JSON, tools and a real Entire checkpoint (uses real API calls)
```

## Entire (AI-session provenance)

```bash
npm run entire            # install (pinned SHA256, inside the repo), enable, recover history
npm run entire -- status  # what's captured, what's unpushed, secret check
npm run entire -- push    # pushes checkpoints only if no secret is found
```

## Models

| Model | Job |
|---|---|
| Gemma 4 (local, `gemma-4-26B-A4B` on oMLX / `gemma4:e2b` on Ollama) | Privacy scan and aliasing on the device |
| Gemini 4 Hydrogen | Contract and blind rebuilds |
| Gemini 4 Carbon | Judge (must quote the requirement) |
| NVIDIA Nemotron 3.5 Super | Second model family for rebuilds |
| Gemini Decisions | Attention routing; can only add doubt |
| Gemini Live | Voice ("Hey Katse") |

Model IDs and endpoints are configurable in `.env.local` (see `.env.example`).

## Known limits of this implementation

- Executable review is tuned for C# and the Tieto #2283 harness. Other languages get the maths layer and rules.
- Local copies on Windows are not an OS security sandbox.
- NativeAOT, .NET 10, other OS targets and the other 7 test projects are not run. They are always reported as **not checked**.
