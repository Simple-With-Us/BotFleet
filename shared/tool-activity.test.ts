import { describe, expect, it } from "vitest";

import {
  classifyTool,
  clip,
  describeResult,
  describeTarget,
  shortenPath,
  toolActivity,
  toolVerb,
  TARGET_LIMIT,
} from "./tool-activity.ts";

describe("classifyTool", () => {
  it("lands every engine's spelling of the same job on one kind", () => {
    for (const name of ["Read", "read_file", "readFile", "view", "read-many-files"]) {
      expect(classifyTool(name)).toBe("read");
    }
    for (const name of ["Bash", "shell", "run_command", "runTerminalCommand", "local_shell"]) {
      expect(classifyTool(name)).toBe("execute");
    }
    for (const name of ["Edit", "write_file", "apply_patch", "str_replace_editor", "MultiEdit"]) {
      expect(classifyTool(name)).toBe("edit");
    }
  });

  it("prefers the engine's own kind over a guess from the name", () => {
    // ACP reports kind directly; an MCP tool named "acme_do" is unguessable
    expect(classifyTool("acme_do", "execute")).toBe("execute");
    expect(classifyTool("acme_do")).toBe("other");
  });

  it("does not guess when nothing matches, because a wrong icon is worse than none", () => {
    expect(classifyTool("mcp__sentry__find_organizations")).toBe("search");
    expect(classifyTool("zzz")).toBe("other");
    expect(classifyTool(undefined)).toBe("other");
  });
});

describe("toolVerb", () => {
  it("uses the shared verb for a recognised kind", () => {
    expect(toolVerb("read", "read_file")).toBe("Read");
    expect(toolVerb("execute", "run_command")).toBe("Run");
  });

  it("keeps the engine's own name when the kind is unknown, so the row still identifies the tool", () => {
    expect(toolVerb("other", "mcp__slack__send_message")).toBe("mcp__slack__send_message");
    expect(toolVerb("other", undefined)).toBe("Tool");
  });
});

describe("shortenPath", () => {
  it("replaces the home prefix, which is the part carrying no information", () => {
    expect(shortenPath("/Users/jay/apps/x/y.ts", "/Users/jay")).toBe("~/apps/x/y.ts");
    expect(shortenPath("/Users/jay", "/Users/jay")).toBe("~");
    expect(shortenPath("C:\\Users\\jay\\x", "C:\\Users\\jay")).toBe("~\\x");
  });

  it("drops the working folder first — the row should say which file, not where the bot lives", () => {
    // a hundred-step turn in one repo repeated the repo path a hundred times
    expect(shortenPath("/home/ada/apps/thing/server/index.ts", "/home/ada", "/home/ada/apps/thing")).toBe(
      "server/index.ts",
    );
    // outside the folder, home is still the fallback
    expect(shortenPath("/home/ada/notes.md", "/home/ada", "/home/ada/apps/thing")).toBe("~/notes.md");
    // the folder itself is not shortened to nothing
    expect(shortenPath("/home/ada/apps/thing", "/home/ada", "/home/ada/apps/thing")).toBe("~/apps/thing");
    // a sibling folder must not be mistaken for a child
    expect(shortenPath("/home/ada/apps/thing-two/x", "/home/ada", "/home/ada/apps/thing")).toBe(
      "~/apps/thing-two/x",
    );
  });

  it("leaves a path outside home alone, and survives no home at all", () => {
    expect(shortenPath("/etc/hosts", "/Users/jay")).toBe("/etc/hosts");
    expect(shortenPath("/etc/hosts")).toBe("/etc/hosts");
    // a sibling directory must not be mistaken for a child of home
    expect(shortenPath("/Users/jaywalker/x", "/Users/jay")).toBe("/Users/jaywalker/x");
  });
});

describe("clip", () => {
  it("flattens whitespace so a multi-line command stays one row", () => {
    expect(clip("git status\n  && git diff", 80)).toBe("git status && git diff");
  });

  it("marks the clip, so a reader knows the row is a headline", () => {
    const clipped = clip("x".repeat(200), 10);
    expect(clipped).toHaveLength(10);
    expect(clipped.endsWith("…")).toBe(true);
  });
});

describe("describeTarget", () => {
  it("prefers ACP's own locations, which is the spec's answer to this question", () => {
    expect(
      describeTarget({ file_path: "/tmp/ignored" }, { locations: [{ path: "/Users/jay/a.ts" }], home: "/Users/jay" }),
    ).toBe("~/a.ts");
  });

  it("counts the rest when a step touched more than one file", () => {
    expect(
      describeTarget({}, { locations: [{ path: "/a.ts" }, { path: "/b.ts" }, { path: "/c.ts" }] }),
    ).toBe("/a.ts +2");
  });

  it("reads the command before anything else a shell payload carries", () => {
    expect(describeTarget({ cwd: "/repo", command: "pnpm test" })).toBe("pnpm test");
  });

  it("finds the file, pattern, query or url each engine names differently", () => {
    expect(describeTarget({ file_path: "/Users/jay/a.ts" }, { home: "/Users/jay" })).toBe("~/a.ts");
    expect(describeTarget({ AbsolutePath: "/Users/jay/a.ts" }, { home: "/Users/jay" })).toBe("~/a.ts");
    expect(describeTarget({ target_file: "src/x.ts" })).toBe("src/x.ts");
    expect(describeTarget({ TargetFile: "src/x.ts" })).toBe("src/x.ts");
    expect(describeTarget({ CommandLine: "git status -s", Cwd: "/repo" })).toBe("git status -s");
    expect(describeTarget({ pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(describeTarget({ url: "https://example.com" })).toBe("https://example.com");
  });

  it("falls back to any scalar rather than saying nothing", () => {
    expect(describeTarget({ weird_field: "something" })).toBe("something");
  });

  it("clips, so one megabyte of payload can never reach a transcript row", () => {
    const target = describeTarget({ command: "x".repeat(5_000) });
    expect(target).toBeDefined();
    expect(target!.length).toBeLessThanOrEqual(TARGET_LIMIT);
  });

  it("returns nothing when the payload names nothing", () => {
    expect(describeTarget(undefined)).toBeUndefined();
    expect(describeTarget({})).toBeUndefined();
    expect(describeTarget({ enabled: true })).toBeUndefined();
  });
});

describe("describeResult", () => {
  it("reads the text out of an ACP content block", () => {
    expect(describeResult([{ type: "content", content: { type: "text", text: "3 files changed" } }])).toBe(
      "3 files changed",
    );
  });

  it("reads a plain string and a Claude tool_result alike", () => {
    expect(describeResult("exit 0")).toBe("exit 0");
    expect(describeResult([{ type: "text", text: "not found" }])).toBe("not found");
  });

  it("returns nothing for an empty result, so a clean step stays a bare row", () => {
    expect(describeResult(undefined)).toBeUndefined();
    expect(describeResult([])).toBeUndefined();
    expect(describeResult({})).toBeUndefined();
  });

  // Tool output is the one place a live credential arrives by accident, and
  // this line is kept twice over — in the transcript and on the Sentry span.
  // Redaction has to beat the clip: a secret cut at DETAIL_LIMIT has lost the
  // closing marker its pattern anchors on, so redacting afterwards finds
  // nothing.  Fixtures are obviously fake and longer than the clip.
  it("redacts a secret in tool output BEFORE clipping it", () => {
    const body = "FAKEFAKE".repeat(38); // 304 chars, outlives DETAIL_LIMIT
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const out = String(describeResult(pem));
    expect(out).not.toContain("FAKEFAKE");
    // the clip did not get to cut the block apart, so the shape survives whole
    expect(out).toContain("BEGIN RSA PRIVATE KEY");
    expect(out).toContain("END RSA PRIVATE KEY");
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("redacts through every wrapper shape a driver hands it", () => {
    const opaque = `FAKE${"0123456789".repeat(30)}`;
    const raw = `POST failed {"api_key":"${opaque}","retry":false}`;
    for (const payload of [
      raw,
      [{ type: "text", text: raw }],
      { output: raw },
      [{ type: "content", content: { type: "text", text: raw } }],
    ]) {
      const out = String(describeResult(payload));
      expect(out, JSON.stringify(payload).slice(0, 40)).not.toContain(opaque.slice(0, 24));
      expect(out).toContain("«redacted");
    }
  });

  // This runs on the synchronous event path, so the redaction pass has to
  // stay bounded: a tool that dumps a log file hands us megabytes, and only
  // 240 characters of it can ever be kept.
  it("does not scan a megabyte of tool output to keep 240 characters", () => {
    const huge = `${"x".repeat(5_000_000)}\n${"Auth" + "orization"}: Basic FAKEFAKEFAKEFAKEFAKE`;
    const started = Date.now();
    const out = String(describeResult(huge));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toHaveLength(240);
    expect(out.startsWith("xxxx")).toBe(true);
  });

  it("widens the window when masking compresses the text below the limit", () => {
    // Each of these is longer than the clip on its own, so redacting only a
    // narrow prefix would leave far too little text to fill the row — the
    // window has to grow until the clip is satisfied.
    const many = Array.from(
      { length: 60 },
      (_, i) => `{"api_key":"FAKE${String(i).padStart(4, "0")}${"0123456789".repeat(40)}"}`,
    ).join("\n");
    const out = String(describeResult(many));
    expect(out).toHaveLength(240);
    expect(out).not.toMatch(/0123456789012345/);
    expect(out).toContain("«redacted");
  });

  it("leaves ordinary tool output untouched", () => {
    expect(describeResult("error: cannot find module ./keyboard-shortcuts.ts")).toBe(
      "error: cannot find module ./keyboard-shortcuts.ts",
    );
  });
});

describe("toolActivity", () => {
  it("derives the whole row in one call", () => {
    expect(
      toolActivity("read_file", { rawInput: { file_path: "/Users/jay/apps/a.ts" }, home: "/Users/jay" }),
    ).toEqual({ kind: "read", verb: "Read", target: "~/apps/a.ts" });
  });

  it("still produces a usable row when the engine sent nothing but a name", () => {
    expect(toolActivity("Bash")).toEqual({ kind: "execute", verb: "Run", target: undefined });
  });
});
