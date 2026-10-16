import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { httpUrlToNetworkAllow, isShippedZulipPlugin, pluginNetworkAllow } from "./plugin-net-policy.ts";

describe("plugin network allow policy", () => {
  it("grants declared hosts only when net.hosts is declared", () => {
    const declared = ["API.Example.com:443", "not a host", "203.0.113.5:80"];
    expect(pluginNetworkAllow({
      capabilities: ["read.bots"],
      declared,
      shippedZulip: false,
    })).toEqual([]);
    expect(pluginNetworkAllow({
      capabilities: ["net.hosts"],
      declared,
      shippedZulip: false,
    })).toEqual(["api.example.com:443", "203.0.113.5:80"]);
  });

  it("adds the configured Zulip realm only for the shipped plugin directory", () => {
    const root = mkdtempSync(join(tmpdir(), "botfleet-first-party-"));
    const shipped = join(root, "zulip");
    mkdirSync(shipped);
    const elsewhere = mkdtempSync(join(tmpdir(), "botfleet-third-party-"));
    mkdirSync(join(elsewhere, "zulip"));

    const installed = mkdtempSync(join(tmpdir(), "botfleet-installed-zulip-"));
    mkdirSync(join(installed, "zulip"));

    expect(isShippedZulipPlugin("zulip", shipped, root)).toBe(true);
    expect(isShippedZulipPlugin("zulip", join(installed, "zulip"), root)).toBe(false);
    expect(isShippedZulipPlugin("zulip", join(elsewhere, "zulip"), root)).toBe(false);
    expect(isShippedZulipPlugin("zulip", null, root)).toBe(false);
    expect(isShippedZulipPlugin("zulip", "", root)).toBe(false);
    expect(isShippedZulipPlugin("other", shipped, root)).toBe(false);
    expect(isShippedZulipPlugin("zulip", join(root, "missing"), root)).toBe(false);

    const realm = "https://chat.example.com/realm/";
    expect(httpUrlToNetworkAllow(realm)).toBe("chat.example.com:443");
    expect(pluginNetworkAllow({
      capabilities: [],
      declared: [],
      shippedZulip: true,
      zulipRealm: realm,
    })).toEqual(["chat.example.com:443"]);
    expect(pluginNetworkAllow({
      capabilities: [],
      declared: ["203.0.113.9:443"],
      shippedZulip: false,
      zulipRealm: realm,
    })).toEqual([]);
    expect(pluginNetworkAllow({
      capabilities: ["net.hosts"],
      declared: ["203.0.113.9:443"],
      shippedZulip: isShippedZulipPlugin("zulip", realpathSync(shipped), root),
      zulipRealm: "http://127.0.0.1:9",
    })).toEqual(["203.0.113.9:443", "127.0.0.1:9"]);
  });

  it("refuses a realm URL that is not a plain http(s) host", () => {
    expect(httpUrlToNetworkAllow("https://user:secret@chat.example.com")).toBeNull();
    expect(httpUrlToNetworkAllow("ftp://chat.example.com")).toBeNull();
    expect(pluginNetworkAllow({
      capabilities: [],
      declared: [],
      shippedZulip: true,
      zulipRealm: "https://user:secret@chat.example.com",
    })).toEqual([]);
  });
});
