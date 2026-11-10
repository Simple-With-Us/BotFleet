import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { vpsDriverError } from "./vps-computer.ts";
import {
  computerReach,
  computerTransport,
  type ComputerCapabilityFlags,
  type ComputerReach,
} from "./computer-capability.ts";
import { ALL_FIXTURES, ENGINE_FIXTURES, engineFixture } from "./computer-capability.fixtures.ts";

const HERE = fileURLToPath(new URL("./computer-capability.ts", import.meta.url));

const reachOf = (driverKind: string, capabilities: ComputerCapabilityFlags): ComputerReach =>
  computerReach({ driverKind, capabilities });

describe("computer transport", () => {
  it("reads the transport off flags the drivers already declare", () => {
    expect(computerTransport({ driverKind: "boxAgent", capabilities: {} })).toBe("remoteAgent");
    expect(computerTransport({ driverKind: "claudeAgent", capabilities: { computerMcp: true } })).toBe("mcpClient");
    expect(computerTransport({ driverKind: "grok", capabilities: { toolLoop: true } })).toBe("harnessToolLoop");
    expect(computerTransport({ driverKind: "someAcpAgent", capabilities: {} })).toBeNull();
    expect(computerTransport({ driverKind: "someAcpAgent" })).toBeNull();
  });

  it("lets where the turn runs beat any flag, and the wider mount beat the narrower", () => {
    // A remote agent's reach is a property of WHERE it runs, so no MCP flag
    // can widen it; and an engine that can mount MCP servers reaches more
    // than one that can only be handed tool definitions.
    expect(computerTransport({ driverKind: "boxAgent", capabilities: { computerMcp: true, toolLoop: true } }))
      .toBe("remoteAgent");
    expect(computerTransport({ driverKind: "someAgent", capabilities: { computerMcp: true, toolLoop: true } }))
      .toBe("mcpClient");
  });
});

describe("computer reach, every cell", () => {
  // (transport × localComputerMcp) is the whole input space of the
  // derivation — cloudBackend and destination are how a CALLER reads the
  // answer, and both are exercised below.
  const CELLS: Array<{
    transport: string;
    driverKind: string;
    capabilities: ComputerCapabilityFlags;
    expected: ComputerReach;
  }> = [
    {
      transport: "remoteAgent, host control withheld",
      driverKind: "boxAgent",
      capabilities: {},
      expected: { box: true, vps: false, vm: false, local: false },
    },
    {
      transport: "remoteAgent, host control declared",
      driverKind: "boxAgent",
      capabilities: { localComputerMcp: true },
      // Deliberately NOT local: the agent runs on the box, so there is no
      // channel back to this Mac's approval broker.  No shipped driver
      // occupies this cell — boxagent.ts declares no computer flag at all —
      // so this pins the rule rather than an engine's behaviour.
      expected: { box: true, vps: false, vm: false, local: false },
    },
    {
      transport: "mcpClient, host control declared",
      driverKind: "claudeAgent",
      capabilities: { computerMcp: true, localComputerMcp: true },
      expected: { box: true, vps: true, vm: true, local: true },
    },
    {
      transport: "mcpClient, host control withheld",
      driverKind: "someMcpAgent",
      capabilities: { computerMcp: true },
      expected: { box: true, vps: true, vm: true, local: false },
    },
    {
      transport: "harnessToolLoop, host control declared",
      driverKind: "grok",
      capabilities: { toolLoop: true, localComputerMcp: true },
      expected: { box: false, vps: false, vm: false, local: true },
    },
    {
      transport: "harnessToolLoop, host control withheld",
      driverKind: "someLoop",
      capabilities: { toolLoop: true },
      expected: { box: false, vps: false, vm: false, local: false },
    },
    {
      transport: "no transport, host control declared",
      driverKind: "someAcpAgent",
      capabilities: { localComputerMcp: true },
      // Deliberately NOT local, and — like the remoteAgent twin above — a
      // DEVIATION from the rule this replaced: `server/index.ts`'s
      // `mountsLocalComputer` read `localComputerMcp` alone, so it answered
      // true here.  The derivation asks for a transport first, because an
      // engine the harness can neither mount an MCP server into nor hand tool
      // definitions to has no way to be given the host either.  No shipped
      // driver occupies this cell — drivers/acp/core.ts sets `computerMcp` and
      // `localComputerMcp` from one `mountsMcpServers` boolean, and every
      // other built-in pairs `localComputerMcp` with `computerMcp` or
      // `toolLoop` — so this pins the rule rather than an engine's behaviour,
      // and the engine-for-engine parity test below is not in conflict with
      // it.  An engine that ever does occupy the cell is a driver change, and
      // it loses host control the day it lands: that is the trade this cell
      // records.
      expected: { box: false, vps: false, vm: false, local: false },
    },
    {
      transport: "no transport, nothing declared",
      driverKind: "someAcpAgent",
      capabilities: {},
      expected: { box: false, vps: false, vm: false, local: false },
    },
  ];

  for (const cell of CELLS) {
    it(`answers all four destinations for ${cell.transport}`, () => {
      expect(reachOf(cell.driverKind, cell.capabilities)).toEqual(cell.expected);
    });
  }

  it("answers both cloud backends off the same reach", () => {
    // "Cloud" is one word for two destinations, and the box-native engine is
    // the case where they differ — which is the whole reason the picker has
    // to be handed the RESOLVED backend rather than guessing "box".
    const box = reachOf("boxAgent", {});
    expect(box.box).toBe(true);
    expect(box.vps).toBe(false);
    const claude = reachOf("claudeAgent", { computerMcp: true, localComputerMcp: true });
    expect(claude.box).toBe(true);
    expect(claude.vps).toBe(true);
    const grok = reachOf("grok", { toolLoop: true, localComputerMcp: true });
    expect(grok.box).toBe(false);
    expect(grok.vps).toBe(false);
  });

  it("keeps vpsDriverError agreeing with the reach it is handed", () => {
    for (const fixture of ALL_FIXTURES) {
      const reach = computerReach(fixture);
      const error = vpsDriverError(fixture.driverKind, reach);
      expect(error === null, `${fixture.displayName} (${fixture.driverKind})`).toBe(reach.vps);
      if (fixture.driverKind === "boxAgent") expect(error).toMatch(/runs on Box/);
      else if (error) expect(error).toMatch(/cannot mount a self-hosted VPS/);
    }
  });
});

describe("the derivation is the old rule, engine for engine", () => {
  // The regression net for "cell for cell": every engine the fleet ships is
  // asked the OLD questions — the three expressions that used to sit at the
  // top of server/index.ts's dispatch, plus vpsDriverError's two rejections
  // — and the new derivation must answer identically.  A reach flip cannot
  // ride in on a consolidation without failing here first.
  for (const fixture of ENGINE_FIXTURES) {
    it(`reproduces today's matrix for ${fixture.displayName}`, () => {
      const { driverKind, capabilities } = fixture;
      const mountsComputerMcp = capabilities.computerMcp === true;
      const mountsCloudComputer = mountsComputerMcp || driverKind === "boxAgent";
      const mountsLocalComputer = capabilities.localComputerMcp === true;
      // the old Local VM gate, verbatim: `!mountsComputerMcp || boxAgent` threw
      const mountsLocalVm = mountsComputerMcp && driverKind !== "boxAgent";
      // the old vpsDriverError, verbatim: boxAgent rejected, then !computerMcp
      const mountsVps = driverKind !== "boxAgent" && mountsComputerMcp;

      expect(computerReach(fixture)).toEqual({
        box: mountsCloudComputer,
        vps: mountsVps,
        vm: mountsLocalVm,
        local: mountsLocalComputer,
      });
    });
  }

  it("has a fixture row for every engine the default fleet ships", () => {
    // Without this, a new driver lands with its reach unstated and the
    // matrix above silently stops covering it.
    const shipped = BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort();
    const stated = ENGINE_FIXTURES.map((fixture) => fixture.driverKind).sort();
    expect(stated).toEqual(shipped);
  });

  it("names every fixture uniquely, so engineFixture() cannot silently pick the wrong row", () => {
    const names = ALL_FIXTURES.map((fixture) => fixture.displayName);
    expect(new Set(names).size).toBe(names.length);
    expect(() => engineFixture("no such engine")).toThrow(/no engine fixture/);
  });
});

describe("the dependency ban", () => {
  // The CLIENT imports this module (src/lib/local-computer.ts and
  // src/state/store.tsx), so anything it can see has to be importable inside
  // a renderer bundle.  Asserted rather than trusted, the way
  // server/tools/registry.test.ts asserts its own ban.
  const source = readFileSync(HERE, "utf8");

  it("imports no node builtin and nothing that reaches server/index.ts", () => {
    for (const line of source.split("\n")) {
      // Only real import/export specifiers; a prose mention in a comment is
      // documentation, not a dependency.
      const specifier = line.match(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/)?.[1];
      if (!specifier) continue;
      expect(specifier, `computer-capability.ts imports ${specifier}`).not.toMatch(/^node:/);
      expect(specifier, `computer-capability.ts imports ${specifier}`).not.toMatch(/(^|\/)index(\.ts)?$/);
    }
  });

  it("keeps every import type-only, so nothing at all is pulled in at runtime", () => {
    const imports = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line, line.trim()).toMatch(/^\s*import\s+type\s/);
    }
  });
});
