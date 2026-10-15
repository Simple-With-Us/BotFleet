import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { httpUrlToNetworkAllow, pluginNetworkAllow, shippedZulipHostTrust } from "./plugin-net-policy.ts";

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

  it("records Zulip realm trust only for the shipped source folder", () => {
    const root = mkdtempSync(join(tmpdir(), "botfleet-first-party-"));
    const shipped = join(root, "zulip");
    mkdirSync(shipped);
    const elsewhere = mkdtempSync(join(tmpdir(), "botfleet-third-party-"));
    const copy = join(elsewhere, "zulip");
    mkdirSync(copy);

    expect(shippedZulipHostTrust("zulip", { kind: "folder", path: shipped }, root)).toBe("zulip-realm");
    expect(shippedZulipHostTrust("zulip", { kind: "folder", path: copy }, root)).toBeUndefined();
    expect(shippedZulipHostTrust("other", { kind: "folder", path: shipped }, root)).toBeUndefined();
    expect(shippedZulipHostTrust("zulip", { kind: "folder", path: join(root, "missing") }, root)).toBeUndefined();
    expect(shippedZulipHostTrust("zulip", {
      kind: "git",
      url: "https://example.com/zulip.git",
      ref: null,
      path: "",
    }, root)).toBeUndefined();

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
      shippedZulip: shippedZulipHostTrust("zulip", { kind: "folder", path: shipped }, root) === "zulip-realm",
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
