import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveBoardCli } from "./decommission-gate-state.mjs";

/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this test file. */

// The retired `board` binary, its `board-legacy` alias and the mac-collab
// backend behind them are retired write routes (AGENTS.md), and the refresh
// used to resolve `board` in preference to the current CLI.  The
// resolver's choice is pinned here: simple-board, never board.

/** A stand-in CLI that answers nothing, because the resolver never runs it. */
function writeFakeCli(path) {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

/** The real `which`, linked into a fake PATH so the resolver can search it. */
function linkWhich(root) {
  for (const candidate of ["/usr/bin/which", "/bin/which", "/usr/local/bin/which"]) {
    if (!existsSync(candidate)) continue;
    symlinkSync(candidate, join(root, "which"));
    return;
  }
}

/** A private directory that stands in for one PATH entry. */
function fakeBin(names) {
  const root = mkdtempSync(join(tmpdir(), "bf-linear-cli-"));
  for (const name of names) writeFakeCli(join(root, name));
  linkWhich(root);
  return root;
}

/** A private HOME, optionally holding a verified CLI under ~/.local/bin. */
function fakeHome(names) {
  const root = mkdtempSync(join(tmpdir(), "bf-linear-home-"));
  if (names.length === 0) return root;
  mkdirSync(join(root, ".local", "bin"), { recursive: true });
  for (const name of names) writeFakeCli(join(root, ".local", "bin", name));
  return root;
}

/** Run with a controlled environment, then put the caller's environment back. */
function withEnv(env, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the refresh resolves simple-board and never the retired board binary", () => {
  const bin = fakeBin(["simple-board", "board"]);
  const home = fakeHome([]);
  try {
    const resolved = withEnv(
      { BOARD_CLI: undefined, HOME: home, PATH: bin },
      resolveBoardCli,
    );
    assert.equal(
      resolved,
      join(bin, "simple-board"),
      "the refresh must resolve simple-board, not the retired board CLI",
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the verified simple-board wins over a retired board on PATH", () => {
  const bin = fakeBin(["board"]);
  const home = fakeHome(["simple-board"]);
  try {
    const resolved = withEnv(
      { BOARD_CLI: undefined, HOME: home, PATH: bin },
      resolveBoardCli,
    );
    assert.equal(
      resolved,
      join(home, ".local", "bin", "simple-board"),
      "the refresh must resolve the current CLI, not the retired board CLI",
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("the retired board binary is never resolved, even when it is the only one", () => {
  const bin = fakeBin(["board"]);
  const home = fakeHome([]);
  try {
    assert.throws(
      () => withEnv({ BOARD_CLI: undefined, HOME: home, PATH: bin }, resolveBoardCli),
      (error) => {
        assert.match(error.message, /simple-board/);
        assert.doesNotMatch(error.message, /install verified board/);
        return true;
      },
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("BOARD_CLI may not point at the retired board binary", () => {
  for (const retired of ["/usr/local/bin/board", "/usr/local/bin/board-legacy"]) {
    assert.throws(
      () => withEnv({ BOARD_CLI: retired }, resolveBoardCli),
      /retired Linear CLI/,
      `BOARD_CLI=${retired} must be refused`,
    );
  }
});

test("the fail-closed message names the current CLI", () => {
  const bin = fakeBin([]);
  const home = fakeHome([]);
  try {
    assert.throws(
      () => withEnv({ BOARD_CLI: undefined, HOME: home, PATH: bin }, resolveBoardCli),
      /Linear CLI 'simple-board' not found on PATH or at ~\/\.local\/bin\/simple-board/,
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
