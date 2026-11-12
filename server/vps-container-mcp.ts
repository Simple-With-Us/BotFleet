// Transparent stdio bridge to the official CUA MCP server in a VPS
// container. Docker's SSH transport handles authentication through the
// user's normal SSH config and agent; this process stores no credentials.
// The piping, drain-safe exit, and dead-transport watchdog live in
// mcp-bridge.ts, shared with the Local VM entry point.
import { CUA_SOCKET, DISPLAY } from "./container-computer.ts";
import { runMcpBridge } from "./mcp-bridge.ts";
import { vpsContainerMcpArgs, vpsDockerArgs } from "./vps-computer.ts";

const [alias, containerName, socket = CUA_SOCKET, display = DISPLAY] = process.argv.slice(2);
const sshAlias = alias ?? "";
let args: string[];
try {
  args = vpsContainerMcpArgs(sshAlias, containerName ?? "", socket, display);
} catch {
  process.stderr.write("invalid VPS MCP connection\n");
  process.exit(2);
}

// The who-is-driving pair rides in env, not argv — argv is world-readable
// through `ps`, and the token guards a loopback endpoint.
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";

runMcpBridge({
  command: "docker",
  args,
  label: "VPS CUA Driver",
  // The probe checks the TRANSPORT (SSH + daemon), deliberately not the
  // driver: a busy desktop mid-tool-call must never look dead, while an
  // unreachable VPS must, and `docker version` distinguishes exactly that.
  liveness: { command: "docker", args: vpsDockerArgs(sshAlias, ["version", "--format", "{{.Server.Version}}"]) },
  ...(controlUrl && controlToken ? { gate: { url: controlUrl, token: controlToken } } : {}),
});
