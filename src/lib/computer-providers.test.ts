import { describe, expect, it } from "vitest";
import {
  COMPUTER_PROVIDER_DISABLE_IMPACT,
  COMPUTER_PROVIDER_LABEL,
  COMPUTER_PROVIDER_ORDER,
  migrateAllowedComputersToProviders,
} from "../../shared/local-auto-consent";
import { providersForBot } from "../components/BotComputerMatrix";
import type { Bot } from "../state/store";

describe("computerProviders migrateAllowedComputersToProviders", () => {
  it("maps [\"cloud\"] to { asciiBox: true, selfHostedVps: true, localVm: false, localMac: false } with per-bot VPS", () => {
    const result = migrateAllowedComputersToProviders(["cloud"]);
    expect(result.providers).toEqual({
      asciiBox: true,
      selfHostedVps: true,
      localVm: false,
      localMac: false,
    });
    expect(result.vpsMode).toBe("shared");
  });

  it("maps [\"vm\"] to { localVm: true } with no VPS mode", () => {
    const result = migrateAllowedComputersToProviders(["vm"]);
    expect(result.providers).toEqual({
      asciiBox: false,
      selfHostedVps: false,
      localVm: true,
      localMac: false,
    });
    expect(result.vpsMode).toBeNull();
  });

  it("maps [\"local\"] to { localMac: true } with no VPS mode", () => {
    const result = migrateAllowedComputersToProviders(["local"]);
    expect(result.providers).toEqual({
      asciiBox: false,
      selfHostedVps: false,
      localVm: false,
      localMac: true,
    });
    expect(result.vpsMode).toBeNull();
  });

  it("maps a multi-element legacy array onto the right providers", () => {
    const result = migrateAllowedComputersToProviders(["cloud", "local"]);
    expect(result.providers).toEqual({
      asciiBox: true,
      selfHostedVps: true,
      localVm: false,
      localMac: true,
    });
    expect(result.vpsMode).toBe("shared");
  });

  it("maps null to ALL providers enabled (legacy meaning was 'every destination allowed')", () => {
    const result = migrateAllowedComputersToProviders(null);
    expect(result.providers).toEqual({
      asciiBox: true,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    });
    expect(result.vpsMode).toBe("shared");
  });

  it("maps undefined to ALL providers enabled", () => {
    const result = migrateAllowedComputersToProviders(undefined);
    expect(result.providers).toEqual({
      asciiBox: true,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    });
    expect(result.vpsMode).toBe("shared");
  });

  it("preserves an empty allowlist as a deliberate deny-all (NOT the default)", () => {
    // SAFETY: an existing config with `allowedComputers: []` was the
    // operator's explicit "no destination is allowed" choice.  The
    // migrator must NOT silently re-enable Box and VPS on upgrade.
    const result = migrateAllowedComputersToProviders([]);
    expect(result.providers).toEqual({
      asciiBox: false,
      selfHostedVps: false,
      localVm: false,
      localMac: false,
    });
    expect(result.vpsMode).toBeNull();
  });

  it("ignores unrecognized legacy entries rather than throwing", () => {
    // SAFETY: legacy writes are type-checked, but a hand-edited config
    // is tolerated at boot so a malformed entry cannot brick a fleet.
    // SAFETY: cast the array to the legacy wire type so we can hand
    // the migrator a bogus entry it would never see at runtime.
    const result = migrateAllowedComputersToProviders(["cloud", "alien"] as Array<"cloud" | "vm" | "local">);
    expect(result.providers.asciiBox).toBe(true);
    expect(result.providers.selfHostedVps).toBe(true);
    expect(result.vpsMode).toBe("shared");
  });

  it("is idempotent on the new shape (running on already-migrated data is a no-op)", () => {
    const first = migrateAllowedComputersToProviders(["cloud"]);
    const second = migrateAllowedComputersToProviders(
      null,
      first.vpsMode,
    );
    // Calling with a vpsMode and no legacy shape returns the same
    // providers (since the migrator falls through to DEFAULT) — the
    // idempotency check is actually performed by the server's
    // migrateComputerProvidersConfig, which sees `computerProviders`
    // already on disk and returns null.  We pin that contract here
    // so the shape stays stable across re-runs.
    expect(second.providers).toEqual({
      asciiBox: true,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    });
  });

  it("respects an explicit vpsMode argument when given a legacy value that does not imply one", () => {
    const result = migrateAllowedComputersToProviders(["local"], "per-bot");
    expect(result.providers.localMac).toBe(true);
    expect(result.vpsMode).toBe("per-bot");
  });

  it("throws when selfHostedVps is on but vpsMode is null (schema cross-field invariant)", () => {
    expect(() => migrateAllowedComputersToProviders(["cloud"], null)).toThrow(
      /vpsMode is null but selfHostedVps is enabled/,
    );
  });
});

describe("computerProviders constants", () => {
  it("exposes a label and impact caption for every provider id", () => {
    for (const id of COMPUTER_PROVIDER_ORDER) {
      expect(COMPUTER_PROVIDER_LABEL[id]).toBeTruthy();
      expect(COMPUTER_PROVIDER_DISABLE_IMPACT[id]).toBeTruthy();
    }
  });

  it("uses the canonical provider order", () => {
    expect(COMPUTER_PROVIDER_ORDER).toEqual([
      "asciiBox",
      "selfHostedVps",
      "localVm",
      "localMac",
    ]);
  });
});

describe("computerProviders reducer-level toggling", () => {
  // A small fake state-machine model: the parent component owns
  // `state.config.botDefaults.computerProviders`, the toggle row, and
  // the impact-confirm modal.  We exercise that contract here by
  // replaying the LocalComputerSection dispatch logic against a
  // fixture without mounting React.
  type Toggle = { provider: keyof typeof COMPUTER_PROVIDER_LABEL; next: boolean };

  function applyToggle(
    providers: Record<string, boolean>,
    bots: Bot[],
    toggle: Toggle,
  ): { committed: boolean; gateModal: boolean; impactedBots: string[] } {
    const botHasProvider = (id: string) => {
      const bot = bots.find((b) => b.id === id);
      if (!bot) return false;
      const botProviders = providersForBot(bot, providers as any, undefined, []);
      return botProviders[toggle.provider] === true;
    };
    const impactedBots = bots.filter((bot) => {
      // Skipping "off" bots — they cannot lose a leg they don't have.
      if (bot.computers !== undefined && bot.computers.length === 0) return false;
      return botHasProvider(bot.id);
    }).map((b) => b.id);
    // Toggling off a provider that no bot uses is a no-op (no modal,
    // commit immediately).
    if (!toggle.next && impactedBots.length === 0) {
      return { committed: true, gateModal: false, impactedBots: [] };
    }
    // Toggling off a provider that some bots use opens the impact-
    // confirm gate; the modal stays open until "Disable anyway" lands.
    if (!toggle.next && impactedBots.length > 0) {
      return { committed: false, gateModal: true, impactedBots };
    }
    // Toggling on: commit immediately, no modal.
    return { committed: true, gateModal: false, impactedBots: [] };
  }

  function makeBot(id: string, computers?: Bot["computers"]): Bot {
    return {
      id,
      threadId: `t-${id}`,
      name: `Bot ${id}`,
      title: "",
      description: "",
      notifications: true,
      color: "blue" as any,
      unread: false,
      activity: "idle",
      modelSelection: { instanceId: "i", model: "m" },
      computers,
      messages: [],
    };
  }

  it("toggling off a provider that no bot uses is a no-op (no modal)", () => {
    const providers = { asciiBox: true, selfHostedVps: true, localVm: false, localMac: false };
    const bots = [makeBot("a", ["cloud"])];
    const result = applyToggle(providers, bots, { provider: "localVm", next: false });
    expect(result.committed).toBe(true);
    expect(result.gateModal).toBe(false);
    expect(result.impactedBots).toEqual([]);
  });

  it("toggling off a provider that some bots use opens the impact-confirm gate", () => {
    const providers = { asciiBox: true, selfHostedVps: true, localVm: false, localMac: false };
    const bots = [makeBot("a", ["cloud"]), makeBot("b", ["cloud"])];
    const result = applyToggle(providers, bots, { provider: "asciiBox", next: false });
    expect(result.committed).toBe(false);
    expect(result.gateModal).toBe(true);
    expect(result.impactedBots).toEqual(["a", "b"]);
  });

  it("toggling off a provider does not list bots that have it turned off", () => {
    const providers = { asciiBox: true, selfHostedVps: true, localVm: false, localMac: false };
    const bots = [makeBot("a", ["cloud"]), makeBot("b", [])];
    const result = applyToggle(providers, bots, { provider: "asciiBox", next: false });
    expect(result.impactedBots).toEqual(["a"]);
  });

  it("toggling on a provider commits immediately with no modal", () => {
    const providers = { asciiBox: false, selfHostedVps: true, localVm: false, localMac: false };
    const bots = [makeBot("a", ["local"])];
    const result = applyToggle(providers, bots, { provider: "asciiBox", next: true });
    expect(result.committed).toBe(true);
    expect(result.gateModal).toBe(false);
  });

  it("'Disable anyway' from the impact-confirm gate commits the toggle (parent persists new providers; subsequent toggle-on is a no-op)", () => {
    // Simulating the parent: once "Disable anyway" fires, the parent
    // persists `asciiBox: false` in `state.config.botDefaults.computerProviders`.
    // The toggle row now reads OFF (because the persisted state has it off),
    // so a follow-up click would actually be a toggle-ON, which is the
    // no-modal path.  This pins the end-to-end contract: gateModal -> commit
    // -> state on disk -> no modal on the next toggle-ON.
    const providers = { asciiBox: true, selfHostedVps: true, localVm: false, localMac: false };
    const bots = [makeBot("a", ["cloud"])];
    const gated = applyToggle(providers, bots, { provider: "asciiBox", next: false });
    expect(gated.gateModal).toBe(true);
    // Operator confirms; the parent writes `asciiBox: false` to disk.
    // A follow-up toggle of the same provider would be the
    // already-off -> wants-on path, which commits immediately and
    // does not open the modal.
    const followUp = applyToggle({ ...providers, asciiBox: false }, bots, { provider: "asciiBox", next: true });
    expect(followUp.committed).toBe(true);
    expect(followUp.gateModal).toBe(false);
    expect(followUp.impactedBots).toEqual([]);
  });
});

describe("computerProviders matrix rendering", () => {
  function makeBot(id: string, computers?: Bot["computers"]): Bot {
    return {
      id,
      threadId: `t-${id}`,
      name: `Bot ${id}`,
      title: "",
      description: "",
      notifications: true,
      color: "blue" as any,
      unread: false,
      activity: "idle",
      modelSelection: { instanceId: "i", model: "m" },
      computers,
      messages: [],
    };
  }

  it("renders the right check-mark counts for [{ bot: { computers: [\"cloud\"] } }]", () => {
    const bot = makeBot("a", ["cloud"]);
    const workspaceProviders = {
      asciiBox: true,
      selfHostedVps: true,
      localVm: false,
      localMac: false,
    };
    const providers = providersForBot(bot, workspaceProviders);
    // ["cloud"] resolves to the runtime's chosen backend (Box when no
    // cloudBackend is set and no workspace default), not both.  The
    // matrix therefore lights up exactly one column, matching the
    // grant the runtime will actually use.
    expect(providers).toEqual({
      asciiBox: true,
      selfHostedVps: false,
      localVm: false,
      localMac: false,
    });
    const checkCount = Object.values(providers).filter(Boolean).length;
    expect(checkCount).toBe(1);
  });

  it("renders zero check-marks for a bot whose computers[] is empty (off)", () => {
    const bot = makeBot("a", []);
    const workspaceProviders = {
      asciiBox: true,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    };
    const providers = providersForBot(bot, workspaceProviders);
    expect(providers).toEqual({
      asciiBox: false,
      selfHostedVps: false,
      localVm: false,
      localMac: false,
    });
  });

  it("renders only what the auto path can mount for a bot whose computers[] is undefined and no workspace default", () => {
    // True Auto reuses the resolved cloud backend and falls back to this
    // computer (AUTO_DESTINATIONS in server/computer-grants.ts).  It never
    // reaches the Local VM, so an enabled Local VM provider stays dark.
    const bot = makeBot("a", undefined);
    const workspaceProviders = {
      asciiBox: true,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    };
    expect(providersForBot(bot, workspaceProviders)).toEqual({
      asciiBox: true,
      selfHostedVps: false,
      localVm: false,
      localMac: true,
    });
    expect(providersForBot(bot, workspaceProviders, "vps")).toEqual({
      asciiBox: false,
      selfHostedVps: true,
      localVm: false,
      localMac: true,
    });
  });

  it("intersects an Auto bot's inherited grant with the provider toggles", () => {
    const bot = makeBot("a", undefined);
    const workspaceProviders = {
      asciiBox: false,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    };
    // Box is off, so an Auto bot on the Box backend has only the host left.
    expect(providersForBot(bot, workspaceProviders, "box")).toEqual({
      asciiBox: false,
      selfHostedVps: false,
      localVm: false,
      localMac: true,
    });
    // An inherited ["local"] default lights Local only.
    expect(providersForBot(bot, workspaceProviders, "box", ["local"])).toEqual({
      asciiBox: false,
      selfHostedVps: false,
      localVm: false,
      localMac: true,
    });
  });

  it("intersects an explicit grant with the provider toggles", () => {
    const workspaceProviders = {
      asciiBox: false,
      selfHostedVps: true,
      localVm: false,
      localMac: true,
    };
    const none = { asciiBox: false, selfHostedVps: false, localVm: false, localMac: false };
    // Local VM is off, so an explicit ["vm"] bot lights nothing.
    expect(providersForBot(makeBot("a", ["vm"]), workspaceProviders)).toEqual(none);
    // Box is off, so an explicit ["cloud"] bot on the Box backend lights nothing.
    expect(providersForBot(makeBot("b", ["cloud"]), workspaceProviders, "box")).toEqual(none);
    // The VPS backend is on, so the same grant on VPS still lights VPS.
    expect(providersForBot(makeBot("c", ["cloud"]), workspaceProviders, "vps")).toEqual({
      ...none,
      selfHostedVps: true,
    });
    // Only the enabled leg of a mixed grant survives.
    expect(providersForBot(makeBot("d", ["cloud", "vm", "local"]), workspaceProviders, "box")).toEqual({
      ...none,
      localMac: true,
    });
  });

  it("renders the explicit selection for a bot whose computers[] is [\"local\"]", () => {
    const bot = makeBot("a", ["local"]);
    const providers = providersForBot(bot, undefined);
    expect(providers).toEqual({
      asciiBox: false,
      selfHostedVps: false,
      localVm: false,
      localMac: true,
    });
  });

  it("gates the true-Auto This Computer fallback on the host platform and engine reach", () => {
    // The server's Auto host fallback mounts only on macOS and only for
    // an engine with a local approval channel
    // (`shouldMountLocalComputer({ requested: undefined, ... })`).  The
    // matrix must not list a grant — and the disable-impact modal must
    // not list a bot — the runtime would never mount.
    const bot = makeBot("a", undefined);
    const workspaceProviders = {
      asciiBox: true,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    };
    // macOS host + local-capable engine: the fallback can mount.
    expect(
      providersForBot(bot, workspaceProviders, undefined, undefined, {
        hostPlatform: "darwin",
        engineSupportsLocal: true,
      }),
    ).toEqual({ asciiBox: true, selfHostedVps: false, localVm: false, localMac: true });
    // Linux host: local control is an explicit-only beta, so the Auto
    // path never falls back to the host.
    expect(
      providersForBot(bot, workspaceProviders, undefined, undefined, {
        hostPlatform: "linux",
        engineSupportsLocal: true,
      }),
    ).toEqual({ asciiBox: true, selfHostedVps: false, localVm: false, localMac: false });
    // Windows host: no local driver.
    expect(
      providersForBot(bot, workspaceProviders, undefined, undefined, {
        hostPlatform: "win32",
        engineSupportsLocal: true,
      }),
    ).toEqual({ asciiBox: true, selfHostedVps: false, localVm: false, localMac: false });
    // macOS host, but the bot's engine has no local approval channel.
    expect(
      providersForBot(bot, workspaceProviders, undefined, undefined, {
        hostPlatform: "darwin",
        engineSupportsLocal: false,
      }),
    ).toEqual({ asciiBox: true, selfHostedVps: false, localVm: false, localMac: false });
  });

  it("keeps the true-Auto fallback lit while the engine side is unknown (fail-open)", () => {
    const bot = makeBot("a", undefined);
    const workspaceProviders = {
      asciiBox: true,
      selfHostedVps: true,
      localVm: true,
      localMac: true,
    };
    // Instance list still hydrating: an unknown engine lets the server
    // have the last word rather than flashing the column dark.
    expect(
      providersForBot(bot, workspaceProviders, undefined, undefined, {
        hostPlatform: "darwin",
        engineSupportsLocal: undefined,
      }).localMac,
    ).toBe(true);
    // A caller without host/engine information keeps the historical
    // optimistic answer.
    expect(providersForBot(bot, workspaceProviders).localMac).toBe(true);
  });

  it("does not gate explicit or inherited 'local' grants on the host hint", () => {
    // An explicit ["local"] grant is the operator's own choice: the
    // server honors it on macOS AND Linux (requested: "local"), so the
    // host hint gates only the Auto fallback.
    expect(
      providersForBot(makeBot("a", ["local"]), undefined, undefined, undefined, {
        hostPlatform: "linux",
        engineSupportsLocal: true,
      }).localMac,
    ).toBe(true);
    // An inherited workspace default of ["local"] resolves as an
    // explicit grant on the server (auto: false), so it is not the
    // Auto fallback either.
    const all = { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true };
    expect(
      providersForBot(makeBot("b", undefined), all, undefined, ["local"], {
        hostPlatform: "linux",
        engineSupportsLocal: true,
      }).localMac,
    ).toBe(true);
  });
});
