import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isRetiredBackendPath,
  isRetiredLinearCli,
  resolveBoardCli,
} from "./decommission-gate-state.mjs";

/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this test file. */

// The retired `board` binary, its `board-legacy` alias and the mac-collab
// backend behind them are retired write routes (AGENTS.md), and the refresh
// used to resolve `board` in preference to the current CLI.  The
// resolver's choice is pinned here: simple-board, never board.

/**
 * A temp directory under its canonical spelling.  The resolver returns
 * the path it validated through realpath, so a test root spelled through
 * a symlinked TMPDIR (macOS /var -> /private/var) would compare unequal
 * to the resolved path although both name the same directory (BF-2719).
 */
function tempRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

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
  const root = tempRoot("bf-linear-cli-");
  for (const name of names) writeFakeCli(join(root, name));
  linkWhich(root);
  return root;
}

/** A private HOME, optionally holding a verified CLI under ~/.local/bin. */
function fakeHome(names) {
  const root = tempRoot("bf-linear-home-");
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

/** A private HOME whose own directory name can be chosen. */
function fakeHomeNamed(name, names) {
  const parent = tempRoot("bf-linear-home-");
  const home = join(parent, name);
  mkdirSync(home, { recursive: true });
  if (names.length > 0) {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    for (const cli of names) writeFakeCli(join(home, ".local", "bin", cli));
  }
  return { parent, home };
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

test("the retired CLI check folds the basename case", () => {
  for (const retired of [
    "/usr/local/bin/board",
    "/usr/local/bin/BOARD",
    "/usr/local/bin/Board",
    "/usr/local/bin/BOARD-LEGACY",
    "/usr/local/bin/Board-legacy",
  ]) {
    assert.equal(
      isRetiredLinearCli(retired),
      true,
      `${retired} names a retired CLI, whatever the case`,
    );
  }
  assert.equal(
    isRetiredLinearCli("/usr/local/bin/simple-board"),
    false,
    "the current CLI is not a retired CLI",
  );
});

test("BOARD_CLI may not name a retired CLI in a different case", () => {
  for (const retired of [
    "/usr/local/bin/BOARD",
    "/usr/local/bin/Board",
    "/usr/local/bin/BOARD-LEGACY",
    "/usr/local/bin/Board-legacy",
  ]) {
    assert.throws(
      () => withEnv({ BOARD_CLI: retired }, resolveBoardCli),
      /retired Linear CLI/,
      `BOARD_CLI=${retired} must be refused`,
    );
  }
});

test("a BOARD_CLI symlink to a retired board binary is refused", () => {
  const root = tempRoot("bf-linear-symlink-");
  try {
    // A stand-in for the retired binary, never executed: the resolver only
    // resolves paths, it never runs them.
    writeFakeCli(join(root, "board"));
    const link = join(root, "linear-cli");
    symlinkSync(join(root, "board"), link);
    assert.throws(
      () => withEnv({ BOARD_CLI: link }, resolveBoardCli),
      /retired Linear CLI/,
      "a symlink to the retired board binary must be refused",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a BOARD_CLI symlink to the current CLI is still accepted", () => {
  const root = tempRoot("bf-linear-symlink-");
  try {
    writeFakeCli(join(root, "current-cli"));
    const link = join(root, "simple-board");
    symlinkSync(join(root, "current-cli"), link);
    const resolved = withEnv({ BOARD_CLI: link }, resolveBoardCli);
    // The VALIDATED path comes back, not the literal spelling of it:  the
    // exec has to run exactly the target the gate judged.
    assert.equal(resolved, join(root, "current-cli"), "a symlink to the current CLI must still resolve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verified default that resolves to a retired CLI is refused", () => {
  // The default branch under ~/.local/bin carries the same gate as the
  // override and the PATH branch.  A verified default that is a symlink to
  // the retired binary is that retired write route under an innocent name.
  const root = tempRoot("bf-linear-default-");
  try {
    writeFakeCli(join(root, "board"));
    const binDir = join(root, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(root, "board"), join(binDir, "simple-board"));
    assert.throws(
      () => withEnv({ BOARD_CLI: undefined, HOME: root }, resolveBoardCli),
      /retired Linear CLI/,
      "a verified default that resolves to the retired binary must be refused",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the PATH branch returns the validated path, not the literal one", () => {
  // The gate judges the RESOLVED path, so that is the path the caller gets
  // back:  a literal that the gate never judged would leave a gap between
  // the check and the exec.
  const bin = fakeBin([]);
  const home = fakeHome([]);
  try {
    // The CLI on PATH is a symlink, so `which` answers with the symlink and
    // the gate judges the target behind it.
    writeFakeCli(join(bin, "current-cli"));
    symlinkSync(join(bin, "current-cli"), join(bin, "simple-board"));
    const resolved = withEnv(
      { BOARD_CLI: undefined, HOME: home, PATH: bin },
      resolveBoardCli,
    );
    assert.equal(
      resolved,
      join(bin, "current-cli"),
      "the PATH branch must return the path the gate validated",
    );
    assert.notEqual(
      resolved,
      join(bin, "simple-board"),
      "the PATH branch must not return the unchecked literal path",
    );
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
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

test("a HOME whose name merely contains the retired marker is not the retired backend", () => {
  // The retired-backend marker is matched as a whole path segment, so a
  // home directory called mac-collab-user is a user's home and not the
  // retired backend.  The verified CLI there has to resolve.
  const { parent, home } = fakeHomeNamed("mac-collab-user", ["simple-board"]);
  try {
    const resolved = withEnv(
      { BOARD_CLI: undefined, HOME: home, PATH: "/usr/bin:/bin" },
      resolveBoardCli,
    );
    assert.equal(
      resolved,
      realpathSync(join(home, ".local", "bin", "simple-board")),
      "a HOME whose name merely contains the retired marker must not lose the verified CLI",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a HOME inside the retired backend directory is still refused", () => {
  // The retired backend directory itself is still the retired backend, so
  // the verified CLI inside it is refused.
  const { parent, home } = fakeHomeNamed("mac-collab", ["simple-board"]);
  try {
    assert.throws(
      () =>
        withEnv({ BOARD_CLI: undefined, HOME: home, PATH: "/usr/bin:/bin" }, resolveBoardCli),
      /retired mac-collab backend/,
      "the retired backend directory itself must still be refused",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("BOARD_CLI inside a directory named mac-collab is refused", () => {
  const parent = tempRoot("bf-linear-override-");
  try {
    const retiredBin = join(parent, "mac-collab", "bin");
    mkdirSync(retiredBin, { recursive: true });
    const cli = join(retiredBin, "simple-board");
    writeFakeCli(cli);
    assert.throws(
      () => withEnv({ BOARD_CLI: cli }, resolveBoardCli),
      /mac-collab backend/,
      "a BOARD_CLI inside the retired backend directory must be refused",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the retired backend segment matches whatever the case", () => {
  // A case-insensitive volume resolves the retired backend under any
  // spelling, so the segment comparison is case-folded.
  const { parent, home } = fakeHomeNamed("MAC-COLLAB", ["simple-board"]);
  try {
    assert.throws(
      () =>
        withEnv({ BOARD_CLI: undefined, HOME: home, PATH: "/usr/bin:/bin" }, resolveBoardCli),
      /retired mac-collab backend/,
      "the retired backend segment must match whatever the case",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the retired backend marker matches a whole path segment only", () => {
  assert.equal(
    isRetiredBackendPath("/Users/jay/apps/mac-collab/bin/board"),
    true,
    "the retired backend directory is the retired backend",
  );
  assert.equal(
    isRetiredBackendPath("/home/mac-collab-user/.local/bin/simple-board"),
    false,
    "a directory whose name merely contains the marker is not the retired backend",
  );
  assert.equal(
    isRetiredBackendPath("C:\\apps\\mac-collab\\bin\\board"),
    true,
    "a Windows-style path counts too",
  );
});
