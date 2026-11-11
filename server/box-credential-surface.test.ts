// The credential surface of a turn that mounts an ASCII.dev Box computer.
//
// One test file, one claim: for a turn with a Box computer mounted, the
// account-wide Box API key never reaches the bot's process — not in its
// environment, and therefore not in the 0600 `mcp.json` a Claude, ACP, or pi
// turn writes its MCP servers into and the bot can read — and a proxy that
// names a box its mount was not granted is refused by the harness before the
// provider ever sees it.
//
// The turn is built through the real resolver rather than a hand-made mount,
// because the vulnerability lived in the resolver: it read `cfg.box.token` and
// put it on the mount.  A test that hand-builds a mount proves nothing about it.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOX_GATEWAY_PATH,
  computerProxyEnv,
  handleBoxGatewayRequest,
  resetBoxGatewayGrants,
} from "./container-computer.ts";
import {
  resolveTurnComputerMounts,
  type TurnComputerDeps,
} from "./computer-grants.ts";
import { boxGatewayUrl, mintBoxGatewayGrant } from "./box-gateway-grant.ts";
import type { AppConfig } from "./config.ts";

/** Obviously fake, and the value this whole file exists to keep out of a bot. */
const ACCOUNT_BOX_KEY = "box_live_FAKE-do-not-log-this";

const engine = { driverKind: "claude", computerMcp: true, localComputerMcp: true, toolLoop: false };

function deps(over: Partial<TurnComputerDeps<object>> = {}): TurnComputerDeps<object> {
  return {
    hostPlatform: "darwin",
    readHostConnection: () => null,
    acquireLocalVm: async () => ({ command: "/bin/vm", args: ["mcp"], env: {} }),
    vps: {
      vpsDriverError: () => "no vps",
      vpsComputerAction: async () => ({}),
      inspectVpsForAuto: async () => ({}),
      vpsComputerMcp: () => ({ command: "/bin/vps", args: ["mcp"], env: {} }),
      vpsComputerScreenshot: async () => ({ png: "", format: "png" }),
    },
    box: {
      boxConfigured: () => true,
      findBox: async () => ({ id: "box-this-bot-owns", state: "running" }),
      provisionBox: async () => ({ boxId: "box-this-bot-owns" }),
      readyBox: async () => ({ id: "box-this-bot-owns", state: "running" }),
      screenshotBox: async () => ({ png: "", format: "png" }),
    },
    vpsLeases: { claim: () => ({}), release: () => {} },
    controlIntegration: () => ({ url: "http://127.0.0.1:8799/api/internal/computer-control?botId=bot-1", token: "ctl" }),
    boxGateway: { url: boxGatewayUrl, mint: mintBoxGatewayGrant },
    broadcast: () => {},
    notice: () => {},
    checkpoint: async () => true,
    ...over,
  };
}

/** The account key deliberately present in config, so the test can prove the
 *  grant the child receives is NOT this value.  A partial AppConfig is built
 *  here once rather than double-asserted at each call site. */
function cfgWithAccountBoxKey(): AppConfig {
  // SAFETY: `box.token` is the only field the Box gateway reads, and every
  // other field it touches is optional, so this partial config is complete
  // for the code under test.
  return { box: { token: ACCOUNT_BOX_KEY } } as AppConfig;
}

async function boxTurn() {
  return resolveTurnComputerMounts({
    bot: { id: "bot-1", name: "Bot", computers: ["cloud"], cloudBackend: "box" },
    cfg: cfgWithAccountBoxKey(),
    engine,
    threadId: "t1",
    dispatchId: 1,
    allowed: null,
    deps: deps(),
  });
}

describe("Box credential surface", () => {
  it("never puts the account-wide key in the child environment or the mcp.json it writes", async () => {
    resetBoxGatewayGrants();
    const { mounts } = await boxTurn();
    const boxMount = mounts.find((m) => m.kind === "box");
    expect(boxMount?.box).toBeTruthy();

    // What claude.ts, pi.ts, and acp/core.ts put in the child's env.
    const env = computerProxyEnv(boxMount!.box!);
    expect(env.OGB_BOX_TOKEN).not.toBe(ACCOUNT_BOX_KEY);
    expect(env.OGB_BOX_API).toBe(`http://127.0.0.1:8799${BOX_GATEWAY_PATH}`);
    expect(JSON.stringify(env)).not.toContain(ACCOUNT_BOX_KEY);

    // And the 0600 file a turn writes its MCP servers into, read back the way
    // the bot reads it.
    const dir = mkdtempSync(join(tmpdir(), "omb-cred-surface-"));
    const mcpConfig = join(dir, "mcp.json");
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { computer: { command: process.execPath, env } } }), { mode: 0o600 });
    const onDisk = readFileSync(mcpConfig, "utf8");
    expect(onDisk).not.toContain(ACCOUNT_BOX_KEY);
    expect(onDisk).toContain(BOX_GATEWAY_PATH);
  });

  it("refuses a call naming a box outside the turn's grant, server-side", async () => {
    resetBoxGatewayGrants();
    const { mounts } = await boxTurn();
    const env = computerProxyEnv(mounts.find((m) => m.kind === "box")!.box!);
    const call = (boxId: string) =>
      handleBoxGatewayRequest(
        {
          method: "POST",
          url: `${BOX_GATEWAY_PATH}/boxes/${boxId}/commands`,
          authorization: `Bearer ${env.OGB_BOX_TOKEN}`,
          remoteAddress: "127.0.0.1",
          body: '{"command":"id"}',
        },
        {
          cfg: cfgWithAccountBoxKey(),
          fetchImpl: async () => new Response('{"exitCode":0}', { status: 200 }),
        },
      );

    // The same bearer, the same harness, a different box: refused here, so the
    // provider never gets a chance to honour it.
    expect((await call("box-this-bot-owns")).status).toBe(200);
    expect((await call("box-a-different-bot-owns")).status).toBe(403);
  });

  it("issues a distinct grant per turn rather than one fleet-wide handle", async () => {
    resetBoxGatewayGrants();
    const first = await boxTurn();
    const second = await boxTurn();
    const tokenOf = (result: Awaited<ReturnType<typeof boxTurn>>) =>
      computerProxyEnv(result.mounts.find((m) => m.kind === "box")!.box!).OGB_BOX_TOKEN;
    expect(tokenOf(first)).toBeTruthy();
    expect(tokenOf(first)).not.toBe(tokenOf(second));
    expect(tokenOf(first)).not.toBe(ACCOUNT_BOX_KEY);
  });
});
