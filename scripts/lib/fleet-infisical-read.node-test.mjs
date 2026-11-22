// The two shared helpers, and the contract every BotFleet read depends on.
//
// The reader is faked here:  the helpers only know that a reader is a program
// the shell and the node side run with `python3 -I`, so a fake that answers
// "value", "absent" or "refused" is enough to prove the exit codes, the
// argument list and the fail-closed behaviour.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readFleetSecret } from "./fleet-infisical-read.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_HELPER = join(HERE, "fleet-infisical-read.sh");
const FAKE_VALUE = "synthetic-reader-value";

/** A fake reader.  It records the arguments it was given and answers with
 * the mode the test asked for. */
function fakeReader(dir) {
  const path = join(dir, "infisical-scoped.py");
  const source = [
    "import os, sys",
    "with open(os.environ['FAKE_READER_ARGS'], 'a') as fh:",
    "    fh.write(' '.join(sys.argv[1:]) + '\\n')",
    "mode = os.environ.get('FAKE_READER_MODE', 'value')",
    "if mode == 'absent':",
    "    sys.exit(3)",
    "if mode == 'refused':",
    "    sys.exit(4)",
    "if mode == 'usage':",
    "    sys.exit(2)",
    "sys.stdout.write(os.environ.get('FAKE_READER_VALUE', '') + '\\n')",
  ].join("\n");
  writeFileSync(path, source);
  return path;
}

/** Run the shell helper the way a caller does:  source it, then call it. */
function shellGet(env, name, folder, account) {
  return spawnSync(
    "sh",
    ["-c", '. "$1"; fleet_secret_get "$2" "$3" "$4"', "sh", SHELL_HELPER, name, folder, account],
    { encoding: "utf8", env, timeout: 20_000 },
  );
}

/** The variables one reader fixture owns. */
const READER_ENV_KEYS = ["FAKE_READER_ARGS", "FAKE_READER_MODE", "FAKE_READER_VALUE", "FLEET_INFISICAL_READER"];

/**
 * Run `body` with the reader's variables set, and put the host's own values
 * back afterwards.
 *
 * The variables are saved one by one on purpose.  Replacing `process.env`
 * with a plain object detaches it from the real environment on Node 26:  a
 * child process then keeps the values from before the replacement, so the
 * fake reader answered with the previous test's path and the absent case read
 * as a refusal.  Node 22 copies the values into the environment instead, so
 * the fault only shows on the newer runtime and the fixture has to work on
 * both.
 */
function withReaderEnv(values, body) {
  const saved = new Map(READER_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withReader(mode, body) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-infisical-read-"));
  const argsFile = join(dir, "args");
  try {
    return withReaderEnv(
      {
        FAKE_READER_ARGS: argsFile,
        FAKE_READER_MODE: mode,
        FAKE_READER_VALUE: FAKE_VALUE,
        FLEET_INFISICAL_READER: fakeReader(dir),
      },
      () => body({ dir, argsFile, env: { ...process.env } }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a reader that answers returns the value to the caller and nothing else", () => {
  withReader("value", ({ argsFile, env }) => {
    const got = readFleetSecret("ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
    assert.equal(got.code, 0);
    assert.equal(got.value, FAKE_VALUE);
    assert.equal(got.reason, "ok");

    const run = shellGet(env, "ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
    assert.equal(run.status, 0);
    assert.equal(run.stdout, `${FAKE_VALUE}\n`);
    assert.equal(run.stderr, "");

    const asked = readFileSync(argsFile, "utf8").trim().split("\n");
    assert.equal(asked.length, 2);
    for (const line of asked) {
      assert.equal(line, "get ASC_KEY_ID --folder /asc --project fleet-ops --account fleet-tools-mm-asc-ro");
    }
  });
});

test("a reader that reports the name absent answers 3 and no value", () => {
  withReader("absent", ({ env }) => {
    const got = readFleetSecret("ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
    assert.equal(got.code, 3);
    assert.equal(got.value, null);
    assert.equal(got.reason, "absent");

    const run = shellGet(env, "ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
    assert.equal(run.status, 3);
    assert.equal(run.stdout, "");
  });
});

test("a reader that refuses answers 4 and no value", () => {
  withReader("refused", ({ env }) => {
    const got = readFleetSecret("ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
    assert.equal(got.code, 4);
    assert.equal(got.value, null);
    assert.equal(got.reason, "refused");

    const run = shellGet(env, "ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
    assert.equal(run.status, 4);
    assert.equal(run.stdout, "");
  });
});

test("a missing reader fails closed, prints no value and does not hang", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-infisical-read-missing-"));
  const missing = join(dir, "not-installed.py");
  try {
    withReaderEnv({ FLEET_INFISICAL_READER: missing }, () => {
      const got = readFleetSecret("ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
      assert.equal(got.code, 4);
      assert.equal(got.value, null);
      assert.equal(got.reason, "reader-missing");

      const run = shellGet({ ...process.env }, "ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
      assert.notEqual(run.signal, "SIGTERM");
      assert.equal(run.status, 4);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /reader is not installed/);
      assert.ok(!run.stderr.includes(FAKE_VALUE));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty account is refused before the reader runs", () => {
  withReader("value", ({ argsFile, env }) => {
    const got = readFleetSecret("ASC_KEY_ID", "/asc", "");
    assert.equal(got.code, 4);
    assert.equal(got.value, null);
    assert.equal(got.reason, "no-account");

    const run = shellGet(env, "ASC_KEY_ID", "/asc", "");
    assert.equal(run.status, 4);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /no scoped Infisical account/);
    assert.ok(!existsSync(argsFile), "the reader must not run without an account");
  });
});

test("the shell helper refuses a wrong command line with 2", () => {
  const run = spawnSync("sh", ["-c", '. "$1"; fleet_secret_get "$2"', "sh", SHELL_HELPER, "ONLY_A_NAME"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(run.status, 2);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /usage: fleet_secret_get/);
});
