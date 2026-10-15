import { describe, expect, it } from "vitest";

import {
  PLUGINS_HELP_URL,
  folderPluginRevealPath,
  gitPluginBrowseUrl,
  installSourceFromDrop,
} from "./plugin-manager-ui";

describe("plugin-manager-ui", () => {
  it("points help at the design doc", () => {
    expect(PLUGINS_HELP_URL).toContain("docs/plugins/DESIGN.md");
  });

  it("builds git browse URLs", () => {
    expect(gitPluginBrowseUrl({ kind: "git", url: "acme/widget", ref: "main", path: "" })).toBe(
      "https://github.com/acme/widget/tree/main",
    );
    expect(gitPluginBrowseUrl({ kind: "git", url: "https://example.com/repo.git", ref: null, path: "" })).toBe(
      "https://example.com/repo.git",
    );
  });

  it("reads folder reveal paths", () => {
    expect(folderPluginRevealPath({ kind: "folder", path: "/tmp/my-plugin" })).toBe("/tmp/my-plugin");
  });

  it("resolves install sources from shell file paths", () => {
    const file = new File([], "plugin");
    expect(installSourceFromDrop([file], () => "/Users/me/plugin")).toBe("/Users/me/plugin");
    expect(installSourceFromDrop([file], () => "")).toBe(null);
    expect(installSourceFromDrop([], () => "/x")).toBe(null);
  });
});
