# Voice in BotFleet

Decision doc, originally 2026-08-14; updated 2026-09-26 with the cross-platform
STT unlock, keyterms vocabulary, and MiniMax TTS as the default voice provider.
How bots speak, and how you hold a conversation with one.

## Shape

```
Renderer (src/)                           Harness (server/)
├── lib/tts/index.ts      the speaker     ├── tts/speech-text.ts  markdown → speakable
│     queue · prefetch · interrupt        ├── tts/elevenlabs.ts   verify · voices · synthesize
├── lib/call-stt.ts       provider-agn.   └── tts/minimax.ts      MiniMax TTS (default since PR #513)
│     apple | assemblyai sessions
├── lib/transcription-provider.ts
│     pickSTTProvider(...)
└── components/CallView.tsx, GroupCallView.tsx, Composer.tsx
       Apple STT (SFSpeechRecognizer)     POST /api/tts/prepare → utterances
       or AssemblyAI Universal Streaming    POST /api/tts/speak   → mp3 bytes
                                       GET/PUT /api/config   ← → callStt.{provider, keyterms}
```

Two STT providers for voice mode: **Apple SFSpeechRecognizer** on macOS, and
**AssemblyAI Universal Streaming** everywhere. Voice TTS providers are
**ElevenLabs** and **MiniMax** (MiniMax is the default as of PR #513).
No local STT model, no fallback ladder — if a call-mode provider is
unreachable, the picker surfaces a clear "no-provider" state with the exact
missing dependency.

## Why the key stays on the harness

The renderer never talks to ElevenLabs. `GET /api/config` reports
configured-or-not booleans and nothing else, which is the same rule every other
credential follows, and it is worth more than a saved round trip. So the app
asks the harness for audio and the harness holds the key.

Two states worth distinguishing, because they need different instructions:
`configured` (a key is saved) and `ready` (a key *and* a chosen voice). Speaking
without either throws `NoVoiceConfigured`, which the route turns into a 409 —
"you haven't set this up" is not a provider failure and should not look like one.

## The spoken register

The half that decides whether this is pleasant. Agents write for a screen:
fenced code, file paths, tables, link soup. Read aloud verbatim, a diff is four
minutes of punctuation and `server/drivers/acp/core.ts` is "server slash drivers
slash a c p slash core dot t s".

`speech-text.ts` says the prose, names the artifacts, drops the syntax. It also
splits into utterances, because that is the unit of work — one request, one clip,
and the client fetches the next while the current one plays. One request per
utterance rather than the streaming-input WebSocket: same perceived latency, far
fewer moving parts, and no socket to leak when a turn is interrupted.

## Call mode

**Half-duplex, on purpose.** The dictation helper is `SFSpeechRecognizer` on raw
`AVAudioEngine` input with no acoustic echo cancellation. A microphone left open
through playback transcribes the bot's own voice back into the conversation and
the two of them talk forever. So the mic is live only when the bot is not
speaking, and interrupting is a tap, the Space bar, or Escape. Full-duplex
barge-in needs AEC on the capture path — a real follow-up, not a footnote.

**Two STT providers, picked once per call.** Apple SFSpeechRecognizer stays the
default on macOS — on-device, free, no API spend. The moment an AssemblyAI key
is configured, the renderer swaps to AssemblyAI's Universal Streaming endpoint
for both 1:1 calls and group rooms. Windows and Linux users get voice calls
the day they paste a key into Settings. The picker lives in
`src/lib/transcription-provider.ts` and resolves platform + capability + the
user's explicit preference to `apple | assemblyai | no-provider`. Per-call
custom vocabulary (`keyterms_prompt`, up to 100 terms) is sourced from
`bot.displayName` plus a small global list in AppConfig — by the time the
streaming WebSocket opens, the model already knows how to spell "BotFleet",
"Mavis", every bot's name, and any product jargon the user has added.

**Turn detection.** Apple STT finalizes when its audio stream ends, which is why the
existing local helper only emits after a silence timeout (~850ms). AssemblyAI's
streaming model does the same job server-side via `min_turn_silence`, configured
to the same 850ms. Composer dictation omits the timeout and keeps its
press-to-stop behavior.

**Narration is what makes it bearable.** An agent turn is 5–60 seconds of tool
calls, and silence that long reads as a dropped call. Every activity chip the
harness narrates is read aloud as it happens. The phrase is computed once,
server-side, into `tool.spoken` at fold time — so the chip you see and the phrase
you hear cannot drift apart.

**Approvals are spoken.** A `request.opened` card is read out and answered with
"yes"/"no". Anything that is not clearly a decision is refused and re-asked:
consent must never be inferred from a sentence that merely contained the word
"sure". Non-permission questions are read too, and the next complete spoken
turn is returned as the answer, so an agent asking for input does not strand the
call behind an invisible card.

**Latency, honestly.** Endpointing is 300–700ms and time-to-first-byte is
~100–250ms, against an agent turn of 5–60s. The agent dominates by 50–100x, so
voice choice is a quality decision, not a latency one. The way to make a call
feel conversational is to put the bot you call on a fast model and let it
delegate real work to specialists over `ask_bot` — no new machinery required.

## Rejected

| Option | Why not |
| --- | --- |
| OS voices (macOS/Windows) | Audibly synthetic; would cheapen the feature |
| Piper | Same complaint, one tier up |
| Kokoro-82M in the renderer | Genuinely good and free, but it is a second provider, a 2.2MB chunk, an ONNX runtime and a first-run model download. Simplicity won. |
| Cartesia | Cheaper and faster to first byte, but a second provider earns its keep only once one is not enough |
| ElevenLabs Agents | Its custom-LLM `cascade_timeout_seconds` maxes at 15s and agent turns exceed that; it also wants to own turn-taking and tool calls, which is what the harness owns |
| OpenAI Realtime / Gemini Live (speech-to-speech) | They replace the brain, and the brain being Claude Code on your own machine *is* the product |

## Known gaps

- **Rooms don't speak yet**, though per-bot voices already exist (`bot.voice`).
  (Rooms *do* now use the same cloud STT pipeline for dictation as 1:1 calls.)
- **No spend meter.** ElevenLabs bills per character, AssemblyAI bills per
  streaming minute. Auto-speak is off by default partly for that reason, but
  the app should eventually show usage for both.
- **No voice barge-in** — see half-duplex above.
- **No transcript polish** — Lane 1+2 ships raw AssemblyAI transcripts (already
  formatted via `format_turns: true`). Lane 3 ("Optimize responses for spoken
  word format") will pipe final transcripts through the bot's MiniMax-M3 model
  for punctuation cleanup and acronym normalization before sending to the agent.

## Failure boundaries

- Intentional microphone stops (playback, hang-up, or replacement) do not emit
  a natural `speech:end`; otherwise the renderer could reopen capture during
  the bot's audio.
- Call phases are updated synchronously alongside React state, so a helper exit
  in the same event-loop turn as a final transcript cannot observe a stale
  `listening` phase.
- Leaving the bot view owns and ends its call. A hidden overlay cannot leave a
  microphone session or a stale `currentCall` behind.
- `startCall` / `endCall` in `src/lib/call.ts` keep firing `window.ogb.speechStop()`
  for backwards compatibility with Apple STT; the assembled component unmounts
  in the same tick and tears down its `STTSession` (Apple or AssemblyAI)
  through its own effect cleanup.
- The cloud STT session mints a 480-second `streaming.assemblyai.com/v3/token`
  right before opening the WebSocket and disposes the session on `stop()`; the
  API key never leaves the Electron main process. AssemblyAI's pricing is
  per-streaming-minute at the model the user selected (default
  `u3-rt-pro` = Universal-3.5 Pro Realtime).
- Synthesis requests are abortable from the renderer and individual utterances
  are capped server-side to bound accidental hosted-voice spend.
