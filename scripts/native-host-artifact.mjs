import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const HOST_CODE_ID = "BotFleetNativeHost";
export const HOST_TEAM = "CC8UTF7ATG";
export const HOST_CAPABILITIES = ["identity-v1", "foreground-service-data-v1", "signal-drain-v1"];
const KEYS = ["schemaVersion", "codeIdentifier", "sourceCommit", "build", "marketingVersion", "capabilities", "distribution", "sourceDirty"];
const fail = () => { throw new Error("Native host artifact verification refused."); };
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Streamed digest for containers too large to hold in one allocation. */
export function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function encodeHostIdentity(identity) {
  if (!identity) fail();
  // Bootstrap JSON validation runs before package installation; no external schema runtime is available.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const strings = ["sourceCommit", "build", "marketingVersion", "codeIdentifier", "distribution"].every((key) => typeof identity[key] === "string");
  if (!strings || Object.keys(identity).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(identity, key)) ||
      identity.schemaVersion !== 1 || identity.codeIdentifier !== HOST_CODE_ID || identity.marketingVersion !== "0.1.0" ||
      !/^[0-9a-f]{40}$/.test(identity.sourceCommit) || /^0+$/.test(identity.sourceCommit) ||
      !/^[0-9]{12}$/.test(identity.build) || /^0+$/.test(identity.build) ||
      JSON.stringify(identity.capabilities) !== JSON.stringify(HOST_CAPABILITIES) ||
      ![true, false].includes(identity.sourceDirty) ||
      !["developer-id", "unsigned-development"].includes(identity.distribution) ||
      (identity.distribution === "developer-id" && identity.sourceDirty)) fail();
  return Buffer.from(JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, identity[key]]))));
}

function bounds(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > bytes.length || length > bytes.length - offset) fail();
}
function u64(bytes, offset, big = false) {
  bounds(bytes, offset, 8);
  const value = Number(big ? bytes.readBigUInt64BE(offset) : bytes.readBigUInt64LE(offset));
  if (!Number.isSafeInteger(value)) fail();
  return value;
}
function name(bytes, offset, length, requireTerminator = false) {
  bounds(bytes, offset, length);
  const field = bytes.subarray(offset, offset + length), end = field.indexOf(0);
  if (end < 0 && requireTerminator) fail();
  const value = new TextDecoder("utf-8", { fatal: true }).decode(field.subarray(0, end < 0 ? length : end));
  for (const character of value) if (character.charCodeAt(0) < 32) fail();
  return value;
}
function thin(bytes) {
  bounds(bytes, 0, 32);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) fail();
  const cpu = bytes.readUInt32LE(4), fileType = bytes.readUInt32LE(12);
  const subtype = bytes.readUInt32LE(8) & 0x00ffffff;
  const arch = cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x86_64" : null;
  if (!arch || subtype !== (arch === "arm64" ? 0 : 3)) fail();
  const count = bytes.readUInt32LE(16), commandBytes = bytes.readUInt32LE(20);
  bounds(bytes, 32, commandBytes);
  if (count > commandBytes / 8) fail();
  const end = 32 + commandBytes, loads = [], rpaths = [];
  let cursor = 32, stamp;
  for (let index = 0; index < count; index += 1) {
    bounds(bytes, cursor, 8);
    const command = bytes.readUInt32LE(cursor), length = bytes.readUInt32LE(cursor + 4);
    if (length < 8 || length % 8 !== 0 || cursor + length > end) fail();
    if (command === 0x19) {
      if (length < 72) fail();
      const sections = bytes.readUInt32LE(cursor + 64);
      if (length !== 72 + sections * 80) fail();
      for (let section = 0; section < sections; section += 1) {
        const start = cursor + 72 + section * 80;
        if (name(bytes, start, 16) !== "__bf_identity") continue;
        if (stamp || name(bytes, cursor + 8, 16) !== "__TEXT" || name(bytes, start + 16, 16) !== "__TEXT") fail();
        const size = u64(bytes, start + 40), offset = bytes.readUInt32LE(start + 48);
        const segmentOffset = u64(bytes, cursor + 40), segmentSize = u64(bytes, cursor + 48);
        const address = u64(bytes, start + 32), vmAddress = u64(bytes, cursor + 24), vmSize = u64(bytes, cursor + 32);
        bounds(bytes, segmentOffset, segmentSize); bounds(bytes, offset, size);
        if (size === 0 || size > 4096 || offset < end || offset < segmentOffset ||
            offset + size > segmentOffset + segmentSize || address < vmAddress ||
            address - vmAddress !== offset - segmentOffset || address + size > vmAddress + vmSize) fail();
        stamp = bytes.subarray(offset, offset + size);
      }
    } else if (command === 0x27) {
      // A dyld environment command can alter loader resolution without appearing as a dependency.
      fail();
    } else if ([0xc, 0x80000018, 0x8000001f, 0x80000023, 0x20, 0x8000001c, 0xe].includes(command)) {
      const minimum = command === 0x8000001c || command === 0xe ? 12 : 24;
      if (length < minimum) fail();
      const offset = bytes.readUInt32LE(cursor + 8);
      if (offset < minimum || offset >= length) fail();
      const value = name(bytes, cursor + offset, length - offset, true);
      if (!value) fail();
      if (command === 0x8000001c) rpaths.push(value);
      else if (command === 0xe) { if (value !== "/usr/lib/dyld") fail(); }
      else loads.push(value);
    }
    cursor += length;
  }
  if (cursor !== end) fail();
  let identity;
  if (stamp) {
    identity = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stamp));
    if (!encodeHostIdentity(identity).equals(stamp)) fail();
  }
  return { cpu, arch, fileType, identity, stamp, loads, rpaths };
}

export function inspectHostMachO(bytes) {
  bounds(bytes, 0, 8);
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return [thin(bytes)];
  const magic = bytes.readUInt32BE(0), fat64 = magic === 0xcafebabf;
  if (magic !== 0xcafebabe && !fat64) fail();
  const count = bytes.readUInt32BE(4), stride = fat64 ? 32 : 20;
  if (count !== 2) fail();
  bounds(bytes, 8, count * stride);
  const ranges = [], slices = [];
  for (let index = 0; index < count; index += 1) {
    const record = 8 + index * stride, cpu = bytes.readUInt32BE(record);
    const subtype = bytes.readUInt32BE(record + 4) & 0x00ffffff;
    const offset = fat64 ? u64(bytes, record + 8, true) : bytes.readUInt32BE(record + 8);
    const size = fat64 ? u64(bytes, record + 16, true) : bytes.readUInt32BE(record + 12);
    bounds(bytes, offset, size);
    if (offset < 8 + count * stride || size === 0 || ranges.some(([start, length]) => offset < start + length && start < offset + size)) fail();
    ranges.push([offset, size]);
    const slice = thin(bytes.subarray(offset, offset + size));
    if (slice.cpu !== cpu || subtype !== (slice.arch === "arm64" ? 0 : 3) ||
        slices.some((existing) => existing.arch === slice.arch)) fail();
    slices.push(slice);
  }
  return slices;
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
function system(path) {
  const normalized = resolve(path);
  return isAbsolute(path) && !path.split("/").some((part) => part === ".." || part === ".") &&
    (normalized === "/usr/lib" || normalized.startsWith("/usr/lib/") || normalized.startsWith("/System/Library/"));
}
function fileAt(root, path) {
  const info = lstatSync(path);
  const canonical = realpathSync(path);
  // Privilege-mode bits ride with the write bits: setuid/setgid/sticky on a staged file is escalation, not packaging.
  if (!info.isFile() || (info.mode & 0o6022) !== 0 || !contained(root, canonical)) fail();
  return canonical;
}

function auditPayload(root, files) {
  const expected = new Set(files.keys());
  const actual = new Set();
  const walk = (directory) => {
    const info = lstatSync(directory);
    if (!info.isDirectory() || (info.mode & 0o6022) !== 0 || !contained(root, realpathSync(directory))) fail();
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry), child = lstatSync(path);
      if (child.isDirectory()) walk(path);
      else if (child.isFile() && (child.mode & 0o6022) === 0 && contained(root, realpathSync(path))) actual.add(path);
      else fail();
    }
  };
  walk(root);
  if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) fail();
}

export function inspectHostSignature(executable, arch) {
  const verified = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "--architecture", arch, executable], { encoding: "utf8" });
  if (verified.status !== 0) fail();
  const display = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", "--architecture", arch, executable], { encoding: "utf8" });
  if (display.status !== 0) fail();
  const text = display.stderr;
  return { codeIdentifier: text.match(/^Identifier=(.+)$/m)?.[1], teamIdentifier: text.match(/^TeamIdentifier=(.+)$/m)?.[1],
    adHoc: /^Signature=adhoc$/m.test(text), hardenedRuntime: /flags=.*\bruntime\b/.test(text) };
}

export function verifyNativeHostArtifact({ executable, stageRoot, expectedSource, expectedBuild, expectedSha256,
  unsignedDevelopment = false, inspectSignature = inspectHostSignature }) {
  const root = realpathSync(stageRoot), file = fileAt(root, resolve(executable)), bytes = readFileSync(file);
  const slices = inspectHostMachO(bytes);
  if (slices.length !== 2 || slices.some((slice) => slice.fileType !== 2 || !slice.stamp) ||
      !slices[0].stamp.equals(slices[1].stamp)) fail();
  const identity = slices[0].identity;
  if (!expectedSource || !expectedBuild || identity.sourceCommit !== expectedSource || identity.build !== expectedBuild ||
      identity.distribution !== (unsignedDevelopment ? "unsigned-development" : "developer-id") ||
      (!unsignedDevelopment && identity.sourceDirty)) fail();
  const digest = sha256(bytes);
  if (expectedSha256 !== undefined && expectedSha256 !== digest) fail();
  const files = new Map([[file, digest]]), visited = new Set();
  for (const slice of slices) {
    const visit = (path, image, inheritedRpaths = []) => {
      const id = `${slice.arch}:${path}`;
      if (visited.has(id)) return;
      visited.add(id);
      if (!unsignedDevelopment) {
        const signature = inspectSignature(path, slice.arch);
        if (!signature || signature.adHoc || !signature.hardenedRuntime || signature.teamIdentifier !== HOST_TEAM ||
            (path === file && signature.codeIdentifier !== HOST_CODE_ID)) fail();
      }
      const expand = (value) => {
        if (value === "@executable_path") return dirname(file);
        if (value === "@loader_path") return dirname(path);
        if (value.startsWith("@executable_path/")) return resolve(dirname(file), value.slice(17));
        if (value.startsWith("@loader_path/")) return resolve(dirname(path), value.slice(13));
        if (isAbsolute(value)) return value;
        fail();
      };
      const rpaths = image.rpaths.map(expand);
      // An unused linker rpath cannot resolve a dependency; validate every search root when one is used.
      if (image.loads.some((load) => load.startsWith("@rpath/"))) {
        for (const candidate of rpaths) if (!system(candidate + "/") && !contained(root, candidate)) fail();
      }
      for (const load of image.loads) {
        if (system(load)) continue;
        const candidates = load.startsWith("@rpath/")
          ? [...rpaths, ...inheritedRpaths].map((entry) => resolve(entry, load.slice(7))) : [expand(load)];
        let dependency;
        for (const candidate of candidates) {
          if (system(candidate)) { dependency = candidate; break; }
          try { dependency = fileAt(root, candidate); break; } catch { /* Try only the remaining confined loader paths. */ }
        }
        if (!dependency) fail();
        if (system(dependency)) continue;
        const dependencyBytes = readFileSync(dependency), images = inspectHostMachO(dependencyBytes);
        const selected = images.find((entry) => entry.arch === slice.arch);
        if (!selected || selected.fileType !== 6) fail();
        files.set(dependency, sha256(dependencyBytes));
        visit(dependency, selected, [...rpaths, ...inheritedRpaths]);
      }
    };
    visit(file, slice);
  }
  auditPayload(root, files);
  return { identity, architectures: slices.map((slice) => slice.arch).sort(), binarySha256: digest,
    files: [...files].map(([path, hash]) => ({ path: relative(root, path), sha256: hash })),
    signatureVerified: !unsignedDevelopment, distributable: false };
}
