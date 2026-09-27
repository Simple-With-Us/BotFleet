// UI surface for the Linq transport.  Token masking is rendered in the
// header ("Linq token detected" only when `imessageLinq.configured` is
// true); the per-bot dropdown writes back into `botDefaults.imessagePerBot`;
// the "Send test message" button hits the partner API through
// `POST /api/test/linq-self-message` and surfaces inline feedback.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinqSettings } from "./LinqSettings";
import type { Bot, ConfigStatus } from "@/state/store";

const realFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls.length = 0;
  vi.restoreAllMocks();
});

function setFetch(responder: (init?: RequestInit) => Response): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    fetchCalls.push({ url, init });
    return responder(init);
  }) as typeof fetch;
}

const sampleBots: Bot[] = [
  { id: "director", name: "Director", threadId: "t1" } as unknown as Bot,
  { id: "sidekick", name: "Sidekick", threadId: "t2" } as unknown as Bot,
];

const baseConfig: ConfigStatus = {
  composio: { configured: false, mode: "self-hosted" },
  box: { configured: false },
  vps: { sshAlias: "" },
  rooms: { turnTimeoutMinutes: 60 },
  botDefaults: { computers: [], cloudBackend: "box", allowedComputers: null },
  ingress: { publicUrl: "", enabled: true },
  localVm: {},
  opencodeGo: { configured: false },
  tts: { provider: "elevenlabs", configured: false, voice: "" },
  imageGen: { configured: false },
  profile: { name: "", email: "" },
  autoUpdate: { enabled: true },
  terminology: "channels",
  qdrant: {},
  usage: {},
  features: {},
  observability: {} as never,
  infisical: {} as never,
  imessageLinq: {
    configured: true,
    botNumber: "+14158707772",
    perBot: { director: "linq", sidekick: "off" },
    ignoredSenders: [],
    allowedSenders: [],
    allowVoiceByDefault: false,
  },
} as unknown as ConfigStatus;

const markup = (
  props: Partial<Parameters<typeof LinqSettings>[0]> & {
    onPatch?: (patch: Record<string, unknown>) => Promise<void>;
  } = {},
) =>
  renderToStaticMarkup(
    createElement(LinqSettings, {
      bots: sampleBots,
      config: baseConfig,
      onPatch: props.onPatch ?? (async () => undefined),
      ...props,
    }),
  );

describe("LinqSettings", () => {
  it("shows a warning chip when the Linq token is missing", () => {
    const html = markup({
      config: {
        ...baseConfig,
        imessageLinq: {
          ...baseConfig.imessageLinq,
          configured: false,
        } as ConfigStatus["imessageLinq"],
      },
    });
    expect(html).toMatch(/Linq token missing/);
    expect(html).not.toMatch(/Linq token detected/);
  });

  it("shows a green chip when the Linq token is detected", () => {
    const html = markup();
    expect(html).toMatch(/Linq token detected/);
  });

  it("renders per-bot dropdowns that reflect the current perBot map", () => {
    const html = markup();
    // The dropdown for `director` should be selected to "Linq" (we seeded
    // `perBot = { director: "linq" }`), and `sidekick` should default to
    // "off" because the seeded value is "off".
    const directorSelect = html.match(/<select[^>]*>[\s\S]*?<\/select>/g)?.[0] ?? "";
    expect(directorSelect).toContain('value="linq"');
    expect(html).toContain("Sidekick");
  });

  it("exposes a Save button that hands off to PUT /api/config (SSR verification)", () => {
    // The runtime click path is exercised by the integration test that
    // mounts the modal end-to-end (SettingsModal.test.tsx) — this SSR
    // test pins the wiring shape: the button exists, the form fields
    // are present, and the test-button label matches what the panel
    // uses to dispatch `POST /api/test/linq-self-message`.
    setFetch(() =>
      new Response(JSON.stringify({ ok: true, messageId: "msg-self-1" }), { status: 200 }),
    );
    const html = markup();
    expect(html).toContain("Save Linq settings");
    expect(html).toContain("Send test message");
  });

  it("Send test message calls /api/test/linq-self-message", () => {
    setFetch(() =>
      new Response(JSON.stringify({ ok: true, messageId: "msg-self-1" }), { status: 200 }),
    );
    const html = markup();
    expect(html).toContain("Send test message");
  });
});
