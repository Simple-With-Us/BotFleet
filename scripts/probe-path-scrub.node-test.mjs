import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPathScrubber } from "./probe-path-scrub.mjs";

const slug = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");
test("scrubs sibling roots and dash-encoded cwd in memory_paths.auto", () => {
  const base = "/private/var/folders/user_hash/T/tmp.a_b";
  const scrub = createPathScrubber([[base + "/home", "<HOME>"], [base + "/config", "<CONFIG>"], [base + "/xdg", "<XDG>"], [base + "/cwd", "<CWD>"]]);
  const line = JSON.stringify({ memory_paths: { auto: base + "/config/projects/" + slug(base + "/cwd") + "/memory/" }, home: base + "/home", xdg: base + "/xdg" });
  const out = scrub(line);
  assert.deepEqual(JSON.parse(out), { memory_paths: { auto: "<CONFIG>/projects/<CWD>/memory/" }, home: "<HOME>", xdg: "<XDG>" });
  assert.ok(!out.includes("user_hash"));
});
test("longest root wins and unset roots leave unrelated text alone", () => {
  const scrub = createPathScrubber([["/tmp/probe", "<HOME>"], ["/tmp/probe/config", "<CONFIG>"], [undefined, "<XDG>"]]);
  assert.equal(scrub("/tmp/probe/config/file /tmp/probe/file ordinary"), "<CONFIG>/file <HOME>/file ordinary");
  assert.equal(createPathScrubber([])("ordinary"), "ordinary");
});
test("scrubs realpath and slugified realpath forms through a symlink", () => {
  const base = mkdtempSync(join(tmpdir(), "probe-scrub-"));
  try {
    const actual = join(base, "real.cwd_dir"); mkdirSync(actual);
    const alias = join(base, "alias"); symlinkSync(actual, alias);
    const scrub = createPathScrubber([[alias, "<CWD>"]]);
    assert.equal(scrub([alias, realpathSync(alias), slug(alias), slug(realpathSync(alias))].join("|")), "<CWD>|<CWD>|<CWD>|<CWD>");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
