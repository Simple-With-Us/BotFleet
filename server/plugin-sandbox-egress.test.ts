import { describe, expect, it } from "vitest";

import {
  buildPluginSandboxSpawnPlan,
  pluginNetworkIsolationAvailable,
  resetPluginNetworkIsolationProbe,
} from "./plugin-sandbox-egress.ts";

describe("plugin sandbox egress", () => {
  it("reports availability on supported CI hosts", () => {
    resetPluginNetworkIsolationProbe();
    if (process.platform === "win32") {
      expect(pluginNetworkIsolationAvailable()).toBe(false);
      return;
    }
    expect(pluginNetworkIsolationAvailable()).toBe(true);
  });

  it("wraps the Node child with a network-deny spawn plan", () => {
    if (!pluginNetworkIsolationAvailable()) return;
    const plan = buildPluginSandboxSpawnPlan("/usr/bin/node", ["--permission", "child.js"]);
    if (process.platform === "darwin") {
      expect(plan.command).toBe("/usr/bin/sandbox-exec");
      expect(plan.args[0]).toBe("-p");
      expect(plan.args[2]).toBe("/usr/bin/node");
      expect(plan.args.join(" ")).toContain("deny network");
    } else if (process.platform === "linux") {
      expect(plan.command).toMatch(/unshare$/);
      expect(plan.args.slice(0, 4)).toEqual(["-U", "-r", "--net", expect.stringContaining("plugin-sandbox-netwrap.sh")]);
      expect(plan.args).toContain("/usr/bin/node");
    }
  });
});
