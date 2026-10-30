import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_ID_PATTERN } from "../shared/placement.ts";
import { loadHostId } from "./host-id.ts";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "bf-host-id-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("host identity", () => {
  it("persists a private identity across restarts and never rewrites its platform", () => {
    const dir = fixture();
    const id = loadHostId(dir, "darwin");
    expect(id).toMatch(HOST_ID_PATTERN);
    expect(id.startsWith("mac:")).toBe(true);
    expect(loadHostId(dir, "linux")).toBe(id);
    expect(statSync(join(dir, "host-id")).mode & 0o777).toBe(0o600);
    chmodSync(join(dir, "host-id"), 0o644);
    expect(loadHostId(dir)).toBe(id);
    expect(statSync(join(dir, "host-id")).mode & 0o777).toBe(0o600);
    expect(loadHostId(fixture(), "linux").startsWith("server:")).toBe(true);
  });

  it("preserves malformed state and refuses a symbolic link", () => {
    const dir = fixture();
    const path = join(dir, "host-id");
    writeFileSync(path, "damaged identity\n");
    expect(() => loadHostId(dir)).toThrow(/host-id is invalid/);
    expect(readFileSync(path, "utf8")).toBe("damaged identity\n");
    rmSync(path);
    symlinkSync(join(dir, "missing"), path);
    expect(() => loadHostId(dir)).toThrow();
    expect(readdirSync(dir)).toEqual(["host-id"]);
  });

  it("publishes one complete identity when first starts race", async () => {
    const dir = fixture();
    const module = new URL("./host-id.ts", import.meta.url).href;
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import { loadHostId } from ${JSON.stringify(module)}; process.stdout.write(loadHostId(process.argv[1], 'linux'));`, dir], { stdio: ["ignore", "pipe", "pipe"] });
      let result = "";
      let error = "";
      child.stdout.on("data", (data) => { result += data; });
      child.stderr.on("data", (data) => { error += data; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(result) : reject(new Error(error)));
    });
    const ids = await Promise.all(Array.from({ length: 8 }, run));
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(HOST_ID_PATTERN);
    expect(loadHostId(dir)).toBe(ids[0]);
    expect(readdirSync(dir)).toEqual(["host-id"]);
  });
});
