import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CONTAINER, CUA_EXECUTABLE, CUA_SOCKET } from "./container-computer.ts";
import {
  CONTAINER_RUNTIME_DISABLED_ENV,
  CONTAINER_RUNTIME_DISABLED_MESSAGE,
  CONTAINER_RUNTIME_FIXTURE_DIR_ENV,
} from "./container-runtime-guard.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// The fake Docker executable below is a POSIX shell script. The production
// bridge remains portable; only this byte-for-byte process fixture is gated.
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Local VM CUA MCP bridge", () => {
  it("passes MCP bytes unchanged to cua-driver mcp over the container runtime", async () => {
    const bin = await mkdtemp(join(tmpdir(), "botfleet-container-mcp-"));
    temporary.push(bin);
    const fakeDocker = join(bin, "docker");
    await writeFile(
      fakeDocker,
      "#!/bin/sh\nprintf 'ARGS:%s\\n' \"$*\" >&2\ncat\n",
      { mode: 0o700 },
    );
    await chmod(fakeDocker, 0o700);

    const input = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n';
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
        {
          env: {
            ...process.env,
            OMB_EXTRA_PATH: bin,
            // The suite runs with container runtimes switched off; this fake
            // `docker` is the one runtime the bridge may run.
            BOTFLEET_CONTAINER_RUNTIME_FIXTURE_DIR: bin,
            NODE_NO_WARNINGS: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(input);
    expect(result.stderr).toContain(
      `ARGS:exec -i -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
        `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ` +
        `${CUA_EXECUTABLE} mcp --socket ${CUA_SOCKET}`,
    );
  });

  it("refuses to spawn any runtime while container runtimes are disabled and no fixture stands in", async () => {
    const bin = await mkdtemp(join(tmpdir(), "botfleet-container-mcp-"));
    temporary.push(bin);
    const trapLog = join(bin, "trap.log");
    // First on every PATH the bridge consults: a refusal that only failed to
    // FIND a runtime would still execute this.
    await writeFile(join(bin, "docker"), `#!/bin/sh\necho "$*" >> "${trapLog}"\ncat\n`, { mode: 0o700 });
    await chmod(join(bin, "docker"), 0o700);

    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./container-mcp.ts", import.meta.url)), "docker", CONTAINER, CUA_SOCKET],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            OMB_EXTRA_PATH: bin,
            [CONTAINER_RUNTIME_DISABLED_ENV]: "1",
            [CONTAINER_RUNTIME_FIXTURE_DIR_ENV]: "",
            NODE_NO_WARNINGS: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.on("error", () => {});
      child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(CONTAINER_RUNTIME_DISABLED_MESSAGE);
    expect(existsSync(trapLog)).toBe(false);
  });
});
