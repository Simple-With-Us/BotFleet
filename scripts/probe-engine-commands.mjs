#!/usr/bin/env node
// Drive the installed Claude CLI the way BotFleet does (-p, stream-json in and
// out) with the few messages that decide whether a slash command may be shown,
// and record the frames as fixtures.  Run it through
// scripts/probe-engine-commands.sh, which gives it a throwaway HOME, a throwaway
// config directory and a throwaway working folder, and checks afterwards that
// the real settings file did not move.  Never run it by hand against a real HOME.
//
// usage: node scripts/probe-engine-commands.mjs <cli> <fixture-dir> <cwd>
//
// Cases, one CLI process each:
//   prompt          a plain sentence: the baseline for what a prompt does here
//   zwsp-context    U+200B then "/context": must reach the model as a prompt
//   context         "/context": a command the CLI answers itself
//   compact         "/compact": a command that needs a conversation to compact
//   zwsp-advisor    U+200B then "/advisor opus": must NOT change any setting
//   warm-context    a plain sentence, then "/context" on the SAME process, the
//                   way a bot's second turn reaches a warm CLI
//
// Every message carries a uuid, as BotFleet stamps them: the CLI reports
// command_lifecycle frames for a stamped message, and the driver's turn logic
// reads them, so a probe without the uuid would prove the wrong thing.
//
// Without a credential the model cannot answer, so a prompt ends in an
// authentication error.  That still proves the point: only a prompt reaches the
// API, while a command is answered by the CLI itself.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CLAUDE_CONTAINMENT_SETTINGS, claudeDisallowedTools } from "../server/drivers/claude.ts";
import { redactSecretsInText } from "../server/redact.ts";

const [cli, fixtureDir, cwd] = process.argv.slice(2);
if (!cli || !fixtureDir || !cwd) {
  console.error("usage: probe-engine-commands.mjs <cli> <fixture-dir> <cwd>");
  process.exit(2);
}

const CASE_TIMEOUT_MS = 90_000;
const ZWSP = "\u200B";
const CASES = [
  { name: "prompt", texts: ["Reply with the single word: ready"] },
  { name: "zwsp-context", texts: [`${ZWSP}/context`] },
  { name: "context", texts: ["/context"] },
  { name: "compact", texts: ["/compact"] },
  { name: "zwsp-advisor", texts: [`${ZWSP}/advisor opus`] },
  { name: "warm-context", texts: ["Reply with the single word: ready", "/context"] },
];

const Frame = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    slash_commands: z.array(z.string()).optional(),
    session_id: z.string().optional(),
    state: z.string().optional(),
  })
  .passthrough();

mkdirSync(fixtureDir, { recursive: true });
const tmpRoot = process.env.HOME ?? "";
const mcpConfig = join(cwd, "mcp.json");
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: {} }));

/** a recorded line with credentials and the throwaway paths taken out */
function scrub(line) {
  let text = redactSecretsInText(line);
  if (tmpRoot) text = text.split(tmpRoot).join("<HOME>");
  text = text.split(cwd).join("<CWD>");
  return text;
}

function runCase({ name, texts }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "acceptEdits",
      "--disallowedTools", claudeDisallowedTools({}).join(","),
      "--settings", JSON.stringify(CLAUDE_CONTAINMENT_SETTINGS),
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
    ];
    // a clean environment: nothing of the caller's, no credential of any kind
    const env = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      PATH: process.env.PATH,
      TERM: "dumb",
      NO_COLOR: "1",
    };
    const child = spawn(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const frames = [];
    let stderr = "";
    let buffer = "";
    let finished = false;
    let sent = 0;
    let results = 0;
    const startedAt = Date.now();
    const finish = (how, code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      resolve({ name, texts, how, code, frames, stderr, ms: Date.now() - startedAt });
    };
    // one message at a time, each stamped the way BotFleet stamps its own
    const sendNext = () => {
      const message = { type: "user", uuid: randomUUID(), message: { role: "user", content: texts[sent] } };
      sent += 1;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(() => finish("timeout", null), CASE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.trim()) continue;
        frames.push(line);
        const parsed = Frame.safeParse(safeJson(line));
        if (parsed.success && parsed.data.type === "result") {
          results += 1;
          if (results >= texts.length) finish("result", null);
          else sendNext();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => finish(`spawn error: ${error.message}`, null));
    child.on("close", (code) => finish("exit", code));
    sendNext();
  });
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** what a case showed, in the terms the allowlist cares about */
function summarize(outcome) {
  const parsed = outcome.frames.map((line) => Frame.safeParse(safeJson(line))).filter((p) => p.success).map((p) => p.data);
  const init = parsed.find((frame) => frame.type === "system" && frame.subtype === "init");
  const result = parsed.find((frame) => frame.type === "result");
  const raw = outcome.frames.join("\n");
  return {
    case: outcome.name,
    messages: outcome.texts.length,
    ended: outcome.how,
    exitCode: outcome.code,
    ms: outcome.ms,
    frameTypes: parsed.map((frame) => (frame.subtype ? `${frame.type}/${frame.subtype}` : String(frame.type))),
    sawInit: Boolean(init),
    slashCommands: init?.slash_commands ?? null,
    sawResult: Boolean(result),
    resultIsError: result?.is_error ?? null,
    resultText: result?.result ? scrub(result.result).slice(0, 400) : null,
    lifecycle: parsed.filter((frame) => frame.type === "command_lifecycle").map((frame) => frame.state),
    localCommandStdout: raw.includes("<local-command-stdout>"),
    localCommandStderr: raw.includes("<local-command-stderr>"),
    compactBoundary: raw.includes("compact_boundary"),
    stderrTail: scrub(outcome.stderr).slice(-400),
  };
}

const summaries = [];
for (const probeCase of CASES) {
  console.error(`probe: ${probeCase.name}`);
  const outcome = await runCase(probeCase);
  writeFileSync(join(fixtureDir, `${probeCase.name}.jsonl`), `${outcome.frames.map(scrub).join("\n")}\n`);
  summaries.push(summarize(outcome));
}

// the one setting a leaked /advisor would have written, in the throwaway config
const settingsPath = join(process.env.CLAUDE_CONFIG_DIR ?? "", "settings.json");
const settingsText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
const report = {
  cli,
  recordedAt: new Date().toISOString(),
  throwawaySettingsExists: existsSync(settingsPath),
  throwawayAdvisorModelWritten: settingsText.includes("advisorModel"),
  cases: summaries,
};
writeFileSync(join(fixtureDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
