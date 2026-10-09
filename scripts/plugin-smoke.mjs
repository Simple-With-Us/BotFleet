#!/usr/bin/env node
// End-to-end smoke for the plugin system.  Boots the registry against
// an isolated fixture, walks the full lifecycle, and exits 0 only when
// every step succeeds.
//
// Usage:
//   node scripts/plugin-smoke.mjs
//
// Fixtures must never touch a real OMB_DATA_DIR or the host's harness
// port; the script sets OMB_DATA_DIR to a mkdtemp directory and tears
// it down on exit.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "example-plugin");
const baseDir = mkdtempSync(join(tmpdir(), "botfleet-plugin-smoke-"));

process.env.OMB_DATA_DIR = baseDir;

const teardown = () => {
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; the OS reclaims the temp dir either way
  }
};
process.on("exit", teardown);
process.on("SIGINT", () => { teardown(); process.exit(130); });
process.on("SIGTERM", () => { teardown(); process.exit(143); });

let failed = false;
function check(label, ok, detail) {
  if (ok) {
    console.log(`✔ ${label}`);
  } else {
    failed = true;
    console.error(`✖ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const {
  installPlugin,
  enablePlugin,
  disablePlugin,
  getPlugin,
  getPluginCardData,
  listPlugins,
  reloadPlugin,
  removePlugin,
  runPluginCommand,
  _loadedNames,
  _resetForTests,
  initPluginRuntime,
} = await import("../server/plugins.ts");
const { readRegistry, listingFor } = await import("../server/plugin-registry.ts");

_resetForTests();
initPluginRuntime({
  listBots: () => [
    { id: "alpha", name: "Alpha", status: "running", driver: "claude" },
    { id: "beta", name: "Beta", status: "stopped", driver: "claude" },
    { id: "gamma", name: "Gamma", status: "errored", driver: "claude" },
  ],
  listConfigKeys: () => ["appearance.theme"],
  readConfig: (_key) => undefined,
  logger: (_event) => {},
});

console.log("plugin smoke: install");
const installed = await installPlugin(FIXTURE, baseDir);
if ("error" in installed) {
  check("install returns a listing", false, installed.error);
  process.exit(1);
}
check("install returns a listing", true);
check("install lands disabled", installed.enabled === false);
check("install writes the tree on disk", existsSync(join(baseDir, "fleet-overview", "botfleet-plugin.json")));
check("registry records the entry", Boolean(readRegistry(baseDir).plugins["fleet-overview"]));

console.log("plugin smoke: enable + host API");
const enabled = await enablePlugin("fleet-overview", baseDir);
if ("error" in enabled) {
  check("enable returns a listing", false, enabled.error);
  process.exit(1);
}
check("enable returns a listing", true);
check("enable marks the plugin enabled", enabled.enabled === true);
check("enable imports the module", _loadedNames().includes("fleet-overview"));

const card = await getPluginCardData("fleet-overview", "fleet-overview", baseDir);
if ("error" in card) {
  check("getPluginCardData runs through the host API", false, card.error);
  process.exit(1);
}
const result = card.data?.result ?? card.data;
check("card data has total bot count", result?.total === 3);
check("card data counts running bots", result?.running === 1);
check("card data counts stopped bots", result?.stopped === 1);
check("card data counts errored bots", result?.errored === 1);

const command = await runPluginCommand("fleet-overview", "fleet", "", baseDir);
if ("error" in command) {
  check("slash command runs through the host API", false, command.error);
  process.exit(1);
}
check("slash command returns expected text", /Fleet has 3 bots/.test(command.text));

console.log("plugin smoke: disable + reload");
const disabled = await disablePlugin("fleet-overview", baseDir);
if ("error" in disabled) {
  check("disable returns a listing", false, disabled.error);
  process.exit(1);
}
check("disable marks the plugin disabled", disabled.enabled === false);
check("disable drops the loaded module", !_loadedNames().includes("fleet-overview"));

const reloadListing = await enablePlugin("fleet-overview", baseDir);
if ("error" in reloadListing) {
  check("re-enable works", false, reloadListing.error);
  process.exit(1);
}
const reloaded = await reloadPlugin("fleet-overview", baseDir);
if ("error" in reloaded) {
  check("reload re-imports the module", false, reloaded.error);
  process.exit(1);
}
check("reload preserves enabled flag", reloaded.enabled === true);

console.log("plugin smoke: list + get");
const list = listPlugins(baseDir);
check("list returns one plugin", list.length === 1);
const one = getPlugin("fleet-overview", baseDir);
if ("error" in one) {
  check("get returns a listing", false, one.error);
  process.exit(1);
}
check("get returns the same plugin", one.name === "fleet-overview");

console.log("plugin smoke: remove");
const removed = await removePlugin("fleet-overview", baseDir);
if ("error" in removed) {
  check("remove succeeds", false, removed.error);
  process.exit(1);
}
check("remove succeeds", removed.removed === true);
check("remove deletes the tree", !existsSync(join(baseDir, "fleet-overview")));
check("remove deletes the registry entry", readRegistry(baseDir).plugins["fleet-overview"] === undefined);

// listingFor after remove should report the plugin as missing.
const gone = listingFor("fleet-overview", baseDir);
check("listingFor reports the missing plugin", "error" in gone);

if (failed) {
  console.error("\nplugin smoke: FAILED");
  process.exit(1);
}
console.log("\nplugin smoke: OK");