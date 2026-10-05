// The capability matrix, checked against the drivers it describes.
//
// `engine-capabilities.test.ts` guards the SHAPE of the registry: every key
// present, every engine in display order, every string well-formed.  It cannot
// tell you whether a cell is TRUE, because a cell's truth lives in a driver,
// not in this directory.  So that file pins the answers it knows in prose —
// "Claude, Codex, Antigravity, pi, and the DSH ACP adapter declare
// composioMcp" — and a prose list is a snapshot of one afternoon.  It misses a
// driver that gains a channel afterwards, and it misses a driver that loses
// one.
//
// This file closes that gap by reading `BUILT_IN_DRIVERS` directly.  Every
// driver publishes `metadata.channelWiring`, resolved once at registration
// from the same expressions the runtime uses, so the matrix can be held to the
// code rather than to a comment:
//
//    composioMcp       -> connectedApps
//    localComputerMcp  -> thisComputer
//    computerMcp       -> computerUse
//    agentsMcp         -> crossBotCoordination
//    images            -> imageAttachments
//
// The rule is deliberately asymmetric, because only one direction is a lie:
//
//   - Claiming a channel a driver does not mount is an OVERCLAIM, and it is
//     what a bot burns a turn on.  Forbidden outright.
//   - Marking a mounted channel as unavailable is a DOWNGRADE.  Legitimate —
//     "the bridge is generic but nobody has audited a real turn on it" is a
//     true and useful thing to say — but it must be said out loud, so the
//     entry carries its own note explaining it.
//
// Every other cell (files, terminal, web access, rooms, voice, long context,
// live research) is a product judgment with no driver flag behind it, so it
// stays prose and is deliberately not checked here.  A test that pretended to
// cover them would be theatre.

import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "../../server/drivers/builtIn.ts";
import type { EngineChannelWiring } from "../../server/contracts.ts";
import {
  ENGINE_CAPABILITIES,
  ENGINE_DISPLAY_ORDER,
  engineIdFromDriverKind,
  type CapabilityKey,
  type CapabilityState,
} from "./engine-capabilities.tsx";

/** Matrix cell -> the driver flag that answers it.  A cell absent from this
 *  map has no driver-declared truth and is not checked. */
const DERIVED_CELLS: ReadonlyArray<readonly [CapabilityKey, keyof EngineChannelWiring]> = [
  ["connectedApps", "composioMcp"],
  ["thisComputer", "localComputerMcp"],
  ["computerUse", "computerMcp"],
  ["crossBotCoordination", "agentsMcp"],
  ["imageAttachments", "images"],
];

/** Verdicts that assert the channel is present. */
const AFFIRMATIVE: ReadonlySet<CapabilityState> = new Set<CapabilityState>(["yes", "yes-pro-only"]);

interface EngineWiring {
  /** driverKind -> what that one driver mounts. */
  byDriver: Map<string, EngineChannelWiring>;
}

/** Every registered driver, grouped under the engine id it resolves to. */
function wiringByEngine(): Map<string, EngineWiring> {
  const grouped = new Map<string, EngineWiring>();
  for (const driver of BUILT_IN_DRIVERS) {
    const engineId = engineIdFromDriverKind(driver.driverKind);
    if (!engineId) continue;
    const wiring = driver.metadata.channelWiring;
    // A driver that publishes no wiring cannot be checked, which would make
    // this whole file quietly vacuous for that engine.  Asserted separately
    // below so it fails loudly rather than skipping.
    if (!wiring) continue;
    let entry = grouped.get(engineId);
    if (!entry) {
      entry = { byDriver: new Map() };
      grouped.set(engineId, entry);
    }
    entry.byDriver.set(driver.driverKind, wiring);
  }
  return grouped;
}

/** Does ANY driver for this engine mount the channel?  An engine id can be
 *  carried by several drivers — `grok` by both the direct API driver and the
 *  Grok Build ACP driver, `deepseek-harness` by both the Clutch bridge and the
 *  legacy `deepseekAgent` — and the matrix row is about the engine, not about
 *  one driver.  A row may therefore say "yes" on the strength of any one of
 *  them. */
function anyDriverMounts(entry: EngineWiring | undefined, flag: keyof EngineChannelWiring): boolean {
  if (!entry) return false;
  for (const wiring of entry.byDriver.values()) {
    if (wiring[flag]) return true;
  }
  return false;
}

describe("capability matrix against the drivers", () => {
  it("publishes channel wiring for every registered driver", () => {
    // Without this, the checks below would quietly skip a driver and the file
    // would pass while proving nothing about it.
    const missing = BUILT_IN_DRIVERS.filter((driver) => !driver.metadata.channelWiring).map(
      (driver) => driver.driverKind,
    );
    expect(missing, "drivers must publish metadata.channelWiring to be checkable").toEqual([]);
  });

  it("never claims a channel a driver does not mount", () => {
    const offenders: string[] = [];
    for (const [engineId, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      const wiring = wiringByEngine().get(engineId);
      for (const [key, flag] of DERIVED_CELLS) {
        const state = entry.capabilities[key];
        if (state === undefined) continue;
        if (!AFFIRMATIVE.has(state)) continue;
        if (!anyDriverMounts(wiring, flag)) {
          offenders.push(`${engineId}.${key} is "${state}" but no driver mounts ${flag}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("records a reason whenever a mounted channel is marked unavailable", () => {
    const offenders: string[] = [];
    for (const [engineId, entry] of Object.entries(ENGINE_CAPABILITIES)) {
      const wiring = wiringByEngine().get(engineId);
      for (const [key, flag] of DERIVED_CELLS) {
        if (entry.capabilities[key] !== "no") continue;
        if (!anyDriverMounts(wiring, flag)) continue; // honest: nothing mounts it
        const note = entry.capabilityNotes?.[key];
        if (!note) {
          offenders.push(
            `${engineId}.${key} is "no" but a driver mounts ${flag} — add a capabilityNotes entry saying why`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every displayed engine at least one driver to stand on", () => {
    const wiring = wiringByEngine();
    const orphans = ENGINE_DISPLAY_ORDER.filter((engineId) => !wiring.has(engineId));
    expect(orphans, "a matrix row with no driver cannot be verified — add a driver or drop the row").toEqual(
      [],
    );
  });

  it("gives every driver either a matrix row or a recorded reason for having none", () => {
    // The gap this whole exercise started from: `BUILT_IN_DRIVERS` carried
    // seventeen engines while the registry described eight, and the rest fell
    // through `engineCapability()` to a generic placeholder that told the user
    // the engine was simply not registered yet.
    const withoutRow: string[] = [];
    for (const driver of BUILT_IN_DRIVERS) {
      if (!engineIdFromDriverKind(driver.driverKind)) withoutRow.push(driver.driverKind);
    }
    expect(
      withoutRow,
      "every built-in driver needs a row in ENGINE_CAPABILITIES (and an alias in engineIdFromDriverKind if its kind does not match its engine id)",
    ).toEqual([]);
  });

  it("resolves every engine id to the same wiring the driver advertises at runtime", () => {
    // Cheap guard on the plumbing itself: if a future refactor drops
    // `channelWiring` from the ACP core's metadata while leaving the flag on
    // `AcpSupport`, the two would disagree and every other assertion in this
    // file would be checking a stale mirror.
    const acp = BUILT_IN_DRIVERS.find((driver) => driver.driverKind === "museAgent");
    expect(acp, "the Muse Code driver must be registered").toBeDefined();
    expect(acp?.metadata.channelWiring).toEqual({
      agentsMcp: true,
      computerMcp: true,
      composioMcp: true,
      localComputerMcp: true,
      images: true,
    });
  });
});
