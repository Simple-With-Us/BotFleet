import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { looksSensitive } from "../auto-approve.ts";
import {
  ZulipCredentialError,
  credentialSourceFor,
  fileCredentialSource,
  parseZuliprc,
  readZuliprc,
  resolveRealm,
  verifyCredentialRealm,
} from "./credentials.ts";

const FAKE_KEY = "fake-test-key-not-real";
const posix = process.platform !== "win32";

function rc(dir: string, name: string, body: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
}

describe("zuliprc files", () => {
  it("parse the [api] section, quotes and comments included", () => {
    const parsed = parseZuliprc(
      `# a comment\n[other]\nkey=nope\n[api]\nemail = "bf-plumber-bot@zulip.test"\nkey=${FAKE_KEY}\nsite=simplewithus.zulipchat.com\n`,
      "x",
    );
    expect(parsed).toEqual({ email: "bf-plumber-bot@zulip.test", key: FAKE_KEY, site: "https://simplewithus.zulipchat.com" });
  });

  it("name what is missing without quoting the file", () => {
    expect(() => parseZuliprc(`[api]\nkey=${FAKE_KEY}\n`, "/p/BF-X-zuliprc")).toThrow(/missing email, site/);
    try {
      parseZuliprc(`[api]\nkey=${FAKE_KEY}\n`, "/p/BF-X-zuliprc");
    } catch (e) {
      expect(String(e)).not.toContain(FAKE_KEY);
    }
  });

  it.skipIf(!posix)("refuse a file group or other can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "zulip-rc-"));
    const path = rc(dir, "BF-Plumber-zuliprc", `[api]\nemail=a@b\nkey=${FAKE_KEY}\nsite=https://x.test\n`, 0o644);
    expect(() => readZuliprc(path)).toThrow(/chmod 600/);
    chmodSync(path, 0o600);
    expect(readZuliprc(path).key).toBe(FAKE_KEY);
  });

  it("report a missing file as missing, so the bot is simply not set up", () => {
    const dir = mkdtempSync(join(tmpdir(), "zulip-rc-"));
    try {
      fileCredentialSource(dir).load("BF-Fixer");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ZulipCredentialError);
      // SAFETY: the line above asserted the instance type.
      expect((e as ZulipCredentialError).reason).toBe("missing");
    }
  });

  it("refuse a role that would walk out of the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "zulip-rc-"));
    expect(() => fileCredentialSource(dir).load("../../etc/passwd")).toThrow(/not a valid Zulip role/);
    expect(() => fileCredentialSource(dir).load("BF/Plumber")).toThrow(/not a valid Zulip role/);
  });
});

describe("the credential source", () => {
  it("is off until a folder is named, and the env override wins", () => {
    expect(credentialSourceFor({}, {})).toBeNull();
    expect(credentialSourceFor({ credentialDir: "relative/dir" }, {})).toBeNull();
    expect(credentialSourceFor({ credentialDir: "/a" }, {})?.describe("BF-Plumber")).toBe("file /a/BF-Plumber-zuliprc");
    expect(credentialSourceFor({ credentialDir: "/a" }, { OMB_ZULIP_CREDENTIAL_DIR: "/b" })?.describe("BF-Plumber")).toBe(
      "file /b/BF-Plumber-zuliprc",
    );
  });
});

describe("the realm", () => {
  it("defaults to the fleet realm and allows plain http only on loopback", () => {
    expect(resolveRealm({}, {})).toEqual({ realm: "https://simplewithus.zulipchat.com" });
    expect(resolveRealm({ realm: "http://127.0.0.1:9999/" }, {})).toEqual({ realm: "http://127.0.0.1:9999" });
    expect(resolveRealm({ realm: "http://zulip.example.com" }, {})).toMatchObject({ error: expect.stringMatching(/https/) });
  });

  it("refuses a key whose site is another host", () => {
    const creds = { email: "a@b", key: FAKE_KEY, site: "https://evil.example.com", source: "/p" };
    expect(() => verifyCredentialRealm(creds, "https://simplewithus.zulipchat.com")).toThrow(/not the configured realm/);
    expect(() => verifyCredentialRealm({ ...creds, site: "https://simplewithus.zulipchat.com" }, "https://simplewithus.zulipchat.com")).not.toThrow();
  });
});

describe("auto-approve", () => {
  it("treats the fleet secrets folder and every zuliprc as sensitive", () => {
    expect(looksSensitive("cat ~/.secrets/Zulip/BF-Fixer-zuliprc")).toBe(true);
    expect(looksSensitive("/Users/jay/.secrets/global-api-keys")).toBe(true);
    expect(looksSensitive("ls /tmp/BF-Plumber-zuliprc")).toBe(true);
    expect(looksSensitive("src/secrets-panel.tsx")).toBe(false);
  });
});
