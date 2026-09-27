import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listenWebhookIngress, MAX_WEBHOOK_BODY_BYTES, webhookCredential, type WebhookIngress } from "./webhook-ingress.ts";
import { WebhookManager } from "./webhooks.ts";

let dir: string;
let ingress: WebhookIngress;
let endpointId: string;
let secret: string;
let manager: WebhookManager;
const queued: Array<Record<string, unknown>> = [];
let admitting = true;
let activeAdmissions = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-webhook-ingress-"));
  manager = new WebhookManager({
    file: join(dir, "webhooks.json"),
    botState: () => "ready",
    enqueue: (input) => {
      queued.push(input);
      return { id: `run-${queued.length}` };
    },
  });
  const created = manager.create({ name: "Build event", prompt: "Review the build", botId: "maus-1" });
  endpointId = created.webhook.endpointId;
  secret = created.secret;
  ingress = await listenWebhookIngress(manager, {
    port: 0,
    beginAdmission: () => {
      if (!admitting) return null;
      activeAdmissions += 1;
      return () => { activeAdmissions -= 1; };
    },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook-only ingress", () => {
  it("exposes health but nothing from the main BotFleet API", async () => {
    const health = await fetch(`${ingress.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ app: "botfleet-webhooks", ready: true });
    expect((await fetch(`${ingress.baseUrl}/api/bots`)).status).toBe(404);
  });

  it("accepts capability URLs and deduplicates retries", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const send = () => fetch(credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "delivery-1", "x-github-event": "push" },
      body: JSON.stringify({ ref: "main", id: "event-in-body" }),
    });
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, duplicate: false, runId: "run-1" });
    const retry = await send();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: "run-1" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.prompt).toContain("Event: push");
    expect(activeAdmissions).toBe(0);
  });

  it("also accepts a bearer secret without putting it in the URL", async () => {
    const response = await fetch(`${ingress.baseUrl}/hooks/${endpointId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded" },
      body: "ticket=42&priority=high",
    });
    expect(response.status).toBe(202);
    expect(queued.at(-1)?.prompt).toMatch(/"ticket"\s*:\s*"42"/);
  });

  it("refuses new deliveries while the runtime admission fence is held", async () => {
    admitting = false;
    try {
      const before = queued.length;
      const response = await fetch(webhookCredential(ingress.baseUrl, endpointId, secret).url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "must wait" }),
      });
      expect(response.status).toBe(503);
      expect(queued).toHaveLength(before);
      expect(activeAdmissions).toBe(0);
    } finally {
      admitting = true;
    }
  });

  it("deduplicates configured Sentry issue Request-ID deliveries while preserving distinct actions", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const before = queued.length;
    // Header names and Request-ID shape were verified in the configured
    // internal app's failed-delivery log.  IDs and payload below are synthetic.
    const send = (requestId: string, action: string) => fetch(credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "request-id": requestId, "sentry-hook-resource": "issue" },
      body: JSON.stringify({ action, data: { issue: { id: "fixture-issue" } } }),
    });
    const first = await send("a".repeat(32), "resolved");
    expect(await first.json()).toMatchObject({ accepted: true, duplicate: false });
    expect(await (await send("a".repeat(32), "resolved")).json()).toMatchObject({ accepted: true, duplicate: true });
    expect(await (await send("b".repeat(32), "unresolved")).json()).toMatchObject({ accepted: true, duplicate: false });
    expect(await (await send("c".repeat(32), "resolved")).json()).toMatchObject({ accepted: true, duplicate: false });
    expect(queued).toHaveLength(before + 3);
  });

  it("retains PagerDuty x-webhook-id precedence and does not treat generic request IDs as deliveries", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const before = queued.length;
    const send = (headers: Record<string, string>) => fetch(credential.url, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ event: { id: "pd-fixture" } }),
    });
    expect(await (await send({ "x-webhook-id": "pd-delivery", "request-id": "d".repeat(32) })).json()).toMatchObject({ duplicate: false });
    expect(await (await send({ "x-webhook-id": "pd-delivery", "request-id": "e".repeat(32) })).json()).toMatchObject({ duplicate: true });
    expect(await (await send({ "request-id": "f".repeat(32) })).json()).toMatchObject({ duplicate: false });
    expect(await (await send({ "request-id": "f".repeat(32) })).json()).toMatchObject({ duplicate: false });
    expect(queued).toHaveLength(before + 3);
  });

  it("does not deduplicate separate requests that reuse a generic payload id", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const before = queued.length;
    const send = () => fetch(credential.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "shared-record", task: "Handle this update" }),
    });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect(queued).toHaveLength(before + 2);
  });

  it("captures a verification event without queueing work", async () => {
    const created = manager.create({ name: "Verify", prompt: "", botId: "maus-1", enabled: false, verificationPending: true });
    const before = queued.length;
    const response = await fetch(webhookCredential(ingress.baseUrl, created.webhook.endpointId, created.secret).url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-event": "support.created" },
      body: JSON.stringify({ task: "Triage ticket 42" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, captured: true });
    expect(queued).toHaveLength(before);
    expect(manager.list().find((webhook) => webhook.id === created.webhook.id)).toMatchObject({ verificationPending: false, enabled: false });
  });

  it("rejects invalid credentials, malformed JSON and oversized bodies", async () => {
    const unauthorized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/wrong`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const malformed = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/${secret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/${secret}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(manager.listAttempts().filter((attempt) => attempt.webhookId === manager.list().find((webhook) => webhook.endpointId === endpointId)?.id && attempt.outcome === "rejected").length).toBeGreaterThanOrEqual(3);
  });
});

describe("webhook-only ingress fixed routes", () => {
  it("serves a mounted partner route (Linq) on the ingress listener, POST only, behind admission", async () => {
    const seen: string[] = [];
    let admit = true;
    const routed = await listenWebhookIngress(manager, {
      port: 0,
      beginAdmission: () => (admit ? () => {} : null),
      routes: {
        "/api/webhooks/linq": async (req, res) => {
          seen.push(req.method ?? "");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        },
      },
    });
    try {
      const ok = await fetch(`${routed.baseUrl}/api/webhooks/linq`, { method: "POST", body: "{}" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      expect((await fetch(`${routed.baseUrl}/api/webhooks/linq`)).status).toBe(405);
      admit = false;
      expect((await fetch(`${routed.baseUrl}/api/webhooks/linq`, { method: "POST", body: "{}" })).status).toBe(503);
      expect(seen).toEqual(["POST"]);
      // Mounting a route does not open the rest of the app API.
      expect((await fetch(`${routed.baseUrl}/api/bots`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => routed.server.close(() => resolve()));
    }
  });
});
