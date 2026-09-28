import { describe, expect, it } from "vitest";

import {
  companionEndpointCandidates,
  hostedCompanionUrl,
  MAX_COMPANION_ENDPOINTS,
} from "../src/endpoints.ts";
import { readLanPolicy } from "../src/lan-policy.ts";

describe("hostedCompanionUrl", () => {
  it("normalizes one explicit HTTPS origin", () => {
    expect(hostedCompanionUrl("  https://Maus.Example/  ")).toBe("https://maus.example");
    expect(hostedCompanionUrl(undefined)).toBeNull();
    expect(hostedCompanionUrl("  ")).toBeNull();
  });

  it("refuses insecure or ambiguous hosted routes", () => {
    for (const value of [
      "http://maus.example",
      "https://user:secret@maus.example",
      "https://maus.example/companion",
      "https://maus.example?device=one",
      "https://maus.example#pair",
      "not a URL",
    ]) {
      expect(() => hostedCompanionUrl(value)).toThrow(/OMB_COMPANION_HOSTED_URL/);
    }
  });
});

// The three ordering cases below are about ORDER, and order only exists once
// the direct routes are reachable at all.  With the default policy — device
// port bound to loopback since S11 — there is nothing to order, so they pass
// the opt-in explicitly.  The expectations themselves are untouched; the
// security default is covered in lan-policy.test.ts and pinned here too, at
// the end of this block.
const CLEARTEXT_ALLOWED = readLanPolicy("1");

describe("companionEndpointCandidates", () => {
  it("offers only the hosted origin under the default loopback-only policy", () => {
    // S11: a direct route the sidecar cannot answer costs a phone its whole
    // connection walk, so the default list is the hosted origin or nothing.
    expect(
      companionEndpointCandidates(
        8810,
        ["192.168.1.42", "10.0.0.7"],
        "macbook.tail1234.ts.net",
        "https://device-123.companion.example",
        "botfleet-abcd1234.local",
      ),
    ).toEqual([{ url: "https://device-123.companion.example", kind: "hosted", priority: 0 }]);
  });

  it("puts hosted HTTPS first, followed by tailnet, LAN, and Bonjour routes", () => {
    expect(
      companionEndpointCandidates(
        8810,
        ["100.121.5.6", "192.168.1.42", "10.0.0.7"],
        "macbook.tail1234.ts.net",
        "https://device-123.companion.example",
        "botfleet-abcd1234.local",
        CLEARTEXT_ALLOWED,
      ),
    ).toEqual([
      { url: "https://device-123.companion.example", kind: "hosted", priority: 0 },
      { url: "http://macbook.tail1234.ts.net:8810", kind: "tailnet", priority: 100 },
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 201 },
      { url: "http://10.0.0.7:8810", kind: "lan", priority: 202 },
      { url: "http://botfleet-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("keeps direct routes when no hosted route exists", () => {
    expect(
      companionEndpointCandidates(
        8810,
        ["192.168.1.42"],
        null,
        null,
        "botfleet-abcd1234.local",
        CLEARTEXT_ALLOWED,
      ),
    ).toEqual([
      { url: "http://192.168.1.42:8810", kind: "lan", priority: 200 },
      { url: "http://botfleet-abcd1234.local:8810", kind: "bonjour", priority: 300 },
    ]);
  });

  it("caps pathological interface lists without losing the Bonjour fallback", () => {
    const addresses = Array.from({ length: 20 }, (_, index) => `192.168.1.${index + 1}`);
    const endpoints = companionEndpointCandidates(
      8810,
      addresses,
      null,
      "https://device-123.companion.example",
      "botfleet-abcd1234.local",
      CLEARTEXT_ALLOWED,
    );
    expect(endpoints).toHaveLength(MAX_COMPANION_ENDPOINTS);
    expect(endpoints[0]).toMatchObject({ kind: "hosted", priority: 0 });
    expect(endpoints.at(-1)).toEqual({
      url: "http://botfleet-abcd1234.local:8810",
      kind: "bonjour",
      priority: 300,
    });
  });
});
