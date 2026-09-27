/** Computer grants: a bot may hold more than one computer at a time.
 *
 * The picker in Settings has always stored an ARRAY of destinations, but for
 * a long time the runtime read only `computers[0]` and the drivers mounted a
 * single MCP server named "computer" behind an `if/else if`. A bot granted
 * both a remote desktop and this machine therefore got exactly one of them,
 * silently, with the remote always winning. That is a routing decision the
 * agent should be making per task, not one the harness should make once.
 *
 * So a grant is a capability, never a preference: every granted computer is
 * mounted as its own MCP server with its own tool prefix, and the agent picks.
 * Granting only the VM means only the VM — there is no fallback to this
 * machine, by design.
 *
 * Naming is deliberately conservative. With exactly one computer the server is
 * still called "computer", so single-computer bots see the identical tool
 * surface, prompt, and allow-list they always have. Distinct names appear only
 * once a second computer is actually mounted.
 */
import { computerReach, type ComputerReach } from "./computer-capability.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";


import type { AppConfig } from "./config.ts";

/** One computer granted to a bot for one turn. Exactly one of `box` / `stdio`
 * is set: the cloud box speaks through BotFleet's REST-to-MCP adapter, while
 * host, sandbox, and VPS computers expose Cua Driver's own MCP server. */
export interface ComputerMount {
  /** MCP server name, and therefore the agent's tool prefix. */
  name: string;
  /** Human label used in the system prompt ("My VPS", "This Mac"). */
  label: string;
  kind: ComputerKind;
  box?: {
    kind?: "box";
    boxId: string;
    token: string;
    control?: { url: string; token: string };
  };
  stdio?: {
    command: string;
    args: string[];
    env: Record<string, string>;
    platform?: "darwin" | "linux" | "win32";
    generation?: string;
    scope?: "local-computer";
  };
}

export type ComputerKind = "box" | "vps" | "vm" | "local";

/** What a person can PICK, which is not the same vocabulary as what gets
 * mounted: "cloud" resolves to a hosted box or a container on their own
 * server depending on the bot's cloudBackend, so it has no mount kind of its
 * own. Keeping the two apart is what stops a destination being compared
 * against a mount kind that can never equal it. */
export type ComputerDestination = "cloud" | "vm" | "local";

/** The MCP server name each kind takes once names have to be distinct. */
const MULTI_NAMES = {
  box: "computer_box",
  vps: "computer_shared_vm",
  vm: "computer_local_vm",
  local: "computer_host",
} satisfies Record<ComputerKind, string>;

/** Label for a kind. Only the host label is platform-dependent, because the
 * agent reasons about it explicitly ("does this need macOS?"). */
export function computerLabel(kind: ComputerKind, hostPlatform: NodeJS.Platform): string {
  switch (kind) {
    case "box":
      return "ASCII.dev Box";
    case "vps":
      return "My VPS";
    case "vm":
      return "Local VM";
    case "local":
      return hostPlatform === "darwin" ? "This Mac" : "This Computer";
  }
}

/** Assign MCP server names across the granted set. One computer keeps the
 * historical name; two or more each get a distinct, self-describing one. */
export function nameMounts(mounts: ComputerMount[]): ComputerMount[] {
  if (mounts.length <= 1) return mounts.map((m) => ({ ...m, name: "computer" }));
  return mounts.map((m) => ({ ...m, name: MULTI_NAMES[m.kind] }));
}

/** True when this mount can click on the person's own desktop. Host control is
 * the one kind that routes every call through BotFleet's permission broker. */
export function isHostMount(mount: ComputerMount): boolean {
  return mount.kind === "local";
}

const SINGLE_PROMPTS = {
  vm: " You have a shared, isolated Cua sandbox: a Linux desktop in a container on this machine. Only /home/cua/workspace is durable; save downloads, repositories, working files, and browser profiles there because everything else inside the VM is disposable. No other host folder is mounted. Use the computer tools for desktop, accessibility, window, and shell work. Inspect the desktop state before acting, prefer accessibility targets over raw coordinates, and work carefully.",
  box: " You have your own cloud computer. In Chrome, prefer browser_snapshot with browser_click/browser_fill for semantic, trusted actions; use screenshot/click/type_text for visual or non-browser UI, open_url for navigation, and computer_exec for Linux tasks. Every action already returns the resulting screen, so don't follow it with screenshot; batch predictable pixel actions with computer_batch.",
  vps: " You have your own self-hosted remote Linux computer through the official Cua tools. Its filesystem is disposable: everything on it is wiped whenever its container is recreated, so keep long-lived work somewhere durable — push it to a remote, or hand the results back in chat — instead of leaving it only on that computer. Inspect the desktop state before acting, prefer accessibility targets over raw coordinates, and act carefully.",
  local: " You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully.",
} satisfies Record<ComputerKind, string>;

/** What a host grant actually puts in the engine's hands.
 *
 * An MCP engine mounts the Cua Driver server and really can see and click the
 * desktop.  A toolLoop engine mounts no MCP server at all: its host surface is
 * the harness's own `bash`, `read_file`, `write_file` and `edit_file` behind
 * the `workspaceOrHostComputer` gate in server/tools/registry.ts, and that
 * registry holds no screenshot, click or desktop-state tool.  Telling that
 * engine to read the desktop first spends its turn reaching for tools that do
 * not exist — so the sentence has to match the surface, not the grant. */
function localPrompt(toolLoopSurface: boolean): string {
  if (!toolLoopSurface) return SINGLE_PROMPTS.local;
  return (
    " You can act on the user's computer through the shell and file tools — run commands with `bash`, and read," +
    " write, and edit files by path. You have no screen on this surface: there is no screenshot, click, or" +
    " desktop-state tool, so do the work from the command line, and say so plainly if a task genuinely needs the" +
    " graphical desktop."
  );
}

/** One line per computer when several are mounted, naming the tool prefix so
 * the agent can tell them apart at the point of use. */
function multiLine(mount: ComputerMount): string {
  const tools = `\`${mount.name}\` tools (prefixed \`mcp__${mount.name}__\`)`;
  switch (mount.kind) {
    case "vm":
      return `${mount.label} — an isolated Linux desktop in a container on this machine, through the ${tools}. Only /home/cua/workspace survives a rebuild.`;
    case "box":
      return `${mount.label} — your own cloud Linux desktop, through the ${tools}. In Chrome prefer browser_snapshot with browser_click/browser_fill; use computer_exec for shell work.`;
    case "vps":
      return `${mount.label} — your own isolated, self-hosted remote Linux desktop (one container per bot, not shared with the other bots), through the ${tools}. Its filesystem is disposable, so push long-lived work to a remote instead of leaving it there.`;
    case "local":
      return `${mount.label} — the user's own machine, through the ${tools}. Every action here is brokered for the user's approval, so it is slower and more intrusive than a remote desktop.`;
  }
}

/** The selection rule, in the owner's terms: the remote desktop is the default
 * for everything, and this machine is reserved for work that genuinely needs
 * it. Both halves of the speed exception must hold — a 2x win on a short task
 * is not a reason to take over someone's desktop. */
function selectionPolicy(remote: ComputerMount, host: ComputerMount): string {
  return (
    ` Default to ${remote.label} for everything. Use ${host.label} only when the task genuinely requires it —` +
    ` Xcode, an iOS simulator, a macOS-only application, or the user's own files, credentials, and signed-in` +
    ` desktop apps — or when running on this hardware would be more than twice as fast AND would save at least` +
    ` five minutes of real time. Both conditions must hold: a 2x speedup that saves less than five minutes is` +
    ` not a reason to use ${host.label}. When you do choose ${host.label}, say so and say why.`
  );
}

/** System-prompt fragment describing the bot's computers.
 *
 * With one computer this returns exactly the text BotFleet has always sent, so
 * a single-computer bot's prompt does not move. With several it names each one
 * and states the selection rule. */
export function computerSystemPrompt(
  mounts: ComputerMount[],
  opts: {
    boxAgent?: boolean;
    hostPlatform?: NodeJS.Platform;
    /** True for a driver-loop engine, which receives HTTP tool definitions
     * rather than MCP servers.  Both dispatchers pass it, so the two lanes
     * cannot describe the same grant differently. */
    toolLoopSurface?: boolean;
  } = {},
): string {
  if (mounts.length === 0) return "";

  const protectedInput =
    " At a sign-in, password, MFA, CAPTCHA, or other protected-input step, stop and ask the user to complete it" +
    " on the visible computer. Never type their password or ask them to paste a password or one-time code into chat.";

  if (mounts.length === 1) {
    const [only] = mounts;
    // The box-native agent already runs on its box; describing the box to it
    // as a separate computer only confuses the agent about where it is.
    const body =
      only.kind === "box" && opts.boxAgent
        ? ""
        : only.kind === "local"
          ? localPrompt(opts.toolLoopSurface === true)
          : SINGLE_PROMPTS[only.kind];
    return body + protectedInput;
  }

  const host = mounts.find(isHostMount);
  const remote = mounts.find((m) => !isHostMount(m));
  const lines = mounts.map((m) => `- ${multiLine(m)}`).join("\n");
  const policy = host && remote ? selectionPolicy(remote, host) : "";
  return (
    ` You have ${mounts.length} computers, each with its own separate set of tools:\n${lines}\n` +
    `They are separate machines: a file, a browser session, or an application on one is not on the other.` +
    policy +
    protectedInput
  );
}

/** The computers a turn actually carries.
 *
 * New callers set `integrations.computers`. Anything that still builds a turn
 * with only the legacy single-computer fields — older call sites and a good
 * many tests — is normalized to the same shape here, under the historical
 * server name, so drivers have exactly one code path to implement. */
export function turnComputerMounts(integrations: {
  computers?: ComputerMount[];
  computer?: ComputerMount["box"];
  localComputer?: ComputerMount["stdio"];
} | undefined): ComputerMount[] {
  if (integrations?.computers?.length) return integrations.computers;
  if (integrations?.computer) {
    return [{ name: "computer", label: "ASCII.dev Box", kind: "box", box: integrations.computer }];
  }
  if (integrations?.localComputer) {
    const stdio = integrations.localComputer;
    // The legacy field cannot say whether a stdio computer is a sandbox, a
    // VPS, or the host — only host control carries a scope. Drivers never
    // read `kind`, so the guess only affects prompt wording for old callers.
    const kind: ComputerKind = stdio.scope === "local-computer" ? "local" : "vm";
    return [{ name: "computer", label: computerLabel(kind, process.platform), kind, stdio }];
  }
  return [];
}

/** MCP tool prefix of the granted host computer, if the bot has one.
 *
 * Approval scoping must key off the host's OWN tools, not any tool whose name
 * happens to start with "computer": clicking inside a disposable Linux
 * container is not the same act as clicking on the person's desktop, and only
 * the latter belongs behind a permission card. */
export function hostToolPrefix(mounts: ComputerMount[]): string | null {
  const host = mounts.find(isHostMount);
  return host ? `mcp__${host.name}` : null;
}


/** What the `auto` path can actually mount when nobody named a destination:
 * the cloud computer (a hosted box or the operator's own VPS) and host
 * control.  Never the Local VM — auto has never created one.  Keeping this
 * list next to the rule that reads it is what lets the allowlist gate `auto`
 * as precisely as it gates a named grant. */
const AUTO_DESTINATIONS: readonly ComputerDestination[] = ["cloud", "local"];

/** Which of the auto path's own destinations the operator still permits.
 *
 * `auto` is one flag, but the auto path mounts more than one thing — it
 * reuses or starts a cloud box or VPS, and it falls back to host control —
 * so a single boolean cannot say "discover a cloud computer, but never take
 * the desktop".  Reducing the allowlist to "is auto meaningful at all" let
 * `allowed: ["local"]` mount an existing Box, and `allowed: ["cloud"]` fall
 * through to CUA on the host when no cloud computer turned up.  Callers gate
 * each auto mount on this list, so the rule stays in one file. */
export function autoDestinations(
  allowed: ComputerDestination[] | null,
): ComputerDestination[] {
  if (allowed === null) return [...AUTO_DESTINATIONS];
  return AUTO_DESTINATIONS.filter((entry) => allowed.includes(entry));
}

/** What a bot's stored `computers` setting actually asks for.
 *
 * The setting has three states, and two of them look identical if you reach
 * for `?? []`:
 *
 *   undefined  never configured — "auto": reuse whatever already exists and,
 *              on macOS, fall back to host control.
 *   []         explicitly emptied — the Off button, or deselecting the last
 *              destination. This bot asked for NO computer.
 *   [...]      these destinations, all of them.
 *
 * Collapsing the first two answers "give this bot no computer" with the
 * person's own desktop, which is the one wrong answer available.
 *
 * The result is filtered through `allowed` — the operator-level allowlist —
 * so disabling "This Computer" once at the top of settings keeps any bot from
 * running on the host.  The allowlist is a boundary, not a preference: every
 * destination that comes back is in it, and an intersection that narrows to
 * empty is an empty grant.  That holds for a bot that was never configured
 * too, because the caller reads BOTH halves of this result — `granted` for
 * what to mount, `auto` for whether to go looking — so handing back the
 * unfiltered set with `auto: true` mounted the host on exactly the install
 * whose operator had just turned the host off. */
export function resolveGrants(
  botComputers: ComputerDestination[] | undefined,
  runOn?: string,
  workspaceDefault?: ComputerDestination[],
  allowed: ComputerDestination[] | null = null,
): { granted: ComputerDestination[]; auto: boolean } {
  // A cloud routine runs on the box whatever the bot is set to, and is never
  // auto — it named its destination.  The cloud destination is always
  // available, because the routine chose to run on the cloud in the first
  // place; the allowlist cannot retroactively un-allow a destination the
  // caller already named.
  if (runOn === "cloud") return { granted: ["cloud"], auto: false };
  // The workspace default answers "nobody has said" — it fills in for a bot
  // that was never configured, and only then. An explicitly emptied bot stays
  // off, because turning a bot's computer off should not be undone by a
  // setting made somewhere else.
  const originallyAuto = botComputers === undefined;
  let granted: ComputerDestination[];
  let auto: boolean;
  if (originallyAuto && workspaceDefault?.length) {
    granted = [...workspaceDefault];
    auto = false;
  } else {
    granted = botComputers ?? [];
    auto = originallyAuto;
  }
  if (allowed === null) return { granted, auto };
  const allowedSet = new Set(allowed);
  // Nothing outside the allowlist is ever handed back, whoever asked for it
  // and however the bot came by it.  An empty intersection is an empty grant:
  // "the operator disabled every destination this bot wanted" and "the bot
  // asked for nothing" want the same answer from the runtime, which is no
  // computer — not a quiet substitution of a destination the operator just
  // turned off.
  const filtered = granted.filter((entry) => allowedSet.has(entry));
  // The auto fallback has to clear the same bar, because it is a grant too:
  // it mounts a cloud box or VPS, or the host, without anyone naming them.
  // Leaving `auto` set while the allowlist blocks both is how an unconfigured
  // bot ended up clicking on a Mac whose operator had disabled This Computer.
  //
  // This flag only says whether auto has anywhere left to go.  WHICH of its
  // destinations survive is `autoDestinations`, and the caller gates each
  // auto mount on that — a single boolean cannot distinguish "discover a
  // cloud computer" from "take the desktop", and treating it as if it could
  // is how an allowlist of just one of the two still mounted the other.
  const autoReachable = auto && autoDestinations(allowed).length > 0;
  return { granted: filtered, auto: autoReachable };
}


/** Which cloud backend a bot uses.
 *
 * One accessor, because the answer is read in four places — the turn that
 * mounts the computer, the status endpoint, the desktop tunnel, and the
 * lifecycle actions. If the turn honored a workspace default and the status
 * endpoint did not, a bot would run on a VPS while its panel reported on a
 * hosted box it never touches. */
export function resolveCloudBackend(
  botCloudBackend: "box" | "vps" | undefined,
  workspaceDefault?: "box" | "vps",
): "box" | "vps" {
  return botCloudBackend ?? workspaceDefault ?? "box";
}

/** True only when a cloud routine must ride the Box computer engine.
 *
 * `runOn === "cloud"` grants the cloud destination; the backend still decides
 * whether that destination is Box or the operator's VPS.  Forcing boxAgent on
 * every cloud run made VPS routines die in vpsDriverError.  VPS keeps the
 * bot's own engine selection. */
export function cloudRunUsesBoxAgent(
  runOn: "bot" | "cloud" | undefined,
  botCloudBackend: "box" | "vps" | undefined,
  workspaceDefault?: "box" | "vps",
): boolean {
  return runOn === "cloud" && resolveCloudBackend(botCloudBackend, workspaceDefault) === "box";
}


/* ── Turn-time resolution ───────────────────────────────────────────────────
 *
 * Everything above answers "what was this bot granted".  What follows answers
 * "what can it actually hold for THIS turn", which is the half that has to
 * talk to the world: a Local VM has to be claimed, a VPS provisioned, a cloud
 * box woken, host control read off Cua Driver's descriptor.
 *
 * It lives here rather than inline in the dispatcher because there are two
 * dispatchers.  `startTurn` resolved all of this and a room turn resolved none
 * of it, so a bot holding Cua, a Box, a Local VM or a VPS in a direct chat
 * lost every one of them the moment it spoke in a room — while the HTTP lane
 * in that same room kept host `bash` through `hasHostComputer`.  A room is a
 * different conversation, not a different bot, so both lanes call this.
 *
 * The world arrives through `deps` rather than imports: the leases, the busy
 * flags and the message sink are the dispatcher's own state, and injecting
 * them is also what lets the policy be tested without a running harness. */

/** The bot fields a computer grant reads.  Deliberately narrow — this is a
 * capability decision, not a bot editor. */
export interface TurnComputerBot {
  id: string;
  name: string;
  computers?: ComputerDestination[];
  cloudBackend?: "box" | "vps";
  autoStartVps?: boolean;
}

/** The engine fields a computer grant reads, flattened off the adapter so a
 * test can ask a policy question without a provider instance. */
export interface TurnComputerEngine {
  driverKind: string;
  /** Can mount the full computer-use MCP surface (GUI, Local VM, VPS). */
  computerMcp: boolean;
  /** Brokers host-control asks through the harness permission broker.  The
   * rule lives in `server/contracts.ts`, and it is the only thing that makes
   * mounting the person's own desktop honest. */
  localComputerMcp: boolean;
  /** Runs the harness tool loop itself, so it has host tools without Cua. */
  toolLoop: boolean;
}

/** The one frame this resolver broadcasts: a cloud computer changing state
 * while the person waits for their turn to start. */
export interface ComputerStateFrame {
  kind: "computer";
  botId: string;
  state: "provisioning" | "waking";
}

/** One VPS or cloud-box status, in the shape this resolver reads it. */
interface RemoteComputerStatus {
  ready?: boolean;
  sshAlias?: string | null;
  container_id?: string | null;
  problem?: string | null;
}

/** What the resolver needs from the running harness.  `Lease` is the VPS turn
 * lease handle, inferred from whatever pool the dispatcher passes. */
export interface TurnComputerDeps<Lease = unknown> {
  hostPlatform: NodeJS.Platform;
  /** Cua Driver's already-running connection descriptor, or null. */
  readHostConnection(): ComputerMount["stdio"] | null;
  /** Claim the Local VM for this turn, or throw the reason it cannot be had.
   * The lease, the lifecycle busy flags and the idle backstop are the
   * dispatcher's state, so the dispatcher owns the claim. */
  acquireLocalVm(): Promise<ComputerMount["stdio"]>;
  vps: {
    vpsDriverError(driverKind: string, reach: ComputerReach): string | null;
    vpsComputerAction(action: "provision", cfg: AppConfig, botId: string): Promise<RemoteComputerStatus>;
    inspectVpsForAuto(cfg: AppConfig, botId: string): Promise<RemoteComputerStatus>;
    vpsComputerMcp(cfg: AppConfig, botId: string, containerRef?: string): { command: string; args: string[]; env: Record<string, string> };
    vpsComputerScreenshot(cfg: AppConfig, botId: string): Promise<{ png: string; format: string }>;
  };
  box: {
    boxConfigured(cfg: AppConfig): boolean;
    findBox(cfg: AppConfig, botId: string): Promise<{ id: string; state: string } | null>;
    /** The caller never reads the result — it re-finds the box afterwards,
     * so a provision that half-succeeded is still seen as it really is. */
    provisionBox(cfg: AppConfig, botId: string, botName: string): Promise<{ boxId: string }>;
    readyBox(cfg: AppConfig, botId: string): Promise<{ id: string; state: string } | null>;
    screenshotBox(cfg: AppConfig, botId: string, knownBoxId?: string): Promise<{ png: string; format: string }>;
  };
  /** The per-bot VPS turn lease, so a second turn cannot enter the same box. */
  vpsLeases: {
    claim(botId: string, threadId: string, dispatchId: number): Lease;
    release(lease: Lease): void;
  };
  /** The loopback control pair a computer bridge calls back on. */
  controlIntegration(botId: string): { url: string; token: string };
  broadcast(frame: ComputerStateFrame): void;
  /** One activity chip on the turn's own thread.  The caller shapes it,
   * because a room chip carries the speaking member and a 1:1 chip does not. */
  notice(text: string, ok: boolean): void;
  /** The dispatcher's "is this still the current turn" guard, awaited at every
   * point the inline block awaited one.  `false` means stop: a newer dispatch
   * owns the thread, or this one was cancelled. */
  checkpoint(): Promise<boolean>;
}

/** The computers one turn actually holds. */
export interface TurnComputerMounts<Lease = unknown> {
  /** Named and ready to hand to the driver. */
  mounts: ComputerMount[];
  /** A screen the harness can poll while the bot works, when this grant has
   * one.  Only the 1:1 lane starts a poller today — see the room call site. */
  previewCapture: (() => Promise<{ png: string; format: string }>) | null;
  /** A claimed VPS turn lease the caller must release when its turn settles. */
  vpsLease: Lease | undefined;
  /** True when `checkpoint()` said this turn is no longer the current one.
   * The caller abandons the turn; `mounts` is empty. */
  cancelled: boolean;
  /** `wantsLocal && localComputerMcp` — the host-tool gate both lanes hand to
   * `buildTurnTools`, kept here so the two dispatchers cannot drift.
   * Deliberately independent of `mounts`: a toolLoop engine has host tools
   * through the harness executor whether or not Cua Driver is running. */
  hasHostComputer: boolean;
}

/** Resolve every computer this bot may hold for this turn.
 *
 * Explicit destinations are strict and throw.  `auto` degrades quietly to no
 * computer, because a routine or webhook that only needs a shell must not die
 * because a desktop was unavailable. */
export interface ResolveTurnComputerMountsInput<Lease> {
  bot: TurnComputerBot;
  cfg: AppConfig;
  engine: TurnComputerEngine;
  threadId: string;
  /** This dispatch's id, so the VPS lease names the turn that took it. */
  dispatchId: number;
  /** `opts.runOn` from the dispatcher: a cloud routine names its own home. */
  runOn?: string;
  /** Whether this turn is running unattended (e.g. routine or webhook). */
  unattended?: boolean;
  /** The operator-level allowlist, already read off the config. */
  allowed: ComputerDestination[] | null;
  deps: TurnComputerDeps<Lease>;
}

export async function resolveTurnComputerMounts<Lease>(
  input: ResolveTurnComputerMountsInput<Lease>,
): Promise<TurnComputerMounts<Lease>> {
  // A refusal must not strand the VPS turn lease the resolution may already
  // have claimed.  The dispatcher used to hold that handle in its own scope
  // and release it from its own catch; now that the claim happens in here,
  // so does the release.  Watching every claim through this shim is what
  // makes it reachable on a path that threw rather than returned, and
  // `release` checks lease identity, so a newer turn's claim is never taken
  // away by a losing one.
  let claimed: Lease | undefined;
  const watched: TurnComputerDeps<Lease> = {
    ...input.deps,
    vpsLeases: {
      claim: (botId, threadId, dispatchId) => {
        claimed = input.deps.vpsLeases.claim(botId, threadId, dispatchId);
        return claimed;
      },
      release: (lease) => {
        input.deps.vpsLeases.release(lease);
        claimed = undefined;
      },
    },
  };
  try {
    return await resolveMounts({ ...input, deps: watched });
  } catch (error) {
    if (claimed !== undefined) input.deps.vpsLeases.release(claimed);
    throw error;
  }
}

async function resolveMounts<Lease>(
  input: ResolveTurnComputerMountsInput<Lease>,
): Promise<TurnComputerMounts<Lease>> {
  const { bot, cfg, engine, threadId, dispatchId, runOn, allowed, deps } = input;
  const hostPlatform = deps.hostPlatform;
  let previewCapture: (() => Promise<{ png: string; format: string }>) | null = null;
  let vpsLease: Lease | undefined;
  const mounts: ComputerMount[] = [];
  let autoVpsProblem: string | null = null;
  const stopped = (): TurnComputerMounts<Lease> => ({
    mounts: [],
    previewCapture,
    vpsLease,
    cancelled: true,
    hasHostComputer: false,
  });

  // Every destination the person granted, not just the first.  A grant is a
  // capability, not a preference: each one is resolved on its own terms below
  // and mounted with its own tools, so the agent chooses per task.  Granting
  // only the VM therefore means only the VM.
  let { granted, auto } = resolveGrants(bot.computers, runOn, cfg.botDefaults?.computers, allowed);
  // `wantsCloud` / `wantsVm` / `wantsLocal` are computed after the
  // per-provider filter below so the mount branches see the post-filter
  // grant.
  // `auto` says the bot never chose; these say where auto is still allowed to
  // look.  They are separate because the auto path mounts two different
  // things — a cloud computer and, failing that, the host — and an operator
  // who disabled only one of them meant only one of them.
  const autoAllows = new Set(autoDestinations(allowed));
  // Cloud destination (including runOn=cloud routines) resolves to ASCII.dev
  // Box or the operator's Coolify-hosted VPS via resolveCloudBackend.  runOn
  // selects the cloud *destination*; it must not override the bot/workspace
  // cloudBackend (historical bug: runOn==="cloud" hardcoded "box" and blocked VPS).
  const cloudBackend = resolveCloudBackend(bot.cloudBackend, cfg.botDefaults?.cloudBackend);
  // The redesigned Computer settings panel drives a per-provider allowlist
  // (`botDefaults.computerProviders`) on top of the legacy
  // `allowedComputers: ["cloud" | "vm" | "local"]` array.  The legacy
  // field is too coarse to distinguish ASCII.dev Box from Self-Hosted
  // VPS, so a workspace with `["cloud"]` in the legacy field AND the
  // operator's Box toggle off would otherwise let a Box-backed bot
  // continue using Box.  It cannot express "Local VM off" or "This
  // Computer off" at all — `null` means every destination is allowed —
  // so a config written with only the new shape (a provider off, the
  // legacy allowlist unrestricted) would still mount both.  Drop each
  // destination the new shape disables, for explicit grants and the Auto
  // fallback alike; a missing `computerProviders` keeps the legacy
  // behavior bit-for-bit.
  const providers = cfg.botDefaults?.computerProviders;
  if (providers) {
    if (granted.includes("cloud")) {
      const backendEnabled = cloudBackend === "box" ? providers.asciiBox === true : providers.selfHostedVps === true;
      if (!backendEnabled) granted = granted.filter((d) => d !== "cloud");
    }
    if (providers.localVm !== true) granted = granted.filter((d) => d !== "vm");
    if (providers.localMac !== true) granted = granted.filter((d) => d !== "local");
  }
  // Recompute `wantsCloud`, `wantsVm` and `wantsLocal` after the
  // per-provider filter so the mount branches below see the post-filter
  // grant.
  const wantsCloudFiltered = granted.includes("cloud");
  const wantsVm = granted.includes("vm");
  const wantsLocal = granted.includes("local");
  const autoCloudProviderEnabled = auto && autoAllows.has("cloud") && providers
    ? (cloudBackend === "box" ? providers.asciiBox === true : providers.selfHostedVps === true)
    : true;
  const autoCloud = auto && autoAllows.has("cloud") && autoCloudProviderEnabled;
  // The Auto host fallback is a grant too: with This Computer off, an
  // unconfigured bot must not reach the desktop through it.
  const autoHostProviderEnabled = providers ? providers.localMac === true : true;
  const autoHost = auto && autoAllows.has("local") && autoHostProviderEnabled;
  // One derivation for every destination — see computer-capability.ts.  The
  // names below are kept because the mount sites read as "does this turn
  // mount X", not "can this engine reach X".
  const unattendedAgy = Boolean(input.unattended && engine.driverKind === "antigravityAgent");
  const reach = computerReach({
    driverKind: engine.driverKind,
    capabilities: { computerMcp: engine.computerMcp, localComputerMcp: engine.localComputerMcp, toolLoop: engine.toolLoop },
  });
  const mountsCloudComputer = reach.box;
  const mountsLocalComputer = reach.local && !unattendedAgy;
  const hasHostComputer = Boolean(wantsLocal && mountsLocalComputer);

  // Explicit destinations are strict.  In particular, Local VM must never
  // fall through to host CUA and accidentally click on the user's Mac.
  if (wantsVm) {
    if (!reach.vm) {
      throw new Error("this model engine cannot use the Local VM — choose Claude or an ACP engine, or select another computer destination");
    }
    const stdio = await deps.acquireLocalVm();
    if (!(await deps.checkpoint())) return stopped();
    mounts.push({ name: "", label: computerLabel("vm", hostPlatform), kind: "vm", stdio });
  }
  // Deliberately not an "else": "the Local VM and this computer" is a
  // legitimate grant, and each destination resolves independently.
  if (wantsLocal) {
    // This computer is the one destination that degrades instead of refusing:
    // the safe direction is "no computer", never a different one, and a
    // routine or webhook that only needs the shell must not die because the
    // desktop is unavailable.  The chip says why the tools are missing so a
    // person can fix the cause.  Engines that broker host asks (ACP, Claude,
    // pi, codex) mount it in every mode; an engine with no approval channel
    // never does.
    const hostSupportsLocal = shouldMountLocalComputer({
      requested: "local",
      hostPlatform,
      providerSupportsLocal: true,
    });
    const cua = hostSupportsLocal && mountsLocalComputer ? deps.readHostConnection() : null;
    const unavailable = !hostSupportsLocal
      ? "local computer control is not available on this platform"
      : unattendedAgy
        ? "unattended turns with this model engine cannot broker host approvals, so BotFleet did not mount the desktop"
        : !mountsLocalComputer
          ? "this model engine has no approval channel for actions on this computer, so BotFleet did not mount it"
          : !cua && !engine.toolLoop
            ? "CUA Driver is not ready for this computer — check permissions and restart BotFleet"
            : null;
    if (unavailable) {
      deps.notice(`local computer not mounted: ${unavailable}`, false);
    } else if (cua) {
      mounts.push({ name: "", label: computerLabel("local", hostPlatform), kind: "local", stdio: cua });
    }
  }

  // A VPS is a local-agent computer mount, never a remote agent runner.
  // Explicit Cloud may prepare/start it.  Auto remains read-only unless the
  // person explicitly opted this bot into remote lifecycle actions.
  // A turn requested with `runOn: "cloud"`, or one whose ONLY granted
  // computer is cloud, fails hard if cloud is unreachable — attended or not:
  // an unattended cloud-only turn must not quietly carry on with the local
  // shell instead.  A bot that also holds a usable host computer degrades
  // gracefully so a network blip never kills the turn.  "Usable" means what
  // actually resolved above, not the grant: a Local VM or desktop that
  // mounted, or host tools a tool-loop engine really gets through
  // `hasHostComputer` (host bash and files work without CUA).  An engine
  // with no host approval channel, an unattended Antigravity turn, or an MCP
  // engine whose CUA Driver is down mounts nothing on the host, so for it
  // cloud is the only computer and a failure must say so.
  const hasUsableFallback =
    mounts.some((m) => m.kind === "vm" || m.kind === "local") || (hasHostComputer && engine.toolLoop === true);
  const shouldThrowOnCloudFailure = wantsCloudFiltered && (runOn === "cloud" || !hasUsableFallback);

  if ((wantsCloudFiltered || autoCloud) && cloudBackend === "vps") {
    const unsupported = deps.vps.vpsDriverError(engine.driverKind, reach);
    if (unsupported) {
      if (wantsCloudFiltered) {
        if (shouldThrowOnCloudFailure) throw new Error(unsupported);
        deps.notice(`VPS computer not mounted: ${unsupported}`, false);
      }
      if (autoCloud) autoVpsProblem = unsupported;
    } else {
      let remote: RemoteComputerStatus | undefined;
      try {
        // Claim inside the try so a shared-desktop contention (another bot
        // already on the single VPS) degrades like a provision failure when
        // this turn has a usable fallback, instead of aborting the whole turn.
        vpsLease = deps.vpsLeases.claim(bot.id, threadId, dispatchId);
        remote = wantsCloudFiltered || bot.autoStartVps
          ? await deps.vps.vpsComputerAction("provision", cfg, bot.id)
          : await deps.vps.inspectVpsForAuto(cfg, bot.id);
      } catch (err) {
        if (vpsLease) {
          deps.vpsLeases.release(vpsLease);
          vpsLease = undefined;
        }
        if (shouldThrowOnCloudFailure) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        deps.notice(`VPS computer not mounted: ${msg}`, false);
        autoVpsProblem = msg;
      }
      if (!(await deps.checkpoint())) return stopped();
      if (remote?.ready && remote.sshAlias) {
        const targetCfg = { ...cfg, vps: { sshAlias: remote.sshAlias } };
        const vpsMcp = deps.vps.vpsComputerMcp(targetCfg, bot.id, remote.container_id ?? undefined);
        const vpsControl = deps.controlIntegration(bot.id);
        mounts.push({
          name: "",
          label: computerLabel("vps", hostPlatform),
          kind: "vps",
          stdio: {
            ...vpsMcp,
            env: { ...vpsMcp.env, OMB_CONTROL_URL: vpsControl.url, OMB_CONTROL_TOKEN: vpsControl.token },
          },
        });
        previewCapture = () => deps.vps.vpsComputerScreenshot(targetCfg, bot.id);
      } else {
        if (vpsLease) {
          deps.vpsLeases.release(vpsLease);
          vpsLease = undefined;
        }
        const problem = remote?.problem ?? autoVpsProblem ?? "the VPS computer could not be reached";
        if (shouldThrowOnCloudFailure) {
          throw new Error(remote?.problem ?? "the VPS computer could not be created or reached");
        }
        if (!autoVpsProblem) {
          deps.notice(`VPS computer not mounted: ${problem}`, false);
        }
        // Keep the caught SSH/timeout error when the lookup threw; the
        // generic text is only for a lookup that returned no usable box.
        autoVpsProblem = problem;
      }
    }
  }

  // Cloud is also strict when explicitly selected.  Auto (unset) reuses an
  // existing cloud box, then falls back to host CUA without provisioning.
  if ((wantsCloudFiltered || autoCloud) && cloudBackend === "box" && deps.box.boxConfigured(cfg)) {
    if (!mountsCloudComputer && wantsCloudFiltered) {
      if (shouldThrowOnCloudFailure) {
        throw new Error("this model engine cannot use computer tools — choose Claude, an ACP engine, or the Computer engine");
      }
      deps.notice("cloud computer not mounted: this model engine cannot use computer tools", false);
    }
    let b = await deps.box.findBox(cfg, bot.id).catch(() => null);
    if (!(await deps.checkpoint())) return stopped();
    // Explicit Cloud and the box-native Computer engine provision on first
    // use.  Auto remains non-surprising and only reuses an existing box.
    if (!b && mountsCloudComputer && (wantsCloudFiltered || engine.driverKind === "boxAgent")) {
      deps.broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
      try {
        await deps.box.provisionBox(cfg, bot.id, bot.name);
      } catch (err) {
        if (shouldThrowOnCloudFailure) throw err;
      }
      if (!(await deps.checkpoint())) return stopped();
      b = await deps.box.findBox(cfg, bot.id).catch(() => null);
      if (!(await deps.checkpoint())) return stopped();
    }
    // an archived box answers every action with an error until it resumes —
    // wake it here, once, instead of letting the agent discover it one failed
    // tool call at a time.  Only worth the resume (~8s, and it un-pauses
    // billing) when the bot can act.
    if (b && mountsCloudComputer && !["idle", "ready", "running"].includes(b.state)) {
      deps.broadcast({ kind: "computer", botId: bot.id, state: "waking" });
      b = (await deps.box.readyBox(cfg, bot.id).catch(() => null)) ?? b;
      if (!(await deps.checkpoint())) return stopped();
    }
    if (b) {
      const known = b;
      previewCapture = () => deps.box.screenshotBox(cfg, bot.id, known.id);
      if (mountsCloudComputer) {
        mounts.push({
          name: "",
          label: computerLabel("box", hostPlatform),
          kind: "box",
          box: {
            kind: "box",
            boxId: known.id,
            token: cfg.box!.token!,
            control: deps.controlIntegration(bot.id),
          },
        });
      }
    }
  }
  if (wantsCloudFiltered && cloudBackend === "box" && !deps.box.boxConfigured(cfg)) {
    throw new Error("Cloud box is not configured — add a Box API key or choose Local VM");
  }
  if (wantsCloudFiltered && cloudBackend === "box" && !mounts.some((m) => m.kind === "box")) {
    // With the host computer also granted, fall back to it instead of
    // killing the turn; the notice says why the cloud tools are missing.
    if (shouldThrowOnCloudFailure) throw new Error("the cloud computer could not be created or reached");
    if (mountsCloudComputer) deps.notice("cloud computer not mounted: the cloud computer could not be created or reached", false);
  }

  // Auto-only host fallback.  Electron owns cua-driver/TCC attribution; the
  // harness only reads its already-running connection descriptor.
  if (
    mounts.length === 0 &&
    autoHost &&
    shouldMountLocalComputer({ requested: undefined, hostPlatform, providerSupportsLocal: mountsLocalComputer })
  ) {
    const cua = deps.readHostConnection();
    if (cua) {
      mounts.push({ name: "", label: computerLabel("local", hostPlatform), kind: "local", stdio: cua });
    }
  }
  if (autoCloud && cloudBackend === "vps" && mounts.length === 0 && autoVpsProblem) {
    const hint = bot.autoStartVps
      ? "Check the VPS connection in App Settings → Connections."
      : "Open Computer and enable Start VPS automatically, or choose Cloud to start it manually.";
    throw new Error(`${autoVpsProblem}. ${hint}`);
  }

  // Name the servers once, here, so a room turn and a direct turn hand the
  // driver byte-identical mounts.
  return { mounts: nameMounts(mounts), previewCapture, vpsLease, cancelled: false, hasHostComputer };
}

/** Hand every grant to the driver, on whichever lane resolved it.
 *
 * With one computer the server keeps its historical name, so a
 * single-computer bot's tool surface, prompt, and allow-list do not move at
 * all.  `computer` / `localComputer` stay populated with the first mount of
 * each shape for consumers that still expect exactly one computer. */
export function applyComputerMounts(
  integrations: {
    computers?: ComputerMount[];
    computer?: ComputerMount["box"];
    localComputer?: ComputerMount["stdio"];
  },
  mounts: ComputerMount[],
): void {
  if (!mounts.length) return;
  integrations.computers = mounts;
  const firstBox = mounts.find((m) => m.box);
  const firstStdio = mounts.find((m) => m.stdio);
  if (firstBox?.box) integrations.computer = firstBox.box;
  if (firstStdio?.stdio) integrations.localComputer = firstStdio.stdio;
}
