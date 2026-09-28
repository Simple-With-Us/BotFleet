/**
 * Remote Access must describe THIS install and nothing else.
 *
 * A public app cannot ship one operator's home tunnel: an end user who
 * installs it must not be pointed at somebody else's server, and a person
 * reading the source must not be handed that server's name.  These tests
 * fail if a personal domain or a personal name comes back — including the
 * fragment-assembled kind, which hid nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMPANION_GATEWAY_BLURB,
  COMPANION_GATEWAY_LABEL,
  normalizeRemoteUrl,
  REMOTE_ACCESS_BLURB,
  REMOTE_ACCESS_HEADING,
  REMOTE_ACCESS_UNCONFIGURED_BLURB,
  REMOTE_URL_LABEL,
  sentenceGapHtml,
} from "./remote-access";

const here = dirname(fileURLToPath(import.meta.url));

/** Everything the shipped remote-access surface may be searched for. */
const SHIPPED_SURFACES = [
  ["src/lib/remote-access.ts", join(here, "remote-access.ts")],
  ["src/components/RemoteAccessSection.tsx", join(here, "../components/RemoteAccessSection.tsx")],
  ["src/components/SettingsModal.tsx", join(here, "../components/SettingsModal.tsx")],
] as const;

/** Banned as a literal AND as a reassembly, because joining the pieces of a
 * domain in source is not redaction — the shipped string still contains it. */
const OWNER_MARKERS = [
  /jays\s*\.\s*services/i,
  /jaysservices/i,
  /jays/i,
  /jay[''`’\s-]*s\s+tunnel/i,
  /botfleet\s*\.\s*jays/i,
];

describe("Remote Access ships no owner-private host or name", () => {
  it.each(SHIPPED_SURFACES)("%s contains no owner domain or personal name", (_label, path) => {
    const source = readFileSync(path, "utf8");
    for (const marker of OWNER_MARKERS) expect(source).not.toMatch(marker);
  });

  it("keeps the personal name out of the Settings search keywords", () => {
    const settings = readFileSync(join(here, "../components/SettingsModal.tsx"), "utf8");
    // The Remote Access entry used to answer a search for the owner's tunnel
    // by name, so the name shipped in a public app's search index.
    const entry = settings.split("\n").find((line) => line.includes('id: "remote"')) ?? "";
    expect(entry).toContain('id: "remote"');
    expect(entry.toLowerCase()).not.toContain("jay");
  });
});

describe("Remote Access copy", () => {
  it("locks heading and labels and says nothing about any particular host", () => {
    expect(REMOTE_ACCESS_HEADING).toBe("Remote Access");
    expect(REMOTE_URL_LABEL).toBe("Remote URL");
    expect(COMPANION_GATEWAY_LABEL).toBe("Companion Gateway");
    expect(REMOTE_ACCESS_BLURB).not.toMatch(/https?:\/\//);
    expect(COMPANION_GATEWAY_BLURB).not.toMatch(/https?:\/\//);
    expect(REMOTE_ACCESS_UNCONFIGURED_BLURB).not.toMatch(/https?:\/\//);
    expect(REMOTE_ACCESS_BLURB).toContain("this Mac");
  });

  it("keeps two ASCII spaces between sentences in the source blurbs", () => {
    expect(REMOTE_ACCESS_BLURB).toMatch(/use\.  Sign/);
    expect(REMOTE_ACCESS_BLURB).toMatch(/in front of it\.  The/);
    expect(REMOTE_ACCESS_UNCONFIGURED_BLURB).toMatch(/to open\.  Set/);
    expect(COMPANION_GATEWAY_BLURB).toMatch(/separately\.  That/);
  });

  it("turns those gaps into NBSP+space for HTML", () => {
    expect(sentenceGapHtml(REMOTE_ACCESS_BLURB)).toContain("use.  Sign");
    expect(sentenceGapHtml(REMOTE_ACCESS_BLURB)).not.toMatch(/use\. {2}Sign/);
    expect(sentenceGapHtml(REMOTE_ACCESS_UNCONFIGURED_BLURB)).toContain("open.  Set");
    expect(sentenceGapHtml(COMPANION_GATEWAY_BLURB)).toContain("separately.  That");
  });

  it("does not invent TryCloudflare on the remote-access path", () => {
    for (const [label, path] of SHIPPED_SURFACES) {
      const source = readFileSync(path, "utf8");
      // Settings still offers the free TryCloudflare pairing toggle, so only
      // the remote-access copy and the section are checked here.
      if (label.endsWith("SettingsModal.tsx")) continue;
      expect(source.toLowerCase()).not.toContain("trycloudflare");
    }
  });

  it("wires a Settings sidebar section to this install's configured address", () => {
    const settings = readFileSync(join(here, "../components/SettingsModal.tsx"), "utf8");
    expect(settings).toContain('id: "remote"');
    expect(settings).toContain('label: "Remote Access"');
    expect(settings).toContain('<RemoteAccessSection configuredUrl={remoteAccessUrl} />');
    expect(settings).toContain('section === "remote" && <RemoteAccessSection configuredUrl={remoteAccessUrl} />');
    // The address is the saved per-install one, read from the config the
    // harness already publishes — not a constant.
    expect(settings).toContain("ingress?.publicUrl");
  });

  it("shows Companion Gateway on the Phone section, not mixed into Remote Access", () => {
    const phone = readFileSync(join(here, "../components/CompanionSection.tsx"), "utf8");
    expect(phone).toContain("<CompanionGatewayCard />");
  });
});

describe("normalizeRemoteUrl", () => {
  it("accepts an http(s) address this Mac saved and strips its trailing slash", () => {
    expect(normalizeRemoteUrl("https://remote.example.test")).toBe("https://remote.example.test");
    expect(normalizeRemoteUrl("  https://remote.example.test/  ")).toBe("https://remote.example.test");
    expect(normalizeRemoteUrl("http://remote.example.test:8787/")).toBe("http://remote.example.test:8787");
    expect(normalizeRemoteUrl("https://remote.example.test/tunnel")).toBe("https://remote.example.test/tunnel");
  });

  it("refuses anything that is not a usable address, so no placeholder can render", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "   ",
      "remote.example.test",
      "javascript:alert(1)",
      "ftp://remote.example.test",
      "https://has space.test",
      `https://${"a".repeat(2100)}.test`,
    ]) {
      expect(normalizeRemoteUrl(raw)).toBeNull();
    }
  });
});
