// Operator entry point for the harness release store.
//
// The store itself (scripts/harness-release-store.mjs) is a library; this is
// the thing a person runs.  The whole point of the store is that the
// always-on harness runs from an immutable, per-commit release directory
// behind one atomically swapped pointer, instead of from a mutable git
// worktree that an update rewrites under a live process.
//
// Usage:
//   harness-release.mjs stage <commit> [--repo <path>] [--skip-install]
//   harness-release.mjs promote <commit>
//   harness-release.mjs swap <commit>
//   harness-release.mjs activate <commit>        # stage, promote, swap
//   harness-release.mjs status
//   harness-release.mjs list
//   harness-release.mjs prune [--keep N]
//
// Every command prints what it did and where the pointer ended up.  No
// command touches a running harness: activating a release is a pointer
// swap, and the harness is restarted separately (launchd's periodic tick
// picks up the new pointer).

import { basename, join } from "node:path";
import {
  currentCommit,
  listReleases,
  promoteStaging,
  pruneReleases,
  releasePath,
  resolveCurrent,
  stageRelease,
  swapCurrent,
} from "./harness-release-store.mjs";

const FULL_COMMIT = /^[a-f0-9]{40}$/;

function usage() {
  process.stdout.write(
    [
      "usage: harness-release.mjs <command> [args]",
      "",
      "  stage <commit> [--repo <path>] [--skip-install]   export a commit and install its deps",
      "                                                   (--skip-install is for staging only)",
      "  (every command accepts --store <root> for a separate store namespace)",
      "  promote <commit>                                  move staging into releases/",
      "  swap <commit>                                     point current at a release",
      "  activate <commit> [--repo <path>]                 stage, promote and swap",
      "  status                                            where current points",
      "  list                                              every release in the store",
      "  prune [--keep N]                                  drop old, unheld releases",
      "",
    ].join("\n"),
  );
}

function flag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

/**
 * The launchd job that runs a store, and the line to print after a swap.
 *
 * The job follows the STORE, not the presence of a flag: an explicit
 * `--store <harness store>` is still the harness, and naming the sidecar's
 * job for it would send an operator to restart the wrong program.
 */
function restartHint(env) {
  const effectiveRoot = env.BOTFLEET_RELEASES_ROOT || join(env.HOME ?? "", ".botfleet");
  // Case-folded: a volume can be case-insensitive, so a store root named
  // "BotFleet-Companion" is the companion's store, and comparing it
  // case-sensitively would name the wrong job.
  const job = basename(effectiveRoot).toLowerCase() === "botfleet-companion" ? "app.botfleet.companion" : "app.botfleet.server";
  return `restart ${job} to pick the new release up (launchctl kickstart -k gui/$(id -u)/${job})`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return 0;
  }
  const env = { ...process.env };
  // A separate store root, so two programs that version independently do
  // not share one pointer: the server and the companion sidecar each move
  // their own release, and swapping one cannot change what the other runs.
  const store = flag(args, "--store");
  if (store) env.BOTFLEET_RELEASES_ROOT = store;

  if (command === "status") {
    const physical = await resolveCurrent(env);
    const commit = await currentCommit(env);
    process.stdout.write(`current: ${physical ?? "(none)"}\n`);
    process.stdout.write(`commit:  ${commit ?? "(none)"}\n`);
    if (physical) {
      const { isReleaseDirectory } = await import("./harness-release-store.mjs");
      const immutable = await isReleaseDirectory(physical);
      process.stdout.write(`shape:   ${immutable ? "immutable release" : "NOT a release (mutable tree)"}\n`);
    }
    return 0;
  }

  if (command === "list") {
    const releases = await listReleases(env);
    if (!releases.length) {
      process.stdout.write("no releases in the store\n");
      return 0;
    }
    // listReleases answers the commits, oldest promotion first, because
    // retention ranks by when a release was promoted rather than by its name.
    const current = await currentCommit(env);
    for (const commit of releases) {
      process.stdout.write(`${commit === current ? "*" : " "} ${commit}  ${releasePath(commit, env)}\n`);
    }
    return 0;
  }

  if (command === "prune") {
    const keep = Number(flag(args, "--keep") ?? "2");
    const result = await pruneReleases({ env, keep: Number.isFinite(keep) ? keep : 2 });
    process.stdout.write(`pruned:  ${result.removed?.length ?? 0}\n`);
    for (const removed of result.removed ?? []) process.stdout.write(`  removed ${removed}\n`);
    return 0;
  }

  const commit = args.find((argument) => FULL_COMMIT.test(argument));
  if (!commit) {
    process.stderr.write("A full 40-character commit is required.\n");
    usage();
    return 2;
  }

  if (command === "stage") {
    const staging = await stageRelease({
      commit,
      repo: flag(args, "--repo"),
      env,
      install: !args.includes("--skip-install"),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(`staged:  ${staging}\n`);
    return 0;
  }

  if (command === "promote") {
    const path = await promoteStaging({ commit, env });
    process.stdout.write(`promoted: ${path}\n`);
    return 0;
  }

  if (command === "swap") {
    const result = await swapCurrent({ commit, env });
    process.stdout.write(`current: ${releasePath(commit, env)}\n`);
    // swapCurrent answers { activated, previous, atomic }.  `previous` is the
    // release that was displaced, and it is null when nothing was displaced
    // (the first activation), so it is checked rather than printed blindly.
    if (result.previous) process.stdout.write(`previous release kept: ${result.previous}\n`);
    if (!result.atomic) {
      process.stdout.write("the pointer swap was not atomic; the old release was put back\n");
    }
    // A swap is not live until the program restarts, so the hint belongs
    // here as much as it does on activate.
    process.stdout.write(`${restartHint(env)}\n`);
    return 0;
  }

  if (command === "activate") {
    // A release without its dependencies is dead on arrival, and a promoted
    // release is READ-ONLY, so the launcher's self-heal cannot install into
    // it: the harness would sit there failing to import a module until an
    // operator swapped the pointer back.  That is the outage the store
    // exists to prevent, so activate always installs.
    if (args.includes("--skip-install")) {
      process.stderr.write(
        "harness-release: activate always installs dependencies.  A release without node_modules cannot start, and a promoted release is read-only, so nothing could repair it.  Use `stage --skip-install` for a tree you will not promote.\n",
      );
      return 2;
    }
    await stageRelease({
      commit,
      repo: flag(args, "--repo"),
      env,
      install: true,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    const path = await promoteStaging({ commit, env });
    process.stdout.write(`promoted: ${path}\n`);
    const result = await swapCurrent({ commit, env });
    process.stdout.write(`current: ${releasePath(commit, env)}\n`);
    if (result.previous) process.stdout.write(`previous release kept: ${result.previous}\n`);
    process.stdout.write(`${restartHint(env)}\n`);
    return 0;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  usage();
  return 2;
}

process.exitCode = await main().catch((error) => {
  // An operator gets the reason, not a stack trace.  The cause code is the
  // stable part (a missing commit, a failed export, a cross-device
  // rename), and the message already says what to do about it.
  const cause = error?.cause ? ` (${error.cause})` : "";
  process.stderr.write(`harness-release: ${error?.message || error}${cause}\n`);
  return 1;
});
