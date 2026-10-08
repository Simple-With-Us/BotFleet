# How Apple Personal Voice And MiniMax Process Text

- **Date:** 2026-10-08
- **Question:** How does Apple's Personal Voice process text differently from MiniMax, and does DeepSeek need to distill the spoken script separately for each TTS engine?
- **Fixed premise:** the DeepSeek-distilled script (spelled-out numbers, skipped code, pause markers) is what gets spoken.  Karaoke shows the original message words and only roughly follows the audio.  Nothing here proposes word-for-word speech.
- **Code anchors:** `main` at `7430b1f9a`, and the lane `claude/voice-distill-karaoke` at `8969416d8`.  Every `file:line` below refers to `main` unless it says lane.
- **Evidence labels:**
  - *official*: Apple or MiniMax documentation or announcements.
  - *forum*: Apple Developer Forums, Hugging Face discussions and similar threads, mostly with no vendor reply.
  - *third-party*: API wrappers, open-source projects and guides.
  - *measured*: a probe on this Mac against Apple system voices (see Method).  No Personal Voice was available, and nobody listened to the audio.
  - *inferred*: reasoning from the rest.
  - *repo*: read in BotFleet's code.

## 1. Short Answer

No separate DeepSeek distill per engine, at least not yet.  Apple's front end already reads most of what the distiller spells out: "3.5", "12:30 pm", "50%" and "version 1.2.3" render byte-identical audio to their spelled-out forms, so the spell-out rules are needed for MiniMax and harmless for Apple.  The real differences are markup and pacing.  MiniMax has inline pause markers (`<#0.3#>`) and sound tags such as `(laughs)`, while Apple has neither and pauses only at punctuation and utterance boundaries.  A deterministic per-engine render pass over the one stored script covers both, without the clip-cache collisions a second stored script would cause today (B6).  There is one live bug: Apple voices speak `<#0.3#>` aloud as about 1.3 to 1.8 seconds of symbol words (measured on three system voices, inferred for Personal Voice), and the macOS `say` provider drops the text after a tag.  On `main` that hits only bots with an explicit `on_demand` or `always` voice-summary mode.  The lane that restores the distilled default strips tags only from the Personal Voice answer, so the strip for `say`, captions and karaoke timing has to land with that lane or before it.

## 2. How Each Engine Handles Text

The MiniMax column is speech-2.8-turbo as BotFleet calls it today: HTTP `/v1/t2a_v2`, `text_normalization` never sent (so off), `language_boost: "auto"`.  The Apple column is AVSpeechSynthesizer.  Front-end behavior matched across premium Ava, enhanced Ava and compact Samantha, which is why it is assumed to hold for Personal Voice (inferred).  Pause lengths did not match across voices.  "Byte-identical" means the rendered audio samples were equal, which is the strongest grade the probe has.  An equal duration is weaker evidence.

| Category | MiniMax speech-2.8-turbo | Apple AVSpeechSynthesizer and Personal Voice | What it means for the script |
|---|---|---|---|
| Numbers | Normalization is off: `voice_setting.text_normalization` defaults to `false` and BotFleet never sends it (official, repo).  The Speech 2.6 launch claims raw numbers read fine, which the 2.8 launch does not restate (official, marketing).  "1,234" was misread on 2.5 (forum). | "749" reads as a cardinal (measured, medium-high).  "1,234" renders the same audio as "1234" (measured).  Short digit-only utterances are sometimes dropped on iOS 26.5.1 (forum). | Spell out.  Needed for MiniMax, harmless for Apple. |
| Decimals and versions | Undocumented. | "3.5" and "version 1.2.3" are byte-identical to "three point five" and "version one point two point three" (measured, high).  "v1.2.3" adds a spoken "v" (measured, low). | Spell out, and write "version" rather than a bare "v". |
| Dates, times and years | The FAQ says normalization "significantly improves" numbers and dates, which implies risk with it off (official).  Replicate advises writing dates out (third-party).  Years read as cardinal quantities in a Chinese test (third-party). | "12:30 pm" is byte-identical to "twelve thirty p m" (measured, high).  `2026-10-08`, `2026/10/08` and `10/08/2026` all render the same audio, exact words unknown (measured, high on identity).  "2026" matches "two thousand twenty-six", not "twenty twenty-six" (measured, medium-high). | Spell out.  Name the year style in the prompt, because Apple's default is "two thousand twenty-six". |
| Currency and percent | The Speech 2.6 launch claims money amounts are handled (official, marketing). | "50%" is byte-identical to "fifty percent" (measured, high).  "$250" is probably "two hundred and fifty dollars" (measured, low). | Spell out. |
| Acronyms | Nothing official on default reading.  `pronunciation_dict` can map `API/A P I` (third-party example).  "No" was read as "Number" (forum). | CSS, HTML, CLI and pnpm are byte-identical to spaced letters (measured, high).  SQL, GPU, HTTP and API read as letters but not identical to the spaced form (measured, low-medium).  Bare "JSON" reads as a word like "Jason", while "J S O N" forces letters (measured, medium).  A lone "A" can come out as "capital A" (forum). | Keep letter-spacing, plus a short list of acronyms said as words, JSON at least.  This is a preference, not an engine difference. |
| Identifiers, hashes and paths | Undocumented. | Hex such as `a3f9c2e` is read character by character (measured, high).  `#` is voiced (measured, medium).  `~` is silent and `/` is voiced (measured, high for `~`).  camelCase and snake_case split silently (measured, high). | Keep "never read hashes".  Describe paths and PR numbers in words. |
| URLs and emails | The Speech 2.6 launch claims URLs and emails are handled (official, marketing).  Undocumented for 2.8. | A raw `https://` URL takes about 8 seconds, with the scheme spelled letter by letter (measured, medium).  An email takes about 3.2 seconds with clause pauses, against 2.0 for "mail at jays dot services" (measured, medium).  Bare domains vary by voice (measured, low).  `speakable()` already turns links into their label and bare URLs into "a link" (repo). | Keep "example dot com".  Never a raw URL, on either engine. |
| Emoji and symbols | No MiniMax statement.  More than 10% invalid control characters returns error 1042 (official). | Emoji are read by name, such as "party popper" and "thumbs up" (measured, high).  `>` is voiced and pipes are silent (measured, low-medium).  `speakable()` strips emoji (repo). | No emoji and no symbol runs. |
| Markdown | Undocumented. | `**`, backticks, `#`, `-` and `*` are silent (measured, high to medium-high).  `>` is voiced, and "1." is read as "one" with a pause (measured, low-medium). | No markdown.  `speakable()` strips it anyway (repo). |
| Pauses | `<#x#>` from 0.01 to 99.99 seconds, only between speakable text, never two in a row (official).  Markers at the start or end of a request were lost, and a marker stacks on an adjacent punctuation pause (third-party).  `\n` is the documented paragraph signal (official), but `sanitizeForTTS` collapses all whitespace (repo).  Dash pause loss and ellipsis stalls are BotFleet's own claim, not in MiniMax's docs (repo). | No inline pause syntax: `<#0.3#>` is spoken aloud (measured, three voices).  Comma, em dash, en dash, ellipsis, `;` and `:` render identical audio (measured, high).  A period and a blank line are identical, and a single `\n` equals a space (measured, high).  Silence varies by voice: a comma is about 0.13 seconds on premium Ava and about 0.22 on the other two (measured).  `preUtteranceDelay` and `postUtteranceDelay` are the official gap controls (official).  SSML `<break>` is honored on system voices but moves the word offsets karaoke needs (measured), and is untested on Personal Voice. | One neutral marker in the script, rendered per engine (section 4). |
| Interjections | 19 canonical tags such as `(laughs)`, `(breath)` and `(sighs)`, on 2.8-hd and 2.8-turbo only (official).  Unlisted parentheticals are undocumented. | `(laughs)` and `[sigh]` are read as plain words (measured, medium-high). | MiniMax only.  The prompt forbids parentheses today, so none are emitted (repo). |
| Pronunciation overrides | Inline parenthesized IPA or pinyin, and `pronunciation_dict` (official).  BotFleet uses neither (repo). | The IPA attributed-string key exists (official), was ignored on macOS 11.4 in 2021 (forum), and is untested on Personal Voice.  SSML `<sub>` is ignored (measured, high). | Out of scope for the distiller.  A per-engine dictionary later, if ever. |
| Length limits | Under 10,000 characters per sync request and 60 requests per minute (official).  BotFleet uses 320-character utterances and caps a message at 12,000 spoken characters and 64 utterances, 160 when progressive (repo). | No documented limit.  One enhanced voice cut long text off at about 300 words (forum).  BotFleet's 600-character renderer groups, 750-character Mac helper chunks and 320-character iPhone segments are self-imposed (repo).  Personal Voice cannot render to buffers, so nothing can be pre-rendered or cached as audio (forum). | Short sentences suit both. |
| Languages | `language_boost: "auto"`, about 40 languages (official, repo). | Personal Voice supports English (US), Spanish (Mexico) and Mandarin (mainland) only (official).  On iOS 26 an English voice can later report `es-MX` or `zh-CN` and become unintelligible (forum). | Not a script concern.  App-side guard in section 5. |
| Timestamps for karaoke | BotFleet estimates timing per character from clip durations (repo).  `subtitle_enable` returns word timestamps (official), but word entries group syllables and offsets drift around pause markers (third-party). | `willSpeakRange` reports per-word offsets into the utterance string (official, repo).  A spoken tag shows up as its own "word" (measured).  With SSML the offsets point into the SSML source, not the spoken text (measured). | Markup must be zero-width before alignment, and the Apple utterance string must be the string the aligner indexes. |

## 3. What BotFleet Sends Today

### When DeepSeek Runs

- On `main` the default script kind is "written".  It is deterministic and makes no DeepSeek call.  The distiller runs only for bots with an explicit `on_demand` or `always` mode (`shared/voice-summary.ts:19-31`, `server/tts/message-audio.ts:440-456`, `server/index.ts:3604`).
- Before #952, and again in the lane, a bot with `speakReplies` or `speechDevices` defaults to `always` and any other bot to `on_demand`.
- `always` pre-warms on `item.completed` (`server/index.ts:3604-3608`).  Otherwise the distill runs on first play when the kind is "summary" and no stored `voiceText` exists (`message-audio.ts:451-454`).
- A reply of 120 characters or fewer with no technical content skips the model and gets `sanitizeForTTS(speakable())` (`server/tts/speech-summary.ts:204-220`).

### The Distiller Call

- **Model and fallback:** `deepseek-flash`, temperature 0.3, thinking disabled, `max_tokens = min(4000, max(500, ceil(inputChars / 3)))` (`speech-summary.ts:121-128`, `:279-288`).  If that returns non-200 or empty, `deepseek-chat` is tried (`:305-313`).  One 15-second deadline covers both calls (`:29`, `:237`).
- **Prompt:** the system prompt is `DEEPSEEK_FLASH_TTS_PROMPT` (`:46-85`), and it targets "MiniMax speech synthesis" (`:47`).  Its rules:
  - No markdown, bullets or emoji (`:51-56`).
  - No dashes (`:59`) and no ellipses (`:60`).
  - Insert `<#0.3#>` or `<#0.5#>` between major thoughts (`:61`).
  - No parentheses or brackets, because they are "reserved by the voice engine" (`:62`).
  - Spell out money, decimals, times, dates and spaced acronyms, and turn URLs and `+ = %` into words (`:64-72`).
  - Never read commit hashes (`:79`).
- **Example:** the worked example (`:82-83`) turns "AA2314" into "American Airlines flight twenty-three fourteen" and adds "slash status", which is not in its input.
- **Cleanup:** `cleanSummaryForTTS` (`:174-178`) strips voice-summary tags and unclosed fences, then runs `sanitizeForTTS(speakable())`.  Pause markers survive it.
- **Storage:** one script per message (`server/store.ts:140-145`).  The job key is `${threadId}:${messageId}` with no engine (`server/index.ts:9795-9805`).  Storing a summary also clears `audio`, `audioVoice` and `audioByVoice` (`server/index.ts:9819-9830`).

### The MiniMax Path

- `toUtterances` (`server/tts/speech-text.ts:152-180`) runs `speakable` (`:60-137`), splits on `. ! ?` (`:141`), caps pieces at 320 characters and glues pieces under 12 characters to a neighbor.  Oversized sentences are cut at ", " or "; " past the halfway mark, else at the last space (`:182-196`).  Message caps live at `message-audio.ts:62-71` and `:466`.
- `redactSecretsInText` runs on each utterance (`server/index.ts:9853`).
- `synthesize` (`server/tts/minimax.ts:355-407`) runs `sanitizeForTTS` (`:327-351`), which collapses whitespace, turns dashes into ", " and turns ellipses into ".".  It then posts this body (`:366-384`):

  ```json
  {
    "model": "speech-2.8-turbo",
    "text": "...",
    "stream": false,
    "output_format": "hex",
    "voice_setting": { "voice_id": "...", "speed": 1.0, "vol": 1.0, "pitch": 0 },
    "audio_setting": { "sample_rate": 24000, "bitrate": 128000, "format": "mp3", "channel": 1 },
    "language_boost": "auto"
  }
  ```

- Never sent: `text_normalization`, `pronunciation_dict`, `subtitle_enable`, `emotion`.
- Pause markers pass through untouched, and the sentence split moves each one to the start of the next clip.  A checked run of the real functions produced `"Here are your options for the flight."` followed by `"<#0.3#> First, American Airlines flight twenty-three fourteen ..."`.

### The Apple Paths

- **Harness answer:** the harness answers an on-device play with `{ audio: [], voiceText, utterances, onDevice: true }`, built from the same `utterances` the clips use (`message-audio.ts:485-497`).  On `main` nothing removes `<#`.
- **Mac:**
  - The renderer packs utterances into groups of up to 600 characters (`src/lib/tts/index.ts:86`, `:130-145`, `:484`).
  - Each group is one `bridge.speak` call (`:513`).  It writes the text to a 0600 file and starts a new helper process with `open -n` (`electron/speech.mjs:379-405`).
  - The helper chunks at 750 characters (`electron/resources/speech-helper.swift:218-314`).  It builds `AVSpeechUtterance(string:)` with the default rate and `postUtteranceDelay = 0.05` (`:357-361`), and reports a word range per `willSpeakRange` (`:364-379`).
- **iPhone:**
  - Harness utterances go through `SpeechProjection.segments(fromUtterances:)`, which packs to 320 characters with `endsParagraph` always false (`ios/Sources/CompanionCore/SpeechProjection.swift:33-39`, `PersonalVoiceChunker.swift:84-109`).
  - `ios/App/PersonalVoice.swift:258-261` builds `AVSpeechUtterance(string:)` with the default rate.  `postUtteranceDelay` is 0.05, or 0 on the last segment, so the 0.25-second paragraph pause is never reached.
  - The audio session is `.playback`, `.spokenAudio`, `.duckOthers` (`:225`).
- **Never used anywhere:** SSML, `prefersAssistiveTechnologySettings`, the IPA attribute, pitch, volume, `preUtteranceDelay`.
- **Offline fallbacks** (harness unreachable) never touch the distiller, so they carry no markers.  The Mac projects locally through `localKaraokeScript` over `writtenReply` or `spokenReply`.  The iPhone uses `SpeechProjection.segments(fromReply:)` (`SpeechProjection.swift:44-65`).

### The Lane At `8969416d8`

- Restores the distilled default (`shared/voice-summary.ts`) and adds `deterministicSpokenText`, so the skip path and fallbacks are labelled "written".
- Defines `PAUSE_TAG`, `stripPauseTags` and `maskPauseTags` in `shared/spoken-script.ts`.  It strips markers from the utterances and `voiceText` of the Personal Voice answer only, and only for the "summary" kind.
- Leaves gaps:
  - `maskPauseTags` has no caller, and no client or aligner file changes.
  - Hosted `utterances` and `voiceText` keep markers.  The lane's own test asserts that markers reach MiniMax.
  - The pattern `/<#[0-9]+(?:\.[0-9]+)?#>/` misses variants such as `<# 0.3 #>`.
  - Nothing aligns karaoke to the distilled script yet.  The marker-free Personal Voice text and the marked hosted text will diverge.

### Bugs And Mismatches

Ranked by impact.

| ID | Problem | Where | Evidence | In the lane |
|---|---|---|---|---|
| B1 | Apple voices speak `<#x#>` aloud whenever the distilled script is used, about 1.3 to 1.8 seconds per marker. | Mac: `message-audio.ts:451-455`, `:496`, then `speech-helper.swift:357`.  iPhone: `ios/App/Session.swift:2026-2028`, then `PersonalVoice.swift:258`. | repo; measured on system voices; inferred for Personal Voice | Fixed for the Personal Voice harness answer only. |
| B2 | The `say` system provider drops text after a marker.  A clip starting with `<#0.3#>` rendered 0.000 seconds, and "Hello there. <#0.5#> Goodbye now." rendered as long as "Hello there." alone. | `server/tts/system-voices.ts:64-77`, `server/tts/index.ts:128-134` | measured | Regression once distilled is the default: every clip that starts with a marker comes out empty. |
| B3 | MiniMax gets markers at the start of clips.  The docs only allow them "between" text, and a third-party project saw edge markers lost. | `speech-text.ts:141` | official rule, third-party report, not probed | Unchanged. |
| B4 | `speakable` inserts "(a code block)" and "(image: x)", which reach MiniMax on the written and fallback paths, while the prompt treats parentheses as reserved. | `speech-text.ts:42`, `:69` | repo; MiniMax reading unverified | Unchanged. |
| B5 | Markers stay in hosted `utterances`.  The call-mode caption shows them, `estimatedClips` counts them as characters, and no aligner handles `<#`. | `src/lib/tts/index.ts:429`; `karaoke-align.ts`, `KaraokeAlign.swift`, `karaoke-feed.ts`, `karaoke-session.ts` | repo | Unchanged. |
| B6 | One script per message, and any script change wipes every voice's clips.  An Apple-specific script stored in the shared `voiceText` would be served to MiniMax.  Two scripts swapped in turn would keep wiping clips and re-billing MiniMax. | `message-audio.ts:369-373`, `:451-453`; `server/index.ts:9804`, `:9823-9829` | repo | Unchanged.  This decides whether per-engine scripts are feasible. |
| B7 | On the Mac, Personal Voice speaks non-message text (call prompts, samples) raw, with no `speakable` and no marker strip. | `src/lib/tts/index.ts:303-306`, against the hosted path at `:523` | repo | Unchanged, low risk. |
| B8 | The iPhone fallback always uses `spokenReply`, while the Mac fallback picks by the bot's mode. | `SpeechProjection.swift:44-49`; Mac `localKaraokeScript` | repo | Unchanged. |
| B9 | Each Mac group is a separate helper process, so the gap between groups is process startup time, not the 0.05-second delay. | `electron/speech.mjs:384-405` | repo | Unchanged. |
| B10 | The prompt's example adds "slash status", which is not in its input.  An example that adds facts teaches the model to add facts. | `speech-summary.ts:82-83` | repo | For the prompt owner. |
| B11 | On the iPhone, `endsParagraph` is always false, so the existing 0.25-second paragraph pause never fires. | `SpeechProjection.swift:33-39`, `PersonalVoiceChunker.swift:84-109`, `PersonalVoice.swift:261` | repo | Unchanged. |
| B12 | A marker-only utterance passes the letters-or-digits guard because "0.3" has digits.  This is rare, given the 12-character glue rule. | `minimax.ts:362` | repo | Unchanged. |
| B13 | `sanitizeForTTS` collapses newlines, discarding MiniMax's documented paragraph signal. | `minimax.ts:327-351` | repo, official | Unchanged, low impact. |

## 4. Recommendation

This doc proposes rules.  Board 8cc3c806 assigns the prompt wording to the Plumber bot, with Oracle reviewing.  Jay decides who writes the final prompt.

### One Distill, Per-Engine Render

Keep one DeepSeek call and one stored `voiceText` per message.  Treat `<#x#>` as a neutral marker meaning "pause about x seconds here", and allow no other markup in the stored script.  Convert it per engine at the edge.  The conversion runs after `toUtterances` and before anything reaches an engine, a caption or an aligner:

```text
reply
  -> DeepSeek, once: one stored voiceText with <#x#> markers
  -> toUtterances
  -> render per engine
       MiniMax:  keep interior markers, drop edge markers      -> synthesize()
       Apple:    strip markers, split there, delay = x seconds -> AVSpeechUtterance(string:)
       say:      strip markers                                 -> say -o
  -> karaoke: align the rendered text (markers zero-width) to the original message words
```

Why this over a second distill:

- The evidence in section 2 shows the engines differ in markup and pacing, and code can render both.  The content-level differences (year style, JSON) are preferences that belong in the shared prompt.
- It sidesteps B6.  There is still one script, one clip set and one karaoke source per message.
- Apple loses nothing.  Spelled-out text gives the same audio, and the Apple voices cannot use MiniMax markup in any form.

### Engine Profiles

**Shared rules (the one prompt):**

1. No markdown, bullets, emoji or symbol runs.
2. Spell out numbers, decimals, versions, money, percents, times and dates.  MiniMax needs it with normalization off, and Apple renders the same audio either way.
3. Say years in one named style.  Proposal: "twenty twenty-six", since Apple otherwise says "two thousand twenty-six".
4. Letter-space acronyms, except a short list said as words (JSON at least; Jay picks the list).
5. Speak URLs, emails and paths as words ("botfleet dot app").  Never a raw URL.
6. Never read hashes, hex strings or long numeric IDs.
7. No parentheses or brackets.  This protects both engines: MiniMax reserves them, and Apple reads them aloud.
8. Pause markers only `<#0.3#>` or `<#0.5#>`, only between two sentences, never at the start or end, never two in a row.

**MiniMax render:**

- Keep the `sanitizeForTTS` dash and ellipsis rewrite.  The claim behind it is unverified, but it is harmless.
- After splitting into clips, drop any marker at the start or end of a clip, since the gap between clips already pauses, and collapse adjacent markers.  Interior markers stay.
- Normalize marker variants such as `<# 0.3 #>` to the canonical form.
- Skip any utterance with no letters or digits once markers are removed (B12).
- Send no interjection tags unless Jay opts into an expressive profile (see Draft Prompt Deltas).
- Leave `text_normalization` off until the billed test in section 6.

**Apple render (Personal Voice and on-device system voices):**

- Strip every marker.  End the utterance at the marker and add its value to the preceding utterance's `postUtteranceDelay`.  Proposal: 0.3 and 0.5 seconds as written, capped at 1 second, to be tuned by ear.
  - iPhone: the segment packer must not pack across a marker, and the segment carries its delay.  Fixing B11 at the same time gives real paragraph pauses.
  - Mac: the renderer's 600-character groups and the helper's 750-character chunks pass plain text today, so the delay needs a small protocol addition.  The cruder option is a group boundary at each marker, which leaves the pause to the helper-process gap (B9), unmeasured.
- Strip the 19 canonical interjection tags if they ever appear.
- No SSML.  It moves `willSpeakRange` offsets into the SSML source, which breaks the #952 karaoke ranges, and it is untested on Personal Voice.
- Return the rendered text as the answer's `utterances` and `voiceText`, so what the client speaks is what the aligner sees.
- The dash and ellipsis rules are unnecessary for Apple, which treats both like a comma, but they are harmless.

**`say` render (system provider):**

- Strip markers and interjection tags.  Pauses come from punctuation only.

### Draft Prompt Deltas

These are deltas against `DEEPSEEK_FLASH_TTS_PROMPT` (`speech-summary.ts:46-85`), not a rewrite.

| Line | Today | Proposed |
|---|---|---|
| `:47` | Targets "MiniMax speech synthesis". | Target "speech synthesis", and add that the app adapts pauses for each voice engine. |
| `:59-60` | No dashes or ellipses, because the engine drops pauses or stalls. | Keep the rules, and make the reason "some voice engines mishandle them". |
| `:61` | Insert `<#0.3#>` or `<#0.5#>` between major thoughts. | Add placement: only between two sentences, never at the start or end, never two in a row. |
| `:62` | Parentheses are "reserved by the voice engine". | Keep the ban, and make the reason "some engines treat parentheses as commands and others read them aloud". |
| `:64-72` | Spell-out rules. | Add the year style and the said-as-words acronym list. |
| `:82-83` | Example adds "slash status". | Use an example whose output adds no facts absent from its input.  Expanding "AA" to "American Airlines" stays fine under the 2026-10-08 correction on 8cc3c806, which withdrew the no-paraphrase constraint. |

If Jay wants per-engine distillation anyway, the whole Apple addendum is:

> Do not write pause markers.  Where you want a pause, end the sentence and start a new one.  Never write sound tags.

An optional MiniMax-only expressive addendum would be:

> You may use at most one sound tag every few paragraphs, written exactly as (breath), (chuckle) or (sighs).  Use no other parentheses.

The Apple addendum is two rules the render pass already enforces.  That is the case for doing it in code.

### Cache Design If Per-Engine Distillation Is Chosen

B6 has to be fixed first, or two scripts will keep resetting each other.

- **Storage:** replace the single `voiceText` and `voiceTextKind` with `voiceTexts: { minimax?: Script, apple?: Script }`, where `Script` is `{ text, kind, promptVersion }`.  Key by engine profile, not by device.  `say` uses the Apple profile.
- **Clip ownership:** clips (`audio`, `audioByVoice`) belong to the MiniMax profile's script, and writing the Apple script never clears them.  `ensureJob` (`message-audio.ts:369-373`) and the store patch in `voiceSummaryFor` (`server/index.ts:9819-9830`) invalidate only clips whose own profile's script changed.
- **Job key:** `${threadId}:${messageId}:${profile}` (`server/index.ts:9795-9805`).
- **Lazy distill:** pre-warm only the bot's primary engine profile on `item.completed` (`server/index.ts:3604-3608`).  Distill the other profile on first play on that engine.  While it runs, play the render-pass version of the existing script, so first play never waits on the 15-second deadline.
- **Isolation:** never serve one profile's text to the other engine.  Today the shared `voiceText` reaches MiniMax directly (`message-audio.ts:451-453`).

### Cost

For a bot played with Personal Voice on the Mac and MiniMax on the iPhone:

| Design | DeepSeek calls per message | MiniMax synthesis | Apple |
|---|---|---|---|
| One script, per-engine render (recommended) | 1 | Billed once per MiniMax voice | Free and on-device.  Only the script is cached. |
| Per-engine scripts, engine-aware clip ownership | Up to 2, the second lazy | Billed once | Free |
| Per-engine scripts on today's storage | Up to 2 | Re-billed every time playback alternates between devices | Free |

- MiniMax speech-2.8-turbo costs $60 per million characters, or $0.06 per 1,000 (official).  A 2,000-character spoken script costs about $0.12 to synthesize, so each wasted re-synthesis on today's storage costs about $0.12 per message.
- Interjection tags appear not to be billed, inferred from two official examples.  Whether pause markers are billed is unknown (section 6).
- DeepSeek pricing was not part of this research.  The call's output is capped by the `max_tokens` formula above.
- Personal Voice cannot render to buffers, so the Apple side never has an audio cost or an audio cache.

### Karaoke Alignment

Two invariants:

1. Each engine's markup is zero-width before alignment.  `<#x#>` markers and the 19 canonical interjection tags are removed or masked in the text the aligner reads, and they contribute time, never words.
2. On Apple, the string given to `AVSpeechUtterance(string:)` is byte-identical to the string the aligner indexes, because `willSpeakRange` offsets index into that string.  So the render runs in the harness before the answer is built, and SSML stays out.

Per engine:

- **MiniMax:** the aligner reads the stored script with markers masked.  The per-character timing estimate should count a marker as zero characters plus x seconds of hold.  Today B5 counts it as characters.  MiniMax's `subtitle_enable` word timestamps could replace the estimate later, but third-party reports say offsets drift around pause markers, so test before adopting.
- **Apple:** the rendered text has no markup, so `willSpeakRange` words map straight onto the script.  The aligner then maps script words to the original message words as #952 does.
- **One definition:** the lane's `shared/spoken-script.ts` (`PAUSE_TAG`, `stripPauseTags`, `maskPauseTags`) is the natural home.  Extend it to the interjection tags, and mirror the same pattern in `KaraokeAlign.swift` (inferred).

## 5. Immediate Fixes Worth Doing Regardless

All are small and keep the distilled script as what is spoken.

1. **Strip markers on every non-MiniMax output** (B2, B5).  That covers the `say` provider and the hosted `utterances` and `voiceText` the client uses for captions and karaoke timing.  Keep markers only in the text passed to `synthesize()`.  Ship this with the lane, or before it.
2. **Widen the pattern** to tolerate whitespace, for example `/<#\s*\d+(?:\.\d+)?\s*#>/g`, and normalize variants to the canonical form for MiniMax.
3. **Drop markers at MiniMax clip edges** and collapse adjacent ones (B3).  Run the guard at `minimax.ts:362` after stripping (B12).
4. **Set `endsParagraph` on the iPhone** so the existing 0.25-second paragraph pause fires (B11).
5. **Guard the Personal Voice language:** check that `voice.language` starts with `en` before speaking English, given the iOS 26 drift reports (inferred from forum).
6. **Project Mac non-message text** through `speakable` and the marker strip on the Personal Voice path (B7).
7. **Hand B10 and the deltas above** to whoever Jay picks for the prompt.

## 6. Open Questions And What Needs A Real Device

Personal Voice cannot be tested headlessly.  This Mac has no Personal Voice, authorization is granted per app, and Personal Voice refuses buffer output, so it can be heard but not recorded through `write()`.  Every Apple result above is a duration or byte comparison on system voices, and nobody listened to any of it.

**On a real device, in the BotFleet app, with Personal Voice:**

1. Does Personal Voice speak `<#0.3#>` aloud like the system voices?  Expected yes, and fix 1 makes it moot.
2. Does it share the system front end?  Listen to "2026", "JSON", "API", a date, "$250" and "1,234".
3. Do `postUtteranceDelay` pauses of 0.3 and 0.5 seconds sound right, and is the 0.05-second delay between chunks audible?
4. Does it honor SSML `<break>` and the IPA attribute?  This only matters if SSML is ever reconsidered.
5. Is there a length or stall threshold?
6. How long is the Mac gap between helper processes (B9)?
7. The `willSpeakRange` callback already reports per-word `elapsedMs` (`src/lib/tts/index.ts:493-501`).  It is the one timing measurement available on real Personal Voice.

**On MiniMax, one billed request each:**

1. Put markers at the start, end and middle of one request.  Which are honored?
2. Send the same text with and without one `<#0.3#>` and compare `extra_info.usage_characters`.
3. Send `text_normalization: true` on 2.8-turbo.  Is it accepted, and are "749", "2026", "3.5" and "10/24" read correctly?  If so, the spell-out rules could shrink for both engines, since Apple does not need them either.  The year style would still need stating.
4. Send "(a code block)" and "(smiles)".  Are they spoken or dropped (B4)?
5. Reproduce or retire the dash and ellipsis claim behind `sanitizeForTTS`.
6. Does the HTTP endpoint accept `english_normalization`, or reject it with 2013?
7. Measure non-streaming latency for 2.8-turbo from the Mac.

## Method

- **Apple probe:**
  - `AVSpeechSynthesizer.write(_:toBufferCallback:)` with a fresh synthesizer per utterance on macOS 27, with nothing played aloud.
  - Voices: premium Ava (en-US), enhanced Ava and compact Samantha.
  - Silence was found with 10 ms RMS windows, a 0.002 threshold and a 100 ms minimum gap.
  - Each probe ran twice and matched to 10 ms.
  - Grades: byte-identical audio is high, an exact duration tie is medium-high, and a difference of 0.05 seconds or more is low.
  - No transcription tool was available, so word choices are inferred from duration.
- **Coarser first pass:** an earlier pass matched durations within 0.05 seconds for "$50", "10:30 PM", "10/24", "example.com" and "API".  The byte-level probe overrides it for "API" and bare domains.
- **`say`:** measured with `say -o x.wav --data-format=LEI16@22050`, matching the system provider.
- **MiniMax:** documentation, announcements, forums and third-party code only.  No live calls were made.
- **Code:** read-only, at the commits named at the top.  The probe scripts lived in a session scratchpad and were not committed.

## Sources

**Apple (official):**

- https://developer.apple.com/documentation/avfaudio/avspeechutterance
- https://developer.apple.com/documentation/avfaudio/avspeechutterance/init(ssmlrepresentation:)-8zam9
- https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer
- https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice
- https://developer.apple.com/videos/play/wwdc2023/10033/
- https://developer.apple.com/videos/play/wwdc2020/10022/
- https://machinelearning.apple.com/research/personal-voice
- https://www.apple.com/ios/feature-availability/
- https://support.apple.com/en-us/104993

**Apple (forum and third-party):**

- https://developer.apple.com/forums/thread/712411 (SSML `<sub>` and `<phoneme>` pauses)
- https://developer.apple.com/forums/thread/684500 (IPA attribute ignored on macOS)
- https://developer.apple.com/forums/thread/707199 ("capital A")
- https://developer.apple.com/forums/thread/736148 (no buffer output with Personal Voice)
- https://developer.apple.com/forums/thread/757828 (iOS app on Mac, no voice-banking access)
- https://developer.apple.com/forums/thread/792409 (iOS 26 language drift)
- https://developer.apple.com/forums/thread/737685 (long-text cutoff)
- https://developer.apple.com/forums/thread/834875 (iOS 27 beta queue ordering)
- https://developer.apple.com/forums/thread/835324 (short digit utterances dropped)
- https://developer.apple.com/forums/thread/844422 (sandboxed Catalyst silence)
- https://nshipster.com/avspeechsynthesizer/
- https://bendodson.com/weblog/2024/04/03/using-your-personal-voice-in-an-ios-app/

**MiniMax (official):**

- https://platform.minimax.io/docs/api-reference/speech-t2a-http
- https://platform.minimax.io/docs/api-reference/speech/t2a/api/openapi.json
- https://platform.minimax.io/docs/api-reference/speech-t2a-websocket
- https://platform.minimax.io/docs/api-reference/speech-t2a-websocket-bidi
- https://platform.minimax.io/docs/faq/about-apis
- https://platform.minimax.io/docs/guides/pricing-paygo
- https://platform.minimax.io/docs/guides/rate-limits
- https://www.minimax.io/news/minimax-speech-26
- https://www.minimax.io/news/minimax-speech-28

**MiniMax (forum and third-party):**

- https://huggingface.co/spaces/MiniMaxAI/README/discussions/3 (digit misreads)
- https://huggingface.co/spaces/MiniMaxAI/README/discussions/1 ("No" read as "Number")
- https://github.com/ZLHad/OpenVideoHarness/pull/69 (pause-marker and subtitle behavior)
- https://minimax-ai.chat/docs/minimax-tts-pronunciation-subtitles/
- https://replicate.com/minimax/speech-2.8-turbo