import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Attachment } from "./composer-attachments";
import {
  getDraft,
  getDraftAttachments,
  mergeRestoredDraft,
  registerLiveDraft,
  restoreDraft,
  setDraft,
  setDraftAttachments,
  subscribeDraftAttachmentUpdates,
} from "./drafts";

describe("draft attachment live updates", () => {
  const target = new EventTarget();

  beforeEach(() => {
    vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
    vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
    vi.stubGlobal("dispatchEvent", target.dispatchEvent.bind(target));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes the window listener on unsubscribe", () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("addEventListener", add);
    vi.stubGlobal("removeEventListener", remove);

    const unsubscribe = subscribeDraftAttachmentUpdates("bot:one", vi.fn());
    expect(add).toHaveBeenCalledWith("omb-draft-attachments-updated", expect.any(Function));

    unsubscribe();
    expect(remove).toHaveBeenCalledWith("omb-draft-attachments-updated", expect.any(Function));
  });

  it("notifies only the matching conversation id", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeDraftAttachmentUpdates("bot:one", onChange);

    target.dispatchEvent(
      new CustomEvent("omb-draft-attachments-updated", { detail: { id: "bot:other" } }),
    );
    expect(onChange).not.toHaveBeenCalled();

    target.dispatchEvent(
      new CustomEvent("omb-draft-attachments-updated", { detail: { id: "bot:one" } }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

const paste = (id: string, text = "pasted body"): Attachment => ({ kind: "paste", id, text, size: text.length, lines: 1 });
const file = (id: string): Attachment => ({ kind: "file", id, path: `/tmp/${id}.txt`, name: `${id}.txt`, size: 4 });

/** An in-memory stand-in for localStorage, the shape drafts.ts takes. */
function memoryStore(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("mergeRestoredDraft", () => {
  it("gives a failed send back verbatim when the composer is empty", () => {
    const sent = { text: "line one\nline two\n", attachments: [paste("a"), file("b")] };
    expect(mergeRestoredDraft({ text: "", attachments: [] }, sent)).toEqual(sent);
  });

  it("treats a composer holding only spaces as empty", () => {
    const merged = mergeRestoredDraft({ text: "  \n", attachments: [] }, { text: "keep me", attachments: [] });
    expect(merged.text).toBe("keep me");
  });

  it("puts the failed text before whatever was typed since, and keeps both", () => {
    const merged = mergeRestoredDraft(
      { text: "typed after the failure", attachments: [] },
      { text: "the message that failed", attachments: [] },
    );
    expect(merged.text).toBe("the message that failed\n\ntyped after the failure");
  });

  it("leaves newer typing alone when the failed send was attachments only", () => {
    const merged = mergeRestoredDraft({ text: "newer", attachments: [] }, { text: "", attachments: [paste("a")] });
    expect(merged).toEqual({ text: "newer", attachments: [paste("a")] });
  });

  it("joins the chips without repeating one that is already in the composer", () => {
    const merged = mergeRestoredDraft(
      { text: "", attachments: [paste("a"), file("c")] },
      { text: "", attachments: [paste("a"), file("b")] },
    );
    expect(merged.attachments.map((attachment) => attachment.id)).toEqual(["a", "b", "c"]);
  });
});

describe("restoreDraft", () => {
  it("writes a failed send back to a conversation nobody has open", () => {
    const store = memoryStore();
    restoreDraft("bot:one", { text: "long prompt", attachments: [paste("a")] }, store);
    expect(getDraft(store, "bot:one")).toBe("long prompt");
    expect(getDraftAttachments(store, "bot:one")).toEqual([paste("a")]);
  });

  it("merges into a stored draft instead of replacing it", () => {
    const store = memoryStore();
    setDraft(store, "bot:one", "typed since");
    setDraftAttachments(store, "bot:one", [file("c")]);
    restoreDraft("bot:one", { text: "failed", attachments: [paste("a")] }, store);
    expect(getDraft(store, "bot:one")).toBe("failed\n\ntyped since");
    expect(getDraftAttachments(store, "bot:one").map((attachment) => attachment.id)).toEqual(["a", "c"]);
  });

  it("restores only the conversation the send came from", () => {
    const store = memoryStore();
    restoreDraft("bot:one", { text: "failed", attachments: [] }, store);
    expect(getDraft(store, "bot:two")).toBe("");
  });

  it("does not throw when storage refuses the write", () => {
    const full: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => restoreDraft("bot:one", { text: "failed", attachments: [paste("a")] }, full)).not.toThrow();
  });

  it("hands the failed send to the open composer, which owns the text on screen", () => {
    const store = memoryStore();
    const restore = vi.fn();
    const unregister = registerLiveDraft("bot:one", restore);
    const sent = { text: "failed", attachments: [paste("a")] };

    restoreDraft("bot:one", sent, store);
    expect(restore).toHaveBeenCalledWith(sent);
    // storage is left to the open composer: it writes its own state through
    expect(getDraft(store, "bot:one")).toBe("");

    unregister();
    restoreDraft("bot:one", sent, store);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(getDraft(store, "bot:one")).toBe("failed");
  });

  it("keeps the newest open composer when an older one unregisters late", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerLiveDraft("bot:one", first);
    const unregisterSecond = registerLiveDraft("bot:one", second);
    unregisterFirst();

    restoreDraft("bot:one", { text: "failed", attachments: [] }, memoryStore());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unregisterSecond();
  });
});
