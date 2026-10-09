#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadVmCliManifest, parseVmCliShellEnvironment } from "../../server/vm-cli-manifest.ts";
import { renderVerifyScript } from "../../server/vm-cli-install.ts";

loadVmCliManifest();

const environment = parseVmCliShellEnvironment(process.argv[2]);
const result = spawnSync("bash", ["-c", renderVerifyScript(environment)], {
  encoding: "utf8",
  stdio: "inherit",
});
process.exit(result.status ?? 1);
