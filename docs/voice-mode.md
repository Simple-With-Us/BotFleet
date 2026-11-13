# Voice in BotFleet

Decision doc, originally 2026-08-14; updated 2026-11-12 with the current TTS
ladder, xAI speech-to-text, speech-to-speech calls, and group-call speech.

How bots speak, and how you hold a conversation with one.

## Shape

```
Renderer (src/)                           Harness (server/)
├── lib/tts/index.ts      the speaker     ├── tts/speech-text.ts  markdown → speakable
│     queue · prefetch · interrupt        ├── tts/xai.ts          xAI TTS
├── lib/call-stt.ts       provider-agn.   ├── tts/azure.ts        Azure Neural TTS
│     apple | xai | assemblyai sessions   ├── tts/minimax.ts      MiniMax TTS + voice clone
├── lib/sts/*             speech-to-speech├── tts/system-voices.ts macOS `say`
│     xAI realtime | Gemini Live          └── stt/xai.ts          xAI STT (REST + streaming)
└── components/CallView.tsx, GroupCallView.tsx, Composer.tsx
       Apple STT (SFSpeechRecognizer)     POST /api/tts/prepare → utterances
       xAI STT (proxied by the harness)     POST /api/tts/speak   → audio bytes
       or AssemblyAI Universal Streaming    POST /api/stt/xai/sessions → harness proxy
                                       GET/PUT /api/config   ← → tts.enabled, callStt, sts
```

**TTS providers**, tried in this order when a workspace does not pin one:
**xAI**, then **Azure Speech**, then **MiniMax**. On macOS, the built-in `say`
voices and Apple Personal Voice are also available. Personal Voices stay on
the device that made them and cannot be the workspace default. Voice clone is
MiniMax-only.

**STT providers** for voice mode and composer dictation: **Apple
SFSpeechRecognizer** on macOS (private, free), **xAI**
(`grok-voice-transcribe-2.0`, REST and streaming) when an xAI key is on file,
and **AssemblyAI Universal Streaming**. Auto order is Apple, then xAI, then
AssemblyAI. Meta, Azure, and Groq STT have credential slots but no streaming
bridge in this build.

**Speech-to-speech (STS)** is a separate call path, not a third STT value.
When a microphone and an xAI or Gemini key are available, a call can open one
duplex session (xAI `grok-voice-latest` at `wss://api.x.ai/v1/realtime`, or
Gemini Live `gemini-3.8-live`). The realtime model may call the bot's own
engine as a function tool (`sts.frontEngine`, on by default). If the engine
is slow or fails, that turn is answered by the model and marked
`engineBypassed`. Otherwise the call falls back to the chained
capture / transcribe / bot / speak loop.

## Why the key stays on the harness

The renderer never talks to a voice vendor with a permanent key.
`GET /api/config` reports configured-or-not booleans and settings, not
secrets, which is the same rule every other credential follows. The app asks
the harness for audio, or for a short-lived STS token, or (for xAI STT, which
has no vendor ephemeral token) posts PCM to a harness session that opens the
vendor socket itself.

Two states worth distinguishing, because they need different instructions:
`configured` (a key is saved) and `ready` (a key *and* a chosen voice).
Speaking without either throws `NoVoiceConfigured`, which the route turns
into a 409 — "you haven't set this up" is not a provider failure and should
not look like one. A workspace master switch (`tts.enabled`, default on)
gates auto-speak, calls, and the TTS / STS routes; when it is off those
routes return the same 409 with "Voice is turned off in Settings."

## The spoken register

The half that decides whether this is pleasant. Bots write for a screen:
fenced code, file paths, tables, link soup. Read aloud verbatim, a diff is four
minutes of punctuation and `server/drivers/acp/core.ts` is "server slash drivers
slash a c p slash core dot t s".

`speech-text.ts` says the prose, names the artifacts, drops the syntax. It also
splits into utterances, because that is the unit of work — one request, one clip,
and the client fetches the next while the current one plays.

## The default voice and the pronunciation list

Two voice settings belong to the whole workspace, not to a bot (owner ruling,
2026-10-08).  Both live in the workspace config next to the voice key, the way
the always-spell-correctly vocabulary lives as `callStt.keyterms`.  Neither is
a credential or a tunable knob, so neither is in `server/secret-map.ts` or
`server/knob-map.ts`.

- **Default Voice** is `tts.voice`: what every bot without a voice of its own
  speaks with, on every device.  `GET /api/config` returns it (it is a
  setting, not a secret), and every picker names it, "Jay Wedgeworth 001
  (default)", never a bare "(default)" (`defaultVoiceOptionLabel` in
  `shared/bot-voice.ts`, mirrored in Swift).  An empty one reads "No default
  voice": a bot without its own voice then cannot speak (`NoVoiceConfigured`).
  A Personal Voice is device-local and is never offered as the default.
- **Pronunciations** is `tts.pronunciations`: `{ term, say }` pairs, seeded
  with JSON "Jason", SaaS "sass", SQL "sequel", REGEX "redge ex", GUI "gooey",
  CAPTCHA "cap cha", sudo "soo doo", cron "kron" and OAuth "oh auth".  Absent
  means those defaults; a saved list, even an empty one, is used as is.  The
  one validator and matcher are in `shared/pronunciations.ts`.

The Mac saves both through `PUT /api/config`.  The phone saves them through two
narrow routes, `PATCH /api/tts/default-voice` and `PATCH /api/tts/pronunciations`,
which validate the same way and write only their own field, so `/api/config`
stays write-closed to a paired phone (`companion/src/routes.ts`).

Where the list applies, and why a change never re-bills a clip:

- The distiller is told to say each term as given (`voiceSummarySystemPrompt`).
  A distilled script stored before a change is reused as it was, with its
  clips.  **The list applies to scripts generated after a change.**
- The deterministic pass runs only where text leaves for a voice: in
  `tts.speak` (hosted and built-in Mac voices; message clips, Try and call
  mode) and on the utterances an on-device Personal Voice answer hands the
  device, whose spans are rebuilt so a respelled term still maps to the term.
  `voiceText`, the stamps and the utterances every cache check compares never
  carry it.  **Clips already made keep the sound they were made with; new
  synthesis uses the current list.**
- Karaoke treats each pair as the same word (`shared/karaoke-align.ts`, mirrored
  in `KaraokeAlign.swift`), so "oh auth" lights up "OAuth" on screen.

## Call mode

**Chained calls are half-duplex, on purpose.** The dictation helper is
`SFSpeechRecognizer` or a cloud transcriber on raw microphone input with no
acoustic echo cancellation. A microphone left open through playback transcribes
the bot's own voice back into the conversation and the two of them talk
forever. So the mic is live only when the bot is not speaking, and interrupting
is a tap, the Space bar, or Escape. Speech-to-speech calls are the exception:
the vendor session supports barge-in, and talking over the bot interrupts it.

**STT is picked once per chained call.** Apple SFSpeechRecognizer is the Auto
default on macOS — on-device, free, no API spend. If Apple is unavailable,
Auto uses xAI when `cfg.xai.key` is present, otherwise AssemblyAI when that
key is present. An explicit preference in Transcription settings wins when
that provider is actually usable. Windows and Linux users get voice calls
once an xAI or AssemblyAI key is in Settings. Per-call custom vocabulary
(up to 100 terms) is sourced from `bot.displayName` plus `callStt.keyterms`.
xAI receives those as repeated `keyterm` query parameters (and on the REST
form); AssemblyAI receives them as `keyterms_prompt`.

xAI STT pricing is $0.10/hr for REST file transcription and $0.20/hr for
streaming. Usage is recorded in the existing telemetry log. The model covers
38+ languages; a language hint is passed when the client knows one, and
`format=true` is set only together with that hint.

**Turn detection.** Apple STT finalizes when its audio stream ends, which is why the
existing local helper only emits after a silence timeout (~850ms). AssemblyAI's
streaming model does the same job server-side via `min_turn_silence`, configured
to the same 850ms. xAI streaming uses `endpointing=850` with interim results.
Composer dictation omits the timeout and keeps its press-to-stop behavior.

**Group and room calls speak.** `GroupCallView` uses the same chained STT path
and speaks each member's reply with that member's Mac voice.

**Narration is what makes it bearable.** A bot turn is 5–60 seconds of tool
calls, and silence that long reads as a dropped call. Every activity chip the
harness narrates is read aloud as it happens. The phrase is computed once,
server-side, into `tool.spoken` at fold time — so the chip you see and the phrase
you hear cannot drift apart.

**Approvals are spoken.** A `request.opened` card is read out and answered with
"yes"/"no". Anything that is not clearly a decision is refused and re-asked:
consent must never be inferred from a sentence that merely contained the word
"sure". Non-permission questions are read too, and the next complete spoken
turn is returned as the answer, so a bot asking for input does not strand the
call behind an invisible card.

**Latency, honestly.** Endpointing is 300–700ms and time-to-first-byte is
~100–250ms, against a bot turn of 5–60s. The bot dominates by 50–100x, so
voice choice is a quality decision, not a latency one. The way to make a call
feel conversational is to put the bot you call on a fast model and let it
delegate real work to specialists over `ask_bot` — no new machinery required.
Speech-to-speech moves turn-taking onto the vendor session, but the heavy work
still belongs to the bot engine when `sts.frontEngine` is on.

## Rejected

| Option | Why not |
| --- | --- |
| Piper / Kokoro-82M in the renderer | A second on-device runtime and model download; simplicity won. |
| Cartesia as a fourth hosted TTS | The xAI / Azure / MiniMax ladder already covers hosted speech. |
| Letting a speech-to-speech vendor own the brain | The product is the bot's own engine on your machine. STS is offered only with that engine as a function tool, and chained calls remain the fallback. |

## Known gaps

- **No spend meter in the UI yet.** Hosted TTS bills per character, xAI STT
  bills per hour, AssemblyAI bills per streaming minute. Auto-speak is off by
  default partly for that reason, but the app should eventually show usage for
  all of them. The harness already records the events.
- **No voice barge-in on chained calls** — see half-duplex above. STS calls
  do support talking over the bot.
- **No transcript polish** — raw transcriber output is what the bot hears.
  A later pass could clean punctuation and acronyms before the turn is sent.
- **Meta, Azure, and Groq STT** are listed in settings as not yet available.
  Their keys can be stored, but this build has no streaming bridge for them.

## Failure boundaries

- Intentional microphone stops (playback, hang-up, or replacement) do not emit
  a natural `speech:end`; otherwise the renderer could reopen capture during
  the bot's audio.
- Call phases are updated synchronously alongside React state, so a helper exit
  in the same event-loop turn as a final transcript cannot observe a stale
  `listening` phase. The overlay shows connecting, listening, thinking,
  speaking, or reconnecting, plus whether the call is speech-to-speech or
  chained and which provider is in use.
- Leaving the bot view owns and ends its call. A hidden overlay cannot leave a
  microphone session or a stale `currentCall` behind.
- `startCall` / `endCall` in `src/lib/call.ts` keep firing `window.ogb.speechStop()`
  for backwards compatibility with Apple STT; the assembled component unmounts
  in the same tick and tears down its `STTSession` (Apple, xAI, or AssemblyAI)
  through its own effect cleanup.
- The AssemblyAI cloud STT session mints a 480-second
  `streaming.assemblyai.com/v3/token` right before opening the WebSocket and
  disposes the session on `stop()`; the API key never leaves the Electron main
  process. xAI STT has no vendor ephemeral token, so the renderer posts audio
  to `/api/stt/xai/sessions` and the harness holds `cfg.xai.key`.
- Synthesis requests are abortable from the renderer and individual utterances
  are capped server-side to bound accidental hosted-voice spend.
