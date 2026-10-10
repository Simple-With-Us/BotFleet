# Voice Provider Options: Meta, Microsoft, Grok And The Rest

**Author:** [MM] · **Date:** Sat, Oct 10, 2026 · **Status:** exploration, nothing built

## The Short Version

BotFleet's two voice defaults are among the more expensive options in the market, and
the cheapest credible replacements are ones we can adopt **without adding a single new
credential**.

- **TTS.** The default, MiniMax `speech-2.8-turbo`, is **$60 per 1M characters**.
  xAI's `/v1/tts` is **$15 per 1M characters** — 4x cheaper (6.7x against the HD tier) —
  and BotFleet **already holds an `xai.key`** in `server/secret-map.ts` for the Grok
  chat engine.  The voice is a different API on a key we already store.
- **STT.** The call-mode default, AssemblyAI Universal-3.6 Pro Realtime, is
  **$0.45/hour** streaming.  Meta's Muse Voice Transcribe is **$0.18/hour** and xAI's
  `/v1/stt` is **$0.20/hour** streaming.  Again, xAI reuses an existing key.
- **Voice prompts** (one-shot dictation) are the cheapest thing to move: Groq serves
  Whisper Large v3 Turbo at **$0.04/hour**, the published price floor, with no streaming
  needed.
- **Speech-to-speech is a trap for us.**  See "Why Not Speech-To-Speech" below.  A
  speech-to-speech model replaces the bot's brain, and in BotFleet the brain is the
  bot's ACP coding engine.  We should not adopt one as the default call path.

## Current State

| Surface | Where | Providers today |
|---|---|---|
| TTS (server) | `server/tts/index.ts` | `minimax` (default, keyed), `system` (macOS `say`, no key) |
| STT (call mode, renderer) | `src/lib/call-stt.ts` | `apple` (macOS SFSpeech helper), `assemblyai` (keyed) |
| STT picker | `src/lib/transcription-provider.ts` | preference → platform → key-on-file |
| Voice cloning | `server/tts/index.ts` | MiniMax only |

ElevenLabs support was already removed and legacy `provider: "elevenlabs"` configs fall
through to MiniMax.  Both dispatch points are small unions with a factory, so a new
provider is a module plus one branch — the shape is good.

## TTS Price Table

Verified 2026-10-10.  USD per 1 million characters.

| Provider | Price | Source | Notes |
|---|---|---|---|
| OpenAI `gpt-4o-mini-tts` | $12 | developers.openai.com | **Retires 2027-01-06**, replaced by `gpt-realtime-2.1-mini` |
| **xAI `/v1/tts`** | **$15** | docs.x.ai | Speech tags (laughter, whisper, pause); MP3 → telephony μ-law; unary or WebSocket; multilingual |
| Azure Neural | $16 | secondary (see caveats) | 500K chars free/month; 500+ voices; 140+ languages; commitment tiers reach $7.50 |
| Azure Neural HD | $22 | Microsoft techcommunity blog | Cut from $30 in March 2026 |
| Hume Octave 2 | $25–75 | hume.ai pricing | Subscription tiers, overage-based |
| Deepgram Aura-2 | $30 | deepgram.com/pricing | |
| Cartesia Sonic 3.6 | $49 list / $37.40 on Scale | Artificial Analysis, cartesia.ai | #1 on both AA TTS boards; sub-90ms model latency |
| **MiniMax `speech-2.8-turbo`** (our default) | **$60** | platform.minimax.io | |
| MiniMax `speech-2.8-hd` | $100 | platform.minimax.io | |
| macOS `say` (our `system`) | $0 | — | Darwin only, no key, no cloning |

## STT Price Table

Verified 2026-10-10.  USD per hour of audio.

| Provider | Batch / async | Streaming | Notes |
|---|---|---|---|
| Groq Whisper Large v3 Turbo | **$0.04** | — | Price floor.  No streaming.  10s minimum per request, 25MB cap.  ~228x realtime |
| Groq Whisper Large v3 | $0.111 | — | Higher accuracy variant |
| Azure MAI-Transcribe-2 | $0.10 (promo) | — | Promo **ends 2026-12-31**; MS calls it the lowest-priced transcription model |
| Cartesia Ink | $0.13 | $0.13 | Streaming-optimized Whisper variant |
| **xAI `/v1/stt`** | **$0.10** | **$0.20** | 38+ languages; diarization; **Smart Turn** end-of-turn; word timestamps |
| OpenAI `gpt-4o-mini-transcribe` | $0.18 | — | |
| **Meta Muse Voice Transcribe** | — | **$0.18** | ASR + diarization (20+ speakers) + endpointing in **one** model; 25 languages with code-switching; 128 concurrent streams, 16k streams/hr |
| MiniMax Speech Recognition | $0.38 | $0.38 | New; supersedes our old belief that MiniMax ships no STT |
| Deepgram Nova-3 mono | $0.26 | $0.29 promo / $0.46 list | Flux: $0.39–0.47, turn detection built into the model |
| **AssemblyAI** (our default) | $0.21 | **$0.45** | Universal-3.5 Pro / 3.6 Pro Realtime |
| Apple SFSpeechRecognizer | $0 | — | macOS on-device only |

## Why Not Speech-To-Speech

For "call conversational style interaction" the market now sells bundled
speech-to-speech agents.  On price they look attractive:

| Option | Price | Per hour |
|---|---|---|
| Hume EVI 4 MINI | $0.02–0.035/min | $1.20–2.10 |
| OpenAI `gpt-realtime-2.1-mini` | ~$0.02–0.05/min | — |
| xAI `grok-voice-think-fast-2.0` | $0.08/min | $4.80 |
| AssemblyAI Voice Agent API | $0.075/min | $4.50 |

**All of them make the same architectural trade we cannot make.**  A speech-to-speech
model owns the conversation turn and the response generation.  In BotFleet a bot *is* its
coding engine — a Claude bot is Claude over ACP, a Codex bot is Codex, each with its own
tools and workspace.  Routing a call through EVI or `grok-voice-latest` means the call is
answered by EVI or Grok, with the bot's engine demoted to a tool call.  That is not
"BotFleet bot, by voice" — it is "BotFleet hosting someone else's voice agent".

xAI's STS does advertise tool use, which is the closest fit, but it is still Grok's tool
calling loop rather than delegation into an arbitrary ACP engine.  Retell, Vapi and Bland
are worse on this axis, not better: they are managed phone-agent platforms that bill per
minute and own the turn.

**Conclusion:** keep the chained stack — STT → the bot's own engine → TTS — and make each
link swappable.  Speech-to-speech stays out of the default path.  If we want it later, it
belongs in an experiment that proves engine handoff works, not in the settings panel.

## Recommended Shape

**TTS.** Widen the `VoiceProvider` union in `server/tts/index.ts`, add the provider as a
module exporting `verifyKey` / `listVoices` / `synthesize`, and namespace voice IDs by
provider the way `shared/bot-voice.ts` already namespaces Personal Voices.

Order of work:

1. **`xai`** — first, because it needs no new credential and is 4x cheaper.
2. **`azure`** — second, for the free tier (500K chars/month) and the widest voice and
   language coverage.  Also the only serious route to a Microsoft custom voice.
3. Keep `minimax` and `system`.  MiniMax stays for cloning; `system` stays free.

**STT.** Widen the `STTProvider` union in `src/lib/call-stt.ts` and add a factory branch
in `createSTTSession`.  One required refactor: `TranscriptionCapability` currently carries
a single `cloudSttConfigured: boolean`, which cannot express "an xAI key but no Meta key".
It has to become a per-provider capability map before a second cloud provider can be
offered honestly.

1. **`meta`** for call mode — best accuracy claim and endpointing built in.
2. **`groq`** for voice prompts and dictation — cheapest, no streaming needed there.
3. **`xai`** for call mode when we want one key to cover both TTS and STT.

**Cost ceilings.** If this ships, per-provider spend limits belong in
`server/knob-map.ts` as Infisical-managed knobs, not as code.  A per-bot provider choice
that defaults to workspace settings, like the existing voice picker, is enough UX.

## Integration Costs And Gotchas

- **Infisical is the only source of truth.**  Every new credential is a row in
  `server/secret-map.ts`; every tunable is a row in `server/knob-map.ts`.  No direct
  `process.env` reads for either.
- **Keys must not reach the renderer.**  AssemblyAI mints its streaming token server-side
  and hands the browser a short-lived token via `window.ogb.transcription`.  Every new
  cloud STT provider needs the same shape.
- **Meta's realtime endpoint authenticates inside the handshake frame** and explicitly
  ignores the `Authorization` header (`dev.meta.ai/docs/speech-to-text`).  It cannot reuse
  the existing bridge verbatim; it needs its own token-mint path.
- **Personal Voices are on-device only** and the harness refuses to synthesize them
  server-side.  Keep that guard in front of every new provider, not just MiniMax.
- **Vendor benchmarks are not comparable.**  Meta's "3.1% streaming WER" and AssemblyAI's
  "5.19% WER" are each measured on the vendor's own test set.  Treat both as marketing
  until one of them is measured on our own fixtures.

## Corrections To Existing Fleet Beliefs

- CLAUDE's 2026-09-22 voice-mode review recorded "MiniMax does not ship STT."  **No
  longer true** — MiniMax Speech Recognition is $0.38/hour with streaming, diarization and
  subtitle export.
- MiniMax TTS has been treated as the cost-efficient default.  On the current price list it
  is the second-most-expensive keyed option we could pick.

## What I Did Not Verify

- Azure's published pricing page renders `$` placeholders outside a priced region, so the
  $16 Neural figure is from a secondary source; the $22 Neural HD figure is corroborated by
  a Microsoft Tech Community post.
- No provider was called with a live key.  Prices are list prices, not negotiated rates.
- Latency claims (Cartesia sub-90ms, xAI sub-second) are vendor-stated and untested here.
- Meta's endpointing quality and 3.1% WER have not been run against BotFleet audio.