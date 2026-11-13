// composeMessage with images, the image tag round-trip through
// splitAttachedImages, and the mime gate the composer pastes through.
import { describe, expect, it } from "vitest";

import {
  appendPastedText,
  filesFromClipboard,
  attachmentBasename,
  attachmentImageUrl,
  composeMessage,
  isImageFile,
  splitAttachedImages,
  type ImageAttachment,
} from "./composer-attachments";

/** Exercises the spacing and empty-draft cases for pasted text insertion. */
function appendPastedTextTests() {
  /** Keeps an existing draft ahead of newly inserted pasted content. */
  function addsPastedContentAfterDraft() {
    expect(appendPastedText("Keep this", "Edit this too")).toBe("Keep this\n\nEdit this too");
  }

  /** Avoids duplicating a separator when the draft already ends with a newline. */
  function preservesExistingTrailingNewline() {
    expect(appendPastedText("Keep this\n", "Edit this too")).toBe("Keep this\nEdit this too");
  }

  /** Inserts pasted content directly when no draft exists yet. */
  function insertsIntoEmptyDraft() {
    expect(appendPastedText("", "Edit this too")).toBe("Edit this too");
  }

  it("adds pasted content after an existing draft", addsPastedContentAfterDraft);
  it("does not add a second separator when the draft ends with a newline", preservesExistingTrailingNewline);
  it("uses the pasted content directly for an empty draft", insertsIntoEmptyDraft);
}

describe("appendPastedText", appendPastedTextTests);

/** Builds a stable image attachment fixture for prompt and preview tests. */
function image(path: string): ImageAttachment {
  return {
    kind: "image",
    id: "i1",
    path,
    name: "shot.png",
    size: 1234,
    mime: "image/png",
  };
}

describe("composeMessage with images", () => {
  it("emits an attached-image tag carrying the server path", () => {
    const prompt = composeMessage("what is this?", [image("/home/u/.botfleet/attachments/abc.png")]);
    expect(prompt).toBe(
      'what is this?\n\n<attached-image path="/home/u/.botfleet/attachments/abc.png" />',
    );
  });

  it("escapes a hostile path the same way file paths are escaped", () => {
    const prompt = composeMessage("", [image('/x/")} onload="evil()')]);
    // every quote is entity-encoded, so the payload can never break out of
    // the attribute — the tag stays one well-formed element
    expect(prompt).toMatch(/<attached-image path="[^"]*" \/>/);
    expect(prompt).toContain("&quot;");
  });
});

describe("splitAttachedImages", () => {
  it("splits tags out of a stored message and returns the paths", () => {
    const stored =
      'look at this\n\n<attached-image path="/a/b/one.png" />\n\n<attached-image path="/a/b/two.jpg" />';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe("look at this");
    expect(images).toEqual(["/a/b/one.png", "/a/b/two.jpg"]);
  });

  it("unescapes attribute entities so the path round-trips", () => {
    const stored = '<attached-image path="/a/b/&amp;x.png" />';
    const { images } = splitAttachedImages(stored);
    expect(images).toEqual(["/a/b/&x.png"]);
  });

  it("leaves plain text and other tags untouched", () => {
    const stored = '<pasted-text index="1">\nhi\n</pasted-text>';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe(stored);
    expect(images).toEqual([]);
  });

  it("strips attached-file tags and previews image files as images", () => {
    const stored =
      'see this\n\n<attached-file path="/Users/j/.botfleet/attachments/123e4567-e89b-12d3-a456-426614174000.jpg" />\n\n<attached-file path="/Users/j/.botfleet/attachments/123e4567-e89b-12d3-a456-426614174001.pdf" />';
    const { display, images, files } = splitAttachedImages(stored);
    expect(display).toBe("see this");
    expect(images).toEqual(["/Users/j/.botfleet/attachments/123e4567-e89b-12d3-a456-426614174000.jpg"]);
    expect(files).toEqual(["/Users/j/.botfleet/attachments/123e4567-e89b-12d3-a456-426614174001.pdf"]);
  });
});

describe("attachmentBasename", () => {
  it("takes the final path segment on POSIX and Windows separators", () => {
    expect(attachmentBasename("/a/b/c.png")).toBe("c.png");
    expect(attachmentBasename("C:\\a\\b\\c.png")).toBe("c.png");
  });

  it("turns only generated image names into same-origin preview URLs", () => {
    expect(attachmentImageUrl("/a/b/123e4567-e89b-12d3-a456-426614174000.png")).toBe(
      "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png",
    );
    expect(attachmentImageUrl("C:\\a\\b\\photo.webp")).toBe("/api/attachments/photo.webp");
    expect(attachmentImageUrl("https://attacker.example/tracker.png?cookie=1")).toBeNull();
    expect(attachmentImageUrl("/a/b/payload.html")).toBeNull();
    expect(attachmentImageUrl("/a/b/123e4567-e89b-12d3-a456-426614174000.svg")).toBe(
      "/api/attachments/123e4567-e89b-12d3-a456-426614174000.svg",
    );
    expect(attachmentImageUrl("/a/b/not%2Fan-image.png")).toBeNull();
  });
});

describe("isImageFile", () => {
  it("accepts the served image mimes, including HEIC, BMP, and SVG", () => {
    expect(isImageFile({ type: "image/png", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/jpeg", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/webp", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/gif", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/heic", size: 10, name: "face.heic" })).toBe(true);
    expect(isImageFile({ type: "image/bmp", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/svg+xml", size: 10 })).toBe(true);
    expect(isImageFile({ type: "", size: 10, name: "spin.gif" })).toBe(true);
    expect(isImageFile({ type: "", size: 10, name: "mark.svg" })).toBe(true);
    expect(isImageFile({ type: "text/plain", size: 10 })).toBe(false);
  });
});

/** Clipboard paste often exposes HEIC plus a converted TIFF under image.* names. */
describe("filesFromClipboard", () => {
  it("dedupes generated HEIC + TIFF clipboard items to a single file", () => {
    const heic = new File([new Uint8Array([1, 2, 3])], "image.heic", { type: "image/heic" });
    const tiff = new File([new Uint8Array([4, 5, 6, 7])], "image.tiff", { type: "image/tiff" });
    const out = filesFromClipboard({
      files: [heic, tiff],
      items: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toMatch(/^image\.(heic|tiff)$/i);
  });
});
