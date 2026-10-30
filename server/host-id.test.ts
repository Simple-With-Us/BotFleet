import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lchownSync, linkSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_ID_PATTERN } from "../shared/placement.ts";
import { loadHostId } from "./host-id.ts";

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "bf-host-id-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("host identity", () => {
  it.skipIf(process.platform === "win32")("keeps the configured user-owned data-directory aliases accepted by the ownership fence", () => {
    const dir = fixture();
    const alias = join(fixture(), "user-data");
    symlinkSync(dir, alias);
    // Root-hosted fixtures still exercise an ordinary user's alias.
    if (process.getuid?.() === 0) lchownSync(alias, 65534, 65534);
    expect(lstatSync(alias).uid).not.toBe(0);
    const id = loadHostId(alias, "darwin");
    expect(loadHostId(dir)).toBe(id);
    expect(loadHostId(alias)).toBe(id);
    expect(readdirSync(dir)).toEqual(["host-id"]);
  });

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

  it("rejects a persistent hard link without changing the linked file's mode", () => {
    const dir = fixture();
    const other = join(dir, "other-file");
    writeFileSync(other, "mac:11111111-1111-4111-8111-111111111111\n", { mode: 0o640 });
    linkSync(other, join(dir, "host-id"));
    const mode = statSync(other).mode;
    expect(() => loadHostId(dir)).toThrow(/one link/);
    expect(statSync(other).mode).toBe(mode);
    expect(statSync(other).nlink).toBe(2);
  });

  it("waits for a verified concurrent publication alias to disappear", async () => {
    const dir = fixture();
    const id = "server:11111111-1111-4111-8111-111111111111";
    const script = "import {writeFileSync,linkSync,unlinkSync} from 'node:fs'; import {join} from 'node:path'; const path=join(process.argv[1],'host-id'); const candidate=path+'.22222222-2222-4222-8222-222222222222.pending'; writeFileSync(candidate,process.argv[2],{mode:0o600}); linkSync(candidate,path); process.stdout.write('linked'); setTimeout(()=>unlinkSync(candidate),100);";
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, id], { stdio: ["ignore", "pipe", "pipe"] });
    const finished = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`publisher exited ${code}`)));
    });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", (code) => { if (code) reject(new Error("publisher failed")); }); });
    expect(loadHostId(dir)).toBe(id);
    await finished;
    expect(statSync(join(dir, "host-id")).nlink).toBe(1);
    expect(readdirSync(dir)).toEqual(["host-id"]);
  });

  it("recovers the published identity after its creator exits before removing the publication alias", () => {
    const dir = fixture();
    const id = "server:11111111-1111-4111-8111-111111111111";
    const script = "import {writeFileSync,linkSync} from 'node:fs'; import {join} from 'node:path'; const path=join(process.argv[1],'host-id'); const candidate=path+'.22222222-2222-4222-8222-222222222222.pending'; writeFileSync(candidate,process.argv[2],{mode:0o600}); linkSync(candidate,path); process.exit(73);";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, dir, id], { stdio: "pipe" });
    expect(child.status).toBe(73);
    const unrelated = join(dir, "host-id.33333333-3333-4333-8333-333333333333.pending");
    writeFileSync(unrelated, "unrelated");
    expect(statSync(join(dir, "host-id")).nlink).toBe(2);
    expect(loadHostId(dir)).toBe(id);
    expect(loadHostId(dir)).toBe(id);
    expect(statSync(join(dir, "host-id")).nlink).toBe(1);
    expect(readFileSync(unrelated, "utf8")).toBe("unrelated");
    expect(readdirSync(dir).sort()).toEqual(["host-id", "host-id.33333333-3333-4333-8333-333333333333.pending"]);
  });
});
