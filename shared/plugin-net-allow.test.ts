import { describe, expect, it } from "vitest";

import {
  canonicalNetworkToken,
  hostIsAllowlisted,
  isPluginNetworkIp,
  networkAllowMatches,
  normalizePluginNetworkAllow,
  parsePluginNetworkAllow,
} from "./plugin-net-allow.ts";

describe("plugin network allowlist", () => {
  it("canonicalizes hostnames and IP literals", () => {
    expect(parsePluginNetworkAllow("API.Example.com:443")).toEqual({
      host: "api.example.com",
      port: 443,
      token: "api.example.com:443",
    });
    expect(parsePluginNetworkAllow("[::1]:9")).toEqual({ host: "::1", port: 9, token: "[::1]:9" });
    expect(canonicalNetworkToken("Example.com.", 443)).toBe("example.com:443");
    expect(isPluginNetworkIp("127.0.0.1")).toBe(true);
    expect(isPluginNetworkIp("example.com")).toBe(false);
  });

  it("rejects schemes, wildcards, missing ports, and ambiguous IPv6", () => {
    for (const entry of ["*", "https://example.com/a", "example.com", "127.0.0.1:0", "127.0.0.1:99999", "::1:443", " 127.0.0.1:80", "01.2.3.4:80"]) {
      expect(parsePluginNetworkAllow(entry)).toBeNull();
    }
  });

  it("matches only the declared destination and drops invalid entries", () => {
    const allow = normalizePluginNetworkAllow(["Example.com:443", "*", "example.com:443", "127.0.0.1:9"]);
    expect(allow).toEqual(["example.com:443", "127.0.0.1:9"]);
    expect(networkAllowMatches(allow, "example.com", 443)).toBe(true);
    expect(networkAllowMatches(allow, "example.com", 80)).toBe(false);
    expect(networkAllowMatches(allow, "127.0.0.1", 9)).toBe(true);
    expect(hostIsAllowlisted(allow, "example.com.")).toBe(true);
    expect(hostIsAllowlisted(allow, "other.test")).toBe(false);
    expect(normalizePluginNetworkAllow(["*", "https://evil.test"])).toEqual([]);
  });
});
