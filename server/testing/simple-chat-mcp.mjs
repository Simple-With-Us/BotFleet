// The stdio MCP server the fleet's simple-chat entry runs, as a fixture.
//
// The mcode-launch-seat tests (server/drivers/acp/mcode-launch-seat.test.ts)
// register an MCP entry in mcp.json the way the owner registers it in
// ~/.minimax/mcp.json (`mcp --default-seat MM`) and script the model to call
// `whoami`, so the test can read which seat that entry answers as.
//
// The entry used to name the host's own simple-chat, and that made the
// suite's result depend on what the machine had installed:  the fleet's
// simple-chat gates its MCP server on the seat's own bearer file and on a
// hosted gateway with a fixed endpoint, so on a host carrying the current
// build the server refuses to start at all and the test failed with "no
// whoami answer among 0 tool results".  This fixture serves the contract the
// test asserts instead — the launcher's seat wins, the default seat is only a
// fallback, and a launcher that names no seat serves nothing — so the test
// exercises its own fixture on every host, whatever is installed.
//
// It answers only what mcode needs: initialize, tools/list, tools/call.
import { createInterface } from "node:readline";

/** The seat the launcher bound, if any. */
function launchSeat() {
  const seat = (process.env.AGENT_LAUNCH_SEAT || process.env.AGENT_SEAT || "").trim();
  return seat ? seat.toUpperCase() : "";
}

/** The seat the entry's `--default-seat` names. */
function defaultSeat(argv) {
  const at = argv.indexOf("--default-seat");
  return at >= 0 ? String(argv[at + 1] || "").trim().toUpperCase() : "";
}

/** The seat this session signs as, and where that seat came from. */
function resolveSeat(argv) {
  const launched = (process.env.AGENT_LAUNCHER || "").trim();
  const seat = launchSeat();
  if (seat) return { seat, source: "env" };
  // A launcher that names no seat serves nothing:  falling back to the entry's
  // default would sign the turn as a seat nobody launched it for.
  if (launched) return null;
  const fallback = defaultSeat(argv);
  return fallback ? { seat: fallback, source: "none" } : null;
}

/** The seat's own credentials, in the environment the entry carries. */
function credentials(seat) {
  const code = seat.replace(/[^A-Z0-9]/g, "_");
  return {
    email: process.env[`ZULIP_${code}_EMAIL`] || "",
    key: process.env[`ZULIP_${code}_API_KEY`] || "",
    realm: process.env.ZULIP_SITE || process.env.AGENT_SYNC_REALM || "",
  };
}

/** Who this session signs as, proved against the realm the entry names. */
async function whoami(resolved) {
  const { seat, source } = resolved;
  const { email, key, realm } = credentials(seat);
  if (!realm || !email || !key) throw new Error("the entry carries no realm credential");
  const response = await fetch(`${realm}/api/v1/users/me`, {
    headers: { Authorization: `Basic ${Buffer.from(`${email}:${key}`).toString("base64")}` },
  });
  if (!response.ok) throw new Error(`the realm refused the ${seat} credential`);
  const who = await response.json();
  const session = (process.env.AGENT_SESSION || "").trim();
  return {
    seat,
    email: who.email,
    // A launched turn carries the session in its tag; an ordinary one does not.
    tag_prefix: source === "env" ? `[${seat}·${session}]` : `[${seat}]`,
    session_source: source,
  };
}

const argv = process.argv.slice(2);
const resolved = resolveSeat(argv);
if (!resolved) {
  process.stderr.write("simple-chat mcp: no seat named; nothing is served without one\n");
  process.exit(3);
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
      serverInfo: { name: "simple-chat", version: "0" },
    });
  } else if (message.method === "tools/list") {
    reply({
      tools: [
        {
          name: "whoami",
          description: "Answer which seat this session would sign as",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  } else if (message.method === "tools/call") {
    whoami(resolved)
      .then((answer) => reply({ content: [{ type: "text", text: JSON.stringify(answer) }] }))
      .catch((error) =>
        reply({ content: [{ type: "text", text: `whoami failed: ${error.message}` }], isError: true }),
      );
  } else {
    reply({});
  }
});
