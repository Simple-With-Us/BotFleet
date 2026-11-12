import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { computerReach } from "../../server/computer-capability.ts";
import { engineFixture, type EngineFixture } from "../../server/computer-capability.fixtures.ts";
import {
  autoSelectsLocalComputer,
  cloudBackendUnavailableNote,
  computerDestinationDisabledReason,
  engineReachKnown,
  instanceSupportsCloudComputer,
  instanceSupportsLocalVm,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
  runsOnDisabledNote,
} from "./local-computer";

const BOT = { modelSelection: { instanceId: "engine", model: "m" } } satisfies Pick<Bot, "modelSelection">;

/** One instance row shaped exactly as the server ships it: the driver's own
 *  flags, plus the reach DERIVED from them by the one derivation.  Deriving
 *  it here rather than hand-writing a reach is the point — a hand-written
 *  fixture can agree with a client bug, and that is how the picker came to
 *  offer destinations the turn refused.  The fixtures themselves are shared
 *  with `server/computer-capability.test.ts`, so the two sides cannot drift
 *  apart again. */
const instanceFor = (fixture: EngineFixture): InstanceInfo[] =>
  [
    {
      instanceId: "engine",
      driverKind: fixture.driverKind,
      displayName: fixture.displayName,
      capabilities: fixture.capabilities,
      computerReach: computerReach(fixture),
    },
  ] as InstanceInfo[];

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    expect(instanceSupportsLocalComputer(instanceFor(engineFixture("Claude")), BOT)).toBe(true);
    expect(instanceSupportsLocalComputer(instanceFor(engineFixture("ASCII.dev Box")), BOT)).toBe(false);
  });

  it("does not offer This computer to an engine that only has the computer MCP surface", () => {
    // REGRESSION.  This helper used to accept `computerMcp` as a second way
    // to qualify, but the server mounts host control on `localComputerMcp`
    // ALONE (`server/index.ts`'s shouldMountLocalComputer feed and the
    // dispatch's mountsLocalComputer).  The picker therefore offered "This
    // computer" to an engine the turn would never mount it for.  Mounting a
    // computer as an MCP server says nothing about whether that engine's
    // asks can reach a person for approval, which is what host control needs.
    expect(
      instanceSupportsLocalComputer(instanceFor(engineFixture("MCP client without host control")), BOT),
    ).toBe(false);
  });

  it("still offers This computer to a harness tool-loop engine", () => {
    // The other half of the same rule: an engine with no MCP client at all
    // reaches the host, because the harness runs those tools itself.
    expect(instanceSupportsLocalComputer(instanceFor(engineFixture("Grok")), BOT)).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "linux" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(linuxAutoDescription()).toContain("otherwise computer use stays off");
    expect(
      autoSelectsLocalComputer({
        platform: "linux",
        computers: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = {
      host: { platform: "linux" as const },
      localComputer: {
        available: false,
        enabled: false,
        reasonCode: "linux-wayland-seat-safety-blocked",
      },
    } as DesktopCapabilities;

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "Local computer control is not available on Wayland yet.  Sign out and choose Ubuntu on Xorg to use This Computer.",
    );
  });

  it("preserves the ready local fallback on supported non-Linux hosts", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computers: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(true);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computers: ["cloud"],
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computers: ["vm"],
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });
});

describe("computer destination eligibility", () => {
  it("offers a Local VM only to an engine that can mount one", () => {
    // the real cost of not checking: 51 turns died on "this model engine
    // cannot use the Local VM" after the picker had offered it
    expect(instanceSupportsLocalVm(instanceFor(engineFixture("Claude")), BOT)).toBe(true);
    expect(instanceSupportsLocalVm(instanceFor(engineFixture("ACP without MCP servers")), BOT)).toBe(false);
    expect(instanceSupportsLocalVm(instanceFor(engineFixture("Grok")), BOT)).toBe(false);
  });

  it("does not offer a Local VM over the remoteAgent transport, which runs the turn elsewhere", () => {
    // Stated as a TRANSPORT rather than as `driverKind === "boxAgent"`: the
    // reason is that the agent runs on the remote machine, so there is no
    // local agent to mount a VM into — not that one engine is special-cased.
    expect(instanceSupportsLocalVm(instanceFor(engineFixture("ASCII.dev Box")), BOT)).toBe(false);
  });

  it("offers a remote desktop to the ASCII.dev Box engine and to anything with the computer surface", () => {
    expect(instanceSupportsCloudComputer(instanceFor(engineFixture("ASCII.dev Box")), BOT, "box")).toBe(true);
    expect(instanceSupportsCloudComputer(instanceFor(engineFixture("Claude")), BOT, "box")).toBe(true);
    expect(instanceSupportsCloudComputer(instanceFor(engineFixture("ACP without MCP servers")), BOT, "box")).toBe(false);
  });

  it("does not offer Cloud to the ASCII.dev Box engine when the backend resolves to a VPS", () => {
    // REGRESSION.  This helper could not see the backend at all, so it
    // answered "box" for every bot and returned true for the box-native
    // engine unconditionally.  A bot on that engine whose cloud backend
    // resolved to "vps" was therefore offered Cloud in Settings and then
    // died mid-turn at server/vps-computer.ts's vpsDriverError, which
    // refuses boxAgent outright.  Same engine, two backends, two answers.
    expect(instanceSupportsCloudComputer(instanceFor(engineFixture("ASCII.dev Box")), BOT, "vps")).toBe(false);
    expect(instanceSupportsCloudComputer(instanceFor(engineFixture("ASCII.dev Box")), BOT, "box")).toBe(true);
    expect(instanceSupportsCloudComputer(instanceFor(engineFixture("Claude")), BOT, "vps")).toBe(true);
    expect(
      computerDestinationDisabledReason("cloud", instanceFor(engineFixture("ASCII.dev Box")), BOT, "vps"),
    ).toContain("cannot drive a remote desktop");
    expect(
      computerDestinationDisabledReason("cloud", instanceFor(engineFixture("ASCII.dev Box")), BOT, "box"),
    ).toBeNull();
  });

  it("lets the server have the last word on an engine the client does not know", () => {
    expect(instanceSupportsLocalVm([], BOT)).toBe(true);
    expect(instanceSupportsCloudComputer([], BOT, "box")).toBe(true);
    expect(instanceSupportsCloudComputer([], BOT, "vps")).toBe(true);
  });

  it("stays fail-closed for a known engine whose row carries no reach", () => {
    const stale = [
      { instanceId: "engine", driverKind: "claudeAgent", displayName: "Claude", capabilities: { computerMcp: true } },
    ] as InstanceInfo[];
    expect(instanceSupportsLocalVm(stale, BOT)).toBe(false);
    expect(instanceSupportsCloudComputer(stale, BOT, "box")).toBe(false);
    expect(instanceSupportsLocalComputer(stale, BOT)).toBe(false);
  });

  it("names the engine in the reason, so the fix is obvious from the tooltip", () => {
    const bare = instanceFor(engineFixture("ACP without MCP servers"));
    const reason = computerDestinationDisabledReason("vm", bare, BOT, "box");
    expect(reason).toContain("ACP without MCP servers");
    expect(reason).toContain("Local VM");
    expect(computerDestinationDisabledReason("vm", instanceFor(engineFixture("Claude")), BOT, "box")).toBeNull();
  });

  it("tells a local-only engine, in one sentence, that it stays on this Mac", () => {
    const grok = instanceFor(engineFixture("Grok"));
    expect(computerDestinationDisabledReason("cloud", grok, BOT, "vps")).toBe(
      "Grok runs only on this Mac.",
    );
    expect(computerDestinationDisabledReason("vm", grok, BOT, "box")).toBe(
      "Grok runs only on this Mac.",
    );
    expect(computerDestinationDisabledReason("cloud", grok, BOT, "box", false)).toBe(
      "Grok runs only on this computer.",
    );
    expect(cloudBackendUnavailableNote(grok, BOT, true)).toBe("Grok runs only on this Mac.");
    expect(cloudBackendUnavailableNote(instanceFor(engineFixture("MiniMax")), BOT, false)).toBe(
      "MiniMax runs only on this computer.",
    );
  });

  it("keeps the VPS sentence for an engine that can use a box and not a VPS", () => {
    const box = instanceFor(engineFixture("ASCII.dev Box"));
    const note = cloudBackendUnavailableNote(box, BOT, true);
    expect(note).toContain("can't run a desktop on your own server");
    expect(note).not.toContain("only on this Mac");
    expect(cloudBackendUnavailableNote(instanceFor(engineFixture("Claude")), BOT, true)).toBeNull();
    expect(cloudBackendUnavailableNote([], BOT, true)).toBeNull();
  });

  it("does not repeat the cloud-backend sentence under Runs On", () => {
    const note = "Grok runs only on this Mac.";
    expect(runsOnDisabledNote(note, note, note, true)).toBeNull();
    expect(runsOnDisabledNote(note, "Grok cannot drive a Local VM.", note, true)).toBe(
      "Grok cannot drive a Local VM.",
    );
    expect(runsOnDisabledNote(note, note, note, false)).toBe(note);
  });
});

describe("the engine list the eligibility answers rest on", () => {
  it("is not known while the list is still hydrating, however fail-open reads", () => {
    // The pairing that matters: the helpers answer "supported" for an empty
    // list on purpose — an engine the client does not know is one the server
    // may well accept — and an un-hydrated list is indistinguishable from
    // that.  `/api/instances` is a parallel request and a cold describe costs
    // tens of seconds, so the window is real.  The computer panel's cloud
    // lifecycle spends money on that answer (a docker run, or a billed
    // ASCII.dev Box), so it holds until this says the list is in.
    expect(instanceSupportsCloudComputer([], BOT, "box")).toBe(true);
    expect(engineReachKnown({ instances: [], hydrationStatus: "idle" })).toBe(false);
    expect(engineReachKnown({ instances: [], hydrationStatus: "loading" })).toBe(false);
  });

  it("is known the moment a row lands, which is what re-runs the hold", () => {
    expect(engineReachKnown({ instances: instanceFor(engineFixture("Claude")), hydrationStatus: "loading" })).toBe(true);
  });

  it("does not hold forever on a fleet that genuinely has no engines", () => {
    // A settled hydrate answers the question even with nothing in it, so an
    // empty list is believed rather than waited on.  Without this the panel
    // would sit in "Checking…" for good.
    expect(engineReachKnown({ instances: [], hydrationStatus: "ready" })).toBe(true);
  });

  it("keeps holding while hydration is failing, because nothing is known yet", () => {
    // The app retries and re-hydrates on the next stream hello, so this is a
    // hold rather than a dead end — and holding is the honest answer while
    // the list cannot be fetched at all.
    expect(engineReachKnown({ instances: [], hydrationStatus: "failed" })).toBe(false);
  });
});
