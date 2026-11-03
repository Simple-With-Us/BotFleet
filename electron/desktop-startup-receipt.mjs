import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize } from "node:path";

const FLAG = "--update-startup-receipt";
const BASENAME = "desktop-startup.json";
const LIMIT = 8 * 1024;
const REQUEST_KEYS = ["schemaVersion", "kind", "requestId", "sourceCommit"];
const RESPONSE_KEYS = ["schemaVersion", "kind", "requestId", "app", "pid", "mode", "uiPort", "sourceCommit", "version", "apiVersion", "uiHash"];
const BUILD_KEYS = ["sourceCommit", "version", "apiVersion", "uiHash", "build"];
const invalid = () => new Error("Invalid desktop startup receipt");
/* oxlint-disable anti-slop/no-runtime-typeof -- Parse unknown private JSON and argv with Node builtins only; the immutable updater bootstrap cannot import a schema package. */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const commit = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) && value !== "0".repeat(40);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const version = (value) => typeof value === "string" && value.length <= 128 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value);
const uiHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const buildNumber = (value) => typeof value === "string" && value.length <= 64 && /^[0-9]+(?:\.[0-9]+){0,2}$/.test(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

function exactKeys(value, keys, optional = []) {
  return object(value) && keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
}

function checkPath(file) {
  if (typeof file !== "string" || !isAbsolute(file) || normalize(file) !== file ||
      file.includes("\0") || basename(file) !== BASENAME) throw invalid();
  return file;
}

/** The flag conveys a private local path only; it never authorizes a process. */
export function desktopStartupReceiptPath(argv = process.argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) throw invalid();
  const flags = argv.filter((arg) => arg === FLAG || arg.startsWith(`${FLAG}=`));
  if (!flags.length) return null;
  if (flags.length !== 1 || !flags[0].startsWith(`${FLAG}=`)) throw invalid();
  return checkPath(flags[0].slice(FLAG.length + 1));
}
/* oxlint-enable anti-slop/no-runtime-typeof */

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function ownedPrivate(stat, directory = false) {
  if (stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
      !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && stat.nlink !== 1)) throw invalid();
}

function withPrivateFile(file, create, operation, writable = false) {
  let parentFd;
  let fd;
  try {
    checkPath(file);
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw invalid();
    const parent = dirname(file);
    const listedParent = lstatSync(parent);
    ownedPrivate(listedParent, true);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const heldParent = fstatSync(parentFd);
    ownedPrivate(heldParent, true);
    if (!sameInode(heldParent, listedParent)) throw invalid();
    const listedFile = create ? null : lstatSync(file);
    if (listedFile) ownedPrivate(listedFile);
    const flags = (create ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR : writable ? constants.O_RDWR : constants.O_RDONLY) |
      constants.O_NOFOLLOW | constants.O_NONBLOCK;
    fd = openSync(file, flags, 0o600);
    const held = fstatSync(fd);
    ownedPrivate(held);
    if (listedFile && !sameInode(held, listedFile)) throw invalid();
    const verify = () => {
      const now = fstatSync(fd);
      ownedPrivate(now);
      const listed = lstatSync(file);
      ownedPrivate(listed);
      const parentNow = lstatSync(parent);
      ownedPrivate(parentNow, true);
      if (!sameInode(held, now) || !sameInode(now, listed) || !sameInode(heldParent, parentNow)) throw invalid();
    };
    verify();
    const result = operation(fd, verify);
    verify();
    return result;
  } catch {
    // File paths, parser input, and OS errors never enter diagnostic output.
    throw invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (parentFd !== undefined) closeSync(parentFd);
  }
}

function readJson(fd) {
  if (fstatSync(fd).size > LIMIT) throw invalid();
  const bytes = Buffer.alloc(LIMIT + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, length);
    if (!count) break;
    length += count;
  }
  if (!length || length > LIMIT || fstatSync(fd).size > LIMIT) throw invalid();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
}

function writeJson(fd, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > LIMIT) throw invalid();
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!count) throw invalid();
    offset += count;
  }
  ftruncateSync(fd, bytes.length);
  fsyncSync(fd);
}

function validRequest(value, inMemory = false) {
  return exactKeys(value, REQUEST_KEYS, inMemory ? ["expectedBuild"] : []) &&
    value.schemaVersion === 1 && value.kind === "request" && uuid(value.requestId) && commit(value.sourceCommit);
}

function expectedIdentity(value) {
  if (!object(value) || !commit(value.sourceCommit)) throw invalid();
  const result = { sourceCommit: value.sourceCommit };
  for (const [key, validate] of [["version", version], ["apiVersion", positive], ["uiHash", uiHash], ["build", buildNumber]]) {
    if (Object.hasOwn(value, key)) {
      if (!validate(value[key])) throw invalid();
      result[key] = value[key];
    }
  }
  return result;
}

/** Create exclusively in an existing private directory; expectedBuild stays in memory. */
export function createDesktopStartupRequest(file, expectedBuild) {
  const expected = expectedIdentity(expectedBuild);
  const request = { schemaVersion: 1, kind: "request", requestId: randomUUID(), sourceCommit: expected.sourceCommit };
  withPrivateFile(file, true, (fd) => writeJson(fd, request));
  return { ...request, expectedBuild: expected };
}

/** Called only after the installed desktop has started its local or remote UI. */
export function writeDesktopStartupReceipt(file, build, { pid = process.pid, mode, uiPort } = {}) {
  const identity = expectedIdentity(build);
  if (build.app !== "botfleet" || build.sourceDirty !== false ||
      !version(identity.version) || !positive(identity.apiVersion) || !uiHash(identity.uiHash) ||
      !positive(pid) || !positive(uiPort) || uiPort > 65535 || !["local", "remote"].includes(mode)) throw invalid();
  return withPrivateFile(file, false, (fd, verify) => {
    const request = readJson(fd);
    if (!validRequest(request) || request.sourceCommit !== identity.sourceCommit) throw invalid();
    const receipt = { schemaVersion: 1, kind: "started", requestId: request.requestId,
      app: "botfleet-desktop", pid, mode, uiPort, ...identity };
    verify();
    writeJson(fd, receipt);
    return receipt;
  }, true);
}

/** A receipt is startup evidence only; callers must independently verify process ownership. */
export function readDesktopStartupReceipt(file, request, expectedBuild = request?.expectedBuild) {
  if (!validRequest(request, true)) throw invalid();
  const expected = expectedIdentity(expectedBuild ?? { sourceCommit: request.sourceCommit });
  if (expected.sourceCommit !== request.sourceCommit) throw invalid();
  return withPrivateFile(file, false, (fd) => {
    const value = readJson(fd);
    if (validRequest(value)) {
      if (value.requestId !== request.requestId || value.sourceCommit !== request.sourceCommit) throw invalid();
      return null;
    }
    if (!exactKeys(value, RESPONSE_KEYS, ["build"]) || value.schemaVersion !== 1 || value.kind !== "started" ||
        value.app !== "botfleet-desktop" || value.requestId !== request.requestId || !commit(value.sourceCommit) ||
        value.sourceCommit !== request.sourceCommit || !positive(value.pid) || !positive(value.uiPort) || value.uiPort > 65535 ||
        !["local", "remote"].includes(value.mode) || !version(value.version) || !positive(value.apiVersion) ||
        !uiHash(value.uiHash) || (Object.hasOwn(value, "build") && !buildNumber(value.build)) ||
        BUILD_KEYS.some((key) => Object.hasOwn(expected, key) && value[key] !== expected[key])) throw invalid();
    return value;
  });
}
