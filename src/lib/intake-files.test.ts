import { describe, expect, it } from "vitest";

import { attachmentLabel, filesFromClipboard, intakeFiles, isImageFile, type Attachment, type ClipboardFileSource, type DroppedFile } from "./composer-attachments";

type Fake = DroppedFile;
const file = (name: string, type: string, size = 10): Fake => ({
  name,
  size,
  type,
  text: async () => "contents",
  arrayBuffer: async () => new ArrayBuffer(size),
});
const upload = async (f: Fake): Promise<Attachment> => ({
  kind: "image",
  id: `id-${f.name}`,
  name: f.name,
  path: `/api/attachments/${f.name}`,
  size: f.size,
  mime: f.type,
});
const onDisk = (f: Fake) => `/Users/me/${f.name}`;

describe("intakeFiles", () => {
  it("uploads images and keeps ordinary files as paths", async () => {
    const out = await intakeFiles([file("shot.png", "image/png"), file("notes.txt", "text/plain")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: upload,
    });
    expect(out.attachments.map((a) => [a.kind, "name" in a ? a.name : ""])).toEqual([
      ["image", "shot.png"],
      ["file", "notes.txt"],
    ]);
    expect(out.notice).toBeNull();
  });

  it("treats an image as an ordinary file when the engine cannot read one", async () => {
    const out = await intakeFiles([file("shot.png", "image/png")], {
      allowImages: false,
      getPath: onDisk,
      uploadImage: async () => {
        throw new Error("must not upload");
      },
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].kind).toBe("file");
  });

  it("treats HEIC, HEIF, and TIFF as images", () => {
    expect(isImageFile({ type: "image/heic", name: "IMG_1234.HEIC" })).toBe(true);
    expect(isImageFile({ type: "image/heif", name: "photo.heif" })).toBe(true);
    expect(isImageFile({ type: "image/tiff", name: "" })).toBe(true);
    expect(isImageFile({ type: "", name: "shot.heic" })).toBe(true);
  });

  it("labels a nameless Apple paste from its mime", () => {
    expect(attachmentLabel({ name: "", type: "image/heic" })).toBe("Pasted Photo.heic");
    expect(attachmentLabel({ name: "", type: "image/tiff" })).toBe("Pasted Screenshot.tiff");
  });

  it("reads screenshot pastes from clipboard items, not only files", () => {
    const blob = new File([new Uint8Array([1, 2, 3])], "", { type: "image/png" });
    const data = {
      files: [] as File[],
      items: [{ kind: "file", type: "image/png", getAsFile: () => blob }],
    } as unknown as ClipboardFileSource;
    expect(filesFromClipboard(data)).toHaveLength(1);
  });

  it("names the files it could not take, rather than dropping them in silence", async () => {
    const out = await intakeFiles([{ ...file("ghost.bin", "application/octet-stream", 999_999_999) }], {
      allowImages: true,
      getPath: () => "",
      uploadImage: upload,
    });
    expect(out.attachments).toHaveLength(0);
    expect(out.notice).toMatch(/ghost\.bin/);
    expect(out.notice).toMatch(/could not be attached/);
  });

  it("reports an upload that failed without losing the files that worked", async () => {
    const out = await intakeFiles([file("ok.png", "image/png"), file("bad.png", "image/png")], {
      allowImages: true,
      getPath: onDisk,
      uploadImage: async (f) => {
        if (f.name === "bad.png") throw new Error("too large");
        return upload(f);
      },
    });
    expect(out.attachments).toHaveLength(1);
    expect(out.notice).toMatch(/bad\.png: too large/);
  });

  it("surfaces the underlying error when a pathless image upload to a non-image engine fails", async () => {
    // Reproduces the user-visible "Pasted Screenshot.png could not be attached" — before this fix the
    // upload error was swallowed by attachmentsFromDroppedFiles so the user had no way to tell what
    // actually went wrong.
    const fakeResponse = {
      ok: false,
      statusText: "Bad Request",
      json: async () => ({ error: "content-type must be a supported file type" }),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(fakeResponse)) as typeof fetch;
    try {
      const out = await intakeFiles([file("", "image/png", 3)], {
        allowImages: false,
        getPath: () => "",
        uploadImage: async () => null,
      });
      expect(out.attachments).toHaveLength(0);
      expect(out.notice).toMatch(/Pasted Screenshot\.png could not be attached/);
      expect(out.notice).toMatch(/Pasted Screenshot\.png: content-type must be a supported file type/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("attaches a pathless screenshot as a file when the engine cannot read images", async () => {
    // Electron drop or browser paste: no disk path, image-capable server endpoint.
    // allowImages: false because the engine/bot has no image capability — the image is still
    // uploaded as a file attachment so the user does not lose the paste.
    const fakeResponse = {
      ok: true,
      statusText: "Created",
      json: async () => ({ path: "/api/attachments/abc.png", mime: "image/png", bytes: 3 }),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(fakeResponse)) as typeof fetch;
    try {
      const out = await intakeFiles([file("", "image/png", 3)], {
        allowImages: false,
        getPath: () => "",
        uploadImage: async () => null,
      });
      expect(out.attachments).toHaveLength(1);
      expect(out.attachments[0].kind).toBe("file");
      expect(out.notice).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
