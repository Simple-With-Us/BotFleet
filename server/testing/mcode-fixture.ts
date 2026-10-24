// Fixtures for the tests that run the REAL MiniMax Code CLI (`mcode`) as a
// BotFleet engine child, with nothing real behind it:
//
//   - the model is a scripted fake of the Anthropic messages wire shape on
//     127.0.0.1, so a turn costs nothing and calls exactly the tools the test
//     names (an MCP tool, then the shell);
//   - the data directory is a throwaway one with a custom provider that points
//     at that fake, and an `mcp.json` the test writes, so the owner's own
//     ~/.minimax is never read or written;
//   - Zulip, where a test needs it, is the existing FakeZulip.
//
// Used by server/drivers/acp/mcode-launch-seat.test.ts, which skips when
// `mcode` is not installed (CI has none).
import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const execFileAsync = promisify(execFile);

/** The stdio MCP server that reports its own launch variables (`dump_env`). */
export const ENV_PROBE_MCP = join(dirname(fileURLToPath(import.meta.url)), "env-probe-mcp.mjs");

/** The picker id of the fixture model:  the model id plus the `thinking` mode
 *  mcode gives a custom provider's model.  A BotFleet turn passes it as
 *  `model`, so the driver selects it and never the real MiniMax rows. */
export const FIXTURE_MODEL = "fixture-model-thinking";

/** The first executable file called `name` on PATH, or in ~/.local/bin of the
 *  account running the tests.  The account's home is asked of the OS because
 *  the vitest setup points HOME at a throwaway directory. */
export function findExecutable(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(userInfo().homedir, ".local", "bin")];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // not here; try the next directory
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

/** One scripted tool call:  the first tool whose name matches `tool`, called
 *  with `input`.  A step whose tool the session does not offer is skipped (and
 *  listed in `FakeModel.missingTools`), so a test can tell "the tool was never
 *  there" from "the tool answered". */
export interface ModelStep {
  tool: RegExp;
  /** The call's arguments:  `{}` for `dump_env` and `whoami`, `{ command }`
   *  for the shell. */
  input: Readonly<Record<string, string>>;
}

/** One server-sent frame of the messages stream:  its event name and payload. */
type SseFrame = readonly [event: string, payload: object];

const MESSAGE_START: SseFrame = [
  "message_start",
  {
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
];

function toolUseFrames(id: string, name: string, input: ModelStep["input"]): SseFrame[] {
  return [
    MESSAGE_START,
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

function textFrames(text: string): SseFrame[] {
  return [
    MESSAGE_START,
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
}

interface MessagesBody {
  tools?: Array<{ name?: string }>;
  messages?: Array<{ role?: string; content?: unknown }>;
}

/** The text of every tool result in a conversation, in order. */
function toolResultTexts(body: MessagesBody): string[] {
  const texts: string[] = [];
  for (const message of body.messages ?? []) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "tool_result") continue;
      const content = block.content;
      texts.push(
        Array.isArray(content) ? content.map((part: { text?: string }) => part?.text ?? "").join("") : String(content ?? ""),
      );
    }
  }
  return texts;
}

/** A fake of the Anthropic messages API that plays a fixed script of tool
 *  calls and then ends the turn with a short text. */
export class FakeModel {
  url = "";
  /** The text of every tool result the session has sent back so far. */
  toolResults: string[] = [];
  /** Sources of the steps whose tool the session did not offer. */
  missingTools: string[] = [];
  private server?: Server;

  constructor(private readonly steps: readonly ModelStep[]) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP host:port reports an AddressInfo.
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (path.endsWith("/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (!path.endsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let body: MessagesBody = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // an unreadable body plays as an empty conversation
      }
      const names = (body.tools ?? []).map((tool) => tool.name ?? "");
      const results = toolResultTexts(body);
      if (results.length > this.toolResults.length) this.toolResults = results;
      this.missingTools = this.steps.filter((step) => !names.some((n) => step.tool.test(n))).map((step) => step.tool.source);
      const offered = this.steps.filter((step) => names.some((n) => step.tool.test(n)));
      const step = offered[results.length];
      const frames = step
        ? toolUseFrames(`toolu_fixture_${results.length}`, names.find((n) => step.tool.test(n))!, step.input)
        : textFrames("done");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [event, payload] of frames) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    });
  }
}

// ---------------------------------------------------------------------------
// The throwaway mcode data directory
// ---------------------------------------------------------------------------

/** One entry of mcode's `mcp.json` (the same shape as ~/.minimax/mcp.json). */
export interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McodeFixture {
  /** The directory mcode treats as its data directory (`MINIMAX_DATA_DIR`). */
  dataDir: string;
  /** A home directory for the engine child, so a tool that reads the home
   *  folder reads the fixture's and never the account's. */
  home: string;
}

/** Build a throwaway mcode data directory under `dir`:  a custom provider
 *  whose base URL is the fake model, that provider as the default model, and
 *  `mcp.json` holding `mcpServers`.  Nothing here touches the owner's
 *  ~/.minimax. */
export async function writeMcodeFixture(input: {
  mcode: string;
  dir: string;
  modelUrl: string;
  mcpServers: Record<string, McpEntry>;
}): Promise<McodeFixture> {
  const dataDir = join(input.dir, "mcode-data");
  const home = join(input.dir, "mcode-home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  // `provider add` without `--use` saves the provider without testing it.  The
  // key reaches it by name from the environment, and the value is a fixture's.
  await execFileAsync(
    input.mcode,
    [
      "provider",
      "add",
      "--name",
      "fixture",
      "--base-url",
      input.modelUrl,
      "--model",
      "fixture-model",
      "--api-key-env",
      "FIXTURE_MODEL_KEY",
    ],
    { env: { PATH: process.env.PATH, HOME: home, MINIMAX_DATA_DIR: dataDir, FIXTURE_MODEL_KEY: "fixture-not-a-key" } },
  );
  // The fixture's provider is the default model, and mcode's data contribution
  // is off:  a test must not send anything to a live service.
  const configPath = join(dataDir, "config.yaml");
  const config: { defaultModel?: string; dataContribution?: { enabled: boolean } } = parseYaml(
    readFileSync(configPath, "utf8"),
  );
  config.defaultModel = "custom_provider:fixture/fixture-model";
  config.dataContribution = { enabled: false };
  writeFileSync(configPath, stringifyYaml(config));
  const servers = Object.fromEntries(
    Object.entries(input.mcpServers).map(([name, entry]) => [name, { type: "stdio", ...entry }]),
  );
  writeFileSync(join(dataDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
  return { dataDir, home };
}

/** The environment that hands `agent-sync mcp` a seat's bot credentials,
 *  pointing at a fake realm:  `ZULIP_<CODE>_EMAIL` and `ZULIP_<CODE>_API_KEY`
 *  for each bot (CODE is the seat with hyphens as underscores) and
 *  `ZULIP_SITE`, which is how an MCP server is given a key now that no
 *  credential folder is read (AFC-359).  `AGENT_SYNC_INFISICAL=0` keeps it from
 *  asking the real vault for anything else.  The keys are a fixture's. */
export function zulipCredentialEnv(input: {
  site: string;
  bots: ReadonlyArray<{ seat: string; email: string; key: string }>;
}): Record<string, string> {
  const env: Record<string, string> = { ZULIP_SITE: input.site, AGENT_SYNC_INFISICAL: "0" };
  for (const bot of input.bots) {
    const code = bot.seat.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    env[`ZULIP_${code}_EMAIL`] = bot.email;
    env[`ZULIP_${code}_API_KEY`] = bot.key;
  }
  return env;
}

/** Run one ordinary `mcode exec` session:  not launched by BotFleet, so its
 *  environment holds no `AGENT_*` variable at all, as when the owner starts
 *  MiniMax Code from a terminal.  Resolves when the session ends. */
export async function runOrdinaryMcode(input: {
  mcode: string;
  fixture: McodeFixture;
  cwd: string;
}): Promise<{ ok: boolean; stderr: string }> {
  try {
    await execFileAsync(input.mcode, ["exec", "--permission", "full", "--cwd", input.cwd, "--timeout", "60s", "go"], {
      cwd: input.cwd,
      env: { PATH: process.env.PATH, HOME: input.fixture.home, MINIMAX_DATA_DIR: input.fixture.dataDir },
      timeout: 90_000,
    });
    return { ok: true, stderr: "" };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}
