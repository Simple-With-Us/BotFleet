import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CompanionGatewayCard,
  describeIngressTestOutcome,
  RemoteAccessSection,
  TestConnectionControl,
} from "./RemoteAccessSection";
import {
  COMPANION_GATEWAY_BLURB,
  COMPANION_GATEWAY_LABEL,
  REMOTE_ACCESS_BLURB,
  REMOTE_ACCESS_HEADING,
  REMOTE_ACCESS_UNCONFIGURED_BLURB,
  REMOTE_URL_LABEL,
  sentenceGapHtml,
} from "@/lib/remote-access";

/** A host only this install would ever configure. */
const CONFIGURED = "https://this-install.example.test";

describe("RemoteAccessSection", () => {
  it("renders the heading, this install's Remote URL, the copy control, and Test Connection", () => {
    const html = renderToStaticMarkup(createElement(RemoteAccessSection, { configuredUrl: CONFIGURED }));
    expect(html).toContain(REMOTE_ACCESS_HEADING);
    expect(html).toContain(REMOTE_URL_LABEL);
    expect(html).toContain(CONFIGURED);
    expect(html).toContain(sentenceGapHtml(REMOTE_ACCESS_BLURB).replaceAll("'", "&#x27;"));
    expect(html).toContain('aria-label="Copy Remote URL"');
    expect(html).toContain("Copy");
    expect(html).toContain("Test Connection");
    expect(html).toContain('aria-label="Test Connection"');
    expect(html).not.toContain("Test Remote Access");
    expect(html.toLowerCase()).not.toContain("trycloudflare");
  });

  it("renders the setup sentence and no URL or probe button when this install has no address", () => {
    for (const configuredUrl of [undefined, null, "", "   ", "not-a-url"]) {
      const html = renderToStaticMarkup(createElement(RemoteAccessSection, { configuredUrl }));
      expect(html).toContain(REMOTE_ACCESS_HEADING);
      expect(html).toContain(sentenceGapHtml(REMOTE_ACCESS_UNCONFIGURED_BLURB).replaceAll("'", "&#x27;"));
      expect(html).not.toContain(REMOTE_URL_LABEL);
      expect(html).not.toContain("Test Connection");
      expect(html).not.toContain("<input");
    }
  });

  it("names no host at all when unconfigured, and certainly not a fixed one", () => {
    const html = renderToStaticMarkup(createElement(RemoteAccessSection, {}));
    expect(html).not.toMatch(/https?:\/\//);
    expect(html.toLowerCase()).not.toContain("jay");
  });
});

describe("describeIngressTestOutcome", () => {
  it("maps a successful probe to Reachable and keeps the raw reason as hover detail", () => {
    expect(
      describeIngressTestOutcome(true, 200, {
        ok: true,
        reason: "Cloudflare answered with HTTP 200.",
        tunnel: "cloudflare",
      }),
    ).toEqual({
      kind: "ok",
      label: "Reachable",
      detail: "Cloudflare answered with HTTP 200.",
      tunnel: "cloudflare",
    });
    expect(describeIngressTestOutcome(true, 200, { ok: true, reason: "Reachable", tunnel: "cloudflared" })).toEqual({
      kind: "ok",
      label: "Reachable",
      detail: "Reachable",
      tunnel: "cloudflared",
    });
  });

  it("maps origin-refused and other non-ok probes to Couldn't reach this Mac.", () => {
    expect(describeIngressTestOutcome(true, 200, { ok: false, reason: "Origin refused the connection" })).toEqual({
      kind: "error",
      label: "Couldn't reach this Mac.",
      detail: "Origin refused the connection",
    });
    expect(describeIngressTestOutcome(true, 200, { ok: false, reason: "connect ECONNREFUSED 127.0.0.1:8799" })).toEqual({
      kind: "error",
      label: "Couldn't reach this Mac.",
      detail: "connect ECONNREFUSED 127.0.0.1:8799",
    });
  });

  it("maps timeout, timed out, and aborted probe reasons to The request timed out.", () => {
    expect(
      describeIngressTestOutcome(true, 200, {
        ok: false,
        reason: "The request timed out before the server answered.",
      }),
    ).toEqual({
      kind: "error",
      label: "The request timed out.",
      detail: "The request timed out before the server answered.",
    });
    expect(
      describeIngressTestOutcome(true, 200, {
        ok: false,
        reason: "The request timed out while reading the server's response.",
      }),
    ).toEqual({
      kind: "error",
      label: "The request timed out.",
      detail: "The request timed out while reading the server's response.",
    });
    expect(describeIngressTestOutcome(true, 200, { ok: false, reason: "This operation was aborted" })).toEqual({
      kind: "error",
      label: "The request timed out.",
      detail: "This operation was aborted",
    });
  });

  it("maps the attached-UI shim's {error} body to product copy and keeps the raw string as detail", () => {
    // electron/attached-ui-shim.mjs proxyHttp: on an unreachable local harness
    // it answers 502 with { error: "BotFleet harness on port <port> is not reachable" },
    // not an IngressProbeResult — the falsey-body-cast bug turned this into a blank pill.
    const result = describeIngressTestOutcome(false, 502, {
      error: "BotFleet harness on port 5199 is not reachable",
    });
    expect(result).toEqual({
      kind: "error",
      label: "Couldn't reach this Mac.",
      detail: "BotFleet harness on port 5199 is not reachable",
    });
  });

  it("falls back to the HTTP status as hover detail when a non-2xx response has no usable error field", () => {
    expect(describeIngressTestOutcome(false, 500, null)).toEqual({
      kind: "error",
      label: "Couldn't reach this Mac.",
      detail: "Request failed with status 500",
    });
    expect(describeIngressTestOutcome(false, 503, { error: 42 })).toEqual({
      kind: "error",
      label: "Couldn't reach this Mac.",
      detail: "Request failed with status 503",
    });
  });
});

describe("TestConnectionControl", () => {
  it("keeps an accessible name that matches the visible label and no live region while idle", () => {
    const html = renderToStaticMarkup(createElement(TestConnectionControl, { test: null, onRunTest: () => {} }));
    expect(html).toContain('aria-label="Test Connection"');
    expect(html).not.toContain("Test Remote Access");
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain("Testing");
  });

  it("updates the accessible name to Testing… and marks aria-busy while the probe is running", () => {
    const html = renderToStaticMarkup(
      createElement(TestConnectionControl, { test: { kind: "running" }, onRunTest: () => {} }),
    );
    expect(html).toContain('aria-label="Testing…"');
    expect(html).not.toContain("Testing Remote Access");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });

  it("announces the running state through a polite live region", () => {
    const html = renderToStaticMarkup(
      createElement(TestConnectionControl, { test: { kind: "running" }, onRunTest: () => {} }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Testing connection…");
  });

  it("restores the idle accessible name and shows product copy with raw detail on title", () => {
    const html = renderToStaticMarkup(
      createElement(TestConnectionControl, {
        test: {
          kind: "ok",
          label: "Reachable",
          detail: "Cloudflare answered with HTTP 200.",
        },
        onRunTest: () => {},
      }),
    );
    expect(html).toContain('aria-label="Test Connection"');
    expect(html).not.toContain("Test Remote Access");
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-testid="remote-access-test-result"');
    expect(html).toContain(">Reachable</span>");
    expect(html).toContain('title="Cloudflare answered with HTTP 200."');
  });

  it("renders unreachable product copy and keeps harness telemetry on title only", () => {
    const html = renderToStaticMarkup(
      createElement(TestConnectionControl, {
        test: {
          kind: "error",
          label: "Couldn't reach this Mac.",
          detail: "BotFleet harness on port 5199 is not reachable",
        },
        onRunTest: () => {},
      }),
    );
    expect(html).toContain(">Couldn&#x27;t reach this Mac.</span>");
    expect(html).toContain('title="BotFleet harness on port 5199 is not reachable"');
    expect(html).not.toMatch(/>(?:BotFleet harness on port 5199 is not reachable)</);
  });
});

describe("CompanionGatewayCard", () => {
  it("renders the companion-path label and blurb without naming any host", () => {
    const html = renderToStaticMarkup(createElement(CompanionGatewayCard));
    expect(html).toContain(COMPANION_GATEWAY_LABEL);
    expect(html).toContain(sentenceGapHtml(COMPANION_GATEWAY_BLURB));
    expect(html).not.toMatch(/https?:\/\//);
    expect(html.toLowerCase()).not.toContain("trycloudflare");
  });
});
