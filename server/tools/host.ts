// The harness's tool executor for one driver-owned turn.
//
// A driver that declares `capabilities.toolLoop` runs its own model-to-tool
// rounds and asks this host to actually run each call.  The host is where
// caller identity lives: `botId` and `threadId` are baked into the closure
// at dispatch, never read from the model's arguments, because this lane
// bypasses the loopback + COMMS_TOKEN hop the MCP lane uses and there is no
// second place to check who is asking.  `AgentToolCallContext` is therefore
// constructible ONLY here — nothing else in the process assembles one.
//
// The host owns no tool bodies.  `server/tools/registry.ts` says which tools
// exist and what they look like on each lane; `server/tools/agents.ts` says
// what they do, with every dependency passed in.  This file is the join:
// gate the catalog, look the call up in it, ASK IF THE RECORD SAYS TO, and
// run it with the turn's identity.
//
// That ask is the one policy decision here, and it is deliberately thin: the
// host reads `approval` off the registry record and hands the question to
// the broker.  It does not decide the answer — auto mode, always-allow, the
// guards and the unattended block all live in the same fold a CLI engine's
// request reaches.  A tool with no `approval` record never asks at all.
//
// `execute` never throws.  Every failure comes back as `{ kind: "error" }`
// with a string the MODEL reads, so a broken tool is one more thing the
// agent can reason about rather than a dead turn.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { looksSensitive } from "../auto-approve.ts";
import type {
  RequestOutcome,
  ToolArguments,
  TurnToolCall,
  TurnToolHost,
  TurnToolOutcome,
  TurnToolRuntime,
} from "../contracts.ts";
import {
  createAgentTools,
  type AgentToolCallContext,
  type AgentToolDeps,
  type AgentToolExecutor,
} from "./agents.ts";
import { createComputerTools } from "./computer.ts";
import { createJobTools, type JobToolsOptions } from "./jobs.ts";
import { TurnProcessGroups } from "./process-group.ts";
import { createGithubTools } from "./github.ts";
import { createPhoneTools } from "./phone.ts";
import { createRecallTools } from "./recall.ts";
import { createLinqTools, type LinqToolDeps } from "./linq.ts";
import type { RecallSettings } from "../recall-transport.ts";
import { harnessTool, toolsFor, type ToolApproval, type ToolGateContext } from "./registry.ts";

export type { AgentBot as TurnToolBot } from "./agents.ts";

/** The host's dependencies are exactly the agents tools' dependencies: the
 *  `/api/internal/` endpoint bodies `index.ts` exports.  Nothing here
 *  imports `index.ts`, which is what keeps the cycle broken. */
export type TurnToolHostDeps = AgentToolDeps;

export interface TurnToolHostContext {
  /** The bot whose turn this is.  Never taken from tool arguments. */
  botId: string;
  /** The thread the turn is running on — the endpoint bodies check that it
   *  belongs to the caller before they will start a peer turn or read
   *  routines. */
  threadId: string;
  /** How many peer hops deep this turn already is. */
  commsDepth: number;
  /** This bot is its section's Chief of Staff.  Gates `create_bot`, both in
   *  the catalog this host advertises (see `gate` below) and in the
   *  registry's own gate function — feeding it here is what makes the two
   *  agree. */
  chiefOfStaff?: boolean;
  /** Whether the bot has host computer tools mounted for this turn. */
  localComputer?: boolean;
  /** Whether the bot is working in an assigned workspace directory. */
  workspace?: boolean;
  /** Working directory for file and shell operations. */
  cwd?: string;
  /** When set, the file tools refuse any path whose realpath escapes this
   *  workspace root.  Passed straight through to `createComputerTools`'s
   *  `confinement` option.  A bot with a workspace but no This Computer
   *  grant is the case that needs this; a bot with This Computer has no
   *  confinement by design. */
  confinement?: { workspaceRealpath: string };
  /** Fleet recall settings, present exactly when Bot RAG is configured for
   *  this turn — carries what `createRecallTools` needs (the resolved
   *  service settings and the seat name `recall_contribute` defaults to). */
  recall?: { settings: RecallSettings; botName: string };
  /** Whether a first-party physical Android phone (USB) is mounted for this turn. */
  phone?: boolean;
  /** Whether the Linq partner-API is bound to this bot for this turn.
   *  `send_voice_message` is the only tool gated on this; the host mounts
   *  the executor only when the dispatch set the flag, so an unconfigured
   *  bot cannot accidentally burn TTS quota. */
  linq?: { settings: ReturnType<typeof import("../linq/dispatch.ts").resolveLinqBinding> };
  deps: TurnToolHostDeps;
  /** Optional dependency injection for the voice-message executor, used by
   *  tests; absent falls back to the first-party hosted TTS driver. */
  linqDeps?: Partial<LinqToolDeps>;
  /** The background job tools for this turn (jobs P1).  Present exactly when
   *  the dispatch offered them in the catalog — the same one boolean feeds
   *  both, so a job tool the model was not offered finds no executor here. */
  jobs?: Pick<JobToolsOptions, "registry" | "onComplete" | "maxWaitSeconds" | "turnId">;
  /** Job notices waiting for this turn (server/steer-queue.ts): the driver's
   *  tool loop drains them between model rounds. */
  drainNotices?: () => string[];
  /** Ceiling on model-to-tool rounds; absent = the driver's default. */
  maxRounds?: number;
  /** The harness's permission broker, already bound to this turn's bot and
   *  thread.  Absent = no broker mounted, and an ask-policy tool is refused
   *  rather than run — fail-closed, because "nobody could be asked" must
   *  never read as "nobody objected". */
  requestApproval?: TurnToolHost["requestApproval"];
}

const failed = (content: string, detail?: string): TurnToolOutcome =>
  detail ? { kind: "error", content, detail } : { kind: "error", content };

/** The `condition` values `server/tools/registry.ts` can name.  The registry
 *  cannot hold these predicates itself — it imports nothing, so anything that
 *  needs a path resolved against this turn's working directory belongs here,
 *  beside the only code that knows `cwd`. */
const APPROVAL_CONDITIONS = {
  // Same resolution `server/tools/computer.ts` applies before it opens the
  // file, so the card names the path the executor will really read and the
  // pattern list sees the resolved absolute path rather than the model's
  // own spelling of it.
  "sensitive-file-path": (args, ctx) => {
    // SAFETY: a `path` that is not a string cannot name a sensitive file, and
    // a string path is the only thing this gate has to judge.  Coercing here
    // rather than narrowing on `typeof` keeps one rule at the boundary: the
    // executor is what decides what a non-string argument means, and by the
    // time it opens anything the path has been through `String()` once.
    const path = stringArg(args.path);
    if (!path) return false;
    return looksSensitive(isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path));
  },
} satisfies Record<
  NonNullable<ToolApproval["condition"]>,
  (args: ToolArguments, ctx: { cwd?: string }) => boolean
>;

/** One model-authored argument, as text.  Empty and absent are both "no
 *  value", which is the only distinction either caller needs. */
// A tool argument is `unknown` by contract, and this is the one place that
// contract meets the executor.  Naming a narrower type here would be a claim
// about the model's output that nothing has checked.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function stringArg(argument: unknown): string {
  if (argument === null || argument === undefined) return "";
  return String(argument);
}

/** The arguments a card is built from.  A record that names a path condition
 *  gets the resolved absolute path substituted first, so the summary the
 *  person reads is the file the executor opens — a `read_file ../../.ssh/
 *  id_rsa` card that said `read_file ../../.ssh/id_rsa` would be a card
 *  about a path nobody is going to look at. */
function approvalArgs(
  args: ToolArguments,
  condition: ToolApproval["condition"],
  cwd: string | undefined,
): ToolArguments {
  // SAFETY: see `stringArg` — a value that is not a string names no path, so
  // it is passed through untouched and the executor decides what it means.
  const path = stringArg(args.path);
  if (condition !== "sensitive-file-path" || !path) return args;
  return { ...args, path: isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path) };
}

/** Production voice synthesizer.  Resolved lazily inside `tools/linq.ts`
 *  so the host module does not import `server/tts/index.ts` directly —
 *  a sibling test (`server/tools/registry.test.ts#386`) bans every
 *  `server/tools/*.ts` file from importing an `index.ts` to keep the
 *  cycle that previously duplicated the `list_bots` filter out. */

/** Build the tool host for ONE turn.  The returned host closes over the
 *  caller's identity, so nothing downstream can forge it. */
export function createTurnToolHost(ctx: TurnToolHostContext): TurnToolHost {
  // A Map, not the record itself: `call.name` is whatever the model said.
  // Every process group this turn's `bash` calls start; what is still alive
  // when the turn ends is stopped by `settle` below.
  const processGroups = new TurnProcessGroups();
  const computerTools = createComputerTools({ cwd: ctx.cwd, confinement: ctx.confinement, processGroups });
  const executors = new Map<string, AgentToolExecutor>([
    ...Object.entries(createAgentTools(ctx.deps)),
    ...Object.entries(computerTools),
    ...(ctx.recall ? Object.entries(createRecallTools({ settings: ctx.recall.settings, defaultSeat: ctx.recall.botName })) : []),
    ...(ctx.phone ? Object.entries(createPhoneTools()) : []),
    // github has no gate of its own: registry.ts's `githubEnabled` predicate
    // IS `hostComputer` (the same `localComputer` check bash uses), so
    // whether the catalog offers github_* tools and whether the host can
    // run them must stay driven by the one `localComputer` boolean —
    // a separate flag here could only drift from the registry's gate.
    ...(ctx.localComputer ? Object.entries(createGithubTools(ctx.botId)) : []),
    // Jobs run where bash runs: the turn's working folder on this host.
    ...(ctx.jobs
      ? Object.entries(
          createJobTools({
            ...ctx.jobs,
            botId: ctx.botId,
            threadId: ctx.threadId,
            cwd: ctx.cwd && existsSync(ctx.cwd) ? ctx.cwd : process.cwd(),
          }),
        )
      : []),
    ...(ctx.linq
      ? Object.entries(
          createLinqTools(
            { botId: ctx.botId, threadId: ctx.threadId },
            {
              // `ctx.linq === true` only when the dispatch actually mounted the
              // voice tool, which it does by binding this dep via the
              // production synthesizer in `server/index.ts`.  Throwing here
              // surfaces a misconfiguration loud and early; the audit doc
              // lists this as a deliberate one-edge dependency across the
              // `server/tools/` import-cycle fence.
              synthesize:
                ctx.linqDeps?.synthesize ??
                (() => {
                  throw new Error(
                    "send_voice_message fired without a synthesizer dep; the dispatch must inject one",
                  );
                }),
            },
          ),
        )
      : []),
  ]);
  const gate: ToolGateContext = {
    // The dispatch only builds a host when the agents integration is
    // mounted, so reaching this file at all means the surface is on — and
    // it mounted that integration only after checking `commsDepth` against
    // `MAX_COMMS_DEPTH`.  Re-applying the ceiling here would subtract it
    // twice and silently strip tools the model was just offered, so the
    // gate below is the SAME one `buildTurnTools` used for the catalog.
    // What it still catches is a name the catalog never contained.
    agents: true,
    commsDepth: 0,
    maxCommsDepth: Number.POSITIVE_INFINITY,
    chiefOfStaff: ctx.chiefOfStaff ?? false,
    localComputer: Boolean(ctx.localComputer),
    workspace: Boolean(ctx.workspace),
    recall: Boolean(ctx.recall),
    phone: Boolean(ctx.phone),
    // No separate TurnToolHostContext field: github rides the same
    // localComputer grant bash does (see registry.ts's githubEnabled),
    // so there is nothing new for a caller to pass in — only the gate
    // object's own `github` key needs to exist, and it derives from the
    // same boolean the executor merge above already keys off.
    github: Boolean(ctx.localComputer),
    linq: Boolean(ctx.linq),
    jobs: Boolean(ctx.jobs),
  };
  // The same gate the catalog handed the model.  A hallucinated name, or a
  // real name the model was not offered this turn, finds no executor.
  const available = new Set(toolsFor("http", gate).map((tool) => tool.name));
  const identity: AgentToolCallContext = {
    botId: ctx.botId,
    threadId: ctx.threadId,
    commsDepth: ctx.commsDepth,
  };

  return {
    maxRounds: ctx.maxRounds,
    requestApproval: ctx.requestApproval,
    drainNotices: ctx.drainNotices,
    settle() {
      // The lost-job detector: a command that returned, or was stopped,
      // while something it started kept running.  Nothing will report on
      // that process once the turn is over, so it does not outlive it.
      //
      // It covers the HTTP tool lane only, where BotFleet starts the shell.
      // A CLI engine (Claude, Codex, ACP) runs its shell inside its own
      // process tree, beside MCP servers that must outlive the turn, so a
      // sweep there cannot tell a lost job from a live server; CLI lanes get
      // BotFleet's own job tools, and their stop rules, in P2.
      void processGroups.reap();
    },
    async execute(call: TurnToolCall, runtime: TurnToolRuntime): Promise<TurnToolOutcome> {
      try {
        const executor = available.has(call.name) ? executors.get(call.name) : undefined;
        if (!executor) {
          return failed(
            `Tool ${call.name} is not available to this bot.  Call only the tools you were given.`,
            "unknown tool",
          );
        }
        // Ask BEFORE the executor runs, never after: an approval that
        // arrives once the side effect has happened is a receipt, not a
        // decision.  A tool with no `approval` record never asks at all —
        // which is every read tool that cannot reach something sensitive,
        // and the reason `list_bots` does not put a card in front of anyone.
        // A record that names a `condition` asks only when that condition
        // holds, so a read stays free until the path is a credential store.
        const approval = harnessTool(call.name)?.approval;
        const asked = approval !== undefined && approval.policy === "ask"
          ? (approval.condition
            ? APPROVAL_CONDITIONS[approval.condition](call.arguments, { cwd: ctx.cwd })
            : true)
          : false;
        if (asked && approval) {
          const cardArgs = approvalArgs(call.arguments, approval.condition, ctx.cwd);
          let summary: string;
          try {
            summary = approval.summary(cardArgs);
          } catch {
            // A summary a person cannot read is not a card worth showing,
            // but running the tool unasked is worse.  Name the tool and ask.
            summary = call.name;
          }
          const request: Parameters<typeof runtime.requestApproval>[0] = {
            tool: call.name,
            summary,
          };
          // This executor invokes bash on the host, never in a VM. Scope
          // host-computer approvals independently of the model's arguments.
          // A background job is a host shell too, under its own `job:`
          // approval namespace (server/auto-approve.ts).
          if ((call.name === "bash" || call.name === "job_start") && ctx.localComputer) request.approvalScope = "local-computer";
          const verdict: RequestOutcome = await runtime.requestApproval(request);
          if (verdict !== "allowed-once") {
            // A refusal the MODEL reads, so the turn continues and the
            // agent can say what it was stopped from doing.  `unavailable`
            // is a deny: nobody could be asked, so nothing was granted.
            return failed(
              verdict === "unavailable"
                ? `Tool ${call.name} was not run: nobody was available to approve it.  Tell the user what you wanted to do and ask them to run it.`
                : `Tool ${call.name} was not approved.  Do not retry it — tell the user what you wanted to do and why.`,
              verdict === "unavailable" ? "approval unavailable" : "denied",
            );
          }
        }
        return await executor(call, identity, runtime);
      } catch (e) {
        // The contract says a host never throws.  This is where that
        // promise is kept, so the driver's loop has one shape to handle.
        const message = e instanceof Error ? e.message : String(e);
        return failed(JSON.stringify({ error: message }), message);
      }
    },
  };
}
