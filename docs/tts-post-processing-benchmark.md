# TTS Post-Processing Model Benchmark & Evaluation

Authoritative benchmark and architectural reference for evaluating lightweight language models as post-processors that adapt dense, technical bot outputs into natural speech for Text-to-Speech (TTS) synthesis.

## 1. Architectural Strategy: Chained Post-Processing vs. Primary Model Dual-Output

When bots operate in voice mode (1:1 voice calls, room audio, or spoken activity narration), their raw output is optimized for visual reading on a screen: Markdown headers, bullet points, file paths, commit hashes, code fences, and status cards.

Two approaches were evaluated to turn this into speakable audio:

| Approach | Architecture | Trade-offs & Limitations |
| :--- | :--- | :--- |
| **A. Primary Model Dual-Output** | The primary model (e.g. Claude 3.5 Sonnet, GPT-4o) emits both visual text and a separate spoken register field (e.g. JSON `{"display": "...", "spoken": "..."}`). | **Rejected.**<br>1. **Destroys UI Time-to-First-Byte (TTFB):** Requires waiting for JSON fields or token buffering before streaming to the UI.<br>2. **Attention & Prompt Dilution:** Directing an agent to write dense code while maintaining conversational voice rules split model attention.<br>3. **High Token Spend:** Generating conversational spoken filler at frontier model rates ($3.00–$15.00/1M tokens) is economically inefficient. |
| **B. Chained Post-Processing (Selected)** | Primary model streams pure Markdown to the UI immediately. A fast, low-cost secondary model reads the turn's Markdown in the background and condenses it into 1–2 conversational sentences for the TTS engine. | **Recommended.**<br>1. **Zero UI Latency Impact:** UI text streams instantly without delay.<br>2. **Specialized Prompts:** Post-processor prompt focuses strictly on phonetic readability and natural conversational cadence.<br>3. **Extreme Cost Efficiency:** Runs on ultra-cheap models ($0.055–$0.40/1M tokens), costing under $0.0003 per spoken utterance. |

---

## 2. Test Fixture & Reproduction

All benchmarked models were evaluated against an identical real-world technical git status message from BotFleet operations.

### Input Fixture

```text
What I merged this run
ai-fleet-coordinator #304 "docs(bootstrap): cloud agent sandbox toolchain restore" — f44865ae0314e6ae23699d3f9a716cbaeee8135b

Merged via gh pr merge --squash --delete-branch (no --admin)
Branch ops/cloud-agent-bootstrap → base main
PR-head aabb4056
Files changed: README.md +1 -0, docs/CLOUD-AGENT-BOOTSTRAP.md +130 -0 — docs-only, canonical /workspace/.bootstrap.sh explainer (because every fresh cloud session wipes /usr/local/bin while /workspace survives)
All 3 checks green: test (in_progress at verify), gitleaks (in_progress at verify), Seer Code Review SUCCESS
Branch protection requires only test; clean status, no Seer bugs, no review threads
AFC has no live deploy surface (no public URL, internal ops repo)
AFC queue now empty (0 open)
```

### Prompt Instructions

```text
You are a helpful voice assistant. Your job is to act as a post-processor. 
Read the following raw, technical output from a bot, and translate it into a natural, conversational, friendly spoken sentence (or two) that is highly optimized for a Text-to-Speech engine. 
CRITICAL RULES:
1. Omit commit hashes, exact file paths, branch names, and deep technical jargon.
2. Provide ONLY the high-level summary of what was accomplished.
3. Make it sound like a human giving a quick verbal update.
4. DO NOT use markdown, bullet points, asterisks, or formatting.
5. Provide ONLY the spoken text, with no preamble.
```

### Reproducing the Benchmark

The benchmark runner is automated and can be executed against all supported providers:

```bash
# Run all benchmarked models
node scripts/benchmark-tts-post-processor.mjs

# Run only MiniMax models
node scripts/benchmark-tts-post-processor.mjs --minimax

# Run with end-to-end MiniMax speech synthesis (measures audio generation latency)
node scripts/benchmark-tts-post-processor.mjs --tts
```

---

## 3. Benchmark Results & Cost Comparison

*Input prompt: ~250 tokens. Output text: ~30–60 tokens.*

| Model | Provider | Latency | Input / 1M | Output / 1M | Est. Cost / Turn | Tone & Output Quality |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **DeepSeek V4.1 Flash (`deepseek-flash`)** | DeepSeek API | **861ms** | **$0.14** | **$0.28** | **$0.000060** | **Selected Default.** Sub-second speed, completely natural human cadence, lowest cost. |
| **Meta LLaMA 3.1 70B Instruct** | OpenRouter | **1,260ms** | $0.40 | $0.40 | $0.000120 | High quality, zero hallucinations, perfect speech pacing. |
| **Meta LLaMA 3.1 8B Instruct** | OpenRouter / DeepInfra | **1,093ms** | **$0.055** | **$0.055** | **$0.000017** | Blazing fast, conversational. Slight hallucination ("new feature" instead of docs). |
| **MiniMax-Text-01** | MiniMax Native | **2,444ms** | $0.20 | $1.10 | $0.000280 | Good direct completion, no reasoning delay, natural phrasing. |
| **MiniMax-M3.1-Flash-Preview** | MiniMax Native | **2,853ms** | $0.30 | $1.20 | $0.000434 | BotFleet's default MiniMax model. Highly accurate, concise spoken summary. |
| **OpenAI GPT-4o-mini** | OpenRouter / OpenAI | **2,538ms** | $0.15 | $0.60 | $0.000068 | High quality, consistent, slightly wordy. |
| **MiniMax-M2.7 (Standard)** | MiniMax Native | **4,347ms** | $0.30 | $1.20 | $0.000272 | Good output, but held back by ~115 tokens of internal reasoning. |
| **MiniMax-M2.7-highspeed** | MiniMax Native | **5,208ms** | $0.60 | $2.40 | $0.000725 | Double the cost of M2.7. Emits ~190 tokens of reasoning before answer. |
| **Mistral NeMo (12B)** | OpenRouter | **5,919ms** | $0.15 | $0.15 | $0.000045 | Slowest, overly verbose and theatrical ("big improvement", "thumbs up"). |

---

## 4. Deep-Dive on MiniMax Models

MiniMax is BotFleet's default voice and chat partner (PR #513). Four distinct MiniMax text models were evaluated:

### 1. `MiniMax-M2.7-highspeed` vs. `MiniMax-M2.7`
* **Pricing:** `M2.7` is priced at **$0.30 / 1M input, $1.20 / 1M output**. The `M2.7-highspeed` variant is priced at exactly **2x base price ($0.60 / 1M input, $2.40 / 1M output)**.
* **The High-Speed Latency Paradox:** Despite being branded as "high-speed", `M2.7-highspeed` exhibited higher total latency (**5,208ms**) than `M2.7` (**4,347ms**) and `M3.1-Flash-Preview` (**2,853ms**).
* **Root Cause:** The `M2.7` family uses a Mixture of Experts (MoE) reasoning architecture that emits `reasoning_content` (chain-of-thought) before generating the user-facing completion. Even for simple one-sentence summarization tasks, the model generated ~700–900 characters (115–190 tokens) of internal reasoning ("The user wants a concise spoken summary... I should omit commit hashes...").
* **Takeaway:** For real-time TTS post-processing, reasoning models incur an unavoidable latency penalty. Paying 2x for the highspeed tier does not overcome the CoT overhead.

### 2. `MiniMax-Text-01`
* **Pricing:** **$0.20 / 1M input, $1.10 / 1M output**.
* **Behavior:** A pure non-reasoning direct-generation model. Latency clocked in at **2,444ms** (and 810ms on simple test prompts) with zero reasoning overhead.
* **Spoken Output:**
  > *"I just merged a documentation update for the cloud agent sandbox toolchain restore in the AI fleet coordinator project. The changes were mainly to the README and a detailed explanation of the bootstrap script. All the checks passed, including tests, security scans, and code reviews. The queue is now clear with no open items."*

### 3. `MiniMax-M3.1-Flash-Preview`
* **Pricing:** **$0.30 / 1M input, $1.20 / 1M output** ($0.06 cached read).
* **Behavior:** BotFleet's primary configured MiniMax model. Fast (**2,853ms**), crisp, and captures the technical essence accurately.
* **Spoken Output:**
  > *"I merged the documentation update for restoring the cloud agent setup after a fresh session, and all checks passed. The coordinator queue is now empty, with no live deployment changes."*

---

## 5. End-to-End Latency with Audio Synthesis

When combining LLM text post-processing with **MiniMax `speech-01-turbo`** audio synthesis:

```
[Raw Markdown] 
      │
      ▼ (LLM Translation)
[Spoken Text]      ─── ~1.1s – 2.5s (LLM Latency)
      │
      ▼ (Minimax t2a_v2 Synthesis)
[Audio Buffer]    ─── ~2.5s – 3.2s (TTS Latency)
────────────────────────────────────────────────────
Total Time-To-Audio:   ~3.6s – 5.5s
```

Because synthesis takes 2.5–3.2 seconds for a complete paragraph, keeping LLM post-processing latency around **1.0–1.3 seconds** (as achieved by `LLaMA 3.1 70B` or `DeepSeek Chat`) delivers the fastest possible voice turn without leaving awkward multi-second dead air.

---

## 6. Recommended Pipeline Deployment

For BotFleet voice mode Lane 3 ("Optimize responses for spoken word format"):

1. **Primary Recommendation:** **DeepSeek Chat** (`deepseek-chat`) or **LLaMA 3.1 70B Instruct** (`meta-llama/llama-3.1-70b-instruct`).
   - Latency: ~1.2s – 1.3s
   - Cost: ~$0.00005 – $0.00012 per turn (~$0.05 to $0.12 per 1,000 voice turns)
   - Highest conversational fidelity with zero CoT delay.
2. **MiniMax-Native Alternative:** **`MiniMax-Text-01`** or **`MiniMax-M3.1-Flash-Preview`**.
   - If keeping the entire voice loop within MiniMax credentials, avoid `M2.7-highspeed` due to reasoning overhead, and use `MiniMax-Text-01` ($0.20/$1.10) or `M3.1-Flash-Preview` ($0.30/$1.20).
