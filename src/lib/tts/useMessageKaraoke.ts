import { useEffect, type RefObject } from "react";

import { attachKaraoke, type KaraokeSession } from "../karaoke-session";
import type { KaraokeFeed } from "./karaoke-feed";
import { speaker } from "./index";

/**
 * Karaoke for one rendered message: while the speaker reads `messageId`, the
 * words inside `ref` follow the voice.  No React state changes per word; the
 * subscription only attaches and disposes a highlighter, so the memoized
 * markdown never re-renders and nothing else in the thread is invalidated.
 *
 * `sourceText` is writtenReply(message.text).  When it changes the message
 * has re-rendered, its text nodes are new, and the highlighter is rebuilt.
 */
export function useMessageKaraoke(ref: RefObject<HTMLElement | null>, messageId: string, sourceText: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    let session: KaraokeSession | null = null;
    /** A finished reply's session, clearing itself after its linger. */
    let lingering: KaraokeSession | null = null;
    let following: KaraokeFeed | null = null;
    const unsubscribe = speaker.subscribeKaraoke((feed) => {
      if (feed === following) return;
      lingering?.dispose();
      lingering = null;
      // A reply that finished keeps its last word for a moment and then
      // clears itself (attachKaraoke's linger); anything else clears now.
      if (feed === null && following?.ended === "finished") lingering = session;
      else session?.dispose();
      session = null;
      following = null;
      const container = ref.current;
      if (!feed || feed.messageId !== messageId || !container) return;
      following = feed;
      session = attachKaraoke(container, feed, sourceText);
    });
    return () => {
      unsubscribe();
      session?.dispose();
      lingering?.dispose();
      session = null;
      lingering = null;
    };
  }, [ref, messageId, sourceText, enabled]);
}
