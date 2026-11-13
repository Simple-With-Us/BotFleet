import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  qdrantAccessWarning,
  qdrantLastSuccessLabel,
  qdrantRouteLabel,
  qdrantStateLabel,
  qdrantTestResultIfCurrent,
  settleQdrantSave,
  settleQdrantSaveWithStatusFence,
  waitForLatestQdrantSave,
} from "./qdrant-status";

describe("Qdrant RAG status copy", () => {
  it("uses the server-selected route and last successful check", () => {
    const status = {
      ready: false,
      source: "recall-service" as const,
      checkedAt: Date.UTC(2026, 8, 12, 10),
      lastSuccessAt: Date.UTC(2026, 8, 12, 9, 30),
    };

    expect(qdrantRouteLabel(status, "")).toBe("Recall service");
    expect(qdrantStateLabel(status)).toBe("Needs attention");
    expect(qdrantLastSuccessLabel(status)).toBe("Sep 12, 2026, 4:30 AM CDT");
  });

  it("remains useful with the old status payload", () => {
    expect(qdrantRouteLabel({ ready: true }, "")).toBe("This Mac's recall CLI");
    expect(qdrantRouteLabel({ ready: true }, "https://recall.example.test")).toBe("Recall service");
    expect(qdrantLastSuccessLabel({ ready: true })).toBe("None recorded");
    expect(qdrantStateLabel({ ready: true })).toBe("Ready");
  });

  it("turns a rejected save into visible local failure state", async () => {
    await expect(settleQdrantSave(async () => { throw new Error("settings are locked"); })).resolves.toEqual({
      ok: false,
      error: "settings are locked",
    });
  });

  it("does not clear a connection result started while a field save is pending", async () => {
    let finishSave!: (value: string) => void;
    const save = new Promise<string>((resolve) => {
      finishSave = resolve;
    });
    let testRevision = 0;
    const result = settleQdrantSaveWithStatusFence(() => save, testRevision, () => testRevision);

    testRevision += 1;
    finishSave("saved");

    await expect(result).resolves.toEqual({ ok: true, value: "saved", clearTestResult: false });
  });

  it("waits for the latest field save before starting a connection test", async () => {
    let finishSave!: (saved: boolean) => void;
    let pending: Promise<boolean> | null = new Promise<boolean>((resolve) => {
      finishSave = resolve;
    });
    const events: string[] = [];
    const test = waitForLatestQdrantSave(() => pending).then((saved) => {
      if (saved) events.push("status requested");
    });

    await Promise.resolve();
    expect(events).toEqual([]);
    const completing = pending;
    finishSave(true);
    pending = null;
    await completing;
    await test;

    expect(events).toEqual(["status requested"]);
  });

  it("keeps a failed save blocking tests after its promise settles", async () => {
    let failed = true;

    await expect(waitForLatestQdrantSave(() => null, () => failed)).resolves.toBe(false);
    failed = false;
    await expect(waitForLatestQdrantSave(() => null, () => failed)).resolves.toBe(true);
  });

  it("drops a connection result from before a newer save", () => {
    let testRevision = 1;
    const result = { ready: true };

    testRevision += 1;

    expect(qdrantTestResultIfCurrent(1, () => testRevision, result)).toBeNull();
    expect(qdrantTestResultIfCurrent(2, () => testRevision, result)).toBe(result);
  });
});

describe("Cloudflare Access service-token warning", () => {
  // The live shape of this bug on this Mac: the client secret was stored and
  // the client id was empty, which sends NO Access headers at all — so a
  // service behind Access answers a login page and the panel reads like an
  // outage rather than like a missing field.
  it("names the missing half when only one is set", () => {
    expect(qdrantAccessWarning("missing-id")).toBe(
      "The Cloudflare Access client id is missing, so the cloud recall service will refuse this Mac.",
    );
    expect(qdrantAccessWarning("missing-secret")).toBe(
      "The Cloudflare Access client secret is missing, so the cloud recall service will refuse this Mac.",
    );
  });

  it("stays quiet for a whole pair, for no pair, and for a status payload that predates the field", () => {
    // Most services are not behind Access at all, so "none" must not nag.
    expect(qdrantAccessWarning("complete")).toBeNull();
    expect(qdrantAccessWarning("none")).toBeNull();
    expect(qdrantAccessWarning(undefined)).toBeNull();
  });

  it("is sentence case, as status text rather than a heading", () => {
    const warning = qdrantAccessWarning("missing-id")!;
    expect(warning).toMatch(/^[A-Z][a-z]/);
    expect(warning).not.toMatch(/Client Id|Client Secret/);
    expect(warning.endsWith(".")).toBe(true);
  });
});

describe("the panel shows the warning it is given", () => {
  const PANEL_SRC = readFileSync(join(__dirname, "..", "components", "QdrantRagConnection.tsx"), "utf8");

  it("reads the state from the status payload, falling back to the saved config", () => {
    expect(PANEL_SRC).toContain("qdrantAccessWarning(testResult?.accessTokenState ?? qdrant?.accessTokenState)");
    expect(PANEL_SRC).toContain("{accessWarning}");
  });
});
