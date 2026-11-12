import assert from "node:assert/strict";
import { linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import test from "node:test";
import { readExisting, renderResources, renderLogrotate, renderUnit, validateDeployPaths, writeUnitFile } from "./render-resources.mjs";

const options = { volume: "/fixture-volume", root: "/fixture-volume/runtime", code: "/fixture-volume/code", user: "fixture", group: "fixture" };
test("managed reads refuse aliases and inode replacement instead of reading a second path", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-managed-read-"));
  const file = join(root, "resources.conf");
  try {
    assert.equal(readExisting(file), null);
    writeFileSync(file, "original");
    assert.equal(readExisting(file), "original");
    linkSync(file, join(root, "hardlink"));
    assert.throws(() => readExisting(file), /unverified/);
    rmSync(join(root, "hardlink"));
    if (process.platform !== "win32") {
      symlinkSync(file, join(root, "symlink"));
      assert.throws(() => readExisting(join(root, "symlink")));
    }
    assert.throws(() => readExisting(file, (fd, encoding) => {
      renameSync(file, join(root, "old"));
      writeFileSync(file, "replacement");
      assert.equal(readFileSync(fd, encoding), "original");
      return "original";
    }), /changed while reading/);
    assert.equal(readFileSync(file, "utf8"), "replacement");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("unit replacement preserves the previous inode on render failure and publishes complete validated text", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-unit-write-"));
  const file = join(root, "fixture.service");
  try {
    writeFileSync(file, "previous unit");
    const before = statSync(file).ino;
    assert.throws(() => writeUnitFile("@UNKNOWN@", options, file));
    assert.equal(statSync(file).ino, before);
    assert.equal(readFileSync(file, "utf8"), "previous unit");
    const previousMask = process.umask(0o077);
    try { writeUnitFile("[Service]\nUser=@BF_USER@\n", options, file); }
    finally { process.umask(previousMask); }
    assert.notEqual(statSync(file).ino, before);
    assert.equal(readFileSync(file, "utf8"), "[Service]\nUser=fixture\n");
    assert.equal(statSync(file).mode & 0o777, 0o644);
    assert.deepEqual(readdirSync(root), ["fixture.service"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("bundling the bootstrap library never runs its standalone CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "bf-storage-bundle-"));
  try {
    const outfile = join(root, "server-fixture.mjs");
    const source = fileURLToPath(new URL("./check-storage.mjs", import.meta.url));
    buildSync({ stdin: { contents: `import { checkStorageDevice } from ${JSON.stringify(source)}; console.log(JSON.stringify(checkStorageDevice('/fixture-data', path => ({dev:path==='/'?1:2}))));`, resolveDir: root }, bundle: true, platform: "node", format: "esm", target: "node24", outfile });
    const result = spawnSync(process.execPath, [outfile], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).online, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("no measured values produces no drop-in or invented log bounds", () => {
  assert.equal(renderResources({}), null);
  assert.equal(renderLogrotate({}, options), null);
});
test("explicit fields render and missing fields preserve previously managed limits", () => {
  const first = renderResources({ BF_CPU_QUOTA: "150%", BF_MEMORY_HIGH: "2G", BF_MEMORY_MAX: "3G", BF_MEMORY_SWAP_MAX: "0", BF_TASKS_MAX: "120", BF_IO_WEIGHT: "200", BF_IO_READ_BANDWIDTH_MAX: "/dev/fixture 10M" });
  assert.match(first, /CPUQuota=150%/);
  assert.match(first, /MemorySwapMax=0/);
  assert.match(first, /IOReadBandwidthMax=\/dev\/fixture 10M/);
  const second = renderResources({ BF_MEMORY_HIGH: "1G" }, first);
  assert.match(second, /CPUQuota=150%/);
  assert.match(second, /MemoryHigh=1G/);
  assert.match(second, /MemoryMax=3G/);
  assert.equal(renderResources({}, first), null);
});
test("strict input refuses typos, shell/unit injection, invalid formats and unmanaged files", () => {
  for (const env of [{ BF_MEMORY_MXA: "1G" }, { BF_CPU_QUOTA: "0%" }, { BF_MEMORY_MAX: "0" }, { BF_MEMORY_MAX: "999E" }, { BF_TASKS_MAX: "9999999999999999999999" }, { BF_MEMORY_MAX: "1G\nDelegate=yes" }, { BF_IO_WEIGHT: "0" }, { BF_IO_READ_BANDWIDTH_MAX: "/dev/../etc 1M" }, { BF_IO_READ_IOPS_MAX: "/dev/fixture nope" }]) assert.throws(() => renderResources(env));
  assert.throws(() => renderResources({ BF_MEMORY_HIGH: "1G" }, "[Service]\nMemoryMax=2G\n"), /unmanaged/);
  assert.throws(() => renderResources({ BF_MEMORY_HIGH: "1G" }, "# Managed by BotFleet render-resources.mjs\n[Service]\nDelegate=yes\n"), /invalid/);
});
test("log rotation needs explicit size and history count and handles append fds", () => {
  assert.throws(() => renderLogrotate({ BF_LOG_ROTATE_SIZE: "1M" }, options));
  assert.throws(() => renderLogrotate({ BF_LOG_ROTATE_SZE: "1M" }, options));
  assert.throws(() => renderLogrotate({ BF_LOG_ROTATE_SIZE: "1M\npostrotate bad", BF_LOG_ROTATE_COUNT: "2" }, options));
  const policy = renderLogrotate({ BF_LOG_ROTATE_SIZE: "1M", BF_LOG_ROTATE_COUNT: "2" }, options);
  assert.match(policy, /size 1M/);
  assert.match(policy, /rotate 2/);
  assert.match(policy, /copytruncate/);
  assert.throws(() => renderLogrotate({ BF_LOG_ROTATE_SIZE: "1M", BF_LOG_ROTATE_COUNT: "2" }, options, "unmanaged policy"));
});
test("deploy paths and identities cannot escape their volume or inject unit lines", () => {
  validateDeployPaths(options);
  for (const edit of [{ volume: "/" }, { root: "/other/runtime" }, { code: "/fixture-volume/../etc" }, { user: "fixture\nUser=root" }, { group: "fixture:bad" }]) assert.throws(() => validateDeployPaths({ ...options, ...edit }));
});
test("unit guards the mount, pins the namespace and moves literal temporary paths onto the volume", () => {
  const unit = renderUnit(readFileSync(new URL("./botfleet-server.service.in", import.meta.url), "utf8"), options);
  assert.match(unit, /RequiresMountsFor=\/fixture-volume/);
  assert.match(unit, /ConditionPathIsMountPoint=\/fixture-volume/);
  assert.match(unit, /BindPaths=\/fixture-volume/);
  assert.match(unit, /MountFlags=private/);
  assert.match(unit, /BindPaths=\/fixture-volume\/runtime\/tmp:\/tmp \/fixture-volume\/runtime\/var-tmp:\/var\/tmp/);
  assert.match(unit, /ExecStartPre=.*check-storage.mjs/);
  assert.match(unit, /ExecStart=.*start.sh/);
  assert.match(unit, /ExecStart=\/fixture-volume\/runtime\/bin\/start.sh/);
  assert.match(unit, /ExecStartPre=.*\/fixture-volume\/runtime\/bin\/check-storage.mjs/);
  assert.doesNotMatch(unit, /StandardOutput=append:/);
  assert.match(unit, /ProtectControlGroups=yes/);
  assert.doesNotMatch(unit, /Delegate=yes/);
  assert.doesNotMatch(unit, /@[A-Z_]+@/);
  assert.throws(() => renderUnit("@UNKNOWN@", options));
  const gate = renderUnit(readFileSync(new URL("./botfleet-owner-gate.service.in", import.meta.url), "utf8"), options);
  assert.match(gate, /RequiresMountsFor=\/fixture-volume/);
  assert.match(gate, /MountFlags=private/);
  assert.match(gate, /StandardOutput=journal/);
  assert.doesNotMatch(gate, /StandardOutput=append:/);
  assert.match(gate, /ExecStartPre=.*check-storage.mjs/);
});
