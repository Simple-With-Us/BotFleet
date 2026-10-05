import { describe, expect, it } from "vitest";

import {
  CONTENT_LISTING,
  PluginFetchError,
  parseGitPluginSource,
  fetchPluginFromGit,
  type GitPluginSource,
} from "./plugin-fetch.ts";

type FakeResponse = { kind: "json"; value: unknown } | { kind: "text"; value: string };

interface FakeResponseMap {
  [url: string]: FakeResponse | undefined;
}

describe("parseGitPluginSource", () => {
  it("accepts owner/repo shorthand", () => {
    const result = parseGitPluginSource("acme/widget");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.kind).toBe("git");
      expect(result.source.owner).toBe("acme");
      expect(result.source.repo).toBe("widget");
      expect(result.source.ref).toBe(null);
      expect(result.source.path).toBe("");
    }
  });

  it("accepts a full GitHub URL with ref and path", () => {
    const result = parseGitPluginSource("https://github.com/acme/widget/tree/main/plugins/foo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.ref).toBe("main");
      expect(result.source.path).toBe("plugins/foo");
    }
  });

  it("rejects an empty string", () => {
    const result = parseGitPluginSource("");
    expect(result.ok).toBe(false);
  });

  it("rejects garbage", () => {
    const result = parseGitPluginSource("hello there");
    expect(result.ok).toBe(false);
  });
});

describe("fetchPluginFromGit", () => {
  it("downloads the manifest and plugin files", async () => {
    const source: GitPluginSource = {
      kind: "git",
      url: "github.com/acme/widget",
      ref: null,
      owner: "acme",
      repo: "widget",
      path: "",
    };
    const manifest = JSON.stringify({ name: "demo", version: "1.0.0", description: "x", botfleet: ">=1", entry: "plugin.mjs" });
    const fetcher = makeFakeFetcher({
      "https://api.github.com/repos/acme/widget/contents/": { kind: "json", value: [
        { type: "file", name: "botfleet-plugin.json", path: "botfleet-plugin.json", download_url: "https://example/manifest" },
        { type: "file", name: "plugin.mjs", path: "plugin.mjs", download_url: "https://example/plugin" },
      ] },
      "https://example/manifest": { kind: "text", value: manifest },
      "https://example/plugin": { kind: "text", value: "export const x = 1;" },
    });
    const fetched = await fetchPluginFromGit(source, fetcher);
    expect(fetched.manifestText).toBe(manifest);
    expect(fetched.files.length).toBe(1);
    expect(fetched.files[0]!.path).toBe("plugin.mjs");
  });

  it("throws when the manifest is missing", async () => {
    const source: GitPluginSource = {
      kind: "git",
      url: "github.com/acme/widget",
      ref: null,
      owner: "acme",
      repo: "widget",
      path: "",
    };
    const fetcher = makeFakeFetcher({
      "https://api.github.com/repos/acme/widget/contents/": { kind: "json", value: [
        { type: "file", name: "plugin.mjs", path: "plugin.mjs", download_url: "https://example/plugin" },
      ] },
    });
    await expect(() => fetchPluginFromGit(source, fetcher)).rejects.toThrow(/botfleet-plugin\.json/);
  });

  it("rejects a listing that is not an array of content entries", async () => {
    const source: GitPluginSource = {
      kind: "git",
      url: "github.com/acme/widget",
      ref: null,
      owner: "acme",
      repo: "widget",
      path: "",
    };
    const fetcher = makeFakeFetcher({
      "https://api.github.com/repos/acme/widget/contents/": { kind: "json", value: { message: "not a listing" } },
    });
    await expect(() => fetchPluginFromGit(source, fetcher)).rejects.toThrow(/contents schema/);
  });

  it("rejects the whole listing when one element is malformed instead of dropping it", async () => {
    const source: GitPluginSource = {
      kind: "git",
      url: "github.com/acme/widget",
      ref: null,
      owner: "acme",
      repo: "widget",
      path: "",
    };
    const fetcher = makeFakeFetcher({
      "https://api.github.com/repos/acme/widget/contents/": { kind: "json", value: [
        { type: "file", name: "botfleet-plugin.json", path: "botfleet-plugin.json", download_url: "https://example/manifest" },
        { type: 7, name: "plugin.mjs", path: "plugin.mjs", download_url: "https://example/plugin" },
      ] },
    });
    await expect(fetchPluginFromGit(source, fetcher)).rejects.toBeInstanceOf(PluginFetchError);
    await expect(fetchPluginFromGit(source, fetcher)).rejects.toMatchObject({ code: "github_listing_invalid" });
  });

  it("rejects an empty-object or null listing rather than treating it as empty", () => {
    expect(CONTENT_LISTING.safeParse({}).success).toBe(false);
    expect(CONTENT_LISTING.safeParse(null).success).toBe(false);
    expect(CONTENT_LISTING.safeParse([]).success).toBe(true);
  });

  it("rejects non-https download URLs and strips unused GitHub fields", () => {
    expect(CONTENT_LISTING.safeParse([
      { type: "file", name: "a.mjs", path: "a.mjs", download_url: "file:///etc/passwd" },
    ]).success).toBe(false);
    const parsed = CONTENT_LISTING.parse([
      { type: "file", name: "a.mjs", path: "a.mjs", download_url: "https://example/a", sha: "abc", size: 3, _links: {} },
    ]);
    expect(parsed).toEqual([{ type: "file", name: "a.mjs", path: "a.mjs", download_url: "https://example/a" }]);
  });
});

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return input;
}

function makeFakeFetcher(responses: FakeResponseMap): typeof fetch {
  const fetcher: typeof fetch = async (input) => {
    const url = fetchInputUrl(input);
    const response = responses[url];
    if (!response) {
      return new Response("not found", { status: 404 });
    }
    if (response.kind === "text") {
      return new Response(response.value, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify(response.value), { status: 200, headers: { "content-type": "application/json" } });
  };
  return fetcher;
}
