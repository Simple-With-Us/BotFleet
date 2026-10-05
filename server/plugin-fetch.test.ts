import { describe, expect, it } from "vitest";

import {
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
});

function makeFakeFetcher(responses: FakeResponseMap): typeof fetch {
  // SAFETY: the cast downcasts the inner async closure to `typeof fetch` because the wrapper has the same call signature, but the inner function takes only the inputs the global fetch accepts.  Plugin authors do not see this type — it lives behind this single test helper.
  return (async (input: string | URL) => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    const url = typeof input === "string" ? input : input.toString();
    const response = responses[url];
    if (!response) {
      return new Response("not found", { status: 404 });
    }
    if (response.kind === "text") {
      return new Response(response.value, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify(response.value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}