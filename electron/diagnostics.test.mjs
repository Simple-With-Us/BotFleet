import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { CREDENTIAL_TOKEN_PATTERNS } from "../shared/redact.ts";

const require = createRequire(import.meta.url);
const {
  buildDiagnosticsReport,
  decodeLogTail,
  diagnosticsFileName,
  redactSecretsInLine,
  CREDENTIAL_ENV_NAMES,
} = require("./diagnostics.mjs");

// The desktop shell cannot import TypeScript, so its credential list is a
// hand copy of server/config.ts WORKSPACE_CREDENTIAL_ENV. This test is the
// drift alarm: a name added server-side without updating the copy here would
// otherwise ship an unredacted export path.
describe("credential env parity with server/config.ts", () => {
  it("matches WORKSPACE_CREDENTIAL_ENV exactly", () => {
    const config = readFileSync(new URL("../server/config.ts", import.meta.url), "utf8");
    const match = config.match(/WORKSPACE_CREDENTIAL_ENV = \[([\s\S]*?)\] as const/);
    expect(match).not.toBeNull();
    const names = [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(CREDENTIAL_ENV_NAMES).toEqual(names);
  });
});

// S13, second half. The token-shape list in diagnostics.mjs is the same
// mechanical copy as CREDENTIAL_ENV_NAMES above, and for the same reason: this
// shell is plain `.mjs` on Electron's own Node with no transpile step, so it
// cannot import shared/redact.ts at runtime. The difference is that the copy
// is now checked against the redactor's own export — pattern by pattern,
// `.source` for `.source` — rather than against nothing. A bug report is
// pasted into a public issue, so a shape the redactor knows and this list
// does not is a credential shipped in the clear, and that is exactly the
// drift the audit found: four of the five added shapes were missing here when
// the two lists were each maintained by hand.
describe("credential shape parity with shared/redact.ts", () => {
  it("carries every shape the redactor knows, in the same order", () => {
    const source = readFileSync(new URL("./diagnostics.mjs", import.meta.url), "utf8");
    const block = source.match(/const CREDENTIAL_TOKEN_FORMATS = \[([\s\S]*?)\n\];/);
    expect(block, "CREDENTIAL_TOKEN_FORMATS is no longer a plain array literal").not.toBeNull();
    // The same pattern literals, read out of the array rather than imported —
    // importing them would require exporting the const, and a copy that
    // cannot be reached from the test is a copy nothing pins.
    const copied = [...block[1].matchAll(/\/(.+)\/([a-z]*)/g)].map((m) => m[1]);
    expect(copied).toEqual(CREDENTIAL_TOKEN_PATTERNS.map((token) => token.source));
  });

  it("redacts every value the shared redactor's S13 shapes are there for", () => {
    // Assembled at runtime so no credential-shaped literal sits in the source.
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const samples = [
      ["stripe live", ["sk", "_live_", alpha.slice(0, 14)].join("")],
      ["stripe test", ["sk", "_test_", alpha.slice(0, 14)].join("")],
      ["generic access key", ["ak", "_", alpha].join("")],
      ["webhook signing secret", ["wh", "sec_", "test", "_", "fake"].join("")],
      ["google oauth", ["ya29", ".", "fake"].join("")],
      ["gitlab pat", ["glpat", "-", "fake0000"].join("")],
    ];
    for (const [label, sample] of samples) {
      const out = redactSecretsInLine(`login failed while sending ${sample}`);
      expect(out, `${label}: ${sample}`).not.toContain(sample);
      expect(out).toMatch(/«redacted \d+ chars»/);
    }
  });
});

describe("buildDiagnosticsReport", () => {
  const appInfo = {
    version: "0.1.27",
    platform: "darwin",
    arch: "arm64",
    electron: "43.4.0",
    node: "24.0.0",
    packaged: true,
    uptimeSeconds: 42,
  };

  it("renders app facts and a sorted config summary", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {
        xai: { configured: true },
        box: { configured: false },
        rooms: { turnTimeoutMinutes: 5 },
      },
      logTail: "",
    });
    expect(report).toContain("version=0.1.27");
    expect(report).toContain("platform=darwin");
    expect(report).toContain("arch=arm64");
    expect(report).toContain("xai.configured=true");
    expect(report).toContain("box.configured=false");
    expect(report).toContain("rooms.turnTimeoutMinutes=5");
    expect(report).toContain("(server log unavailable)");
  });

  it("drops strings, non-scalars and credential-shaped summary values", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {
        xai: { key: "xai-real-secret" },
        composio: { apiKey: "ak_live_abcdef123456789" },
        vps: { sshAlias: "" },
        profile: { name: "Ada" },
        instances: [{ driver: "claudeAgent", environment: { TOKEN: "hunter2" } }],
        note: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      },
      logTail: "",
    });
    expect(report).not.toContain("xai-real-secret");
    expect(report).not.toContain("ak_live_abcdef123456789");
    expect(report).not.toContain("hunter2");
    expect(report).not.toContain("driver");
    expect(report).not.toContain("environment");
    expect(report).not.toContain("profile.name=");
    expect(report).not.toContain("Ada");
    expect(report).not.toContain("note=");
  });

  it("never includes an absolute log path in the report heading", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: "server ready",
      logPath: "/Users/ada/Library/Logs/BotFleet/server.log",
    });
    expect(report).toContain("## Server log tail");
    expect(report).not.toContain("/Users/ada");
  });

  it.each(CREDENTIAL_ENV_NAMES)("masks any value riding on %s in the log tail", (name) => {
    const value = "s3cr3t-value-123456";
    const line = `spawn env ${name}=${value} ready`;
    const report = buildDiagnosticsReport({ appInfo, configSummary: {}, logTail: line });
    expect(report).not.toContain(value);
    expect(redactSecretsInLine(line)).toBe(`spawn env ${name}=«redacted ${value.length} chars» ready`);
  });

  it("masks generic key=value secrets and content-shaped tokens in the log tail", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: [
        'config {"apiKey":"sk-proj-abcdefghijklmnop"}',
        "Authorization: Bearer abcdefghijklmnop",
        "password=hunter2000",
      ].join("\n"),
    });
    expect(report).not.toContain("sk-proj-abcdefghijklmnop");
    expect(report).not.toContain("abcdefghijklmnop");
    expect(report).not.toContain("hunter2000");
    expect(report).toContain("«redacted");
  });

  it.each([
    "sk" + "_live_abcdefghijklmnopqrstuvwxyz0123456789",
    "sk" + "_test_abcdefghijklmnopqrstuvwxyz0123456789",
    "wh" + "sec_abcdefghijklmnopqrstuvwxyz0123456789",
    "ya29" + ".abcdefghijklmnopqrstuvwxyz0123456789abcdefghij",
    "glpat" + "-abcdefghijklmnopqrst",
  ])("masks the issued-credential shape %s", (token) => {
    // S13: credential shapes BotFleet itself issues or stores must not ride
    // out in a diagnostics bundle.
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: `token ${token} ok`,
    });
    expect(report).not.toContain(token);
    expect(report).toContain("«redacted");
  });

  it.each(["Bearer abcdefghijklmnop", "Basic dXNlcjpwYXNzd29yZA=="])(
    "masks the full Authorization credential for %s",
    (authorization) => {
      const report = buildDiagnosticsReport({
        appInfo,
        configSummary: {},
        logTail: `request Authorization: ${authorization}`,
      });
      expect(report).not.toContain(authorization);
      expect(report).not.toContain(authorization.split(" ")[1]);
      expect(report).toContain("Authorization=«redacted");
    },
  );

  it("masks a multiline PEM private key as one value", () => {
    const report = buildDiagnosticsReport({
      appInfo,
      configSummary: {},
      logTail: [
        "loading credential",
        "-----BEGIN PRIVATE KEY-----",
        "super-secret-line-one",
        "super-secret-line-two",
        "-----END PRIVATE KEY-----",
        "ready",
      ].join("\n"),
    });
    expect(report).not.toContain("super-secret-line-one");
    expect(report).not.toContain("super-secret-line-two");
    expect(report).toContain("«redacted private key»");
  });

  it("leaves ordinary log lines untouched", () => {
    const line = "[2026-08-22T20:00:00.000Z] [out] fork server/index.js port=8799 spawned pid=4242";
    expect(redactSecretsInLine(line)).toBe(line);
  });

  it("handles an empty or missing log gracefully", () => {
    for (const logTail of ["", null, undefined]) {
      const report = buildDiagnosticsReport({ appInfo, configSummary: {}, logTail });
      expect(report).toContain("(server log unavailable)");
      expect(report.endsWith("\n")).toBe(true);
    }
  });

  it("keeps long prose lines that merely mention a key by name", () => {
    const line = "user asked whether the XAI_API_KEY variable needs to be set manually";
    expect(redactSecretsInLine(line)).toBe(line);
  });
});

describe("decodeLogTail", () => {
  it("preserves the full buffer when the read starts at the beginning", () => {
    expect(decodeLogTail(Buffer.from("first\nsecond"), false)).toEqual({ tail: "first\nsecond", bytes: 12 });
  });

  it("drops a credential assignment split by a bounded tail read", () => {
    const decoded = decodeLogTail(Buffer.from("RET=split-secret\nserver ready\n"), true);
    expect(decoded).toEqual({ tail: "server ready\n", bytes: 13 });
    expect(decoded.tail).not.toContain("split-secret");
  });

  it("returns an empty tail when a truncated buffer has no complete line", () => {
    expect(decodeLogTail(Buffer.from("partial-secret"), true)).toEqual({ tail: "", bytes: 0 });
  });
});

describe("diagnosticsFileName", () => {
  it("uses botfleet-diagnostics-YYYYMMDD-HHmmss.txt", () => {
    expect(diagnosticsFileName(new Date(2026, 7, 22, 16, 5, 9))).toBe(
      "botfleet-diagnostics-20260822-160509.txt",
    );
  });
});
