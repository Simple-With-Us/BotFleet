import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeFileAtomic } from "../../server/atomic.ts";
import { openedFileIsListedSync } from "../../server/opened-file.ts";

const MANAGED = "# Managed by BotFleet render-resources.mjs";
const KEY_MAP = {
  BF_CPU_QUOTA: "CPUQuota", BF_MEMORY_HIGH: "MemoryHigh", BF_MEMORY_MAX: "MemoryMax",
  BF_MEMORY_SWAP_MAX: "MemorySwapMax", BF_TASKS_MAX: "TasksMax", BF_IO_WEIGHT: "IOWeight",
  BF_IO_READ_BANDWIDTH_MAX: "IOReadBandwidthMax", BF_IO_WRITE_BANDWIDTH_MAX: "IOWriteBandwidthMax",
  BF_IO_READ_IOPS_MAX: "IOReadIOPSMax", BF_IO_WRITE_IOPS_MAX: "IOWriteIOPSMax",
};
const size = /^(?:infinity|0|[1-9]\d*(?:[KMGTPE])?)$/;
const boundedSize = /^(?:[1-9]\d*)(?:[KMGTPE])?$/;
const safeSize = (value) => {
  if (value === "infinity") return true;
  if (!size.test(value)) return false;
  const match = /^(\d+)([KMGTPE]?)$/.exec(value);
  return BigInt(match[1]) * (1024n ** BigInt(match[2] ? "KMGTPE".indexOf(match[2]) + 1 : 0)) <= BigInt(Number.MAX_SAFE_INTEGER);
};

function valid(key, value) {
  const parsed = z.string().safeParse(value);
  if (!parsed.success || !parsed.data || parsed.data.trim() !== parsed.data) return false;
  value = parsed.data;
  if (key === "CPUQuota") return /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%$/.test(value) && Number.isFinite(Number(value.slice(0, -1)));
  if (key === "TasksMax") return value === "infinity" || /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (key === "IOWeight") return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 10000;
  if (key.startsWith("IO")) {
    const parts = value.split(" ");
    if (parts.length !== 2 || !/^\/dev\/[A-Za-z0-9_./+-]+$/.test(parts[0]) || parts[0].split("/").includes("..")) return false;
    return key.includes("IOPS") ? /^[1-9]\d*$/.test(parts[1]) && Number.isSafeInteger(Number(parts[1])) : boundedSize.test(parts[1]) && safeSize(parts[1]);
  }
  return safeSize(value) && (key !== "MemoryMax" || value !== "0");
}

/** Unset fields preserve an existing managed limit instead of clearing it. */
export function renderResources(env, existing = null) {
  const supplied = {};
  for (const key of Object.keys(env)) {
    if (!/^BF_(?:CPU_|MEMORY_|TASKS_|IO_)/.test(key)) continue;
    if (!(key in KEY_MAP)) throw new Error(`Unknown resource setting: ${key}`);
    const value = env[key];
    if (!valid(KEY_MAP[key], value)) throw new Error(`Invalid resource setting: ${key}`);
    supplied[KEY_MAP[key]] = value;
  }
  if (Object.keys(supplied).length === 0) return null;
  const settings = {};
  if (existing !== null) {
    if (!existing.startsWith(`${MANAGED}\n[Service]\n`)) throw new Error("Refusing to overwrite an unmanaged resources.conf");
    for (const line of existing.split("\n")) {
      if (!line || line.startsWith("#") || line === "[Service]") continue;
      const split = line.indexOf("=");
      const key = line.slice(0, split);
      const value = line.slice(split + 1);
      if (split < 1 || !Object.values(KEY_MAP).includes(key) || key in settings || !valid(key, value)) throw new Error("Existing resources.conf is invalid; refusing to overwrite it");
      settings[key] = value;
    }
  }
  Object.assign(settings, supplied);
  return `${MANAGED}\n[Service]\n${Object.values(KEY_MAP).filter((key) => key in settings).map((key) => `${key}=${settings[key]}`).join("\n")}\n`;
}

const deployPath = z.string().regex(/^\/[A-Za-z0-9_./+-]+$/).refine(value => !value.split("/").some(part => part === "." || part === ".."));
const serviceIdentity = z.string().regex(/^[a-z_][a-z0-9_-]*[$]?$/);
const deployPaths = z.object({ volume: deployPath, root: deployPath, code: deployPath, user: serviceIdentity, group: serviceIdentity });
const logBounds = z.object({
  bytes: z.string().regex(boundedSize).refine(safeSize),
  count: z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value))),
});

export function validateDeployPaths(options) {
  const parsed = deployPaths.parse(options);
  const { volume, root, code } = parsed;
  if (volume === "/" || !root.startsWith(`${volume}/`) || !code.startsWith(`${volume}/`)) throw new Error("Deployment paths must be safe absolute paths beneath the dedicated volume");
  return parsed;
}

export function renderUnit(template, options) {
  const checked = validateDeployPaths(options);
  const values = { BF_VOLUME: checked.volume, BF_ROOT: checked.root, BF_CODE: checked.code, BF_USER: checked.user, BF_GROUP: checked.group, NODE_BIN: `${checked.root}/node/bin/node` };
  return template.replace(/@([A-Z_]+)@/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown unit placeholder: ${key}`);
    return values[key];
  });
}

/** No rotation size or retained-file count is invented before inventory. */
export function renderLogrotate(env, options, existing = null) {
  const checked = validateDeployPaths(options);
  for (const key of Object.keys(env)) if (key.startsWith("BF_LOG_ROTATE_") && !["BF_LOG_ROTATE_SIZE", "BF_LOG_ROTATE_COUNT"].includes(key)) throw new Error(`Unknown log rotation setting: ${key}`);
  if (env.BF_LOG_ROTATE_SIZE === undefined && env.BF_LOG_ROTATE_COUNT === undefined) return null;
  const bounds = logBounds.safeParse({ bytes: env.BF_LOG_ROTATE_SIZE, count: env.BF_LOG_ROTATE_COUNT });
  if (!bounds.success) throw new Error("Set valid BF_LOG_ROTATE_SIZE and BF_LOG_ROTATE_COUNT together");
  const { bytes, count } = bounds.data;
  if (existing !== null && !existing.startsWith(`${MANAGED}\n`)) throw new Error("Refusing to overwrite an unmanaged log rotation policy");
  return `${MANAGED}\n${checked.root}/logs/server.log {\n  size ${bytes}\n  rotate ${count}\n  missingok\n  notifempty\n  compress\n  copytruncate\n  su ${checked.user} ${checked.group}\n}\n`;
}

/** Read the opened inode, never a second path lookup after checking its type. */
export function readExisting(path, read = readFileSync) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!openedFileIsListedSync(fstatSync(fd), path)) throw new Error(`Refusing unverified managed file: ${path}`);
    const text = read(fd, "utf8");
    if (!openedFileIsListedSync(fstatSync(fd), path)) throw new Error(`Managed file changed while reading: ${path}`);
    return text;
  } catch (error) {
    if (fd === undefined && error.code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Complete validation precedes a sibling-temp/fsync/rename replacement. */
export function writeUnitFile(template, options, target) {
  const text = renderUnit(template, options);
  readExisting(target);
  writeFileAtomic(target, text, { mode: 0o644, exactMode: true });
}

function runCli() {
  const unitMode = process.argv.length === 4 && ["--unit", "--write-unit"].includes(process.argv[2]) && ["botfleet-server.service.in", "botfleet-owner-gate.service.in"].includes(process.argv[3]);
  if (!unitMode && (process.argv.length !== 3 || !["--write", "--dry-run"].includes(process.argv[2]))) throw new Error("usage: node render-resources.mjs --write|--dry-run|--unit|--write-unit <known-template>");
  const options = { volume: process.env.BF_VOLUME, root: process.env.BF_ROOT, code: process.env.BF_CODE, user: process.env.BF_USER, group: process.env.BF_GROUP };
  validateDeployPaths(options);
  if (unitMode) {
    const template = readFileSync(new URL(`./${process.argv[3]}`, import.meta.url), "utf8");
    if (process.argv[2] === "--write-unit") writeUnitFile(template, options, `/etc/systemd/system/${process.argv[3].slice(0, -3)}`);
    else process.stdout.write(renderUnit(template, options));
    return;
  }
  const path = "/etc/systemd/system/botfleet-server.service.d/resources.conf";
  const resources = renderResources(process.env) === null ? null : renderResources(process.env, readExisting(path));
  const logPath = "/etc/logrotate.d/botfleet-server";
  const logs = renderLogrotate(process.env, options) === null ? null : renderLogrotate(process.env, options, readExisting(logPath));
  for (const [target, text, note] of [
    [path, resources, "no resource limits set; run the inventory recipe; existing limits are unchanged"],
    [logPath, logs, "no log rotation bounds set; run the inventory recipe; existing policy is unchanged"],
  ]) {
    if (text === null) { console.log(note); continue; }
    if (process.argv[2] === "--dry-run") { console.log(`Would render ${target}`); continue; }
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileAtomic(target, text, { mode: 0o644 });
  }
}

let entry = false;
try { entry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (entry) {
  try { runCli(); } catch (error) {
    console.error(error instanceof Error ? error.message : "Resource rendering failed");
    process.exitCode = 2;
  }
}
