// A stdio MCP server that reports its own environment.  The real-mcode tests
// (server/drivers/acp/mcode-launch-seat.test.ts) register it with mcode, then
// script the model to call `dump_env`, so the test can read what an MCP child
// of a BotFleet-launched mcode turn actually inherits.
//
// It answers only what mcode needs: initialize, tools/list, tools/call.  It
// reports the launch variables and the fixture marker, never anything else
// from the environment.
import { createInterface } from "node:readline";

const REPORTED = /^(AGENT_|X_FIXTURE_)/;

function report() {
  const seen = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (REPORTED.test(name)) seen[name] = value;
  }
  return seen;
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  if (message.method === "initialize") {
    reply({
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "env-probe", version: "0" },
    });
  } else if (message.method === "tools/list") {
    reply({
      tools: [
        {
          name: "dump_env",
          description: "Report the launch variables in this server process's environment",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  } else if (message.method === "tools/call") {
    reply({ content: [{ type: "text", text: `MCP_ENV ${JSON.stringify(report())}` }] });
  } else {
    reply({});
  }
});
