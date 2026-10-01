// What is attached to the next message: text too long for the input or a
// file dropped onto the window. Chips fold back into a normal prompt on
// send, so every driver receives the same message shape.
import { formatByteSize as formatSize } from "../../shared/text-format.ts";

export type PasteAttachment = {
  kind: "paste";
  id: string;
  text: string;
  size: number;
  lines: number;
};

export type FileAttachment = {
  kind: "file";
  id: string;
  path: string;
  name: string;
  size: number;
};

export type ImageAttachment = {
  kind: "image";
  id: string;
  path: string;
  name: string;
  size: number;
  mime: string;
};

export type Attachment = PasteAttachment | FileAttachment | ImageAttachment;

export function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  if (typeof attachment.id !== "string" || !validSize(attachment.size)) return false;
  if (attachment.kind === "paste") {
    return (
      typeof attachment.text === "string" &&
      typeof attachment.lines === "number" &&
      Number.isInteger(attachment.lines) &&
      attachment.lines >= 1
    );
  }
  if (attachment.kind === "file") {
    return (
      typeof attachment.path === "string" &&
      attachment.path.length > 0 &&
      typeof attachment.name === "string"
    );
  }
  if (attachment.kind === "image") {
    return (
      typeof attachment.path === "string" &&
      attachment.path.length > 0 &&
      typeof attachment.name === "string" &&
      typeof attachment.mime === "string" &&
      attachment.mime.startsWith("image/")
    );
  }
  return false;
}

function validSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Past this, a paste stops reading as typing and becomes an attachment.
 * Long-but-narrow (a stack trace, a log) counts by line, not just chars. */
export const PASTE_CHARS = 900;
export const PASTE_LINES = 12;

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_CHARS || countLines(text) >= PASTE_LINES;
}

export function countLines(text: string): number {
  return text.split("\n").length;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `a${Math.random().toString(36).slice(2)}`;
}

export function fileAttachment(name: string, path: string, size: number): FileAttachment {
  return { kind: "file", id: newId(), path, name, size };
}

/** Matches the server's IMAGE_MAX_BYTES — checked client-side so an
 * oversized paste is refused before the upload starts, not mid-stream. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Formats the transcript can preview and most engines can open. */
const PREVIEWABLE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Apple screenshot paste (TIFF) and camera roll (HEIC/HEIF) plus AVIF/BMP.
 * SVG stays previewable via <img> (main); not transcoded. */
const CONVERTIBLE_IMAGE_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  "image/avif",
  "image/tiff",
  "image/bmp",
  "image/x-ms-bmp",
]);

const IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/tiff",
  "image/bmp",
  "image/x-ms-bmp",
  "image/svg+xml",
] as const;

const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** Browser drops often arrive with an empty type; use the filename then. */
export function guessImageMime(file: { type: string; name?: string }): string | null {
  const declared = file.type.split(";")[0]!.trim().toLowerCase();
  if ((IMAGE_MIMES as readonly string[]).includes(declared)) {
    return declared === "image/x-ms-bmp" ? "image/bmp" : declared;
  }
  const ext = (file.name ?? "").split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT_MIME[ext] ?? null;
}

function imageMimeOf(file: { type: string; name?: string }): string {
  return guessImageMime(file) ?? (file.type || "").split(";")[0]!.trim().toLowerCase();
}

export function isImageFile(file: { type: string; size?: number; name?: string }): boolean {
  const mime = imageMimeOf(file);
  return PREVIEWABLE_IMAGE_MIMES.has(mime) || CONVERTIBLE_IMAGE_MIMES.has(mime) || mime === "image/svg+xml";
}

export function attachmentLabel(file: { name?: string; type?: string }): string {
  const name = (file.name || "").trim();
  if (name && name !== "blob" && name !== "image.png") return name;
  const mime = (file.type || "").split(";")[0]!.trim().toLowerCase();
  if (mime === "image/heic" || mime === "image/heif") return "Pasted Photo.heic";
  if (mime === "image/tiff") return "Pasted Screenshot.tiff";
  if (mime.startsWith("image/")) return "Pasted Screenshot.png";
  return name || mime || "untitled";
}

/**
 * Clipboard / drop shape we read files from.
 *
 * Structural on purpose: this module is imported from server tests under a
 * Node-only tsconfig (no DOM lib). Naming the DOM `DataTransfer` there picks
 * up a stub without `files`/`items`. The browser `DataTransfer` still
 * satisfies this shape at the call site.
 */
export type ClipboardFileSource = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{
    kind: string;
    type: string;
    getAsFile: () => File | null;
  }> | null;
};

type BitmapLike = { width: number; height: number; close: () => void };
type Canvas2DLike = { drawImage(image: BitmapLike, dx: number, dy: number): void };
type CanvasLike = {
  width: number;
  height: number;
  getContext(contextId: "2d"): Canvas2DLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
};

type ImageTranscodeGlobals = {
  createImageBitmap?: (image: Blob) => Promise<BitmapLike>;
  document?: { createElement(tagName: "canvas"): CanvasLike };
};

/** Cmd-V of a screenshot often puts the bitmap on `items`, not `files`. */
export function filesFromClipboard(data: ClipboardFileSource | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (file: File | null) => {
    if (!file || file.size === 0) return;
    const key = `${file.type}:${file.size}:${file.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(file);
  };
  for (const file of Array.from(data.files ?? [])) add(file);
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file" || item.type.startsWith("image/")) add(item.getAsFile());
  }

  // OS clipboards often hold one screenshot in multiple formats (e.g. PNG + TIFF, or HEIC + TIFF).
  // The browser exposes them all as separate items named "image.<ext>".
  // If we took them all, one paste would upload duplicates (and the TIFF might fail the 10MB limit).
  const isGenerated = (f: File) => /^image\.(png|jpeg|jpg|tiff|bmp|gif|webp|heic|heif)$/i.test(f.name);
  const generated = out.filter(isGenerated);
  if (generated.length > 1) {
    const best = generated.find(f => f.type === "image/png") ||
                 generated.find(f => f.type === "image/jpeg") ||
                 generated[0];
    return out.filter(f => !isGenerated(f) || f === best);
  }
  return out;
}

/** Decode HEIC/TIFF/AVIF via the OS image stack and re-encode JPEG so the
 * transcript preview (png|jpg|gif|webp only) and most engines can open it. */
export async function previewableImageFile(file: {
  name: string;
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<{ name: string; size: number; type: string; arrayBuffer: () => Promise<ArrayBuffer> }> {
  const mime = imageMimeOf(file);
  if (PREVIEWABLE_IMAGE_MIMES.has(mime) || mime === "image/svg+xml") {
    return { name: file.name || attachmentLabel(file), size: file.size, type: mime || file.type, arrayBuffer: () => file.arrayBuffer() };
  }
  const globals = globalThis as typeof globalThis & ImageTranscodeGlobals;
  const createBitmap = globals.createImageBitmap;
  const doc = globals.document;
  if (typeof createBitmap !== "function" || !doc) return file;
  try {
    const blob = new Blob([await file.arrayBuffer()], { type: mime || "application/octet-stream" });
    const bitmap = await createBitmap(blob);
    const canvas = doc.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const jpeg = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((encoded: Blob | null) => (encoded ? resolve(encoded) : reject(new Error("encode failed"))), "image/jpeg", 0.92);
    });
    const buffer = await jpeg.arrayBuffer();
    const base = attachmentLabel(file).replace(/\.[^.]+$/, "") || "Pasted Screenshot";
    return {
      name: `${base}.jpg`,
      size: buffer.byteLength,
      type: "image/jpeg",
      arrayBuffer: async () => buffer,
    };
  } catch {
    return file;
  }
}

/** Persist a pasted image server-side and return the attachment chip data.
 * The server writes ~/.botfleet/attachments/<uuid>.<ext> and answers
 * with the path; the prompt references that path so every CLI can open it. */
export async function imageAttachmentFromFile(file: {
  name: string;
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<ImageAttachment | null> {
  const prepared = await previewableImageFile(file);
  if (!isImageFile(prepared)) return null;
  if (prepared.size > IMAGE_MAX_BYTES) throw Object.assign(new Error(`${attachmentLabel(file)} exceeds 10 MB`), { status: 413 });
  const bytes = new Uint8Array(await prepared.arrayBuffer());
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: { "content-type": prepared.type || file.type },
    body: bytes,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw Object.assign(new Error(detail.error ?? "upload failed"), { status: response.status });
  }
  const saved = (await response.json()) as { path: string; mime: string; bytes: number };
  return { kind: "image", id: newId(), path: saved.path, name: prepared.name || file.name || "pasted image", size: saved.bytes, mime: saved.mime };
}

export function pasteAttachment(text: string): PasteAttachment {
  const id = newId();
  // measured once, here: a chip re-renders on every keystroke in the
  // composer, and encoding half a megabyte each time would be felt
  return { kind: "paste", id, text, size: byteLength(text), lines: countLines(text) };
}

/** Move a pasted attachment into the editable composer draft without
 * running the text back through the paste threshold. */
export function appendPastedText(text: string, pasted: string): string {
  if (!text) return pasted;
  return `${text}${text.endsWith("\n") ? "" : "\n\n"}${pasted}`;
}

/** Persist a pathless drop (browser paste, iOS share) so the prompt can
 * carry a disk path every engine can open. */
export async function uploadPathlessFile(file: {
  name: string;
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}): Promise<FileAttachment | ImageAttachment | null> {
  const mime = (file.type || "application/octet-stream").split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: { "content-type": mime },
    body: bytes,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw Object.assign(new Error(detail.error ?? "upload failed"), { status: response.status });
  }
  const saved = (await response.json()) as { path: string; mime: string; bytes: number };
  if (saved.mime.startsWith("image/")) {
    return { kind: "image", id: newId(), path: saved.path, name: file.name || "pasted image", size: saved.bytes, mime: saved.mime };
  }
  return fileAttachment(file.name || "attachment", saved.path, saved.bytes);
}

export const INLINE_DROP_LIMIT = 512 * 1024;

export type DroppedFile = Pick<File, "name" | "size" | "type" | "text"> & {
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

/** Turn a browser drop into composer attachments. Electron-backed files
 * keep their disk path; small pathless text drops keep their contents.
 * Promise.all preserves the user's drop order even when text reads finish
 * in a different order. */
export async function attachmentsFromDroppedFiles<T extends DroppedFile>(
  files: readonly T[],
  getPath: (file: T) => string,
  opts: { allowImages?: boolean } = {},
): Promise<{ attachments: Attachment[]; rejectedNames: string[] }> {
  const allowImages = opts.allowImages !== false;
  const results = await Promise.all(
    files.map(async (file) => {
      let path = "";
      try {
        path = getPath(file);
      } catch {
        // A browser or older desktop shell has no disk path to expose.
      }
      if (path) return { attachment: fileAttachment(file.name || attachmentLabel(file), path, file.size) };
      if (allowImages && isImageFile(file) && file.arrayBuffer) {
        try {
          const image = await imageAttachmentFromFile({
            name: file.name || attachmentLabel(file),
            size: file.size,
            type: file.type,
            arrayBuffer: file.arrayBuffer,
          });
          if (image) return { attachment: image };
        } catch {
          // Fall through to generic upload or reject.
        }
      }
      if (isInlineText(file) && file.size <= INLINE_DROP_LIMIT) {
        try {
          return { attachment: pasteAttachment(await file.text()) };
        } catch {
          // Treat an unreadable browser drag like any other pathless file.
        }
      }
      if (file.arrayBuffer) {
        try {
          const uploaded = await uploadPathlessFile({
            name: file.name || attachmentLabel(file),
            size: file.size,
            type: file.type,
            arrayBuffer: file.arrayBuffer,
          });
          if (uploaded) {
            if (!allowImages && uploaded.kind === "image") {
              return { attachment: fileAttachment(uploaded.name, uploaded.path, uploaded.size) };
            }
            return { attachment: uploaded };
          }
        } catch {
          // Named below as rejected.
        }
      }
      return { rejectedName: attachmentLabel(file) };
    }),
  );

  return {
    attachments: results.flatMap((result) =>
      "attachment" in result && result.attachment ? [result.attachment] : [],
    ),
    rejectedNames: results.flatMap((result) =>
      "rejectedName" in result && result.rejectedName ? [result.rejectedName] : [],
    ),
  };
}

function isInlineText(file: DroppedFile): boolean {
  return file.type.startsWith("text/") || file.type === "application/json";
}

/** What the paste actually weighs — String#length counts UTF-16 units, so
 * it reads a third under on accented text and half under on CJK. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "12 lines, 3.4 KB" — what the chip says under the preview. */
export function pasteSummary(a: { lines: number; size: number }): string {
  return `${a.lines} lines, ${formatSize(a.size)}`;
}

export { formatSize };

/** The prompt the bot receives: what was typed, then one block per
 * attachment. Tagged blocks rather than fences — pasted code and markdown
 * carry fences of their own, and nesting them loses the boundary. A file
 * needs only its path: every driver here is an agent that can open it. */
export function composeMessage(text: string, attachments: Attachment[]): string {
  const parts = [text.trim()];
  attachments.forEach((a, i) => {
    if (a.kind === "paste") {
      parts.push(`<pasted-text index="${i + 1}">\n${a.text}\n</pasted-text>`);
    } else if (a.kind === "image") {
      parts.push(`<attached-image path="${escapeAttribute(a.path)}" />`);
    } else {
      parts.push(`<attached-file path="${escapeAttribute(a.path)}" />`);
    }
  });
  return parts.filter(Boolean).join("\n\n");
}

/** File paths are untrusted prompt content. Keep them inside the quoted
 * attribute even when a filename contains XML characters or line breaks. */
export function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

function unescapeAttachmentPath(raw: string): string {
  return raw
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Split a stored user message into display text, images, and other files.
 * Both `<attached-image>` and `<attached-file>` tags are stripped from the
 * bubble.  A file whose saved name is a previewable image (png/jpg/gif/webp)
 * is shown as an image even when the engine stored it as a file. */
export function splitAttachedImages(text: string): { display: string; images: string[]; files: string[] } {
  const images: string[] = [];
  const files: string[] = [];
  const take = (kind: "image" | "file", path: string) => {
    if (!path) return;
    if (kind === "image" || attachmentImageUrl(path)) images.push(path);
    else files.push(path);
  };
  const display = text
    .replace(/<attached-image\s+path="([^"]*)"\s*\/?>(?:\s*\n)?/g, (_match, raw: string) => {
      take("image", unescapeAttachmentPath(raw));
      return "";
    })
    .replace(/<attached-file\s+path="([^"]*)"\s*\/?>(?:\s*\n)?/g, (_match, raw: string) => {
      take("file", unescapeAttachmentPath(raw));
      return "";
    });
  return { display: display.trim(), images, files };
}

/** The bare filename a saved attachment path ends in — what the serving
 * route expects. Works for POSIX and Windows separators. */
export function attachmentBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** The renderer never loads a transcript-provided URL directly. Only names
 * the attachment server itself can have generated become same-origin image
 * URLs; malformed and executable-image paths render nothing, while a string
 * that looks remote can at most resolve to a local generated filename. */
export function attachmentImageUrl(path: string): string | null {
  const name = attachmentBasename(path);
  if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp|heic|heif|avif|bmp|svg)$/.test(name)) return null;
  return `/api/attachments/${encodeURIComponent(name)}`;
}

/** Same-origin URL for a saved chat file (pdf, zip, …).  Generated names only. */
export function attachmentFileUrl(path: string): string | null {
  const name = attachmentBasename(path);
  if (!/^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}$/.test(name)) return null;
  if (name.startsWith(".")) return null;
  return `/api/attachments/${encodeURIComponent(name)}`;
}

/** One intake path for files arriving by drop OR by the composer's attach
 * button, so a picked file and a dropped one can never behave differently.
 * The image uploader is injected: the caller owns the network, this owns
 * the ordering and the sentence the user reads when something is refused. */
export async function intakeFiles<T extends DroppedFile & { type: string }>(
  _files: readonly T[],
  _opts: {
    allowImages: boolean;
    getPath: (file: T) => string;
    uploadImage: (file: T) => Promise<Attachment | null>;
  },
): Promise<{ attachments: Attachment[]; notice: string | null }> {
  const files = [..._files];
  const { allowImages, getPath, uploadImage } = _opts;
  const attachments: Attachment[] = [];
  const rejectedNames: string[] = [];
  const imageErrors: string[] = [];
  // Finish each selected file in sequence so the chips retain the order in
  // which the user chose or dropped them.
  for (const file of files) {
    if (allowImages && isImageFile(file)) {
      try {
        const attachment = await uploadImage(file);
        if (attachment) attachments.push(attachment);
      } catch (err) {
        imageErrors.push(`${attachmentLabel(file)}: ${err instanceof Error ? err.message : "upload failed"}`);
      }
      continue;
    }
    const result = await attachmentsFromDroppedFiles([file], getPath, { allowImages });
    attachments.push(...result.attachments);
    rejectedNames.push(...result.rejectedNames);
  }
  const pathless = rejectedNames.length
    ? `${rejectedNames.join(", ")} could not be attached.  Paste, drop, or pick a supported file (images, PDF, Office, zip, audio, video, or text).`
    : null;
  const failed = imageErrors.length ? imageErrors.join("; ") : null;
  return {
    attachments,
    notice: pathless && failed ? `${pathless} (${failed})` : (pathless ?? failed),
  };
}
