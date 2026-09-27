import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TurnToolCall, TurnToolRuntime } from "../contracts.ts";
import type { AgentToolCallContext } from "./agents.ts";
import { createComputerTools, READ_FILE_DEFAULT_LINE_LIMIT, READ_FILE_MAX_BYTES } from "./computer.ts";

const dummyIdentity: AgentToolCallContext = {
  botId: "bot-1",
  threadId: "thread-1",
  commsDepth: 0,
};

const dummyRuntime: TurnToolRuntime = {
  signal: new AbortController().signal,
  requestApproval: async () => "allowed-once",
};

describe("computer tools", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "bf-comp-test-"));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe("bash", () => {
    it("executes a basic shell command successfully", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-1",
        name: "bash",
        arguments: { command: 'echo "hello from bash"' },
      };
      const result = await tools.bash(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      expect(result.content).toContain("hello from bash");
    });

    it("reports an error on non-zero exit code", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-2",
        name: "bash",
        arguments: { command: "exit 42" },
      };
      const result = await tools.bash(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("42");
    });

    it("rejects empty or missing command", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-3",
        name: "bash",
        arguments: { command: "  " },
      };
      const result = await tools.bash(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("command argument must be a non-empty string");
    });
  });

  describe("read_file", () => {
    it("reads full file contents with line numbers", async () => {
      const filePath = join(scratchDir, "test.txt");
      writeFileSync(filePath, "line one\nline two\nline three\n", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-4",
        name: "read_file",
        arguments: { path: "test.txt" },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      expect(result.content).toBe("1: line one\n2: line two\n3: line three\n4: ");
      // No regression: a short file (well under READ_FILE_DEFAULT_LINE_LIMIT
      // and READ_FILE_MAX_BYTES) comes back whole, with no truncation notice
      // and no "(truncated)" suffix on detail.
      expect(result.content).not.toContain("truncated");
      expect(result.detail).toBe("lines 1-4 of 4");
    });

    it("supports offset and limit", async () => {
      const filePath = join(scratchDir, "test2.txt");
      writeFileSync(filePath, "A\nB\nC\nD\nE\n", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-5",
        name: "read_file",
        arguments: { path: "test2.txt", offset: 2, limit: 2 },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      // Paging itself is unchanged — offset/limit still select exactly lines
      // 2-3 of the 6 "lines" split("\n") produces for "A\nB\nC\nD\nE\n" (the
      // trailing "\n" yields a final empty line, same as the test above).
      // What's new under DR5 is the trailing notice: the explicit limit=2
      // stopped short of the file's end (line 3 of 6), so the executor now
      // says so and names where to resume, exactly as it would if limit had
      // been left to default.
      expect(result.content).toBe(
        "2: B\n3: C\n\n[truncated: showed lines 2-3 of 6 (limit=2 lines).  " +
          "Call read_file again with offset=4 to continue, and limit to control how much comes back.]",
      );
      expect(result.detail).toBe("lines 2-3 of 6 (truncated)");
    });

    it("defaults limit to READ_FILE_DEFAULT_LINE_LIMIT and names the next offset when a file is longer than the default", async () => {
      const filePath = join(scratchDir, "long.txt");
      const totalLines = READ_FILE_DEFAULT_LINE_LIMIT + 100;
      const content = Array.from({ length: totalLines }, (_, i) => `line ${i + 1}`).join("\n");
      writeFileSync(filePath, content, "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-default-limit",
        name: "read_file",
        arguments: { path: "long.txt" },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");

      const [body, notice] = result.content.split("\n\n[truncated:");
      // Exactly READ_FILE_DEFAULT_LINE_LIMIT lines came back, numbered 1..limit.
      expect(body).toBe(
        Array.from({ length: READ_FILE_DEFAULT_LINE_LIMIT }, (_, i) => `${i + 1}: line ${i + 1}`).join("\n"),
      );
      expect(notice).toBeDefined();
      expect(result.content).toContain(
        `showed lines 1-${READ_FILE_DEFAULT_LINE_LIMIT} of ${totalLines} (limit=${READ_FILE_DEFAULT_LINE_LIMIT} lines)`,
      );
      expect(result.content).toContain(`offset=${READ_FILE_DEFAULT_LINE_LIMIT + 1}`);
      expect(result.detail).toBe(`lines 1-${READ_FILE_DEFAULT_LINE_LIMIT} of ${totalLines} (truncated)`);
    });

    it("caps the rendered result at READ_FILE_MAX_BYTES when lines are huge, even under the default line limit", async () => {
      const filePath = join(scratchDir, "huge-lines.txt");
      // Each line is 2000 'x' characters. 50 lines is comfortably under
      // READ_FILE_DEFAULT_LINE_LIMIT (400) but ~100KB of raw content alone —
      // well past READ_FILE_MAX_BYTES (64KB) — so the byte cap, not the line
      // limit, must be what stops this read.
      const lineText = "x".repeat(2000);
      const totalLines = 50;
      const content = Array.from({ length: totalLines }, () => lineText).join("\n");
      writeFileSync(filePath, content, "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-byte-cap",
        name: "read_file",
        arguments: { path: "huge-lines.txt" },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");

      const [body] = result.content.split("\n\n[truncated:");
      // The rendered (pre-notice) file content itself must respect the cap.
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(READ_FILE_MAX_BYTES);

      // Every returned line must be a COMPLETE rendered line ("N: " + the
      // full 2000-char line) — proves the cap trims on whole-line
      // boundaries and never splits a line mid-way.  Since offset defaults
      // to 1, the number of whole lines returned is also the last line
      // number returned.
      const bodyLines = body.split("\n");
      const lastLineReturned = bodyLines.length;
      for (const [idx, renderedLine] of bodyLines.entries()) {
        expect(renderedLine).toBe(`${idx + 1}: ${lineText}`);
      }
      // It must have stopped well short of the line limit (50 < 400) and
      // well short of the file's end, proving the byte cap — not the line
      // limit and not EOF — is what bound this read.
      expect(lastLineReturned).toBeLessThan(totalLines);

      // The notice must name the byte cap as the reason and the real last
      // line actually returned (not the line-limit boundary).
      expect(result.content).toContain(`(${READ_FILE_MAX_BYTES}-byte cap)`);
      expect(result.content).toContain(`showed lines 1-${lastLineReturned} of ${totalLines}`);
      expect(result.content).toContain(`offset=${lastLineReturned + 1}`);
      expect(result.detail).toBe(`lines 1-${lastLineReturned} of ${totalLines} (truncated)`);
    });

    it("returns error for missing file", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-6",
        name: "read_file",
        arguments: { path: "nonexistent.txt" },
      };
      const result = await tools.read_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("File not found");
    });
  });

  describe("write_file", () => {
    it("writes file and creates parent directories if needed", async () => {
      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-7",
        name: "write_file",
        arguments: { path: "sub/dir/output.txt", content: "hello world" },
      };
      const result = await tools.write_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");
      expect(result.content).toContain("Successfully wrote 11 bytes");

      const content = readFileSync(join(scratchDir, "sub/dir/output.txt"), "utf8");
      expect(content).toBe("hello world");
    });
  });

  describe("edit_file", () => {
    it("replaces target string when unique", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "const greeting = 'hello';\nconst name = 'world';", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-8",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "const greeting = 'hello';",
          new_string: "const greeting = 'hi';",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");

      const updated = readFileSync(filePath, "utf8");
      expect(updated).toBe("const greeting = 'hi';\nconst name = 'world';");
    });

    it("fails when target string is not found", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "some text", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-9",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "not here",
          new_string: "replacement",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("Target content old_string not found");
    });

    it("fails when target string matches multiple times", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "apple banana apple", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-10",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "apple",
          new_string: "orange",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("error");
      expect(result.content).toContain("matched 2 times");
    });

    it("writes replacement-pattern characters literally", async () => {
      const filePath = join(scratchDir, "target.txt");
      writeFileSync(filePath, "PLACEHOLDER", "utf8");

      const tools = createComputerTools({ cwd: scratchDir });
      const call: TurnToolCall = {
        id: "call-11",
        name: "edit_file",
        arguments: {
          path: "target.txt",
          old_string: "PLACEHOLDER",
          new_string: "$& costs $$5",
        },
      };
      const result = await tools.edit_file(call, dummyIdentity, dummyRuntime);
      expect(result.kind).toBe("result");

      const updated = readFileSync(filePath, "utf8");
      expect(updated).toBe("$& costs $$5");
    });
  });
});

// CONFINEMENT — a workspace-only bot (no This Computer grant) gets the file
// tools with `confinement` set, and every path is realpath-checked against
// the bot's workspace root.  The exact same class of escape bot-cwd.test.ts
// exercises for the phone-originated cwd path (symlinks out of the root,
// `..` traversal, absolute path elsewhere) — so the same set of failure
// scenarios lives here.
describe("createComputerTools with confinement (workspace-only bots)", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "bf-comp-confinement-"));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function confinedTools() {
    // realpath to mirror the production wiring in server/index.ts
    // (it calls `realOrResolved(cwd)` so confinement sees a canonical
    // path).  macOS resolves mkdtempSync(tmpdir()) through
    // /private/var/folders/... while the raw tmpdir() path is
    // /var/folders/..., so we must realpath or isInside rejects
    // in-workspace paths.
    return createComputerTools({ cwd: scratchDir, confinement: { workspaceRealpath: realpathSync(scratchDir) } });
  }

  function unconfinedTools() {
    // A This Computer bot: explicitly without `confinement` so the existing
    // whole-host view is unchanged.
    return createComputerTools({ cwd: scratchDir });
  }

  it("reads a file inside the workspace (positive case)", async () => {
    writeFileSync(join(scratchDir, "in.txt"), "hello\n");
    const result = await confinedTools().read_file(
      { id: "c-r1", name: "read_file", arguments: { path: join(scratchDir, "in.txt") } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("result");
    expect(result.content).toContain("hello");
  });

  it("refuses to read an absolute path that escapes the workspace (e.g. /etc/passwd)", async () => {
    const result = await confinedTools().read_file(
      { id: "c-r2", name: "read_file", arguments: { path: "/etc/passwd" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
    expect(result.content).toMatch(/outside this bot's workspace/i);
  });

  it("refuses to read a `..`-traversed path under the workspace that escapes it", async () => {
    const result = await confinedTools().read_file(
      { id: "c-r3", name: "read_file", arguments: { path: join(scratchDir, "..", "sibling.txt") } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
  });

  it("refuses a symlink inside the workspace that points outside (e.g. ~/.ssh)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "bf-comp-outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "ssh-private-key-bytes");
    const link = join(scratchDir, "escape");
    try {
      symlinkSync(outsideFile, link, "file");
    } catch {
      rmSync(outsideDir, { recursive: true, force: true });
      return; // no symlink permission on this runner
    }
    const result = await confinedTools().read_file(
      { id: "c-r4", name: "read_file", arguments: { path: link } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("refuses an INTERMEDIATE symlink inside the workspace that points outside (sub/ → /etc)", async () => {
    // Same realpath-safe check, but the symlink is a sub-FOLDER inside the
    // workspace, not the leaf file.  realOrResolved walks the full path so
    // the comparison must still reject this — same code path as
    // bot-cwd.test.ts:77-83 exercises for the cwdConfinementError side.
    const outsideDir = mkdtempSync(join(tmpdir(), "bf-comp-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "ssh-private-key-bytes");
    const subLink = join(scratchDir, "sub");
    try {
      symlinkSync(outsideDir, subLink, "dir");
    } catch {
      rmSync(outsideDir, { recursive: true, force: true });
      return; // no symlink permission on this runner
    }
    const result = await confinedTools().read_file(
      { id: "c-r4b", name: "read_file", arguments: { path: join(subLink, "secret.txt") } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("uses the canonical realpath when reading a symlink INSIDE the workspace", async () => {
    // Companion to the "returns realpath for syscall" hardening: a symlink
    // INSIDE the workspace that points to another file INSIDE the workspace
    // is allowed (real resolves to a sibling of the symlink, which still
    // satisfies isInside).  This pins that the executor reads via the
    // canonical path, not the unresolved candidate.
    const realFile = join(scratchDir, "real.txt");
    writeFileSync(realFile, "hello-canonical\n");
    const link = join(scratchDir, "alias.txt");
    try {
      symlinkSync(realFile, link, "file");
    } catch {
      return; // no symlink permission on this runner
    }
    const result = await confinedTools().read_file(
      { id: "c-r4c", name: "read_file", arguments: { path: link } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("result");
    expect(result.content).toContain("hello-canonical");
  });

  it("refuses to write an absolute path outside the workspace", async () => {
    const result = await confinedTools().write_file(
      { id: "c-w1", name: "write_file", arguments: { path: "/tmp/should-not-exist.txt", content: "nope" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
  });

  it("refuses to edit an absolute path outside the workspace", async () => {
    const result = await confinedTools().edit_file(
      { id: "c-e1", name: "edit_file", arguments: { path: "/etc/hostname", old_string: "x", new_string: "y" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("error");
    expect(result.detail).toBe("outside_workspace");
  });

  it("writes a new file inside the workspace (positive case)", async () => {
    const target = join(scratchDir, "nested", "new.txt");
    const result = await confinedTools().write_file(
      { id: "c-w2", name: "write_file", arguments: { path: target, content: "ok" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("result");
  });

  it("allows bash even when confinement is set — bash is gated on hostComputer only, so a workspace-only bot never sees it in production", async () => {
    // Regression guard: the P0 fix confines FILE tools, not bash.  bash
    // remains gated on hostComputer at the registry level, so a
    // workspace-only bot never sees it; this test pins the executor's
    // unchanged behavior (it still shells out unconfined) so a future
    // refactor that tries to also gate bash inside this file cannot
    // silently start adding a confinement check that changes the
    // production guarantee.
    const tools = confinedTools();
    expect(tools.bash).toBeDefined();
    const result = await tools.bash(
      { id: "c-b1", name: "bash", arguments: { command: "true" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.detail).not.toBe("outside_workspace");
  });

  it("a This Computer bot (no confinement set) keeps its whole-host view — this is the only path that legitimately touches /etc/hosts", async () => {
    // The confining change is opt-in via the `confinement` option, so a
    // caller (currently: the 1:1 and room dispatch paths when the bot has
    // hasHostComputer) that omits it gets exactly the pre-fix behavior.
    // macOS-only because /etc/hosts is a macOS path; skip elsewhere.
    if (process.platform !== "darwin") return;
    const result = await unconfinedTools().read_file(
      { id: "c-r5", name: "read_file", arguments: { path: "/etc/hosts" } },
      dummyIdentity,
      dummyRuntime,
    );
    expect(result.kind).toBe("result");
  });
});
