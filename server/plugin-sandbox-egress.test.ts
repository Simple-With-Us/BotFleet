import { describe, expect, it } from "vitest";

import {
  linuxUnshareNetworkAvailable,
  pluginSandboxEgressDenyScript,
  pluginSandboxEgressImportArgv,
  pluginSandboxSpawnTarget,
  PLUGIN_EGRESS_DENIED,
} from "./plugin-sandbox-egress.ts";

describe("plugin sandbox egress", () => {
  it("ships the deny import script beside the server root", () => {
    const path = pluginSandboxEgressDenyScript();
    expect(path.endsWith("plugin-sandbox-egress-deny.mjs")).toBe(true);
    expect(pluginSandboxEgressImportArgv()).toEqual([`--import=${path}`]);
  });

  it("exposes a stable denial code", () => {
    expect(PLUGIN_EGRESS_DENIED).toBe("ERR_PLUGIN_EGRESS_DENIED");
  });

  it("wraps spawn targets with unshare only when Linux allows it", () => {
    const node = process.execPath;
    const argv = ["--import=/tmp/deny.mjs", "child.js"];
    const target = pluginSandboxSpawnTarget(node, argv);
    if (process.platform === "linux" && linuxUnshareNetworkAvailable()) {
      expect(target).toEqual({ command: "unshare", args: ["-n", node, ...argv] });
    } else {
      expect(target).toEqual({ command: node, args: argv });
    }
  });
});
