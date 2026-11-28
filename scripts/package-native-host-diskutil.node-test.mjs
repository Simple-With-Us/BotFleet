// BF-2711: the disk-image tool choice must spell both tools exactly, and
// the probe must select diskutil only where `diskutil image create from`
// answers its help with exit 0.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  diskImageAttachCommand,
  diskImageCreateCommand,
  diskImageDetachCommand,
  diskutilImageAvailable,
} from "./package-native-host.mjs";

describe("disk-image tool choice (BF-2711)", () => {
  it("spells the diskutil create, attach and eject commands", () => {
    assert.deepEqual(diskImageCreateCommand(true, "Vol", "/src", "/out.dmg"), [
      "/usr/sbin/diskutil",
      ["image", "create", "from", "--format", "UDZO", "--volumeName", "Vol", "/src", "/out.dmg"],
    ]);
    assert.deepEqual(diskImageAttachCommand(true, "/mnt", "/out.dmg"), [
      "/usr/sbin/diskutil",
      ["image", "attach", "--readOnly", "--nobrowse", "--mountPoint", "/mnt", "/out.dmg"],
    ]);
    assert.deepEqual(diskImageDetachCommand(true, "/mnt"), [
      "/usr/sbin/diskutil",
      ["eject", "/mnt"],
    ]);
  });

  it("keeps the exact hdiutil fallback spellings", () => {
    assert.deepEqual(diskImageCreateCommand(false, "Vol", "/src", "/out.dmg"), [
      "/usr/bin/hdiutil",
      ["create", "-volname", "Vol", "-srcfolder", "/src", "-ov", "-format", "UDZO", "/out.dmg"],
    ]);
    assert.deepEqual(diskImageAttachCommand(false, "/mnt", "/out.dmg"), [
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-mountpoint", "/mnt", "/out.dmg"],
    ]);
    assert.deepEqual(diskImageDetachCommand(false, "/mnt"), [
      "/usr/bin/hdiutil",
      ["detach", "/mnt"],
    ]);
  });

  it("probes the exact subcommand and honours its exit status", () => {
    const seen = [];
    const spawnOk = (command, args) => {
      seen.push([command, args]);
      return { status: 0 };
    };
    assert.equal(diskutilImageAvailable(spawnOk), true);
    assert.deepEqual(seen, [["/usr/sbin/diskutil", ["image", "create", "from", "--help"]]]);
    assert.equal(diskutilImageAvailable(() => ({ status: 1 })), false);
    assert.equal(diskutilImageAvailable(() => ({ status: null, error: new Error("ENOENT") })), false);
    assert.equal(
      diskutilImageAvailable(() => {
        throw new Error("ENOENT");
      }),
      false,
    );
  });
});
