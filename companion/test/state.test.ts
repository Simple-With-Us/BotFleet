// The sidecar's data directory, and the one property an upgrade depends on:
// the fleet paired under the previous product name is the fleet the new
// build boots with.  The rename to BotFleet rewrote the legacy list to the
// current name, so nothing was ever adopted and every phone came back
// unpaired; and the adoption ran on the first write rather than before the
// first read, so even a correct list would have loaded nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DeviceRegistry } from "../src/devices.ts";
import { adoptLegacyDataDir, DATA_DIR, LEGACY_COMPANION_DIRS } from "../src/state.ts";

const OPENMAUSBOT = ".openmausbot-companion";
const OPENGROKBOT = ".opengrokbot-companion";
const legacyDir = (name: string) => join(homedir(), name);

const plantLegacy = (name: string, devices = "[]") => {
  const dir = legacyDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "devices.json"), `{"devices":${devices}}`);
  return dir;
};

const pair = (registry: DeviceRegistry, name = "iPhone") => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, name);
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};

describe("companion data directory", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    for (const name of LEGACY_COMPANION_DIRS) rmSync(legacyDir(name), { recursive: true, force: true });
  });

  it("names the predecessors, never itself", () => {
    // the test rig pins DATA_DIR to the default name, so this is the real check
    expect(basename(DATA_DIR)).toBe(".botfleet-companion");
    expect(LEGACY_COMPANION_DIRS).toEqual([OPENMAUSBOT, OPENGROKBOT]);
    expect(LEGACY_COMPANION_DIRS).not.toContain(basename(DATA_DIR));
  });

  it("adopts the OpenMausBot-era directory on first boot", () => {
    const legacy = plantLegacy(OPENMAUSBOT, '[{"id":"a","tokenHash":"b"}]');

    expect(adoptLegacyDataDir()).toBe(legacy);

    expect(existsSync(legacy)).toBe(false);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).devices).toHaveLength(1);
  });

  it("prefers the newest predecessor and leaves the older one alone", () => {
    plantLegacy(OPENGROKBOT, '[{"id":"old","tokenHash":"x"}]');
    const newest = plantLegacy(OPENMAUSBOT, '[{"id":"new","tokenHash":"y"}]');

    expect(adoptLegacyDataDir()).toBe(newest);

    expect(JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).devices[0].id).toBe("new");
    expect(existsSync(legacyDir(OPENGROKBOT))).toBe(true);
  });

  it("falls back to the OpenGrokBot-era directory when that is all there is", () => {
    const legacy = plantLegacy(OPENGROKBOT);
    expect(adoptLegacyDataDir()).toBe(legacy);
    expect(existsSync(join(DATA_DIR, "devices.json"))).toBe(true);
  });

  it("never touches a predecessor once the current directory exists", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "devices.json"), '{"devices":[]}');
    const legacy = plantLegacy(OPENMAUSBOT, '[{"id":"a","tokenHash":"b"}]');

    expect(adoptLegacyDataDir()).toBeNull();

    expect(existsSync(legacy)).toBe(true);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).devices).toEqual([]);
  });

  it("adopts nothing when there is nothing to adopt", () => {
    expect(adoptLegacyDataDir()).toBeNull();
    expect(existsSync(DATA_DIR)).toBe(false);
  });

  it("boots with the fleet that was paired under the old name", () => {
    // pair under the current name, then put the file where the previous
    // build would have left it — the upgrade a real user goes through
    const { token, device } = pair(new DeviceRegistry());
    renameSync(DATA_DIR, legacyDir(OPENMAUSBOT));
    expect(existsSync(DATA_DIR)).toBe(false);

    const upgraded = new DeviceRegistry();

    expect(upgraded.authenticate(token)?.id).toBe(device.id);
    expect(upgraded.list().map((d) => d.id)).toEqual([device.id]);
    expect(existsSync(legacyDir(OPENMAUSBOT))).toBe(false);
    // and the first write after the upgrade keeps that fleet, rather than
    // replacing it with the empty one an unmigrated boot would have read
    pair(upgraded, "iPad");
    expect(new DeviceRegistry().list().map((d) => d.id)).toContain(device.id);
  });
});
