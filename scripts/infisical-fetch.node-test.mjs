import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { maskValue, run, writeGithubEnvValue } from "./infisical-fetch.mjs";

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

/** A stub fetch standing in for Infisical: login always succeeds, the list
 * call returns exactly the fixture secrets given. Neither ever touches the
 * network. */
function stubFetch(vaultSecrets) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/api/v1/auth/universal-auth/login")) {
      return {
        ok: true,
        json: async () => ({ accessToken: "test-token", expiresIn: 3600 }),
      };
    }
    if (u.includes("/api/v3/secrets/raw")) {
      return {
        ok: true,
        json: async () => ({
          secrets: Object.entries(vaultSecrets).map(([secretKey, secretValue]) => ({ secretKey, secretValue })),
        }),
      };
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
        calls.push({ url: String(url), headers: init?.headers ?? {} });
        return {
          ok: true,
          json: async () => ({
            secrets: [{ secretKey: "FOO", secretValue: SENTINEL_PRESENT }],
          }),
        };
      },
      log,
    });
    assert.equal(calls.length, 1, "a service token must not trigger a login call");
    assert.match(calls[0].url, /\/api\/v3\/secrets\/raw/);
    assert.ok(
      String(calls[0].headers.authorization ?? "").endsWith("st.test-token"),
      "the service token must be the bearer credential",
    );
    assert.match(readFileSync(path, "utf8"), /FOO</);
    assert.ok(lines.some((line) => line === `::add-mask::${SENTINEL_PRESENT}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
        return {
          ok: true,
          json: async () => ({
            secrets: [{ secretKey: "FOO", secretValue: SENTINEL_PRESENT }],
          }),
        };
      },
      log,
    });
    assert.equal(calls.length, 1, "the token path must not also log in");
    assert.ok(String(calls[0].headers.authorization ?? "").endsWith("st.test-token"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name present in the vault is masked and written to GITHUB_ENV", async () => {
  const { dir, path } = tempGithubEnv();
  try {
    const { lines, log } = collectLines();
    await run({
      env: {
        INFISICAL_NAMES: "FOO",
        INFISICAL_PROJECT_ID: "proj",
        INFISICAL_CLIENT_ID: "id",
        INFISICAL_CLIENT_SECRET: "secret",
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
        INFISICAL_CLIENT_ID: "id",
        INFISICAL_CLIENT_SECRET: "secret",
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
        INFISICAL_CLIENT_ID: "id",
        INFISICAL_CLIENT_SECRET: "secret",
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
            INFISICAL_CLIENT_ID: "id",
            INFISICAL_CLIENT_SECRET: "secret",
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
        INFISICAL_CLIENT_ID: "id",
        INFISICAL_CLIENT_SECRET: "secret",
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
        INFISICAL_CLIENT_ID: "id",
        INFISICAL_CLIENT_SECRET: "secret",
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
