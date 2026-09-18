// github.ts's whole safety story is the real-path confinement check: every
// action must resolve to a repo directory actually inside this bot's own
// workspace, the same class of symlink/traversal escape bot-cwd.test.ts
// exercises for the phone-originated cwd path.
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

// workspace.ts reads DATA_DIR from config.ts, which reads OMB_DATA_DIR at
// import time — set it before any transitive import evaluates that module
// (same pattern as checkpoints.test.ts / attachments.test.ts).
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-github-tool-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const { createGithubTools } = await import("./github.ts");
const { ensureWorkspace, workspaceDir } = await import("../workspace.ts");

afterAll(async () => {
  await removeTempDir(DATA_ROOT);
});

const BOT_ID = "bot-under-test";

function call(name: string, args: Record<string, unknown>) {
  const tools = createGithubTools(BOT_ID);
  const executor = tools[name];
  if (!executor) throw new Error(`no such tool: ${name}`);
  return executor(
    { id: "call-1", name, arguments: args },
    { botId: BOT_ID, threadId: "thread-1", commsDepth: 0 },
    { signal: new AbortController().signal, requestApproval: async () => "allowed-once" },
  );
}

describe("createGithubTools confinement", () => {
  it("refuses a non-clone action when dir is missing", async () => {
    const result = await call("github_status", {});
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/github_clone/);
  });

  it("refuses a dir that does not exist under the workspace", async () => {
    const result = await call("github_status", { dir: "never-cloned" });
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/github_clone/);
  });

  it("refuses a dir that escapes the workspace with ..", async () => {
    ensureWorkspace(BOT_ID);
    const result = await call("github_status", { dir: "../../etc" });
    expect(result.kind).toBe("error");
  });

  it("refuses a dir that escapes the workspace via a symlink", async () => {
    const root = ensureWorkspace(BOT_ID);
    const outside = mkdtempSync(join(tmpdir(), "omb-github-outside-"));
    const link = join(root, "escape-link");
    try {
      symlinkSync(outside, link, "dir");
    } catch {
      return; // no symlink permission on this runner
    }
    const result = await call("github_status", { dir: "escape-link" });
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/github_clone/);
  });

  it("rejects an unsafe repo spec before ever shelling out", async () => {
    const result = await call("github_clone", { repo: "owner/repo; rm -rf /" });
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/owner\/repo/);
  });

  it("rejects an unsafe dir name for clone", async () => {
    const result = await call("github_clone", { repo: "octocat/hello-world", dir: "../escape" });
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/plain folder name/);
  });

  it("refuses to clone into a dir name that already exists", async () => {
    const root = ensureWorkspace(BOT_ID);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "already-there"), { recursive: true });
    const result = await call("github_clone", { repo: "octocat/hello-world", dir: "already-there" });
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/already exists/);
  });

  it("requires a commit message", async () => {
    ensureWorkspace(BOT_ID);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(workspaceDir(BOT_ID), "repo-a"), { recursive: true });
    const result = await call("github_commit", { dir: "repo-a", message: "" });
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/message/);
  });

  it("requires a PR number for github_pr_checkout", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(workspaceDir(BOT_ID), "repo-b"), { recursive: true });
    const result = await call("github_pr_checkout", { dir: "repo-b" });
    expect(result.kind).toBe("error");
    expect(result.content).toMatch(/number/);
  });

  it("only ever resolves inside this bot's own workspace, never another bot's", async () => {
    ensureWorkspace("other-bot");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(workspaceDir("other-bot"), "shared-name"), { recursive: true });
    // Passing an absolute path into another bot's workspace must not be
    // accepted just because *a* directory with that name exists somewhere.
    const result = await call("github_status", { dir: join(workspaceDir("other-bot"), "shared-name") });
    expect(result.kind).toBe("error");
  });
});
