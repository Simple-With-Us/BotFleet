/**
 * Report a Problem: the issue body this app can put in a PUBLIC repository.
 *
 * Two properties are load-bearing and neither is optional.  A secret that
 * rode in on an error string must be gone before the URL is built, and the
 * body must carry enough build context that a maintainer can tell which
 * build filed it.  A test that stops asserting either one is the bug.
 */
import { describe, expect, it } from "vitest";

import {
  buildFallbackIssueUrl,
  readReportDiagnostics,
  REPORT_ISSUE_LABELS,
  resetReportBuildIdentityForTests,
  setReportBuildIdentityForTests,
} from "./sentry";

// Obviously fake, and shaped like the real thing: a bearer token with the
// "sk-" prefix the redactor keys on, plus a bearer-style assignment.
//
// Assembled at run time, never spelled out: a literal with a real provider's
// shape is what GitHub push protection blocks on, and a security branch is
// exactly where a blocked push is most expensive.  The values are still the
// shapes the redactor keys on — the same trick `sentry-ai-live-sink.test.ts`
// uses, for the same reason.
const FAKE_SECRET_BEARER = ["sk", "-ant-api03-", "F".repeat(24), "-fa", "ke-fa"].join("");
const FAKE_SECRET_ASSIGNED = ["xox", "b-111111111111-", "222222222222-", "F".repeat(28)].join("");

function bodyOf(url: string): string {
  const raw = url.split("body=")[1];
  return decodeURIComponent(raw.split("&labels=")[0]);
}

describe("buildFallbackIssueUrl — redaction", () => {
  it("keeps a synthetic secret out of the generated issue body", () => {
    const url = buildFallbackIssueUrl(
      "Report a Problem",
      `Error encountered: request failed with Authorization: Bearer ${FAKE_SECRET_BEARER} and com_openai_key=${FAKE_SECRET_ASSIGNED}`,
    );
    const body = bodyOf(url);
    expect(body).not.toContain(FAKE_SECRET_BEARER);
    expect(body).not.toContain(FAKE_SECRET_ASSIGNED);
    expect(body).toContain("redacted");
    // The shape survives, which is what a maintainer actually debugs with.
    expect(body).toContain("Authorization");
  });

  it("redacts before the body is measured, not after the URL is assembled", () => {
    // A secret is longer than its mask, so redaction-after-encoding would
    // blow the budget; redaction-first is why this stays inside it.
    const url = buildFallbackIssueUrl("Report a Problem", `token=${FAKE_SECRET_ASSIGNED} `.repeat(6));
    expect(url.length).toBeLessThanOrEqual(2000);
    expect(bodyOf(url)).not.toContain(FAKE_SECRET_ASSIGNED);
  });
});

describe("buildFallbackIssueUrl — diagnostic context", () => {
  it("marks the context block synthetic and carries version, build, OS, architecture, and engine", () => {
    const body = bodyOf(
      buildFallbackIssueUrl("Report a Problem", "Error encountered: something broke", 2000, {
        appVersion: "1.2.3",
        build: "abc1234def56",
        os: "macOS 15.6",
        architecture: "arm 64-bit",
        engine: "Claude Code 2.0.1",
      }),
    );
    expect(body).toContain("**Diagnostics (synthetic");
    expect(body).toContain("- App version: 1.2.3");
    expect(body).toContain("- Build: abc1234def56");
    expect(body).toContain("- OS: macOS 15.6");
    expect(body).toContain("- Architecture: arm 64-bit");
    expect(body).toContain("- Engine: Claude Code 2.0.1");
  });

  it("still names every field when the build identity is unknown", () => {
    resetReportBuildIdentityForTests();
    const body = bodyOf(buildFallbackIssueUrl("Report a Problem", "Error encountered: something broke"));
    expect(body).toContain("- App version: unknown");
    expect(body).toContain("- Build: unknown");
    expect(body).toContain("- OS:");
    expect(body).toContain("- Architecture:");
    expect(body).toContain("- Engine: unknown");
  });

  it("flattens a multi-line value so it cannot reformat the block", () => {
    const body = bodyOf(
      buildFallbackIssueUrl("Report a Problem", "boom", 2000, { os: "macOS\n- Build: spoofed" }),
    );
    expect(body).toContain("- OS: macOS - Build: spoofed");
    // Exactly one real Build line, so the spoofed one cannot pass for it.
    expect(body.match(/^- Build: /gm)).toHaveLength(1);
  });

  it("prefers the primed build identity over unknown", () => {
    setReportBuildIdentityForTests({ appVersion: "9.9.9", build: "0123456789abcdef0123456789abcdef01234567" });
    const body = bodyOf(buildFallbackIssueUrl("Report a Problem", "boom"));
    expect(body).toContain("- App version: 9.9.9");
    expect(body).toContain("- Build: 0123456789ab");
    setReportBuildIdentityForTests({});
  });
});

describe("buildFallbackIssueUrl — labels", () => {
  it("carries the report labels so a filed report is not ordinary triage", () => {
    const url = buildFallbackIssueUrl("Report a Problem", "boom");
    expect(url).toContain(`&labels=${encodeURIComponent(REPORT_ISSUE_LABELS.join(","))}`);
    // `bug` already exists in the repo; `user-report` is the one that has to
    // be created.  Both are lowercase kebab, matching `effort-in-progress`.
    for (const label of REPORT_ISSUE_LABELS) expect(label).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("readReportDiagnostics", () => {
  it("reads OS and architecture from UA client hints when the window has them", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgentData: {
          platform: "macOS",
          platformVersion: "15.6",
          architecture: "arm",
          bitness: "64",
        },
      },
    });
    try {
      setReportBuildIdentityForTests({ appVersion: "1.0.0", build: "deadbeefcafe" });
      const diagnostics = readReportDiagnostics({ engine: "Codex 1.2.3" });
      expect(diagnostics).toEqual({
        appVersion: "1.0.0",
        build: "deadbeefcafe",
        os: "macOS 15.6",
        architecture: "arm 64-bit",
        engine: "Codex 1.2.3",
      });
    } finally {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      setReportBuildIdentityForTests({});
    }
  });
});
