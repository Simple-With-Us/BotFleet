// Unsent composer text, kept per thread. The Composer is keyed by bot/room
// id, so switching threads unmounts it and its local text state dies with
// it. Drafts live in localStorage, so coming back to a bot — in this
// session or after a restart — finds what you were typing still there.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { isAttachment, type Attachment } from "./composer-attachments.js";

const KEY = "omb-drafts";
const ATTACHMENTS_KEY = "omb-draft-attachments";

type Values = Record<string, unknown>;
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;

// Storage is best-effort: a full quota, a locked-down origin, or a garbled
// value must never cost a keystroke — every failure reads as "no drafts".
function read(store: Store, key: string): Values {
  try {
    const raw = store?.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Values) : {};
  } catch {
    return {};
  }
}

export function getDraft(store: Store, id: string): string {
  const text = read(store, KEY)[id];
  return typeof text === "string" ? text : "";
}

export function setDraft(store: Store, id: string, text: string): void {
  const drafts = read(store, KEY);
  // an emptied composer drops its entry rather than storing "" forever
  if (text) drafts[id] = text;
  else delete drafts[id];
  try {
    store?.setItem(KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode — the draft just doesn't outlive the mount */
  }
}

export function getDraftAttachments(store: Store, id: string): Attachment[] {
  const attachments = read(store, ATTACHMENTS_KEY)[id];
  return Array.isArray(attachments) ? attachments.filter(isAttachment) : [];
}

export function setDraftAttachments(store: Store, id: string, attachments: Attachment[]): void {
  const drafts = read(store, ATTACHMENTS_KEY);
  if (attachments.length) drafts[id] = attachments;
  else delete drafts[id];
  try {
    store?.setItem(ATTACHMENTS_KEY, JSON.stringify(drafts));
  } catch {
    /* quota / private mode — attachments remain in component state */
  }
}

interface EventTargetLike {
  dispatchEvent(event: unknown): boolean;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Live composer chips listen here so a sidebar drop lands in the open draft. */
export function subscribeDraftAttachmentUpdates(
  id: string,
  onChange: (attachments: Attachment[]) => void,
): () => void {
  if (typeof globalThis === "undefined" || !("addEventListener" in globalThis)) {
    return () => {};
  }
  const target = globalThis as unknown as EventTargetLike;
  const handler = (e: unknown) => {
    const detail = (e as { detail?: { id?: string } })?.detail;
    if (detail?.id === id) {
      onChange(getDraftAttachments(getStore(), id));
    }
  };
  target.addEventListener("omb-draft-attachments-updated", handler);
  return () => target.removeEventListener("omb-draft-attachments-updated", handler);
}

export function appendDraftAttachments(id: string, newAttachments: Attachment[]): void {
  if (!newAttachments.length) return;
  const store = getStore();
  const existing = getDraftAttachments(store, id);
  setDraftAttachments(store, id, [...existing, ...newAttachments]);
  try {
    if (typeof globalThis !== "undefined" && "dispatchEvent" in globalThis) {
      const target = globalThis as unknown as EventTargetLike;
      const CustomEventCtor = (globalThis as unknown as { CustomEvent?: new (type: string, params?: unknown) => unknown }).CustomEvent;
      if (CustomEventCtor) {
        target.dispatchEvent(new CustomEventCtor("omb-draft-attachments-updated", { detail: { id } }));
      }
    }
  } catch {
    /* window not available in non-DOM test env */
  }
}

/** What a send took out of the composer: the text and the attachment chips. */
export interface DraftSnapshot {
  text: string;
  attachments: Attachment[];
}

/** A failed send folded back into the composer as it is now.  The failed text
 * goes first (it was written first) and anything typed since is kept after
 * it; chips are joined by id, so a restore never doubles one. */
export function mergeRestoredDraft(current: DraftSnapshot, sent: DraftSnapshot): DraftSnapshot {
  const text = !current.text.trim()
    ? sent.text
    : !sent.text.trim()
      ? current.text
      : `${sent.text.trimEnd()}\n\n${current.text}`;
  const restored = new Set(sent.attachments.map((attachment) => attachment.id));
  return {
    text,
    attachments: [...sent.attachments, ...current.attachments.filter((attachment) => !restored.has(attachment.id))],
  };
}

type LiveRestore = (sent: DraftSnapshot) => void;

// The composers that are on screen right now, by conversation.  An open
// composer owns the text its person is looking at (storage can be full or
// blocked and still hold nothing), so a restore goes to it first.
const liveDrafts = new Map<string, LiveRestore>();

export function registerLiveDraft(id: string, restore: LiveRestore): () => void {
  liveDrafts.set(id, restore);
  // a composer that unmounts late must not unregister the one that replaced it
  return () => {
    if (liveDrafts.get(id) === restore) liveDrafts.delete(id);
  };
}

/** Puts a send the server refused back into conversation `id`'s draft.  The
 * person may have switched conversations while the send was in flight, so
 * with no open composer it lands in storage, where coming back finds it. */
export function restoreDraft(id: string, sent: DraftSnapshot, store: Store = getStore()): void {
  const live = liveDrafts.get(id);
  if (live) {
    live(sent);
    return;
  }
  const merged = mergeRestoredDraft(
    { text: getDraft(store, id), attachments: getDraftAttachments(store, id) },
    sent,
  );
  setDraft(store, id, merged.text);
  setDraftAttachments(store, id, merged.attachments);
}

// Reaching for localStorage is itself a failure point: on an origin with
// storage blocked the getter throws, and `typeof` doesn't shield it.
function getStore(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** useState for the composer text, persisted under `id` (a bot or room). */
export function useDraft(id: string): [string, (next: string) => void] {
  const store = getStore();
  const [text, setText] = useState(() => getDraft(store, id));
  const set = useCallback(
    (next: string) => {
      setText(next);
      setDraft(store, id, next);
    },
    [store, id],
  );
  return [text, set];
}

/** A conversation's complete composer draft. Attachment storage is separate
 * from text so typing does not stringify a large pasted payload per keypress. */
export function useComposerDraft(
  id: string,
): [
  string,
  (next: string) => void,
  Attachment[],
  (next: SetStateAction<Attachment[]>) => void,
] {
  const store = getStore();
  const [text, setText] = useDraft(id);
  const [attachments, setAttachmentState] = useState(() => getDraftAttachments(store, id));
  const setAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      setAttachmentState((previous) => {
        const value = typeof next === "function" ? next(previous) : next;
        setDraftAttachments(store, id, value);
        return value;
      });
    },
    [store, id],
  );

  // Sidebar drops write storage then fire this event. useEffect so StrictMode
  // and unmount actually remove the listener — useState initializers never run
  // the returned cleanup.
  useEffect(() => {
    setAttachmentState(getDraftAttachments(getStore(), id));
    return subscribeDraftAttachmentUpdates(id, setAttachmentState);
  }, [id]);

  // A send the server refuses folds back into what is on screen right now.
  // Registered in a layout effect: a refusal that lands between this render
  // and a passive effect would write storage behind a draft already read.
  const onScreen = useRef<DraftSnapshot>({ text, attachments });
  onScreen.current = { text, attachments };
  useLayoutEffect(
    () =>
      registerLiveDraft(id, (sent) => {
        const merged = mergeRestoredDraft(onScreen.current, sent);
        onScreen.current = merged;
        setText(merged.text);
        setAttachments(merged.attachments);
      }),
    [id, setText, setAttachments],
  );

  return [text, setText, attachments, setAttachments];
}

/** A send as the composer handed it over: the draft it took, which
 * conversation it came from, and the message it was a reply to. */
export interface SentDraft<Reply> extends DraftSnapshot {
  draftId: string;
  threadId: string;
  reply?: Reply;
}

/** Returns what a composer calls when the server refuses or cannot be reached
 * for a send: the draft goes back where it was, and the reply target goes back
 * too unless the person has moved on (another thread, another reply, or the
 * composer is gone). */
export function useFailedSendRestore<Reply>(
  threadId: string,
  onRestoreReply?: (reply: Reply) => void,
): (sent: SentDraft<Reply>) => void {
  const latest = useRef({ threadId, onRestoreReply, mounted: true });
  latest.current.threadId = threadId;
  latest.current.onRestoreReply = onRestoreReply;
  useEffect(() => {
    latest.current.mounted = true;
    return () => {
      latest.current.mounted = false;
    };
  }, []);
  return useCallback((sent) => {
    restoreDraft(sent.draftId, sent);
    const now = latest.current;
    if (sent.reply && now.mounted && now.threadId === sent.threadId) now.onRestoreReply?.(sent.reply);
  }, []);
}

