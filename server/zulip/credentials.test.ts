import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { looksSensitive } from "../auto-approve.ts";
import {
  ZulipCredentialError,
  cachedVaultReader,
  credentialSourceFor,
  fileCredentialSource,
  infisicalCredentialSource,
  parseZuliprc,
  readZuliprc,
  resolveRealm,
  verifyCredentialRealm,
  zulipVaultNames,
} from "./credentials.ts";

const FAKE_KEY = "fake-test-key-not-real";
const posix = process.platform !== "win32";
/** What `describe` says for a role file in `dir`: the folder is resolved, so
 *  "/a" is "D:\a" on Windows.  Built the way the source builds it. */
const fileIn = (dir: string, role = "BF-Plumber") => `file ${join(resolve(dir), `${role}-zuliprc`)}`;

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

  it("refuse a malformed email, key or site by field name, never by value", () => {
    const refusal = (text: string): ZulipCredentialError => {
      try {
        parseZuliprc(text, "/p/BF-X-zuliprc");
      } catch (e) {
        if (e instanceof ZulipCredentialError) return e;
        throw e;
      }
      throw new Error("expected a refusal");
    };
    const badKey = "has a space";
    const key = refusal(`[api]\nemail=a@b\nkey=${badKey}\nsite=https://x.test\n`);
    expect(key.reason).toBe("invalid");
    expect(key.message).toBe("/p/BF-X-zuliprc: invalid key");
    expect(key.message).not.toContain(badKey);
    expect(refusal(`[api]\nemail=not-an-email\nkey=${FAKE_KEY}\nsite=https://x.test\n`).message).toBe(
      "/p/BF-X-zuliprc: invalid email",
    );
    expect(refusal(`[api]\nemail=@b\nkey=${FAKE_KEY}\nsite=https://x.test\n`).message).toBe("/p/BF-X-zuliprc: invalid email");
    expect(refusal(`[api]\nemail=a@b\nkey=${FAKE_KEY}\nsite=ftp://x.test\n`).message).toBe("/p/BF-X-zuliprc: invalid site");
    // every wrong field is named once, and the key is in none of the text
    const all = refusal(`[api]\nemail=nope\nkey=bad key\nsite=ftp://x.test\n`);
    expect(all.message).toBe("/p/BF-X-zuliprc: invalid email, key, site");
    expect(all.message).not.toContain("bad key");
  });

  it("still accept the loose shapes Zulip allows: a bare-host email, a loopback http site, a key of any length", () => {
    expect(parseZuliprc(`[api]\nemail=a@b\nkey=k\nsite=http://127.0.0.1:9999/\n`, "x")).toEqual({
      email: "a@b",
      key: "k",
      site: "http://127.0.0.1:9999",
    });
    const long = "K".repeat(300);
    expect(parseZuliprc(`[api]\nemail=a@b\nkey=${long}\nsite=x.test\n`, "x").key).toBe(long);
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
    expect(credentialSourceFor({ credentialDir: "/a" }, {})?.describe("BF-Plumber")).toBe(fileIn("/a"));
    expect(credentialSourceFor({ credentialDir: "/a" }, { OMB_ZULIP_CREDENTIAL_DIR: "/b" })?.describe("BF-Plumber")).toBe(
      fileIn("/b"),
    );
  });
});

describe("the Infisical source", () => {
  const REALM = "https://z.test";
  const vault = (rows: Record<string, string>) => {
    const calls: string[] = [];
    const read = async (path: string) => {
      calls.push(path);
      return new Map(Object.entries(rows));
    };
    return { read, calls };
  };

  it("is off unless chosen, needs the harness's reader, and never wins over the env's test folder", () => {
    const { read } = vault({});
    expect(credentialSourceFor({ credentialSource: "infisical" }, {})).toBeNull();
    expect(credentialSourceFor({ credentialSource: "infisical" }, {}, { vault: read })?.describe("BF-Plumber")).toBe(
      "infisical /zulip ZULIP_BF_PLUMBER_*",
    );
    expect(
      credentialSourceFor({ credentialSource: "infisical", infisicalPath: "/bots" }, {}, { vault: read })?.describe("BF-Plumber"),
    ).toBe("infisical /bots ZULIP_BF_PLUMBER_*");
    // a folder alone is still the file source, and a reader alone turns nothing on
    expect(credentialSourceFor({ credentialDir: "/a" }, {}, { vault: read })?.describe("BF-Plumber")).toBe(fileIn("/a"));
    expect(credentialSourceFor({}, {}, { vault: read })).toBeNull();
    expect(
      credentialSourceFor({ credentialSource: "infisical" }, { OMB_ZULIP_CREDENTIAL_DIR: "/b" }, { vault: read })?.describe("BF-Plumber"),
    ).toBe(fileIn("/b"));
  });

  it("maps a role to its vault names and loads email, key and the realm as the site", async () => {
    expect(zulipVaultNames("BF-Plumber")).toEqual({
      email: "ZULIP_BF_PLUMBER_EMAIL",
      key: "ZULIP_BF_PLUMBER_API_KEY",
      site: "ZULIP_BF_PLUMBER_SITE",
    });
    const { read, calls } = vault({ ZULIP_BF_PLUMBER_EMAIL: "bf-plumber-bot@z.test", ZULIP_BF_PLUMBER_API_KEY: FAKE_KEY });
    const creds = await infisicalCredentialSource(read, { realm: REALM }).load("BF-Plumber");
    expect(creds).toEqual({ email: "bf-plumber-bot@z.test", key: FAKE_KEY, site: REALM, source: "infisical /zulip" });
    expect(calls).toEqual(["/zulip"]);
    // the key never lands in the environment
    expect(Object.values(process.env)).not.toContain(FAKE_KEY);
  });

  it("refuses a malformed email, key or site from the vault by field name, never by value", async () => {
    const refusal = async (rows: Record<string, string>): Promise<ZulipCredentialError> => {
      try {
        await infisicalCredentialSource(vault(rows).read, { realm: REALM }).load("BF-Plumber");
      } catch (e) {
        if (e instanceof ZulipCredentialError) return e;
        throw e;
      }
      throw new Error("expected a refusal");
    };
    // a multi-line vault value must not reach the Authorization header
    const multiline = `${FAKE_KEY}\nX-Injected: 1`;
    const key = await refusal({ ZULIP_BF_PLUMBER_EMAIL: "bf-plumber-bot@z.test", ZULIP_BF_PLUMBER_API_KEY: multiline });
    expect(key.reason).toBe("invalid");
    expect(key.message).toBe("infisical /zulip: invalid key");
    expect(key.message).not.toContain(FAKE_KEY);
    const email = await refusal({ ZULIP_BF_PLUMBER_EMAIL: "no-at-sign", ZULIP_BF_PLUMBER_API_KEY: FAKE_KEY });
    expect(email.message).toBe("infisical /zulip: invalid email");
    const site = await refusal({
      ZULIP_BF_PLUMBER_EMAIL: "bf-plumber-bot@z.test",
      ZULIP_BF_PLUMBER_API_KEY: FAKE_KEY,
      ZULIP_BF_PLUMBER_SITE: "file:///x",
    });
    expect(site.message).toBe("infisical /zulip: invalid site");
  });

  it("names what is missing, never a value, and turns a vault failure into a value-free error", async () => {
    const { read } = vault({ ZULIP_BF_PLUMBER_EMAIL: "bf-plumber-bot@z.test" });
    const missing = await Promise.resolve()
      .then(() => infisicalCredentialSource(read, { realm: REALM }).load("BF-Plumber"))
      .catch((e: ZulipCredentialError) => e);
    expect(missing).toBeInstanceOf(ZulipCredentialError);
    expect((missing as ZulipCredentialError).reason).toBe("missing");
    expect((missing as ZulipCredentialError).message).toBe("Infisical /zulip has no ZULIP_BF_PLUMBER_API_KEY");
    const failing = infisicalCredentialSource(
      async () => {
        throw new Error("Infisical secrets list failed (403)");
      },
      { realm: REALM },
    );
    await expect(failing.load("BF-Plumber")).rejects.toThrow("cannot read Infisical /zulip: Infisical secrets list failed (403)");
    await expect(infisicalCredentialSource(read, { realm: REALM }).load("../etc")).rejects.toThrow(/not a valid Zulip role/);
  });

  it("reads the vault once per folder per window, and does not cache a failure", async () => {
    let now = 0;
    let fail = true;
    let reads = 0;
    const cached = cachedVaultReader(
      async () => {
        reads += 1;
        if (fail) throw new Error("down");
        return new Map([["A", "1"]]);
      },
      { ttlMs: 1_000, now: () => now },
    );
    await expect(cached("/zulip")).rejects.toThrow("down");
    fail = false;
    await cached("/zulip");
    await cached("/zulip");
    expect(reads).toBe(2);
    now = 1_500;
    await cached("/zulip");
    expect(reads).toBe(3);
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
