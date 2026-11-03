import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listSecretsRaw, maskValue, run, verifyServiceTokenMetadata, writeGithubEnvValue } from "./infisical-fetch.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "infisical-fetch.mjs");

const SENTINEL_PRESENT = "sentinel-value-in-vault-9f2c";
const SENTINEL_FALLBACK = "sentinel-value-fallback-4b1e";
// The shape a `base64 < cert.p12` actually has: wrapped at a column, so the
// value the vault hands back is several lines long.  A single-line
// `::add-mask::` registers only the first of them and prints the rest.
const SENTINEL_LINE_1 = "sentinel-multiline-first-7a3d";
const SENTINEL_LINE_2 = "sentinel-multiline-second-b5e8";
const SENTINEL_MULTILINE = `${SENTINEL_LINE_1}\n${SENTINEL_LINE_2}`;

function tempGithubEnv() {
  const dir = mkdtempSync(join(tmpdir(), "omb-infisical-fetch-"));
  return { dir, path: join(dir, "github_env") };
}

/** The stub accepts only token-metadata verification and the scoped secrets read. */
function stubFetch(vaultSecrets) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/api/v2/service-token")) {
      return new Response(JSON.stringify({
        workspace: "proj", projectId: "proj", scopes: [{ environment: "prod", secretPath: "/" }],
        permissions: ["read"], expiresAt: null,
      }), { status: 200 });
    }
    if (u.includes("/api/v3/secrets/raw")) {
      return new Response(JSON.stringify({
        secrets: Object.entries(vaultSecrets).map(([secretKey, secretValue]) => ({
          secretKey, secretValue, workspace: "proj", environment: "prod", secretValueHidden: false,
        })),
      }), { status: 200 });
    }
    throw new Error(`stubFetch: unexpected URL ${u}`);
  };
}

function collectLines() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test("a service token replaces the universal-auth login", async () => {
  // Every app and pipeline outside the agent seats reads the vault with a
  // token scoped to one project, environment and folder, so the fetch must
  // work with a token alone -- no machine identity, no login call.
  const { dir, path } = tempGithubEnv();
  const calls = [];
  try {
    const { lines, log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "FOO",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_TOKEN: "st.test-token",
        GITHUB_ENV: path,
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers ?? {}, init });
        if (String(url).includes("/api/v2/service-token")) {
          return new Response(JSON.stringify({
            workspace: "proj", projectId: "proj", scopes: JSON.stringify([{ environment: "prod", secretPath: "/" }]),
            permissions: ["read"], expiresAt: null,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
            secrets: [{ secretKey: "FOO", secretValue: SENTINEL_PRESENT, workspace: "proj", environment: "prod", secretValueHidden: false }],
          }), { status: 200 });
      },
      log,
    });
    assert.equal(calls.length, 2, "metadata verification and secrets fetch should be the only requests");
    assert.match(calls[0].url, /\/api\/v2\/service-token$/);
    assert.match(calls[1].url, /\/api\/v3\/secrets\/raw/);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.ok(
      calls.every((call) => String(call.headers.authorization ?? "").endsWith("st.test-token")),
      "the service token must be the bearer credential on both requests",
    );
    assert.match(readFileSync(path, "utf8"), /FOO</);
    assert.ok(lines.some((line) => line === `::add-mask::${SENTINEL_PRESENT}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification uses the injected fetch and rejects project, scope, permission, expiry, and malformed scopes before secrets", async (t) => {
  const valid = {
    workspace: "proj", projectId: "proj", scopes: [{ environment: "prod", secretPath: "/" }],
    permissions: ["read"], expiresAt: null,
  };
  const cases = [
    ["wrong project", { ...valid, workspace: "other", projectId: "other" }],
    ["wrong folder", { ...valid, scopes: [{ environment: "prod", secretPath: "/elsewhere" }] }],
    ["wrong environment", { ...valid, scopes: [{ environment: "staging", secretPath: "/" }] }],
    ["write token refused as read-only", { ...valid, permissions: ["read", "write"] }],
    ["expired token", { ...valid, expiresAt: "2020-01-01T00:00:00Z" }],
    ["missing expiry metadata", (({ expiresAt: _expiresAt, ...metadata }) => metadata)(valid)],
    ["invalid calendar date", { ...valid, expiresAt: "2026-02-30T00:00:00Z" }],
    ["malformed serialized scopes", { ...valid, scopes: "not-json" }],
    ["wrapped scopes shape", { ...valid, scopes: { scopes: valid.scopes } }],
  ];
  for (const [name, metadata] of cases) {
    await t.test(name, async () => {
      const { dir, path } = tempGithubEnv();
      const order = [];
      const { lines, log } = collectLines();
      try {
        await assert.rejects(run({
          env: {
            INFISICAL_NAMES: "FOO", INFISICAL_REQUIRED: "FOO", INFISICAL_PROJECT_ID: "proj",
            INFISICAL_TOKEN: "st.fixture-only", GITHUB_ENV: path,
          },
          fetchImpl: async (url) => {
            order.push(String(url).includes("/api/v2/service-token") ? "verify" : "secrets");
            if (String(url).includes("/api/v2/service-token")) return new Response(JSON.stringify(metadata), { status: 200 });
            throw new Error("must not read secrets");
          },
          log,
        }), /Missing required/);
        assert.deepEqual(order, ["verify"]);
        assert.ok(lines.every((line) => !line.includes("st.fixture-only")));
        assert.equal(existsSync(path), false, "a refused scope must not export values");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test("service-token URL preflight rejects insecure, malformed, credentialed, query, and fragment URLs before fetch", async (t) => {
  const invalidUrls = [
    "http://infisical.example",
    "http://127.0.0.1:8080",
    "https://",
    "https:///missing-host/path",
    "https://user:password@infisical.example",
    "https://@infisical.example",
    "https://infisical.example/path?token=fixture-secret",
    "https://infisical.example/path#fragment",
    "https://infisical.example\\@attacker.example/path",
    "https://infisical.example/path?",
    "https://infisical.example/path#",
  ];
  for (const siteUrl of invalidUrls) {
    await t.test(siteUrl.startsWith("http://") ? "insecure URL" : "invalid URL components", async () => {
      let calls = 0;
      const options = {
        siteUrl,
        token: "st.fixture-only",
        projectId: "proj",
        environment: "prod",
        secretPath: "/",
        mode: "read",
        fetchImpl: async () => { calls++; throw new Error("must not fetch"); },
      };
      await assert.rejects(verifyServiceTokenMetadata(options), (error) => {
        assert.match(error.message, /valid HTTPS URL/);
        assert.ok(!error.message.includes(siteUrl));
        assert.ok(!error.message.includes("fixture-secret"));
        return true;
      });
      await assert.rejects(listSecretsRaw(options), /valid HTTPS URL/);
      assert.equal(calls, 0);
    });
  }
});

test("service-token URL preflight preserves HTTPS path prefixes and redirects:error", async () => {
  const calls = [];
  const values = await listSecretsRaw({
    siteUrl: "https://infisical.example/prefix/",
    token: "st.fixture-only",
    projectId: "proj",
    environment: "prod",
    secretPath: "/",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/v2/service-token")) {
        return new Response(JSON.stringify({ workspace: "proj", projectId: "proj",
          scopes: [{ environment: "prod", secretPath: "/" }], permissions: ["read"], expiresAt: null }));
      }
      return new Response(JSON.stringify({ secrets: [{ secretKey: "FOO", secretValue: "fixture-value",
        workspace: "proj", environment: "prod", secretValueHidden: false }] }));
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://infisical.example/prefix/api/v2/service-token");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(new URL(calls[1].url).pathname, "/prefix/api/v3/secrets/raw");
  assert.equal(values.get("FOO"), "fixture-value");
});

test("the injected fetch validates serialized exact read scope before secrets", async () => {
  const { dir, path } = tempGithubEnv();
  const order = [];
  try {
    await run({
      env: { INFISICAL_NAMES: "FOO", INFISICAL_PROJECT_ID: "proj", INFISICAL_TOKEN: "st.fixture-only", GITHUB_ENV: path },
      fetchImpl: async (url) => {
        if (String(url).includes("/api/v2/service-token")) {
          order.push("verify");
          return new Response(JSON.stringify({
            workspace: "proj", projectId: "proj", scopes: JSON.stringify([{ environment: "prod", secretPath: "/" }]),
            permissions: ["read"], expiresAt: null,
          }), { status: 200 });
        }
        order.push("secrets");
        assert.match(String(url), /\/api\/v3\/secrets\/raw/);
        return new Response(JSON.stringify({ secrets: [{ secretKey: "FOO", secretValue: SENTINEL_PRESENT,
          workspace: "proj", environment: "prod", secretValueHidden: false }] }), { status: 200 });
      },
      log: () => {},
    });
    assert.deepEqual(order, ["verify", "secrets"]);
    assert.match(readFileSync(path, "utf8"), /FOO</);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matching wildcard request and grant never reach the secret endpoint", async (t) => {
  for (const character of ["*", "?", "[", "]", "{", "}"]) {
    await t.test(character, async () => {
      const secretPath = `/folder/${character}`;
      const calls = [];
      await assert.rejects(listSecretsRaw({
        siteUrl: "https://infisical.example", token: "st.fixture-only", projectId: "proj",
        environment: "prod", secretPath,
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(JSON.stringify({ workspace: "proj", permissions: ["read"], expiresAt: null,
            scopes: [{ environment: "prod", secretPath }],
          }));
        },
      }), /literal folder/);
      assert.deepEqual(calls, [], "invalid request folders must fail before any network access");
    });
  }
});

test("all metadata folders must be literal even when an exact literal grant is present", async (t) => {
  for (const character of ["*", "?", "[", "]", "{", "}"]) {
    await t.test(character, async () => {
      const calls = [];
      await assert.rejects(listSecretsRaw({
        siteUrl: "https://infisical.example", token: "st.fixture-only", projectId: "proj",
        environment: "prod", secretPath: "/folder",
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(JSON.stringify({ workspace: "proj", permissions: ["read"], expiresAt: null,
            scopes: [{ environment: "prod", secretPath: "/folder" },
              { environment: "staging", secretPath: `/other/${character}` }],
          }));
        },
      }), /metadata is invalid/);
      assert.deepEqual(calls, ["https://infisical.example/api/v2/service-token"]);
    });
  }
});

test("literal folders keep spaces and ordinary punctuation", async () => {
  const secretPath = "/folder with spaces/(copy)+@!#%&=,;:._-";
  const calls = [];
  const values = await listSecretsRaw({
    siteUrl: "https://infisical.example", token: "st.fixture-only", projectId: "proj",
    environment: "prod", secretPath,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/api/v2/service-token")) {
        return new Response(JSON.stringify({ workspace: "proj", permissions: ["read"], expiresAt: null,
          scopes: JSON.stringify([{ environment: "prod", secretPath: `${secretPath}/` }]),
        }));
      }
      return new Response(JSON.stringify({ secrets: [{ secretKey: "FOO", secretValue: SENTINEL_PRESENT,
        workspace: "proj", environment: "prod", secretPath, secretValueHidden: false }] }));
    },
  });
  assert.equal(values.get("FOO"), SENTINEL_PRESENT);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get("secretPath"), secretPath);
});

test("the service token wins over a machine identity that is also configured", async () => {
  const { dir, path } = tempGithubEnv();
  const calls = [];
  try {
    const { log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "FOO",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_TOKEN: "st.test-token",
        INFISICAL_CLIENT_ID: "id",
        INFISICAL_CLIENT_SECRET: "secret",
        GITHUB_ENV: path,
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), headers: init?.headers ?? {} });
        if (String(url).includes("/api/v2/service-token")) {
          return new Response(JSON.stringify({
            workspace: "proj", projectId: "proj", scopes: [{ environment: "prod", secretPath: "/" }],
            permissions: ["read"], expiresAt: null,
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ secrets: [{ secretKey: "FOO", secretValue: SENTINEL_PRESENT,
          workspace: "proj", environment: "prod", secretValueHidden: false }] }), { status: 200 });
      },
      log,
    });
    assert.equal(calls.length, 2, "only verification and the secrets list should run");
    assert.ok(calls.every((call) => String(call.headers.authorization ?? "").endsWith("st.test-token")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing service token never activates an inherited machine identity", async () => {
  const { dir, path } = tempGithubEnv();
  const { lines, log } = collectLines();
  let calls = 0;
  try {
    await run({
      env: { INFISICAL_PROJECT_ID: "proj", INFISICAL_NAMES: "FOO", INFISICAL_CLIENT_ID: "unused-id",
        INFISICAL_CLIENT_SECRET: "unused-secret", GH_FALLBACK_FOO: SENTINEL_FALLBACK, GITHUB_ENV: path },
      fetchImpl: async () => { calls++; throw new Error("must not authenticate"); }, log,
    });
    assert.equal(calls, 0);
    assert.ok(lines.some((line) => line.includes("migration is pending")));
    assert.ok(readFileSync(path, "utf8").includes(SENTINEL_FALLBACK));
    assert.ok(lines.every((line) => !line.includes("unused-secret")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a rejected service token never falls back to another identity or exposes upstream errors", async () => {
  const { dir, path } = tempGithubEnv();
  const { lines, log } = collectLines();
  const calls = [];
  try {
    await assert.rejects(run({
      env: { INFISICAL_PROJECT_ID: "proj", INFISICAL_NAMES: "FOO", INFISICAL_REQUIRED: "FOO",
        INFISICAL_TOKEN: "st.refused-fixture", INFISICAL_CLIENT_ID: "unused-id", INFISICAL_CLIENT_SECRET: "unused-secret", GITHUB_ENV: path },
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (String(url).includes("/api/v2/service-token")) return new Response("private error body", { status: 403 });
        throw new Error("must not read after rejected metadata");
      }, log,
    }), /Missing required/);
    assert.equal(calls.length, 1);
    assert.ok(calls.every((url) => url.includes("/api/v2/service-token")));
    assert.ok(lines.every((line) => !line.includes("st.refused-fixture") && !line.includes("unused-secret")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a name present in the vault is masked and written to GITHUB_ENV", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "FOO",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_TOKEN: "st.fixture",
        GITHUB_ENV: path,
      },
      fetchImpl: stubFetch({ FOO: SENTINEL_PRESENT }),
      log,
    });

    assert.ok(lines.some((l) => l === `::add-mask::${SENTINEL_PRESENT}`));
    const written = readFileSync(path, "utf8");
    assert.match(written, /^FOO<<INFISICAL_[0-9a-f]+\n/m);
    assert.match(written, new RegExp(SENTINEL_PRESENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // Every line that is not the add-mask carrier line for this value must
    // never carry the value itself.
    for (const line of lines) {
      if (line === `::add-mask::${SENTINEL_PRESENT}`) continue;
      assert.doesNotMatch(line, new RegExp(SENTINEL_PRESENT));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name missing from the vault falls back to GH_FALLBACK_<NAME>", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "BAR",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_TOKEN: "st.fixture",
        GH_FALLBACK_BAR: SENTINEL_FALLBACK,
        GITHUB_ENV: path,
      },
      fetchImpl: stubFetch({}),
      log,
    });

    assert.ok(lines.some((l) => l === `::add-mask::${SENTINEL_FALLBACK}`));
    const written = readFileSync(path, "utf8");
    assert.match(written, /^BAR<<INFISICAL_[0-9a-f]+\n/m);
    assert.ok(!lines.some((l) => l.startsWith("::warning::") || l.startsWith("::error::")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name missing from both the vault and the fallback warns and is absent", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "BAZ",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_TOKEN: "st.fixture",
        GITHUB_ENV: path,
      },
      fetchImpl: stubFetch({}),
      log,
    });

    assert.ok(
      lines.some((l) => l === "::warning::BAZ is empty after the Infisical prod export and the GitHub secret fallback."),
    );
    assert.ok(!lines.some((l) => l.startsWith("::add-mask::")));
    assert.ok(!lines.some((l) => l.startsWith("::error::")));
    let written = "";
    try {
      written = readFileSync(path, "utf8");
    } catch {
      // No entries at all means the file was never created -- also fine.
    }
    assert.doesNotMatch(written, /^BAZ<</m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing required name rejects instead of silently continuing", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    await assert.rejects(
      () =>
        run({
          env: {
            INFISICAL_NAMES: "QUX",
            INFISICAL_REQUIRED: "QUX",
            INFISICAL_PROJECT_ID: "proj",
            INFISICAL_TOKEN: "st.fixture",
            GITHUB_ENV: path,
          },
          fetchImpl: stubFetch({}),
          log,
        }),
      /QUX/,
    );
    assert.ok(
      lines.some((l) => l === "::error::QUX is empty after the Infisical prod export and the GitHub secret fallback."),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every line in a mixed run is either an add-mask carrier or a warning, never a bare sentinel", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "FOO BAZ",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_TOKEN: "st.fixture",
        GITHUB_ENV: path,
      },
      fetchImpl: stubFetch({ FOO: SENTINEL_PRESENT }),
      log,
    });

    for (const line of lines) {
      const isMask = line.startsWith("::add-mask::");
      const isWarning = line.startsWith("::warning::");
      assert.ok(isMask || isWarning, `unexpected log line shape: ${line}`);
      if (!isMask) assert.doesNotMatch(line, new RegExp(SENTINEL_PRESENT));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no configured identity resolves purely from GH_FALLBACK_<NAME>, with no fetch call", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    let fetchCalled = false;
    await run({
      env: {
        INFISICAL_NAMES: "BAR",
        GH_FALLBACK_BAR: SENTINEL_FALLBACK,
        GITHUB_ENV: path,
      },
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("must not be called when unconfigured");
      },
      log,
    });
    assert.equal(fetchCalled, false);
    assert.ok(lines.some((l) => l === `::add-mask::${SENTINEL_FALLBACK}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every line of a multi-line value gets its own ::add-mask:: and is never printed bare", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "MAC_CERT_P12_BASE64",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_TOKEN: "st.fixture",
        GITHUB_ENV: path,
      },
      fetchImpl: stubFetch({ MAC_CERT_P12_BASE64: SENTINEL_MULTILINE }),
      log,
    });

    // GitHub parses ::add-mask:: one line at a time, so each line of the
    // value has to arrive as its own command or the runner echoes the rest.
    assert.ok(lines.includes(`::add-mask::${SENTINEL_LINE_1}`), "first line was not masked on its own");
    assert.ok(lines.includes(`::add-mask::${SENTINEL_LINE_2}`), "second line was not masked on its own");

    // ORDER is the finding this test exists for.  A `::add-mask::<whole
    // value>` command emitted ahead of the per-line ones registers only line
    // one and echoes every later line into the public log on the way past --
    // so the per-line masks must come FIRST, and no command may carry a
    // newline at all.
    const masks = lines.filter((line) => line.startsWith("::add-mask::"));
    assert.equal(masks[0], `::add-mask::${SENTINEL_LINE_1}`);
    assert.equal(masks[1], `::add-mask::${SENTINEL_LINE_2}`);
    for (const line of lines) assert.doesNotMatch(line, /[\r\n]/);

    // And no line of the value may appear anywhere except as the payload of
    // a mask command -- that is the whole leak this guards.  Lines two
    // onward are checked against every command, mask commands included:
    // only their own carrier line may name them.
    lines.forEach((line, index) => {
      if (line === `::add-mask::${SENTINEL_LINE_1}` || line === `::add-mask::${SENTINEL_LINE_2}`) return;
      assert.doesNotMatch(line, new RegExp(SENTINEL_LINE_1), `line ${index} leaked the first line`);
      assert.doesNotMatch(line, new RegExp(SENTINEL_LINE_2), `line ${index} leaked the second line`);
    });

    // The value still round-trips whole into GITHUB_ENV, newline included.
    const written = readFileSync(path, "utf8");
    assert.match(written, new RegExp(`${SENTINEL_LINE_1}\\n${SENTINEL_LINE_2}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maskValue emits one command per line, in order, and never the joined value", () => {
  const single = [];
  maskValue("one-line-value", (l) => single.push(l));
  assert.deepEqual(single, ["::add-mask::one-line-value"]);

  const wrapped = [];
  maskValue("aaa\r\nbbb\n\n", (l) => wrapped.push(l));
  // Per line, in reading order, and the joined value is absent: a command
  // carrying it would register only `aaa` and print `bbb` on the way past.
  // The blank trailing line is skipped rather than masking the empty string.
  assert.deepEqual(wrapped, ["::add-mask::aaa", "::add-mask::bbb"]);
  for (const line of wrapped) assert.doesNotMatch(line, /[\r\n]/);

  // A value whose lines repeat still costs one command per distinct line.
  const repeated = [];
  maskValue("same\nsame\nother", (l) => repeated.push(l));
  assert.deepEqual(repeated, ["::add-mask::same", "::add-mask::other"]);
});

test("writeGithubEnvValue is a no-op with no GITHUB_ENV path", () => {
  let called = false;
  writeGithubEnvValue("", "NAME", "value", () => {
    called = true;
  });
  assert.equal(called, false);
});

test("CLI entry exits non-zero for a missing required name with no vault configured", () => {
  const { dir, path } = tempGithubEnv();
  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        INFISICAL_NAMES: "QUX",
        INFISICAL_REQUIRED: "QUX",
        GITHUB_ENV: path,
      },
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SENTINEL_PRESENT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI entry exits zero when every name is best-effort and absent", () => {
  const { dir, path } = tempGithubEnv();
  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        INFISICAL_NAMES: "BAZ",
        GITHUB_ENV: path,
      },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /::warning::BAZ is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
