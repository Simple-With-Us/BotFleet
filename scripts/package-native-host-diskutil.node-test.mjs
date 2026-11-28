// BF-2711: the disk-image tool choice must spell both tools exactly, and
// the probe must select diskutil only where `diskutil image create from`
// answers its help with exit 0.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const seenVerbs = [];
    const spawnVerbs = (command, args) => {
      seenVerbs.push(args);
      return { status: args[1] === "attach" ? 0 : 1 };
    };
    assert.equal(diskutilImageAvailable(spawnVerbs, ["image", "attach", "--help"]), true);
    assert.deepEqual(seenVerbs, [["image", "attach", "--help"]]);
  });

  it(
    "round-trips a real disk image where diskutil image exists",
    { skip: process.platform !== "darwin" || !diskutilImageAvailable() },
    () => {
      assert.equal(diskutilImageAvailable(undefined, ["image", "attach", "--help"]), true);
      const exec = ([command, args]) => execFileSync(command, args, { encoding: "utf8" });
      const root = mkdtempSync(join(tmpdir(), "bf2711-test-"));
      const source = join(root, "payload");
      mkdirSync(source);
      writeFileSync(join(source, "hello.txt"), "bf-2711-roundtrip\n");
      const artifact = join(root, "out.dmg");
      const mounted = join(root, "mounted");
      mkdirSync(mounted);
      try {
        exec(diskImageCreateCommand(true, "BF2711TEST", source, artifact));
        exec(diskImageAttachCommand(true, mounted, artifact));
        try {
          assert.equal(readFileSync(join(mounted, "hello.txt"), "utf8"), "bf-2711-roundtrip\n");
        } finally {
          exec(diskImageDetachCommand(true, mounted));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
