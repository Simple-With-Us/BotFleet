// Where a Claude Write or Edit would really land.  Every case builds its own
// folders on disk, because the whole point is what the filesystem does with
// symlinks, `..` and paths that do not exist yet.  The "outside" folders and
// the fake temp root are siblings under one scratch folder rather than the
// real temp dir, so a test that should be refused cannot pass by accident
// just because everything happens to sit under os.tmpdir().
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { checkWriteTargets, type WriteCheckOptions } from "./path-containment.ts";

const posixOnly = describe.skipIf(process.platform === "win32");

let base: string;
let ws: string;
let outside: string;
let fakeTmp: string;
let home: string;
let options: WriteCheckOptions;

beforeAll(() => {
  // The `.native` spelling, because that is the spelling `checkWriteTargets`
  // reports: it walks paths with `realpathSync.native`, which on Windows
  // expands an 8.3 short name into the long form, while the non-native
  // `realpathSync` below leaves it short.  Resolving the scratch folder the
  // same way keeps every `join(ws, ...)` expectation comparable with the
  // `real` paths the module hands back.
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "omb-containment-")));
  ws = join(base, "ws");
  outside = join(base, "outside");
  fakeTmp = join(base, "faketmp");
  home = join(base, "home");
  for (const dir of [
    join(ws, "src", "deep"),
    join(outside, "sub"),
    join(outside, "LaunchAgents"),
    fakeTmp,
    join(home, ".config", "gh"),
    join(home, ".botfleet", "workspaces", "bot1"),
    join(base, "ws-evil"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(ws, "src", "a.ts"), "x");
  writeFileSync(join(outside, "secret.txt"), "x");
  options = { roots: [ws, fakeTmp], home, dataDir: join(home, ".botfleet") };
});

afterAll(() => removeTempDir(base));

const check = (path: string, over: Partial<WriteCheckOptions> = {}) =>
  checkWriteTargets([path], { ...options, ...over });

describe("a write that stays inside a root", () => {
  it("accepts an existing file", () => {
    expect(check(join(ws, "src", "a.ts"))).toMatchObject({ contained: true, real: [join(ws, "src", "a.ts")] });
  });

  it("accepts a new file in an existing folder", () => {
    expect(check(join(ws, "src", "new.ts"))).toMatchObject({ contained: true });
  });

  it("accepts a new file under folders that do not exist yet, via the nearest existing parent", () => {
    expect(check(join(ws, "a", "b", "c", "new.ts"))).toMatchObject({
      contained: true,
      real: [join(ws, "a", "b", "c", "new.ts")],
    });
  });

  it("accepts the fake temp root as a root of its own", () => {
    expect(check(join(fakeTmp, "scratch.txt"))).toMatchObject({ contained: true });
  });

  it("accepts doubled and trailing slashes, and a harmless ./ segment", () => {
    expect(check(`${ws}//src///./deep/`)).toMatchObject({ contained: true });
  });

  it("accepts a harmless .. that stays inside", () => {
    expect(check(`${ws}/src/deep/../a.ts`)).toMatchObject({ contained: true });
  });

  it("accepts every path of a multi-path ask only when all of them are inside", () => {
    expect(checkWriteTargets([join(ws, "a.ts"), join(ws, "b.ts")], options).contained).toBe(true);
    expect(checkWriteTargets([join(ws, "a.ts"), join(outside, "b.ts")], options)).toMatchObject({
      contained: false,
      why: "outside-roots",
    });
  });
});

describe("a write that leaves every root", () => {
  it("refuses a plain outside path", () => {
    expect(check(join(outside, "secret.txt"))).toMatchObject({ contained: false, why: "outside-roots" });
  });

  it("refuses a .. that climbs out", () => {
    expect(check(`${ws}/../outside/f.txt`)).toMatchObject({ contained: false, why: "outside-roots" });
    expect(check(`${ws}/src/../../outside/f.txt`)).toMatchObject({ contained: false, why: "outside-roots" });
  });

  it("refuses a sibling folder that merely shares the root's name as a prefix", () => {
    expect(check(join(base, "ws-evil", "f.txt"))).toMatchObject({ contained: false, why: "outside-roots" });
  });

  it("refuses the root's parent and the filesystem root", () => {
    expect(check(base)).toMatchObject({ contained: false });
    expect(check("/")).toMatchObject({ contained: false });
  });

  it("refuses a path that is not absolute, whatever the folder it might mean", () => {
    expect(check("src/a.ts")).toMatchObject({ contained: false, why: "relative-path" });
    expect(check("./a.ts")).toMatchObject({ contained: false, why: "relative-path" });
    expect(check("../outside/f")).toMatchObject({ contained: false, why: "relative-path" });
  });

  it("refuses home spellings the file tool might expand", () => {
    expect(check("~/.zshrc")).toMatchObject({ contained: false, why: "relative-path" });
    expect(check("~root/.zshrc")).toMatchObject({ contained: false, why: "relative-path" });
    expect(check("$HOME/.zshrc")).toMatchObject({ contained: false, why: "relative-path" });
    expect(check("${HOME}/.zshrc")).toMatchObject({ contained: false, why: "relative-path" });
    expect(check("%USERPROFILE%\\.zshrc")).toMatchObject({ contained: false, why: "relative-path" });
  });

  it("treats a $ in a later segment as the literal name it is", () => {
    expect(check(join(ws, "routes", "posts.$postId.tsx"))).toMatchObject({ contained: true });
  });

  it("refuses an empty list, an empty string and a NUL byte", () => {
    expect(checkWriteTargets([], options)).toMatchObject({ contained: false, why: "no-path" });
    expect(check("")).toMatchObject({ contained: false });
    expect(check(`${ws}/a.ts\0.png`)).toMatchObject({ contained: false, why: "invalid-path" });
  });

  it("has no root to be inside of when none was given", () => {
    expect(check(join(ws, "a.ts"), { roots: [] })).toMatchObject({ contained: false });
    expect(check(join(ws, "a.ts"), { roots: [undefined, ""] })).toMatchObject({ contained: false });
  });
});

describe("roots that are too wide to mean anything", () => {
  it("never treats the home folder as a root, so a bot with no folder keeps its rc files out", () => {
    const rc = join(home, ".zshrc");
    expect(check(rc, { roots: [home] })).toMatchObject({ contained: false, why: "outside-roots" });
    expect(check(join(home, "proj", "a.ts"), { roots: [home] })).toMatchObject({ contained: false });
  });

  it("never treats an ancestor of home or the filesystem root as a root", () => {
    expect(check(join(home, ".zshrc"), { roots: [base] })).toMatchObject({ contained: false });
    expect(check(join(ws, "a.ts"), { roots: [base] })).toMatchObject({ contained: false });
    expect(check(join(ws, "a.ts"), { roots: ["/"] })).toMatchObject({ contained: false });
  });

  it("still honours a folder inside home", () => {
    const proj = join(home, "proj");
    mkdirSync(proj, { recursive: true });
    expect(check(join(proj, "a.ts"), { roots: [proj] })).toMatchObject({ contained: true });
  });

  it("keeps a credential folder out even under a root that contains it", () => {
    const config = join(home, ".config");
    expect(check(join(config, "other", "x"), { roots: [config] })).toMatchObject({ contained: true });
    expect(check(join(config, "gh", "hosts.yml"), { roots: [config] })).toMatchObject({
      contained: false,
      why: "protected-dir",
    });
  });

  it("lets the bot's own workspace under the data directory be a root", () => {
    const workspace = join(home, ".botfleet", "workspaces", "bot1");
    expect(check(join(workspace, "MEMORY.md"), { roots: [workspace] })).toMatchObject({ contained: true });
    expect(check(join(home, ".botfleet", "config.json"), { roots: [workspace] })).toMatchObject({ contained: false });
  });

  // The case the Windows CI run caught, pinned so it cannot come back.  The
  // module walks a path with `realpathSync.native` (which expands an 8.3
  // short name to the long form) but its protected dirs used to be compared
  // with the non-native `realpathSync` (which leaves it short), so a home
  // spelled the short way degraded `~/.config/gh` from "protected-dir" to a
  // mere "outside-roots" and the credential folder was no longer named as
  // such.  On macOS and Linux both spellings are the same string and this is
  // a tautology; on Windows `raw` is the short form and `long` the long one,
  // which is exactly the pair that disagreed.
  it("refuses a credential folder however the caller spells home", () => {
    const raw = mkdtempSync(join(tmpdir(), "omb-home-"));
    const long = realpathSync.native(raw);
    const config = join(raw, ".config", "gh");
    mkdirSync(config, { recursive: true });
    for (const spelled of [raw, long]) {
      expect(check(join(config, "hosts.yml"), { roots: [spelled], home: spelled, dataDir: join(spelled, ".botfleet") }))
        .toMatchObject({ contained: false, why: "protected-dir" });
    }
    removeTempDir(raw);
  });
});

posixOnly("symlinks", () => {
  it("refuses a file symlink in the workspace that points outside", () => {
    symlinkSync(join(outside, "secret.txt"), join(ws, "link-to-secret"));
    expect(check(join(ws, "link-to-secret"))).toMatchObject({
      contained: false,
      why: "outside-roots",
      real: [join(outside, "secret.txt")],
    });
  });

  it("refuses a folder symlink in the workspace that points outside", () => {
    symlinkSync(outside, join(ws, "link-to-outside"));
    expect(check(join(ws, "link-to-outside", "new.txt"))).toMatchObject({
      contained: false,
      real: [join(outside, "new.txt")],
    });
  });

  it("refuses a symlink to the home folder, the shape that reaches ~/.zshrc", () => {
    symlinkSync(home, join(ws, "home-link"));
    expect(check(join(ws, "home-link", ".zshrc"))).toMatchObject({
      contained: false,
      real: [join(home, ".zshrc")],
    });
  });

  it("refuses a symlink chain: workspace to temp to outside", () => {
    symlinkSync(outside, join(fakeTmp, "hop"));
    symlinkSync(join(fakeTmp, "hop"), join(ws, "two-hops"));
    expect(check(join(ws, "two-hops", "x.txt"))).toMatchObject({ contained: false });
  });

  it("refuses a dangling file symlink, which a write would follow and create", () => {
    symlinkSync(join(outside, "LaunchAgents", "com.evil.plist"), join(ws, "evil.plist"));
    expect(check(join(ws, "evil.plist"))).toMatchObject({ contained: false });
  });

  it("refuses a dangling folder symlink, and anything written below it", () => {
    symlinkSync(join(outside, "does-not-exist-yet"), join(ws, "dangling-dir"));
    expect(check(join(ws, "dangling-dir"))).toMatchObject({ contained: false });
    expect(check(join(ws, "dangling-dir", "file.txt"))).toMatchObject({ contained: false });
  });

  it("refuses a symlink loop", () => {
    symlinkSync(join(ws, "loop-b"), join(ws, "loop-a"));
    symlinkSync(join(ws, "loop-a"), join(ws, "loop-b"));
    expect(check(join(ws, "loop-a"))).toMatchObject({ contained: false });
    expect(check(join(ws, "loop-a", "x"))).toMatchObject({ contained: false });
  });

  it("accepts a symlink that stays inside the root", () => {
    symlinkSync(join(ws, "src"), join(ws, "src-alias"));
    expect(check(join(ws, "src-alias", "new.ts"))).toMatchObject({
      contained: true,
      real: [join(ws, "src", "new.ts")],
    });
  });

  it("accepts a root that is itself reached through a symlink", () => {
    const alias = join(base, "ws-alias");
    symlinkSync(ws, alias);
    expect(check(join(alias, "src", "x.ts"))).toMatchObject({ contained: true });
    expect(check(join(ws, "src", "x.ts"), { roots: [alias] })).toMatchObject({ contained: true });
  });

  it("judges `..` the way the OS does after a symlink, not the way the string reads", () => {
    // ws/jump -> outside/sub, so "ws/jump/../f.txt" is outside/f.txt on disk
    // even though, read as a string, it collapses to ws/f.txt
    symlinkSync(join(outside, "sub"), join(ws, "jump"));
    expect(check(`${ws}/jump/../f.txt`)).toMatchObject({ contained: false });
    expect(check(`${ws}/jump/../f.txt`).real).toContain(join(outside, "f.txt"));
  });

  it("refuses a nonexistent folder followed by .., which no filesystem would let a write through", () => {
    expect(check(`${ws}/nope/../f.txt`)).toMatchObject({ contained: false });
  });

  it("refuses to write below a regular file", () => {
    expect(check(join(ws, "src", "a.ts", "child"))).toMatchObject({ contained: false });
  });
});
