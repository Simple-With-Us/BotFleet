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

const CONTENT_ENTRY = z.object({
  type: z.string(),
  name: z.string(),
  path: z.string(),
  download_url: z.string().nullable().optional(),
}).strip();
type ContentEntry = z.infer<typeof CONTENT_ENTRY>;

const CONTENT_LISTING = z.array(CONTENT_ENTRY);

async function fetchListing(url: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const response = await fetcher(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "BotFleet-plugins" },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  const parsed = CONTENT_LISTING.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`GitHub listing for ${url} did not match the contents schema`);
  }
  return parsed.data;
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { headers: { "user-agent": "BotFleet-plugins" } });
  if (!response.ok) throw new Error(`download failed (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("file is larger than the 256KB import cap");
  return text;
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
  const entries = await listDir(source, source.path, fetcher);
  const manifestEntry = entries.find(
    (entry) => entry.type === "file" && entry.name === "botfleet-plugin.json",
  );
  if (!manifestEntry || !manifestEntry.download_url) {
    throw new Error(`no botfleet-plugin.json in ${source.path || "the repository root"}`);
  }

  const manifestText = await fetchText(manifestEntry.download_url, fetcher);

  const plugins = entries
    .filter((entry) => entry.type === "file" && entry.name !== "botfleet-plugin.json" && entry.download_url)
    .filter((entry) => /\.(?:mjs|cjs|js|json)$/i.test(entry.name))
    .slice(0, MAX_FILES);

  const files = await Promise.all(
    plugins.map(async (entry) => ({
      path: entry.name,
      content: await fetchText(entry.download_url!, fetcher),
    })),
  );

  return {
    source: `${source.url}${source.ref ? `@${source.ref}` : ""}/${source.path}`.replace(/\/$/, ""),
    manifestText,
    files,
  };
}