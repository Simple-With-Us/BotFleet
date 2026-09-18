import { describe, expect, it } from "vitest";
import {
  computerLabel,
  resolveCloudBackend,
  cloudRunUsesBoxAgent,
  autoDestinations,
  resolveGrants,
  computerSystemPrompt,
  hostToolPrefix,
  nameMounts,
  turnComputerMounts,
  type ComputerMount,
} from "./computer-grants.ts";
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
    expect(resolveGrants(["vm"], "maus")).toEqual({ granted: ["vm"], auto: false });
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

  it("uses Box's Computer engine only when runOn=cloud and the resolved backend is Box", () => {
    // startTurn / interrupt / boxToken pending previously keyed only on
    // runOn==="cloud", which forced boxAgent onto a VPS Housekeeper and
    // then died in vpsDriverError.  The same predicate now decides the
    // engine AND whether a missing Box API key can block the turn.
    expect(cloudRunUsesBoxAgent("cloud", "vps")).toBe(false);
    expect(cloudRunUsesBoxAgent("cloud", "vps", "box")).toBe(false);
    expect(cloudRunUsesBoxAgent("cloud", "box")).toBe(true);
    expect(cloudRunUsesBoxAgent("cloud", "box", "vps")).toBe(true);
    expect(cloudRunUsesBoxAgent("cloud", undefined)).toBe(true);
    expect(cloudRunUsesBoxAgent("cloud", undefined, "box")).toBe(true);
    expect(cloudRunUsesBoxAgent("cloud", undefined, "vps")).toBe(false);
    expect(cloudRunUsesBoxAgent("maus", "box")).toBe(false);
    expect(cloudRunUsesBoxAgent("maus", "vps")).toBe(false);
    expect(cloudRunUsesBoxAgent(undefined, "box")).toBe(false);
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
