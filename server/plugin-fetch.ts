// Fetch a plugin's manifest + files from a git source.  Network in,
// {manifestText, files} out.  Validation and storage live in plugins.ts
// and plugin-registry.ts.
//
// v1 ships against the GitHub contents API, the same shape skill-fetch.ts
// already uses.  Tests hand it a fake fetcher; the production path is
// the real GitHub API.
import { z } from "zod";

import type { FetchedPlugin } from "./plugin-types.ts";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const API = "https://api.github.com";

export type GitPluginSource = {
  kind: "git";
  url: string;
  ref: string | null;
  owner: string;
  repo: string;
  path: string;
};

export type PluginSourceInput =
  | { ok: true; source: GitPluginSource }
  | { ok: false; error: string };

/** Parse a git URL or shorthand.  Accepts:
 *  - owner/repo
 *  - https://github.com/owner/repo
 *  - https://github.com/owner/repo/tree/<ref>/<path>
 */
export function parseGitPluginSource(input: string): PluginSourceInput {
  const text = input.trim();
  if (!text) return { ok: false, error: "paste a GitHub repository or folder URL" };

  const tree = text.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i,
  );
  if (tree) {
    return {
      ok: true,
      source: {
        kind: "git",
        url: `github.com/${tree[1]}/${tree[2]}`,
        ref: tree[3] ?? null,
        owner: tree[1]!,
        repo: tree[2]!,
        path: tree[4] ?? "",
      },
    };
  }

  const shorthand = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) {
    return {
      ok: true,
      source: {
        kind: "git",
        url: `github.com/${shorthand[1]}/${shorthand[2]}`,
        ref: null,
        owner: shorthand[1]!,
        repo: shorthand[2]!,
        path: "",
      },
    };
  }

  return { ok: false, error: "that does not look like a GitHub repository or folder URL" };
}

/** Stable failure codes for a git fetch.  The message is for the API
 *  caller; the code is what logs and callers branch on. */
export type PluginFetchFailure =
  | "github_http_error"
  | "github_listing_invalid"
  | "manifest_missing"
  | "download_failed"
  | "file_too_large";

/** The only error fetchPluginFromGit throws.  A malformed upstream payload
 *  surfaces as one of these, never as an empty listing. */
export class PluginFetchError extends Error {
  readonly code: PluginFetchFailure;

  constructor(code: PluginFetchFailure, message: string) {
    super(message);
    this.name = "PluginFetchError";
    this.code = code;
  }
}

/** One GitHub contents API entry, reduced to the fields the installer
 *  reads.  Unused GitHub fields (sha, size, url, html_url, git_url,
 *  _links, ...) are stripped explicitly.  An entry with a missing or
 *  mistyped field fails the whole listing. */
export const CONTENT_ENTRY = z.object({
  type: z.enum(["file", "dir", "symlink", "submodule"]),
  name: z.string().min(1).max(255),
  path: z.string().max(4096),
  download_url: z.url({ protocol: /^https$/ }).nullable(),
}).strip();
export type ContentEntry = z.infer<typeof CONTENT_ENTRY>;

/** The listing is an array built from the concrete entry schema.  A
 *  non-array payload or any bad element rejects the whole response. */
export const CONTENT_LISTING = z.array(CONTENT_ENTRY);

/** A file entry the installer can download. */
type DownloadableEntry = ContentEntry & { type: "file"; download_url: string };

function isDownloadable(entry: ContentEntry): entry is DownloadableEntry {
  return entry.type === "file" && entry.download_url !== null;
}

async function fetchListing(url: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const response = await fetcher(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "BotFleet-plugins" },
  });
  if (!response.ok) throw new PluginFetchError("github_http_error", `GitHub API returned ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PluginFetchError("github_listing_invalid", "GitHub listing did not match the contents schema");
  }
  const parsed = CONTENT_LISTING.safeParse(body);
  if (!parsed.success) {
    throw new PluginFetchError("github_listing_invalid", "GitHub listing did not match the contents schema");
  }
  return parsed.data;
}

/** Read a response body with a hard byte cap.  Rejects a declared
 *  content-length above the cap before buffering, and aborts the stream
 *  once the running total crosses MAX_FILE_BYTES so a missing or lying
 *  content-length cannot force unbounded memory use. */
async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    throw new PluginFetchError("file_too_large", "file is larger than the 256KB import cap");
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw new PluginFetchError("file_too_large", "file is larger than the 256KB import cap");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw new PluginFetchError("file_too_large", "file is larger than the 256KB import cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Per-request deadline so a stalled GitHub peer cannot pin an install
 *  handler open for undici's multi-minute default timeouts. */
const FETCH_TIMEOUT_MS = 30_000;

/** Overlap a few downloads without a MAX_FILES-wide Promise.all. */
const DOWNLOAD_CONCURRENCY = 6;

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, {
    headers: { "user-agent": "BotFleet-plugins" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new PluginFetchError("download_failed", `download failed (${response.status})`);
  return readBoundedText(response);
}

async function listDir(source: GitPluginSource, path: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const ref = source.ref ? `?ref=${encodeURIComponent(source.ref)}` : "";
  return fetchListing(`${API}/repos/${source.owner}/${source.repo}/contents/${path}${ref}`, fetcher);
}

/** Fetch the manifest + plugin files from a git source.  Mirrors
 *  fetchSkillDir but tolerates a `botfleet-plugin.json` at the root
 *  only (no discovery across skills-style nested folders). */
export async function fetchPluginFromGit(
  source: GitPluginSource,
  fetcher: typeof fetch = fetch,
): Promise<FetchedPlugin> {
  const entries = (await listDir(source, source.path, fetcher)).filter(isDownloadable);
  const manifestEntry = entries.find((entry) => entry.name === "botfleet-plugin.json");
  if (!manifestEntry) {
    throw new PluginFetchError("manifest_missing", `no botfleet-plugin.json in ${source.path || "the repository root"}`);
  }

  const manifestText = await fetchText(manifestEntry.download_url, fetcher);

  const plugins = entries
    .filter((entry) => entry.name !== "botfleet-plugin.json")
    .filter((entry) => /\.(?:mjs|cjs|js|json)$/i.test(entry.name))
    .slice(0, MAX_FILES);

  // Bounded concurrency: enough to overlap round-trips without the peak
  // memory of a 64-wide Promise.all, and every request is time-bounded.
  const files: Array<{ path: string; content: string }> = [];
  const queue = [...plugins];
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      files.push({ path: entry.name, content: await fetchText(entry.download_url, fetcher) });
    }
  }));

  return {
    source: `${source.url}${source.ref ? `@${source.ref}` : ""}/${source.path}`.replace(/\/$/, ""),
    manifestText,
    files,
  };
}