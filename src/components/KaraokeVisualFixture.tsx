// Test harness for tests/e2e/karaoke.visual.spec.ts: a reply caught in the
// middle of being read aloud, highlighted on the message itself.
//
// Everything on the Mac path is real except the sound: the real speaker
// singleton asks the (stubbed) message audio route for the reply, gets a
// written script with its spans exactly as the harness encodes them, plays
// clip 0 through a stand-in Audio element whose clock is pinned, and
// publishes its karaoke feed.  The bubble follows it through the real
// useMessageKaraoke hook, ChatMarkdown and CSS.highlights.
//
// `?fixture=karaoke&t=<seconds>` pins the clip clock (default 4.8: "installer" is rolling in and "the" before it is trailing off);
// `&theme=dark` renders the Midnight skin.  The page marks itself ready once
// the highlighter has painted, and records the bubble height before and
// during reading so the spec can check that nothing re-flows.
//
// The fonts are pinned here, before the first layout, rather than by the
// spec after navigation: a style the spec adds can land between the two
// height measurements and look like a re-flow.  The "before" height is taken
// once the fonts are ready, and only then does the voice start.
import { useEffect, useRef, useState } from "react";

import { utterancesWithSpans } from "../../shared/speech-spans";
import { encodeSpokenSpans } from "../../shared/spoken-script";
import { writtenReply } from "../../shared/voice-summary";
import { speaker } from "@/lib/tts";
import { useMessageKaraoke } from "@/lib/tts/useMessageKaraoke";
import { ChatMarkdown } from "./ChatMarkdown";

const params = new URLSearchParams(window.location.search);
const DARK = params.get("theme") === "dark";
const CLOCK_SECONDS = Number(params.get("t") ?? "4.8");

const THREAD = "karaoke-fixture-thread";
const MESSAGE = "karaoke-fixture-message";

export const KARAOKE_FIXTURE_REPLY = [
  "The release build **749** passed every check on the first try, and the installer is signed and ready to share with the team today.",
  "",
  "```sh",
  "pnpm build && pnpm test",
  "```",
  "",
  "Two things changed since the last build:",
  "",
  "- The voice reads the reply as written, so numbers like 749 stay numbers.",
  "- Words light up right here in the message as they are spoken.",
  "",
  "See [the release notes](https://example.com/notes) for the rest.",
].join("\n");

const SOURCE = writtenReply(KARAOKE_FIXTURE_REPLY);
const SPOKEN = utterancesWithSpans(SOURCE);
/** The first clip's length: a little slower than the estimate, as a real
 * voice usually is. */
const CLIP_SECONDS = (SPOKEN[0]?.text.length ?? 0) * 0.07;

/** A clip that is "playing" at a pinned position and never ends. */
class PinnedAudio {
  src: string;
  currentTime = CLOCK_SECONDS;
  duration = CLIP_SECONDS;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  addEventListener(): void {}
}

function audioAnswer(): Response {
  const body = {
    audio: [{ path: "/api/attachments/karaoke-fixture-0.mp3", mime: "audio/mpeg" }],
    voiceText: SPOKEN.map((u) => u.text).join(" "),
    utterances: SPOKEN.map((u) => u.text),
    total: SPOKEN.length,
    complete: false,
    voice: "fixture-voice",
    script: "written",
    spans: encodeSpokenSpans(SOURCE, SPOKEN),
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** The same pin as the spec's pinFonts, applied before anything renders. */
const PINNED_FONTS = `
  *, *::before, *::after {
    font-family: "DejaVu Sans", sans-serif !important;
  }
  code, kbd, pre, samp, tt {
    font-family: "DejaVu Sans Mono", monospace !important;
  }
`;

function pinFonts(): void {
  if (document.getElementById("karaoke-fixture-fonts")) return;
  const style = document.createElement("style");
  style.id = "karaoke-fixture-fonts";
  style.textContent = PINNED_FONTS;
  document.head.appendChild(style);
}

pinFonts();

let installed = false;

function installStandIns(): void {
  if (installed) return;
  installed = true;
  Object.defineProperty(window, "Audio", { configurable: true, writable: true, value: PinnedAudio });
  const realFetch = window.fetch.bind(window);
  const audioRoute = `/api/threads/${THREAD}/messages/${MESSAGE}/audio`;
  window.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url, window.location.href).pathname;
    if (path === audioRoute && init?.method === "POST") return audioAnswer();
    if (path.startsWith(`${audioRoute}/`)) return new Response(new Blob(["fixture clip"], { type: "audio/mpeg" }), { status: 200 });
    return realFetch(input, init);
  };
}

export default function KaraokeVisualFixture() {
  const spokenRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [heightBefore, setHeightBefore] = useState<number | null>(null);
  const [heightAfter, setHeightAfter] = useState<number | null>(null);
  useMessageKaraoke(spokenRef, MESSAGE, SOURCE);

  useEffect(() => {
    if (DARK) document.documentElement.dataset.skin = "midnight";
    installStandIns();
    let frame = 0;
    let cancelled = false;
    const unsubscribe = speaker.subscribeKaraoke((feed) => {
      if (!feed) return;
      // Two frames: the highlighter paints from its own frame loop.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setHeightAfter(bubbleRef.current?.offsetHeight ?? null));
      });
    });
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      setHeightBefore(bubbleRef.current?.offsetHeight ?? null);
      void speaker.speak(KARAOKE_FIXTURE_REPLY, { botId: "karaoke-fixture-bot", threadId: THREAD, messageId: MESSAGE, voiceId: "fixture-voice" });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      unsubscribe();
      speaker.stop();
    };
  }, []);

  return (
    <div className="min-h-screen bg-app p-6 text-ink" data-testid="karaoke-board">
      <div
        ref={bubbleRef}
        data-testid="karaoke-bubble"
        data-karaoke-ready={heightAfter !== null ? "true" : "false"}
        data-height-before={heightBefore ?? ""}
        data-height-after={heightAfter ?? ""}
        className="max-w-[560px] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink"
      >
        <div ref={spokenRef}>
          <ChatMarkdown text={SOURCE} />
        </div>
      </div>
    </div>
  );
}
