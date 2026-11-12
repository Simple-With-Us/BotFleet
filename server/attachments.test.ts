// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-attachments-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const {
  ATTACHMENTS_DIR,
  DEFAULT_AUDIO_RETENTION_DAYS,
  IMAGE_MAX_BYTES,
  extensionForMime,
  readAttachment,
  saveAttachment,
  saveImage,
  sweepExpiredAudioAttachments,
} = await import("./attachments.ts");

describe("extensionForMime", () => {
  it("maps the accepted image mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
    expect(extensionForMime("image/bmp")).toBe(".bmp");
    expect(extensionForMime("image/svg+xml")).toBe(".svg");
    expect(extensionForMime("image/heic")).toBe(".heic");
    expect(extensionForMime("image/heif")).toBe(".heif");
    expect(extensionForMime("image/tiff")).toBe(".tiff");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses html/js, which execute in a browser", () => {
    expect(extensionForMime("text/html")).toBeNull();
    expect(extensionForMime("application/javascript")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });

  it("maps ordinary chat files and audio formats", () => {
    expect(extensionForMime("application/pdf")).toBe(".pdf");
    expect(extensionForMime("text/plain")).toBe(".txt");
    expect(extensionForMime("application/octet-stream")).toBe(".bin");
    expect(extensionForMime("audio/mpeg")).toBe(".mp3");
    expect(extensionForMime("audio/wav")).toBe(".wav");
    expect(extensionForMime("audio/ogg")).toBe(".ogg");
    expect(extensionForMime("audio/opus")).toBe(".opus");
    expect(extensionForMime("audio/mp4")).toBe(".m4a");
    expect(extensionForMime("audio/x-m4a")).toBe(".m4a");
    expect(extensionForMime("audio/aac")).toBe(".aac");
    expect(extensionForMime("audio/webm")).toBe(".webm");
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveImage(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", () => {
    const saved = saveImage(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = readAttachment(name);
    expect(back?.bytes.toString()).toBe("gif!");
    expect(back?.mime).toBe("image/gif");
  });

  it("saves a pdf as a generated .pdf path", () => {
    const saved = saveAttachment(Buffer.from("%PDF-1.4"), "application/pdf");
    expect(saved.path.endsWith(".pdf")).toBe(true);
    expect(saved.mime).toBe("application/pdf");
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveImage(Buffer.from("x"), "text/html")).toThrow(/unsupported file type/);
    expect(saveImage(Buffer.from("<svg/>"), "image/svg+xml").path.endsWith(".svg")).toBe(true);
    expect(() => saveImage(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/exceeds/);
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("refuses traversal, dotfiles, and names the saver never writes", () => {
    expect(readAttachment("..%2F..%2Fconfig.json")).toBeNull();
    expect(readAttachment(".env")).toBeNull();
    expect(readAttachment("a/b.png")).toBeNull();
    expect(readAttachment("no-extension")).toBeNull();
    expect(readAttachment("uuid.jpeg")).toBeNull(); // saved as .jpg
  });
});

describe("sweepExpiredAudioAttachments", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("deletes audio files older than retentionDays (default 7) while keeping recent audio and non-audio files", () => {
    expect(DEFAULT_AUDIO_RETENTION_DAYS).toBe(7);
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1_000);
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1_000);

    const oldMp3 = saveAttachment(Buffer.from("old-mp3"), "audio/mpeg");
    const oldOpus = saveAttachment(Buffer.from("old-opus"), "audio/ogg");
    const freshMp3 = saveAttachment(Buffer.from("fresh-mp3"), "audio/mpeg");
    const oldPng = saveImage(Buffer.from("old-png"), "image/png");

    utimesSync(oldMp3.path, eightDaysAgo, eightDaysAgo);
    utimesSync(oldOpus.path, eightDaysAgo, eightDaysAgo);
    utimesSync(freshMp3.path, twoDaysAgo, twoDaysAgo);
    utimesSync(oldPng.path, eightDaysAgo, eightDaysAgo);

    const dry = sweepExpiredAudioAttachments(7, { nowMs: now, dryRun: true });
    expect(dry.removedFiles).toBe(2);
    expect(existsSync(oldMp3.path)).toBe(true);

    const result = sweepExpiredAudioAttachments(7, { nowMs: now });
    expect(result.removedFiles).toBe(2);
    expect(result.freedBytes).toBe(15);
    expect(existsSync(oldMp3.path)).toBe(false);
    expect(existsSync(oldOpus.path)).toBe(false);
    expect(existsSync(freshMp3.path)).toBe(true);
    expect(existsSync(oldPng.path)).toBe(true);

    // 0 means keep forever
    utimesSync(freshMp3.path, eightDaysAgo, eightDaysAgo);
    const forever = sweepExpiredAudioAttachments(0, { nowMs: now });
    expect(forever.removedFiles).toBe(0);
    expect(existsSync(freshMp3.path)).toBe(true);
  });
});
