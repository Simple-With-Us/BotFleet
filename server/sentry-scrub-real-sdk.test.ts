import http from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isWebhookIngressPath, safeScrubHook } from "./sentry.ts";

// Drives the real @sentry/node through a no-op transport.  The stand-in SDK
// in sentry.test.ts only ever hands the hooks plain JSON, but a real event
// carries live SDK objects (a captured Scope, the client, its promise
// buffer), and a walk that wrote into one of those threw on every
// transaction.  These tests keep the hooks honest against the real shapes.

const SECRET = "whsec_realsdkprobe123";
const envelopes: string[] = [];

beforeAll(() => {
  Sentry.init({
    dsn: "https://public@example.invalid/1",
    tracesSampleRate: 1,
    enableLogs: true,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
    integrations: [Sentry.httpIntegration({ ignoreIncomingRequests: (urlPath) => isWebhookIngressPath(urlPath) })],
    beforeSend: (event) => safeScrubHook(event),
    beforeSendTransaction: (event) => safeScrubHook(event),
    beforeSendLog: (log) => safeScrubHook(log),
  });
});

afterAll(async () => {
  await Sentry.close(2000);
});

function itemsOfType(type: string): unknown[] {
  const out: unknown[] = [];
  for (const raw of envelopes) {
    const [, items] = JSON.parse(raw) as [unknown, Array<[{ type: string }, unknown]>];
    for (const [header, body] of items) if (header.type === type) out.push(body);
  }
  return out;
}

function internalErrorEvents(): unknown[] {
  return itemsOfType("event").filter((body) => JSON.stringify(body).includes("which has only a getter"));
}

describe("webhook-secret scrub against the real Sentry SDK", () => {
  it("still sends a transaction for a plain gen_ai span", async () => {
    envelopes.length = 0;
    Sentry.startSpan({ name: "invoke_agent plain", op: "gen_ai.invoke_agent" }, () => {});
    await Sentry.flush(2000);
    const names = itemsOfType("transaction").map((t) => (t as { transaction?: string }).transaction);
    expect(names).toContain("invoke_agent plain");
    expect(internalErrorEvents()).toHaveLength(0);
  });

  it("keeps the secret out of every envelope sent while a /hooks request is handled", async () => {
    envelopes.length = 0;
    const server = http.createServer((req, res) => {
      Sentry.addBreadcrumb({ category: "console", message: `got ${req.url}` });
      Sentry.captureException(new Error("webhook receiver broke"));
      Sentry.startSpan({ name: "invoke_agent hook", op: "gen_ai.invoke_agent" }, () => {});
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/hooks/wh_probe/${SECRET}`, { method: "POST" });
      await res.text();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Sentry.flush(2000);

    const names = itemsOfType("transaction").map((t) => (t as { transaction?: string }).transaction);
    expect(names).toContain("invoke_agent hook");
    const errors = itemsOfType("event");
    expect(errors.some((e) => JSON.stringify(e).includes("webhook receiver broke"))).toBe(true);
    expect(internalErrorEvents()).toHaveLength(0);
    for (const raw of envelopes) expect(raw).not.toContain(SECRET);
  });
});
