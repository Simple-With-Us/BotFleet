import { describe, expect, it } from "vitest";
import {
  computerLabel,
  resolveCloudBackend,
  cloudRunUsesBoxAgent,
  autoDestinations,
  resolveGrants,
  resolveTurnComputerMounts,
  computerSystemPrompt,
  hostToolPrefix,
  nameMounts,
  turnComputerMounts,
  type ComputerMount,
  type TurnComputerDeps,
} from "./computer-grants.ts";
import type { AppConfig } from "./config.ts";
import { buildMcpServers } from "./drivers/pi.ts";
import type { SendTurnInput } from "./contracts.ts";

const stdio = (env: Record<string, string> = {}) => ({ command: "/bin/cua", args: ["mcp"], env });
const hostStdio = () => ({ ...stdio(), scope: "local-computer" as const });
const box = () => ({ kind: "box" as const, boxId: "b1", token: "t" });

const mount = (kind: ComputerMount["kind"], stdioOrBox: "stdio" | "box" = "stdio"): ComputerMount => ({
  name: "",
  label: computerLabel(kind, "darwin"),
  kind,
  ...(stdioOrBox === "box" ? { box: box() } : { stdio: kind === "local" ? hostStdio() : stdio() }),
});

describe("nameMounts", () => {
  it("keeps the historical server name when there is exactly one computer", () => {
    expect(nameMounts([mount("vps")]).map((m) => m.name)).toEqual(["computer"]);
    expect(nameMounts([mount("local")]).map((m) => m.name)).toEqual(["computer"]);
  });

  it("gives each computer a distinct, self-describing name once there are several", () => {
    expect(nameMounts([mount("vps"), mount("local")]).map((m) => m.name)).toEqual([
      "computer_shared_vm",
      "computer_host",
    ]);
    expect(nameMounts([mount("box", "box"), mount("vm")]).map((m) => m.name)).toEqual([
      "computer_box",
      "computer_local_vm",
    ]);
  });

  it("names nothing when nothing was granted", () => {
    expect(nameMounts([])).toEqual([]);
  });
});

describe("turnComputerMounts", () => {
  it("returns the granted computers when the turn carries them", () => {
    const computers = nameMounts([mount("vps"), mount("local")]);
    expect(turnComputerMounts({ computers }).map((m) => m.kind)).toEqual(["vps", "local"]);
  });

  it("normalizes a legacy single-box turn under the historical name", () => {
    const [only] = turnComputerMounts({ computer: box() });
    expect(only.name).toBe("computer");
    expect(only.kind).toBe("box");
    expect(only.box).toEqual(box());
  });

  it("reads scope to tell a legacy host computer from a legacy sandbox", () => {
    expect(turnComputerMounts({ localComputer: hostStdio() })[0].kind).toBe("local");
    expect(turnComputerMounts({ localComputer: stdio() })[0].kind).toBe("vm");
  });

  it("is empty for a turn with no computer at all", () => {
    expect(turnComputerMounts({})).toEqual([]);
    expect(turnComputerMounts(undefined)).toEqual([]);
  });
});

describe("hostToolPrefix", () => {
  it("is null when no granted computer is the person's own machine", () => {
    expect(hostToolPrefix(nameMounts([mount("vps")]))).toBeNull();
    expect(hostToolPrefix(nameMounts([mount("vps"), mount("vm")]))).toBeNull();
  });

  it("points at the host's own tools, never at a remote desktop's", () => {
    expect(hostToolPrefix(nameMounts([mount("local")]))).toBe("mcp__computer");
    // The whole point of scoping by prefix: the shared VM's tools also start
    // with "mcp__computer", and must NOT be treated as the person's desktop.
    expect(hostToolPrefix(nameMounts([mount("vps"), mount("local")]))).toBe("mcp__computer_host");
  });
});

describe("computerSystemPrompt", () => {
  it("says nothing when the bot has no computer", () => {
    expect(computerSystemPrompt([])).toBe("");
  });

  it("keeps the established wording for a single computer", () => {
    const one = computerSystemPrompt(nameMounts([mount("vps")]));
    expect(one).toContain("You have your own self-hosted remote Linux computer");
    expect(one).toContain("protected-input step");
    // no multi-computer machinery leaks into the single case
    expect(one).not.toContain("Default to");
    expect(one).not.toContain("mcp__computer_");
  });

  it("does not describe the box to the agent already running on it", () => {
    const mounts = nameMounts([mount("box", "box")]);
    expect(computerSystemPrompt(mounts, { boxAgent: true })).not.toContain("your own cloud computer");
    expect(computerSystemPrompt(mounts, { boxAgent: false })).toContain("your own cloud computer");
  });

  it("names every computer and its tool prefix when the bot holds several", () => {
    const prompt = computerSystemPrompt(nameMounts([mount("vps"), mount("local")]), {
      hostPlatform: "darwin",
    });
    expect(prompt).toContain("You have 2 computers");
    expect(prompt).toContain("mcp__computer_shared_vm__");
    expect(prompt).toContain("mcp__computer_host__");
    expect(prompt).toContain("My VPS");
    expect(prompt).toContain("This Mac");
  });

  it("states the owner's selection rule: remote by default, host only when it earns it", () => {
    const prompt = computerSystemPrompt(nameMounts([mount("vps"), mount("local")]), {
      hostPlatform: "darwin",
    });
    expect(prompt).toContain("Default to My VPS for everything");
    expect(prompt).toContain("Xcode");
    expect(prompt).toContain("twice as fast");
    expect(prompt).toContain("five minutes");
    // both halves are required — the speed exception is not a 2x-alone rule
    expect(prompt).toContain("Both conditions must hold");
  });

  it("omits the host-versus-remote rule when there is no host to choose", () => {
    const prompt = computerSystemPrompt(nameMounts([mount("vps"), mount("vm")]));
    expect(prompt).toContain("You have 2 computers");
    expect(prompt).not.toContain("Default to");
  });

  it("describes the host as a desktop only to an engine that is handed one", () => {
    // An MCP engine mounts the Cua Driver server and really can see and click
    // the desktop.  A driver-loop engine mounts no MCP server at all: its
    // host surface is the harness's own bash and file tools, and that
    // registry holds no screenshot, click or desktop-state tool.  Telling it
    // to take a screenshot first spends its turn reaching for a tool that
    // does not exist, so the sentence has to match the surface.
    const host = nameMounts([mount("local")]);
    const mcp = computerSystemPrompt(host, { hostPlatform: "darwin" });
    const toolLoop = computerSystemPrompt(host, { hostPlatform: "darwin", toolLoopSurface: true });

    expect(mcp).toContain("take a screenshot");
    expect(mcp).toContain("computer tools");

    expect(toolLoop).not.toContain("take a screenshot");
    expect(toolLoop).not.toContain("accessibility actions");
    expect(toolLoop).toContain("shell and file tools");
    expect(toolLoop).toContain("`bash`");
    // and it is told plainly that the screen is not there, so it neither
    // reaches for the missing tool nor claims it looked.
    expect(toolLoop).toContain("no screenshot, click, or desktop-state tool");
    // Both still carry the shared tail, so the flag changes the description
    // of the surface and nothing else.
    expect(toolLoop).toContain("protected-input step");
    expect(mcp).toContain("protected-input step");
  });

  it("leaves a remote computer's wording alone whatever surface the engine has", () => {
    // Only the host mount's sentence is surface-dependent.  A VPS or a Local
    // VM reaches a driver-loop engine the same way it reaches an MCP one, so
    // the flag must not rewrite those.
    for (const kind of ["vps", "vm"] as const) {
      const mounts = nameMounts([mount(kind)]);
      expect(computerSystemPrompt(mounts, { toolLoopSurface: true })).toBe(
        computerSystemPrompt(mounts, { toolLoopSurface: false }),
      );
    }
  });
});

describe("driver mounting (pi)", () => {
  // threadId and text are the only required fields, so the turn needs no cast.
  const turn = (integrations: SendTurnInput["integrations"]): SendTurnInput => ({
    threadId: "t",
    text: "hi",
    integrations,
  });

  it("mounts a single computer under the historical name", () => {
    const servers = buildMcpServers(turn({ computers: nameMounts([mount("vps")]) }));
    expect(Object.keys(servers ?? {})).toEqual(["computer"]);
  });

  it("mounts BOTH computers when a bot was granted both", () => {
    // The regression this module exists for: the drivers used an if/else if
    // keyed on one slot, so a bot holding a shared VM and this Mac silently
    // received only the VM. Access to both means two servers, not a winner.
    const servers = buildMcpServers(turn({ computers: nameMounts([mount("vps"), mount("local")]) }));
    expect(Object.keys(servers ?? {}).sort()).toEqual(["computer_host", "computer_shared_vm"]);
  });

  it("carries host scope on the host mount alone", () => {
    const servers = buildMcpServers(turn({ computers: nameMounts([mount("vps"), mount("local")]) })) ?? {};
    expect(servers.computer_host).toMatchObject({ scope: "local-computer" });
    expect(servers.computer_shared_vm).not.toHaveProperty("scope");
  });

  it("still mounts a legacy single-computer turn", () => {
    expect(Object.keys(buildMcpServers(turn({ localComputer: hostStdio() })) ?? {})).toEqual(["computer"]);
    expect(Object.keys(buildMcpServers(turn({ computer: box() })) ?? {})).toEqual(["computer"]);
  });

  it("mounts nothing when no computer was granted", () => {
    expect(buildMcpServers(turn({}))).toBeNull();
  });
});

describe("resolveGrants", () => {
  it("treats a never-configured bot as auto", () => {
    expect(resolveGrants(undefined)).toEqual({ granted: [], auto: true });
  });

  it("treats an explicitly emptied setting as NO computer, not as auto", () => {
    // The Off button, and deselecting the last destination, both store [].
    // Reading that as "unconfigured" answers "give this bot no computer"
    // with the person's own desktop — the one wrong answer available.
    expect(resolveGrants([])).toEqual({ granted: [], auto: false });
  });

  it("passes every granted destination through", () => {
    expect(resolveGrants(["cloud", "local"])).toEqual({ granted: ["cloud", "local"], auto: false });
  });

  it("sends a cloud routine to the box whatever the bot is set to", () => {
    expect(resolveGrants(["local"], "cloud")).toEqual({ granted: ["cloud"], auto: false });
    // Named its destination, so it is not auto even from an unconfigured bot.
    expect(resolveGrants(undefined, "cloud")).toEqual({ granted: ["cloud"], auto: false });
    // An Off bot still runs a cloud routine on the box: the routine says
    // where it runs, and Off is about the bot's own turns.
    expect(resolveGrants([], "cloud")).toEqual({ granted: ["cloud"], auto: false });
  });

  it("leaves an ordinary turn alone when runOn is anything else", () => {
    expect(resolveGrants(["vm"], "bot")).toEqual({ granted: ["vm"], auto: false });
    expect(resolveGrants(undefined, undefined)).toEqual({ granted: [], auto: true });
  });
});

describe("workspace defaults", () => {
  it("fills in for a bot that was never configured", () => {
    expect(resolveGrants(undefined, undefined, ["cloud", "local"])).toEqual({
      granted: ["cloud", "local"],
      auto: false,
    });
  });

  it("does NOT undo a bot that was explicitly turned off", () => {
    // Turning a bot's computer off should not be reversed by a setting made
    // somewhere else — that is the same class of surprise as Off granting
    // the host in the first place.
    expect(resolveGrants([], undefined, ["cloud", "local"])).toEqual({ granted: [], auto: false });
  });

  it("does not override a bot that chose for itself", () => {
    expect(resolveGrants(["vm"], undefined, ["cloud", "local"])).toEqual({ granted: ["vm"], auto: false });
  });

  it("leaves auto alone when no default is set", () => {
    expect(resolveGrants(undefined, undefined, [])).toEqual({ granted: [], auto: true });
    expect(resolveGrants(undefined, undefined, undefined)).toEqual({ granted: [], auto: true });
  });

  it("still sends a cloud routine to the box", () => {
    expect(resolveGrants(undefined, "cloud", ["local"])).toEqual({ granted: ["cloud"], auto: false });
  });

  it("resolves the backend the same way, and ships as box", () => {
    expect(resolveCloudBackend(undefined, undefined)).toBe("box");
    expect(resolveCloudBackend(undefined, "vps")).toBe("vps");
    expect(resolveCloudBackend("box", "vps")).toBe("box");
    expect(resolveCloudBackend("vps", "box")).toBe("vps");
  });

  it("agrees with the server's own VPS-provisioning gate for an inheriting bot", () => {
    // server/index.ts refuses to provision a VPS unless bot.autoStartVps is
    // set, once resolveCloudBackend(bot.cloudBackend, cfg.botDefaults?.cloudBackend)
    // says "vps".  SettingsPanel decided whether to SHOW that toggle with the
    // raw `bot.cloudBackend === "vps"` -- no `?? "box"`, no resolver -- so for
    // a bot that never chose a backend under a "vps" workspace default it was
    // `undefined === "vps"`, always false: the toggle the server demands never
    // rendered.  The fix routes the client through the same resolver the
    // server already uses, which is what this test pins.
    // SAFETY: this is a literal test fixture, not parsed input — the widened
    // annotation only lets `bot.cloudBackend` read as "never chosen" below.
    const bot = { cloudBackend: undefined as "box" | "vps" | undefined };
    // SAFETY: a literal test fixture; narrowing it to the union member is
    // exactly the value being asserted on, not a claim about unparsed input.
    const workspaceDefault = "vps" as const;
    expect(resolveCloudBackend(bot.cloudBackend, workspaceDefault)).toBe("vps");
    // The old client rule, restated for contrast: it never agreed with the
    // resolver for exactly this inheriting-bot case.
    const legacyClientRule = bot.cloudBackend === "vps";
    expect(legacyClientRule).toBe(false);
  });

  it("documents that runOn=cloud must not force box over cloudBackend=vps", () => {
    // resolveMounts previously did: runOn === "cloud" ? "box" : botBackend.
    // Backend choice is solely resolveCloudBackend; runOn only grants "cloud".
    expect(resolveCloudBackend("vps", undefined)).toBe("vps");
    expect(resolveCloudBackend(undefined, "vps")).toBe("vps");
  });


  it("uses boxAgent only for cloud+box, not cloud+vps", () => {
    expect(cloudRunUsesBoxAgent("cloud", "vps", undefined)).toBe(false);
    expect(cloudRunUsesBoxAgent("cloud", undefined, "vps")).toBe(false);
    expect(cloudRunUsesBoxAgent("cloud", "box", undefined)).toBe(true);
    expect(cloudRunUsesBoxAgent("cloud", undefined, undefined)).toBe(true);
    expect(cloudRunUsesBoxAgent("cloud", undefined, "box")).toBe(true);
    expect(cloudRunUsesBoxAgent("bot", "box", undefined)).toBe(false);
    expect(cloudRunUsesBoxAgent(undefined, "box", undefined)).toBe(false);
  });
});


describe("operator allowlist", () => {
  it("passes every grant through when the allowlist is absent", () => {
    // null is the shipped default: the operator has not narrowed anything,
    // so the existing behavior is preserved bit-for-bit.
    expect(resolveGrants(["cloud", "vm", "local"], undefined, undefined, null)).toEqual({
      granted: ["cloud", "vm", "local"],
      auto: false,
    });
  });

  it("filters a bot's grant through the allowlist and keeps its order", () => {
    expect(resolveGrants(["local", "vm", "cloud"], undefined, undefined, ["cloud", "vm"])).toEqual({
      granted: ["vm", "cloud"],
      auto: false,
    });
  });

  it("strips the local destination when the operator disables This Computer", () => {
    // The whole point of the toggle: globally turning off "This Computer"
    // must keep any bot from running on the host, no matter what it picked.
    expect(resolveGrants(["local"], undefined, undefined, ["cloud", "vm"])).toEqual({
      granted: [],
      auto: false,
    });
    expect(resolveGrants(["cloud", "local"], undefined, undefined, ["cloud"])).toEqual({
      granted: ["cloud"],
      auto: false,
    });
  });

  it("grants an unconfigured bot NOTHING when every default destination is blocked", () => {
    // The allowlist is narrower than the workspace default, so the
    // intersection is empty — and an empty intersection is an empty grant.
    // The bot being unconfigured changes nothing: the caller mounts whatever
    // is in `granted` and falls back to the host when `auto` is set, so the
    // old answer (the UNFILTERED default, auto: true) handed the host to the
    // one workspace whose operator had just disabled it.
    expect(resolveGrants(undefined, undefined, ["local", "vm"], ["cloud"])).toEqual({
      granted: [],
      auto: false,
    });
  });

  it("keeps auto for an unconfigured bot while the auto path is still allowed", () => {
    // Nothing to intersect here: no bot choice and no workspace default, so
    // the historical auto discovery survives — but only because the cloud
    // computer, which auto can mount, is still allowed.
    expect(resolveGrants(undefined, undefined, undefined, ["cloud"])).toEqual({
      granted: [],
      auto: true,
    });
    expect(resolveGrants(undefined, undefined, undefined, ["cloud", "vm", "local"])).toEqual({
      granted: [],
      auto: true,
    });
  });

  it("names the auto destinations individually, so a caller can gate each mount", () => {
    // `auto` is one flag over two different mounts — a cloud computer, and
    // host control as the fallback.  Collapsing the allowlist into that
    // boolean let an allowlist of ["local"] mount an existing Box, and one of
    // ["cloud"] fall through to the host when no cloud computer turned up.
    expect(autoDestinations(null)).toEqual(["cloud", "local"]);
    expect(autoDestinations(["local"])).toEqual(["local"]);
    expect(autoDestinations(["cloud"])).toEqual(["cloud"]);
    // The Local VM is not an auto destination at all: auto has never made one.
    expect(autoDestinations(["vm"])).toEqual([]);
    expect(autoDestinations(["cloud", "vm", "local"])).toEqual(["cloud", "local"]);
    expect(autoDestinations([])).toEqual([]);
  });

  it("drops auto when the allowlist blocks everything auto could mount", () => {
    // Auto mounts a cloud box/VPS or host control, never the Local VM.  An
    // allowlist of just the Local VM therefore leaves auto with nothing it is
    // permitted to reach, and letting it run anyway is the same bypass in a
    // different costume.
    expect(resolveGrants(undefined, undefined, undefined, ["vm"])).toEqual({
      granted: [],
      auto: false,
    });
    expect(resolveGrants(undefined, undefined, undefined, [])).toEqual({
      granted: [],
      auto: false,
    });
  });

  it("does not retroactively un-allow a cloud routine", () => {
    // The cloud destination is what the routine named.  The allowlist
    // describes what is allowed; the call already happened.
    expect(resolveGrants(["local"], "cloud", undefined, ["local"])).toEqual({
      granted: ["cloud"],
      auto: false,
    });
  });

  it("treats an empty allowlist as nothing is allowed", () => {
    expect(resolveGrants(["cloud", "vm"], undefined, undefined, [])).toEqual({
      granted: [],
      auto: false,
    });
    // …and a never-configured bot gets the same answer.  "The operator
    // allowed nothing" is a decision, not a gap for the auto path to fill:
    // returning the workspace default here would have mounted the very
    // destinations the empty allowlist exists to refuse.
    expect(resolveGrants(undefined, undefined, ["cloud", "local"], [])).toEqual({
      granted: [],
      auto: false,
    });
  });
});

describe("per-provider gates (computerProviders)", () => {
  // The legacy allowlist cannot say "Local VM off" or "This Computer off" —
  // null means every destination is allowed — so the per-provider shape must
  // intersect explicit grants and gate the Auto host fallback on its own.
  const engine = { driverKind: "pi", computerMcp: true, localComputerMcp: true, toolLoop: false };
  const cfgWith = (providers?: Record<string, boolean>) =>
    ({ botDefaults: providers ? { computerProviders: providers } : {} }) as unknown as AppConfig;
  const makeDeps = () =>
    ({
      hostPlatform: "darwin" as NodeJS.Platform,
      readHostConnection: () => ({ command: "/bin/cua", args: ["mcp"], env: {} }),
      acquireLocalVm: async () => ({ command: "/bin/vm", args: ["mcp"], env: {} }),
      vps: {
        vpsDriverError: () => "no vps",
        vpsComputerAction: async () => ({}),
        inspectVpsForAuto: async () => ({}),
        vpsComputerMcp: () => ({ command: "/bin/vps", args: ["mcp"], env: {} }),
        vpsComputerScreenshot: async () => ({ png: "", format: "png" }),
      },
      box: {
        boxConfigured: () => false,
        findBox: async () => null,
        provisionBox: async () => ({ boxId: "b1" }),
        readyBox: async () => null,
        screenshotBox: async () => ({ png: "", format: "png" }),
      },
      vpsLeases: { claim: () => ({}), release: () => {} },
      controlIntegration: () => ({ url: "http://localhost", token: "t" }),
      broadcast: () => {},
      notice: () => {},
      checkpoint: async () => true,
    }) satisfies TurnComputerDeps<object>;

  it("mounts the Local VM and host unchanged when the per-provider shape is absent", async () => {
    // Upgrade path: a config written before the toggles existed has no
    // `computerProviders`, and the legacy allowlist alone decides.
    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Bot", computers: ["vm", "local"] },
      cfg: cfgWith(),
      engine,
      threadId: "t1",
      dispatchId: 1,
      allowed: null,
      deps: makeDeps(),
    });
    expect(result.mounts.map((m) => m.kind)).toEqual(["vm", "local"]);
    expect(result.hasHostComputer).toBe(true);
  });

  it("drops the Local VM leg when its provider is off, even with the legacy allowlist unrestricted", async () => {
    let vmClaims = 0;
    const deps = makeDeps();
    deps.acquireLocalVm = async () => {
      vmClaims++;
      return { command: "/bin/vm", args: ["mcp"], env: {} };
    };
    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Bot", computers: ["vm"] },
      cfg: cfgWith({ asciiBox: true, selfHostedVps: true, localVm: false, localMac: true }),
      engine,
      threadId: "t1",
      dispatchId: 1,
      allowed: null,
      deps,
    });
    expect(result.mounts).toEqual([]);
    expect(vmClaims).toBe(0);
  });

  it("drops the host leg when This Computer is off, even with the legacy allowlist unrestricted", async () => {
    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Bot", computers: ["local"] },
      cfg: cfgWith({ asciiBox: true, selfHostedVps: true, localVm: true, localMac: false }),
      engine,
      threadId: "t1",
      dispatchId: 1,
      allowed: null,
      deps: makeDeps(),
    });
    expect(result.mounts).toEqual([]);
    expect(result.hasHostComputer).toBe(false);
  });

  it("keeps the Auto fallback off the host when This Computer is off", async () => {
    // An unconfigured bot never named the host, but Auto discovers it — so
    // the toggle must gate the fallback too, or an explicit "off" mounts the
    // desktop anyway.
    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Bot" },
      cfg: cfgWith({ asciiBox: true, selfHostedVps: true, localVm: true, localMac: false }),
      engine,
      threadId: "t1",
      dispatchId: 1,
      allowed: null,
      deps: makeDeps(),
    });
    expect(result.mounts.map((m) => m.kind)).not.toContain("local");
    expect(result.hasHostComputer).toBe(false);
  });
});

describe("routine failure resiliency and unattended safety", () => {
  const makeBaseDeps = (notices: string[] = []) =>
    ({
      hostPlatform: "darwin" as NodeJS.Platform,
      readHostConnection: () => ({ command: "/bin/cua", args: ["mcp"], env: {} }),
      acquireLocalVm: async () => ({ command: "/bin/vm", args: ["mcp"], env: {} }),
      vps: {
        vpsDriverError: () => null,
        vpsComputerAction: async () => ({ ready: true, sshAlias: "coolify", container_id: "c1" }),
        inspectVpsForAuto: async () => ({ ready: true, sshAlias: "coolify", container_id: "c1" }),
        vpsComputerMcp: () => ({ command: "/bin/vps", args: ["mcp"], env: {} }),
        vpsComputerScreenshot: async () => ({ png: "", format: "png" }),
      },
      box: {
        boxConfigured: (): boolean => false,
        findBox: async () => null,
        provisionBox: async () => ({ boxId: "b1" }),
        readyBox: async () => null,
        screenshotBox: async () => ({ png: "", format: "png" }),
      },
      vpsLeases: { claim: () => ({}), release: () => {} },
      controlIntegration: () => ({ url: "http://localhost", token: "t" }),
      broadcast: () => {},
      notice: (msg: string) => {
        notices.push(msg);
      },
      checkpoint: async () => true,
    }) satisfies TurnComputerDeps<object>;

  it("does not mount local desktop for unattended Antigravity turns and emits notice", async () => {
    const notices: string[] = [];
    const deps = makeBaseDeps(notices);
    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Plumber", computers: ["local"] },
      cfg: {} as AppConfig,
      engine: { driverKind: "antigravityAgent", computerMcp: true, localComputerMcp: true, toolLoop: false },
      threadId: "t1",
      dispatchId: 1,
      unattended: true,
      allowed: null,
      deps,
    });
    expect(result.mounts.map((m) => m.kind)).not.toContain("local");
    expect(result.hasHostComputer).toBe(false);
    expect(notices).toContain(
      "local computer not mounted: unattended turns with this model engine cannot broker host approvals, so BotFleet did not mount the desktop",
    );
  });

  it("mounts local desktop for attended Antigravity turns", async () => {
    const notices: string[] = [];
    const deps = makeBaseDeps(notices);
    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Plumber", computers: ["local"] },
      cfg: {} as AppConfig,
      engine: { driverKind: "antigravityAgent", computerMcp: true, localComputerMcp: true, toolLoop: false },
      threadId: "t1",
      dispatchId: 1,
      unattended: false,
      allowed: null,
      deps,
    });
    expect(result.mounts.map((m) => m.kind)).toContain("local");
    expect(result.hasHostComputer).toBe(true);
    expect(notices).toEqual([]);
  });

  it("mounts local desktop for unattended Claude turns", async () => {
    const notices: string[] = [];
    const deps = makeBaseDeps(notices);
    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "ClaudeBot", computers: ["local"] },
      cfg: {} as AppConfig,
      engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
      threadId: "t1",
      dispatchId: 1,
      unattended: true,
      allowed: null,
      deps,
    });
    expect(result.mounts.map((m) => m.kind)).toContain("local");
    expect(result.hasHostComputer).toBe(true);
    expect(notices).toEqual([]);
  });

  it("gracefully degrades when VPS inspect throws on a local turn (runOn !== 'cloud')", async () => {
    const notices: string[] = [];
    const deps = makeBaseDeps(notices);
    deps.vps.vpsComputerAction = async () => {
      throw new Error("Docker-over-SSH command timed out");
    };
    deps.vps.inspectVpsForAuto = async () => {
      throw new Error("Docker-over-SSH command timed out");
    };

    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Compiler", computers: ["cloud", "local"], cloudBackend: "vps" },
      cfg: {} as AppConfig,
      engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
      threadId: "t1",
      dispatchId: 1,
      runOn: undefined,
      allowed: null,
      deps,
    });

    expect(result.mounts.map((m) => m.kind)).toEqual(["local"]);
    expect(notices).toContain("VPS computer not mounted: Docker-over-SSH command timed out");
  });

  it("throws when VPS inspect throws on an explicit cloud turn (runOn === 'cloud')", async () => {
    const notices: string[] = [];
    const deps = makeBaseDeps(notices);
    deps.vps.vpsComputerAction = async () => {
      throw new Error("Docker-over-SSH command timed out");
    };

    await expect(
      resolveTurnComputerMounts({
        bot: { id: "b1", name: "Compiler", computers: ["cloud", "local"], cloudBackend: "vps" },
        cfg: {} as AppConfig,
        engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
        threadId: "t1",
        dispatchId: 1,
        runOn: "cloud",
        allowed: null,
        deps,
      }),
    ).rejects.toThrow("Docker-over-SSH command timed out");
  });

  it("gracefully degrades when VPS returns ready: false with a problem on a local turn", async () => {
    const notices: string[] = [];
    const deps = makeBaseDeps(notices);
    deps.vps.vpsComputerAction = async () =>
      ({ ready: false, problem: "VPS container is stopped" }) as unknown as Awaited<
        ReturnType<typeof deps.vps.vpsComputerAction>
      >;

    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Monitor", computers: ["cloud", "local"], cloudBackend: "vps" },
      cfg: {} as AppConfig,
      engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
      threadId: "t1",
      dispatchId: 1,
      runOn: undefined,
      allowed: null,
      deps,
    });

    expect(result.mounts.map((m) => m.kind)).toEqual(["local"]);
    expect(notices).toContain("VPS computer not mounted: VPS container is stopped");
  });
  it("fails a cloud failure when the host grant mounted nothing (MCP engine, CUA down)", async () => {
    const deps: TurnComputerDeps<object> = { ...makeBaseDeps(), readHostConnection: () => null };
    deps.vps.vpsComputerAction = async () => {
      throw new Error("Docker-over-SSH command timed out");
    };

    await expect(
      resolveTurnComputerMounts({
        bot: { id: "b1", name: "Compiler", computers: ["cloud", "local"], cloudBackend: "vps" },
        cfg: {} as AppConfig,
        engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
        threadId: "t1",
        dispatchId: 1,
        runOn: undefined,
        allowed: null,
        deps,
      }),
    ).rejects.toThrow("Docker-over-SSH command timed out");
  });

  it("degrades a cloud failure onto an acquired Local VM", async () => {
    const notices: string[] = [];
    const deps = makeBaseDeps(notices);
    deps.vps.vpsComputerAction = async () => {
      throw new Error("Docker-over-SSH command timed out");
    };

    const result = await resolveTurnComputerMounts({
      bot: { id: "b1", name: "Compiler", computers: ["cloud", "vm"], cloudBackend: "vps" },
      cfg: {} as AppConfig,
      engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
      threadId: "t1",
      dispatchId: 1,
      runOn: undefined,
      allowed: null,
      deps,
    });

    expect(result.mounts.map((m) => m.kind)).toEqual(["vm"]);
    expect(notices).toContain("VPS computer not mounted: Docker-over-SSH command timed out");
  });

  it("fails clearly when an unattended cloud-only turn cannot reach the VPS", async () => {
    const deps = makeBaseDeps();
    deps.vps.vpsComputerAction = async () => {
      throw new Error("Docker-over-SSH command timed out");
    };

    await expect(
      resolveTurnComputerMounts({
        bot: { id: "b1", name: "Routine", computers: ["cloud"], cloudBackend: "vps" },
        cfg: {} as AppConfig,
        engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
        threadId: "t1",
        dispatchId: 1,
        runOn: undefined,
        unattended: true,
        allowed: null,
        deps,
      }),
    ).rejects.toThrow("Docker-over-SSH command timed out");
  });

  it("falls back to the host computer when the cloud box cannot be created", async () => {
    for (const provisionFails of [true, false]) {
      const notices: string[] = [];
      const deps = makeBaseDeps(notices);
      deps.box.boxConfigured = () => true;
      deps.box.findBox = async () => null;
      deps.box.provisionBox = async () => {
        if (provisionFails) throw new Error("Box API returned 503");
        return { boxId: "b1" };
      };

      const result = await resolveTurnComputerMounts({
        bot: { id: "b1", name: "Compiler", computers: ["cloud", "local"], cloudBackend: "box" },
        cfg: { box: { token: "t" } } as unknown as AppConfig,
        engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
        threadId: "t1",
        dispatchId: 1,
        runOn: undefined,
        allowed: null,
        deps,
      });

      expect(result.mounts.map((m) => m.kind)).toEqual(["local"]);
      expect(notices).toContain("cloud computer not mounted: the cloud computer could not be created or reached");
    }
  });

  it("fails clearly when an unattended Antigravity turn's cloud fails, since its local grant never mounts", async () => {
    for (const cloudBackend of ["vps", "box"] as const) {
      const deps = makeBaseDeps();
      deps.vps.vpsComputerAction = async () => {
        throw new Error("Docker-over-SSH command timed out");
      };
      deps.box.boxConfigured = () => true;
      deps.box.provisionBox = async () => {
        throw new Error("Box API returned 503");
      };

      await expect(
        resolveTurnComputerMounts({
          bot: { id: "b1", name: "Agy", computers: ["cloud", "local"], cloudBackend },
          cfg: { box: { token: "t" } } as unknown as AppConfig,
          engine: { driverKind: "antigravityAgent", computerMcp: true, localComputerMcp: true, toolLoop: false },
          threadId: "t1",
          dispatchId: 1,
          runOn: undefined,
          unattended: true,
          allowed: null,
          deps,
        }),
      ).rejects.toThrow(cloudBackend === "vps" ? "Docker-over-SSH command timed out" : "Box API returned 503");
    }
  });

  it("still fails a cloud-only box turn when the box cannot be created", async () => {
    const deps = makeBaseDeps();
    deps.box.boxConfigured = () => true;
    deps.box.provisionBox = async () => {
      throw new Error("Box API returned 503");
    };

    await expect(
      resolveTurnComputerMounts({
        bot: { id: "b1", name: "Compiler", computers: ["cloud"], cloudBackend: "box" },
        cfg: { box: { token: "t" } } as unknown as AppConfig,
        engine: { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false },
        threadId: "t1",
        dispatchId: 1,
        runOn: undefined,
        unattended: true,
        allowed: null,
        deps,
      }),
    ).rejects.toThrow("Box API returned 503");
  });
});
