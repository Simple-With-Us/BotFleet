// Auto mode: when a bot may answer its own permission requests.
//
// Two ways in — the bot is in auto mode, or the user pressed "Always
// allow" for that one tool — and one way out: anything that reads as
// destructive stops and asks a human anyway.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
  // Pipe a fetch into a shell.  Auto / Always-allow must never cover
  // `curl | sh` or `wget | bash`.
  /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?((ba)?sh|bash|zsh|fish|ksh)\b/i,
  // Pipe a fetch into an interpreter that reads the PROGRAM from stdin
  // (`curl | python3`, `curl | node`).  `python3 -c` / `node -e` keep the
  // program inline, so the pipe is data — JSON parse, jq-style filters.
  /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(python3?|perl|ruby|node)(?!\s+-[ceE])\b/i,
  // The same download-and-run spelled without a pipe: `bash -c "$(curl …)"`,
  // `eval "$(wget …)"`, `sh <(curl …)`, `source <(curl …)`.  A plain
  // `echo "$(curl …)"` captures the output without running it and stays out.
  /(^|[\s;&|(])(sudo\s+)?((ba|z|da|k|c|tc)?sh|fish|eval|exec)\s+(-[a-zA-Z]+\s+)*["']?\$\(\s*(curl|wget)\b/i,
  /(^|[\s;&|(])(sudo\s+)?((ba|z|da|k|c|tc)?sh|fish|source|\.)\s+(-[a-zA-Z]+\s+)*<\(\s*(curl|wget)\b/i,
];

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
const SENSITIVE = [
  /(^|[\s/"'])\.env(\.|$|["'\s])/i,
  /\.ssh\/|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws\/credentials|\.netrc|\.npmrc|\.pypirc|\.docker\/config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
  // BotFleet's own state is a credential store too, and it was the one
  // place the list above missed: config.json holds every provider key, and
  // a bot that can `cat` it has the whole fleet.  The data directory is
  // `~/.botfleet` by default, or OMB_DATA_DIR on a test or soak rig — both
  // named here rather than imported, because this file stays free of
  // imports.  The app-owned workspaces live under that same directory
  // (server/workspace.ts), so they are covered by it.
  /(^|[\s/"'])\.botfleet([/\\]|$|["'\s])/i,
  // The desktop's OS-encrypted credential document (safeStorage), which is
  // where every packaged-app key actually lands.
  /\bcredentials\.bin\b/i,
  ...(process.env.OMB_DATA_DIR
    ? [new RegExp(`(^|[\\s/"'])${process.env.OMB_DATA_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([/\\\\]|$|["'\\s])`, "i")]
    : []),
];

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

export function looksSensitive(text: string): boolean {
  // Every pattern above is written with `/`, because that is how the list
  // reads and how it was written.  A path that came back from `path.resolve`
  // on Windows is spelled with `\`, so `.ssh\config` matched nothing and a
  // Windows turn could read a key without being asked.  Normalise once here
  // rather than teaching each pattern about both separators.
  const normalized = text.replace(/\\/g, "/");
  // Bot workspaces live under ~/.botfleet/workspaces/<botId>/.
  // Reading/writing files inside a bot's own workspace (such as MEMORY.md
  // or memory/*.md) is standard bot desk work, not unauthorized access to
  // the ~/.botfleet credentials store.
  if (
    /(^|[\s/"'])\.botfleet\/workspaces([/\\]|$|["'\s])/i.test(normalized) &&
    !/(^|[\s/"'])\.botfleet\/(config\.json|credentials\.bin|backups|\.secrets|[a-z0-9_-]+\.once)/i.test(normalized)
  ) {
    const nonStoreRules = SENSITIVE.filter(
      (r) => !r.source.includes("botfleet") && !r.source.includes("credentials\\.bin"),
    );
    return matchFirst(nonStoreRules, normalized) !== null;
  }
  return matchFirst(SENSITIVE, normalized) !== null;
}

export function looksDestructive(text: string): boolean {
  return matchFirst(DESTRUCTIVE, text) !== null;
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal"]);

/** Background job tools (jobs P1).  Their grants live in a namespace of their
 *  own, `job:<program>`, so a remembered `Bash:git` never starts a job, and
 *  the owner ruled (2026-10-01, and again 2026-10-02) that every job start
 *  asks unless the bot is in Auto mode — so a `job:` key is never remembered
 *  at all. */
const JOB_TOOLS = new Set(["job_start"]);

export function isJobTool(tool: string): boolean {
  return JOB_TOOLS.has(tool.replace(/^mcp__.+?__/, "").toLowerCase());
}

/** The unprefixed name of the harness's own job tool, as its HTTP tool lane
 *  offers it to a bot (server/tools/registry.ts).  A name alone never makes a
 *  request the harness's own: a Codex bot reports a third-party MCP tool by
 *  its bare name too (server/drivers/codex.ts), so `job_start` from a mounted
 *  server arrives spelled exactly the same.  Whose call it is comes from where
 *  the request was raised, see `isOwnJobStartRequest`. */
export function isOwnJobStart(tool: string): boolean {
  return tool === "job_start";
}

/** The harness's own `job_start`, decided by ORIGIN: the request is one the
 *  in-process tool host opened on the permission broker
 *  (server/tools/approvals.ts, server/tools/host.ts).  That is the only way
 *  the harness raises a job start in P1, and no engine and no third-party MCP
 *  server can open a request there.  This, and only this, is the call the
 *  owner's ruling covers; a tool a mounted server happens to call `job_start`
 *  keeps every guard that any other MCP tool has.  The MCP lane (jobs P2) has
 *  its own endpoint and must raise its asks the same way, on the broker, to be
 *  counted here.  Read it synchronously from the `request.opened` handler: the
 *  broker registers an ask before it publishes the event, and settles it only
 *  after the event has been handled. */
export function isOwnJobStartRequest(
  broker: { isOpen(threadId: string, requestId: string): boolean },
  event: { tool: string; threadId: string; requestId?: string },
): boolean {
  return isOwnJobStart(event.tool) && Boolean(event.requestId) && broker.isOpen(event.threadId, event.requestId!);
}

/** The program a job summary (`job: pnpm test`) starts, by the same rule a
 *  command tool's key uses: the first bare word, past env assignments and
 *  sudo. */
function firstProgram(command: string): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === "sudo")) i += 1;
  return (words[i] ?? "").split("/").pop()?.replace(/[^\w.-]/g, "") ?? "";
}

/** A job summary whose command was cut to fit the card.  The cut tail is
 *  unseen, so nothing may approve it but a person. */
function truncatedJobSummary(summary: string): boolean {
  return summary.endsWith("…");
}

export function approvalKey(tool: string, summary: string, scope?: "local-computer" | "disposable-computer"): string {
  const bare = tool.replace(/^mcp__.+?__/, "").toLowerCase();
  if (JOB_TOOLS.has(bare)) {
    const program = firstProgram(summary.replace(/^job:\s*/, ""));
    const key = program ? `job:${program}` : "job";
    return scope === "local-computer" ? `${scope}:${key}` : key;
  }
  if (!COMMAND_TOOLS.has(bare)) return scope === "local-computer" ? `${scope}:${tool}` : tool;
  // first bare word of the command, skipping env assignments and sudo
  const words = summary.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || words[i] === "sudo")) i += 1;
  const program = (words[i] ?? "").split("/").pop()?.replace(/[^\w.-]/g, "") ?? "";
  const key = program ? `${tool}:${program}` : tool;
  return scope === "local-computer" ? `${scope}:${key}` : key;
}

/** A summary is not the command. Claude/ACP currently cap it at 200
 * characters and HTTP bash at 160. Refuse automatic decisions when it may
 * be truncated, or when a shell has more than one operation. This is a
 * temporary fail-closed guard until drivers carry full permission input. */
function unsafeCommandSummary(tool: string, summary: string): boolean {
  const bare = tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (!COMMAND_TOOLS.has(bare)) return false;
  if (summary.length >= 160) return true;
  // Conservative on purpose: shell metacharacters inside quoted strings
  // also require a card. A card is safer than guessing a shell grammar.
  return /[;&|`\n\r]|\$\(|[<>]/.test(summary);
}

/** Program names that run whatever follows them.  An Always-allow keyed on
 * one of these is the bare "Bash" grant in disguise — `Bash:bash` covers
 * `bash -c <anything>`, `Bash:env` covers `env sh -c …` — so it is never
 * remembered there, and a stored local-scoped one is ignored.  On a
 * disposable remote computer the same key is the right width. */
const COARSE_PROGRAMS = new Set([
  "sh", "bash", "zsh", "fish", "ksh", "dash", "csh", "tcsh",
  "eval", "exec", "source", ".", "env", "xargs", "nohup", "command", "builtin", "time", "timeout", "nice", "su",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
]);

/** True when remembering this key would hand the bot an unattended shell:
 * a command tool with no program at all, or one whose program is itself a
 * command runner.  Non-command tools (`Read`, `mcp__x__search`) are never
 * coarse — their key is the whole tool, which is what "always allow" means
 * for them. */
export function isCoarseApprovalKey(key: string): boolean {
  const unscoped = key.startsWith("local-computer:") ? key.slice("local-computer:".length) : key;
  // A remembered job grant would start background work with nobody asked,
  // which ruling (c) forbids for every bot not in Auto mode.
  if (unscoped === "job" || unscoped.startsWith("job:")) return true;
  const colon = unscoped.indexOf(":");
  const tool = colon === -1 ? unscoped : unscoped.slice(0, colon);
  if (!COMMAND_TOOLS.has(tool.replace(/^mcp__.+?__/, "").toLowerCase())) return false;
  if (colon === -1) return true;
  const program = unscoped.slice(colon + 1).toLowerCase();
  return program === "" || COARSE_PROGRAMS.has(program);
}

/** Whether Always-allow must refuse this coarse key. Native shell asks
 * are host-capable even when no computer is mounted; only explicitly named
 * remote-computer MCP calls can keep a coarse grant. */
export function coarseAlwaysAllowRefused(
  key: string,
  context?: { scope?: "local-computer" | "disposable-computer" },
): boolean {
  if (!isCoarseApprovalKey(key)) return false;
  const unscoped = key.startsWith("local-computer:") ? key.slice("local-computer:".length) : key;
  if (unscoped === "job" || unscoped.startsWith("job:")) return true;
  if (key.startsWith("local-computer:")) return true;
  if (context?.scope === "local-computer") return true;
  // A native Bash/shell ask runs in the provider process on the host even
  // when no computer MCP server is mounted. An absent scope is not proof
  // of disposable execution. Only a named remote MCP computer can carry a
  // coarse key without becoming a remembered host-shell grant.
  const tool = key.split(":", 1)[0]!;
  return !/^mcp__computer_(?:shared_vm|local_vm|box)__/.test(tool) &&
    !(context?.scope === "disposable-computer" && /^mcp__computer__/.test(tool));
}

/** Decides whether an approval card should offer the user "Always allow".
 *
 * If an action is destructive, accesses sensitive credentials, or is a bare
 * shell runner (`bash:bash`, `sh`, `zsh`, `eval`, `env`), "Always allow" is
 * either refused server-side or dangerously wide. In those cases, we omit the
 * option from the UI so users are never misled into attempting blanket grants. */
export function offerableApprovalKey(
  tool: string,
  summary: string,
  scope?: "local-computer" | "disposable-computer",
): string | undefined {
  if (scope === "local-computer") return undefined;
  // every job start asks (ruling c): there is no grant to offer
  if (isJobTool(tool)) return undefined;
  if (looksDestructive(summary) || looksDestructive(tool)) return undefined;
  if (looksSensitive(summary)) return undefined;
  const key = approvalKey(tool, summary, scope);
  if (coarseAlwaysAllowRefused(key, { scope })) return undefined;
  return key;
}

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "unattended-block"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  | "no-grant";

export interface AutoVerdict {
  /** Chip text when the bot may answer itself, null when a human decides.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** The request is the harness's own `job_start`, by origin: the in-process
     *  tool host opened it on the permission broker (`isOwnJobStartRequest`).
     *  The tool name alone is not enough, since an engine reports a mounted
     *  MCP server's tool by its bare name too.  Only the job-start ruling
     *  reads it. */
    ownJobStart?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer" | "disposable-computer";
  },
): AutoVerdict {
  // Owner ruling, 2026-10-01 and applied literally 2026-10-02: a bot in full
  // auto never gets an approval card for the harness's own `job_start`.  It
  // stands ahead of everything below on purpose, so no guard and no kind of
  // turn can turn it back into a card: not the destructive and sensitive
  // patterns, not the cut-summary check, and not the unattended block, so a
  // turn a webhook, a resource alert, a text or a job's own wake started
  // starts its job too.  The ruling is about this one tool, and "own" is
  // decided by where the request came from (`context.ownJobStart`), with the
  // name as a second lock, never by the name alone: a mounted MCP server's
  // `job_start` reaches here spelled the same on Codex, and it keeps every
  // guard.  Bash and every other tool keep all of theirs, and a bot that is
  // not in full auto falls through to the checks below, where a job start is
  // never granted and a card is the only way in.
  if (bot.autoApprove && context?.ownJobStart === true && isOwnJobStart(tool)) {
    const key = approvalKey(tool, summary, context.scope);
    return { approve: `auto-approved ${key}`, source: "auto-mode", rule: key };
  }
  // the guards outrank the grants, so an "always allow" can never widen
  // into them
  const destructive = matchFirst(DESTRUCTIVE, summary) ?? matchFirst(DESTRUCTIVE, tool);
  const sensitive = destructive ? null : looksSensitive(summary) ? (matchFirst(SENSITIVE, summary) ?? "sensitive-file") : null;
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const key = approvalKey(tool, summary, context?.scope);
  const jobTool = isJobTool(tool);
  // A job's whole command is on the card, compound or not.  One cut to fit
  // is unseen, so no person is asked to approve it.  (The harness's own
  // `job_start` never gets here from a full-auto bot, and refuses a command
  // too long for the card before any card is shown, so this is what keeps a
  // lookalike tool's cut summary from riding an Auto grant.)
  const unsafeCommand = jobTool ? truncatedJobSummary(summary) : unsafeCommandSummary(tool, summary);
  const grant =
    destructive || sensitive || unsafeCommand
      ? null
      : !jobTool && bot.alwaysAllow?.includes(key) && !coarseAlwaysAllowRefused(key, context)
        ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow" as const, rule: key }
        : bot.autoApprove
          ? { approve: `auto-approved ${jobTool ? key : tool}`, source: "auto-mode" as const, rule: jobTool ? key : undefined }
          : null;
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
  if (unsafeCommand) return { approve: null, source: "no-grant", rule: "command-needs-full-review" };
  if (context?.unattended) {
    // Auto mode is something a person switched on for turns they are present
    // for. A webhook turn begins with nobody watching, on a payload someone
    // else wrote, so it does not inherit that decision — the guard above is a
    // pattern list its own comment calls "not a security boundary", and it
    // must not stand in for a human at 3am. A guard that would have carded
    // anyway keeps its own name; the block is only the story when it is the
    // thing that changed the outcome.
    if (grant) return { approve: null, source: "unattended-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && !bot.autoApprove) {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer" | "disposable-computer";
  },
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}
