#!/usr/bin/env bash
# On-demand Mac updater entrypoint.  The transaction implementation stays in
# the tracked BotFleet checkout so the installed helper and its tests cannot
# drift apart.  A machine copy of this file lives at ~/apps/update-botfleet.sh.
#
# When Electron spawns this script from a packaged .app, PATH is reduced to
# /usr/bin:/bin:/usr/sbin:/sbin, which does not include Homebrew or nvm.
# Prepend the common node locations so `node` resolves regardless of how this
# script is invoked.
#
# `ubf` is a no-op when the local BotFleet checkout is already at origin/main.
# Override with BOTFLEET_FORCE=1 (or --force / -f) to reinstall anyway.  The
# transaction inside update-botfleet-mac.mjs has no built-in "already current"
# short circuit; the skip happens here so a second `ubf` an hour later is
# sub-second instead of a 2-minute interruption.
#
# Busy bots never block an update.  The updater asks BotFleet to hold new work,
# gives the work already running a 60-second grace (--grace SECONDS), then
# interrupts what is left, saves it to pending-update-resume.json and resumes it
# after the update.  A live room turn is never interrupted; the updater waits a
# few more minutes for rooms to go quiet, then stops without updating.
# --wait-for-idle [MINUTES] never interrupts: it waits (20 minutes by default)
# and stops without updating if bots are still busy.  --force skips the grace
# and interrupts at once, and reinstalls even when already current.
#
# With no --target (and no BOTFLEET_UPDATE_TARGET), `ubf` installs the NEWEST
# commit on origin/main whose hosted Mac build succeeded, as long as it is newer
# than the installed build, instead of insisting on main's tip.  Main moves
# faster than the hosted build finishes (each push cancels the build of the
# commit it supersedes), so the tip's build is usually queued or cancelled and
# an update that demanded it failed.  The wrapper prints which commit it chose
# and how far behind the tip that is; when nothing newer has a green build the
# update stops with that explanation.  An explicit --target is installed
# exactly as named, and BOTFLEET_UPDATE_SOURCE=local keeps the tip.
set -euo pipefail

# Only this wrapper may tell the updater that no hosted build was available to
# choose (see the selection step below); never inherit that from the caller.
unset BOTFLEET_UPDATE_SELECTION_FAILURE

# Extend PATH with every place node is commonly found on macOS (Homebrew Apple
# Silicon, Homebrew Intel, nvm default, fnm default, local pnpm node, and
# Volta).  Already-present entries are harmless duplicates.
export PATH=\
"/opt/homebrew/bin"\
":/usr/local/bin"\
":${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node/" 2>/dev/null | sort -V | tail -1)/bin"\
":${HOME}/.fnm/node-versions/$(ls "${HOME}/.fnm/node-versions/" 2>/dev/null | sort -V | tail -1)/installation/bin"\
":${HOME}/.local/share/pnpm"\
":${HOME}/.local/bin"\
":${HOME}/.volta/bin"\
":${PATH}"

# Resolve the node binary explicitly so a missing one produces a clear message
# rather than a confusing "exec: node: not found" (exit 127) after the script
# was supposed to work.
NODE_BIN=""
for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then
    NODE_BIN="$candidate"
    break
  fi
done
if [[ -z "$NODE_BIN" ]]; then
  echo "BotFleet updater: node not found.  Install Node.js via Homebrew: brew install node" >&2
  exit 127
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_IMPL="$SCRIPT_DIR/update-botfleet-mac.mjs"
TRACKED_IMPL="${BOTFLEET_UPDATER_IMPL:-$HOME/apps/botfleet-server/scripts/update-botfleet-mac.mjs}"

# launchd provides a minimal PATH. Ensure node/pnpm/git are found for source builds.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.asdf/shims:$PATH"
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  LATEST_NODE="$(ls -t "$HOME/.nvm/versions/node" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$LATEST_NODE" ]]; then
    export PATH="$HOME/.nvm/versions/node/$LATEST_NODE/bin:$PATH"
  fi
fi
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  \. "$NVM_DIR/nvm.sh"
fi
if [[ -s "$HOME/.bun/bin/bun" ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Skip the close / rebuild / relaunch dance when the local BotFleet checkout is
# already at origin/main.  Override the check with BOTFLEET_FORCE=1 or by
# passing --force / -f (which also interrupts busy bots and routines; see the
# warning at the top of this file).  Override the checkout location with
# BOTFLEET_CHECKOUT (defaults to the parent of the tracked implementation).
# --force / -f mirrors the env-var override; recognised here so the documented
# flag does what its name says.
if [[ -z "${BOTFLEET_FORCE:-}" ]]; then
  for arg in "$@"; do
    case "$arg" in
      --force|-f) BOTFLEET_FORCE=1 ;;
    esac
  done
fi
if [[ -z "${BOTFLEET_CHECKOUT:-}" ]]; then
  # Defensive: `set -e` is on, but the parent of $TRACKED_IMPL may not exist
  # yet (first run, custom $BOTFLEET_UPDATER_IMPL, etc.).  Swallow the cd
  # failure and let the next test fall through to the updater.
  BOTFLEET_CHECKOUT="$(cd "$(dirname "$(dirname "$TRACKED_IMPL")")" 2>/dev/null && pwd)" || BOTFLEET_CHECKOUT=""
fi
# Detect the checkout with git itself rather than testing for a .git
# directory: in a linked worktree (`git worktree add`) .git is a FILE that
# points at the main repository's gitdir, so a directory test on .git
# is false and both the up-to-date check and the bootstrap below would be
# skipped, leaving the old installed updater to judge a renamed bundle.
# Require the checkout to be the work tree's top level so a directory that
# merely sits inside some other repository is not mistaken for BotFleet.
BOTFLEET_CHECKOUT_IS_GIT=0
if [[ -n "$BOTFLEET_CHECKOUT" ]] &&
    git -C "$BOTFLEET_CHECKOUT" rev-parse --git-dir >/dev/null 2>&1; then
  CHECKOUT_TOPLEVEL="$(git -C "$BOTFLEET_CHECKOUT" rev-parse --show-toplevel 2>/dev/null)" || CHECKOUT_TOPLEVEL=""
  CHECKOUT_PHYSICAL="$(cd "$BOTFLEET_CHECKOUT" 2>/dev/null && pwd -P)" || CHECKOUT_PHYSICAL=""
  if [[ -n "$CHECKOUT_TOPLEVEL" && -n "$CHECKOUT_PHYSICAL" &&
        "$(cd "$CHECKOUT_TOPLEVEL" 2>/dev/null && pwd -P)" == "$CHECKOUT_PHYSICAL" ]]; then
    BOTFLEET_CHECKOUT_IS_GIT=1
  fi
fi
# The "already at origin/main" shortcut is only for a plain update to
# origin/main.  Every other invocation must reach the updater even when the
# checkout is current:
#   - unquiesce is the recovery action that releases runtime admission after an
#     interrupted run; exiting here would leave the harness fenced.
#   - prepare and apply --stage act on a stage, not on the checkout's HEAD, so
#     the shortcut would make them silently do nothing.
#   - a --target (or BOTFLEET_UPDATE_TARGET) other than origin/main asks for a
#     different commit than the one this check compares against.
#   - --progress / --run-id is the harness's detached run
#     (server/update-control.ts).  It waits for the progress file the updater
#     writes and settles a run that never writes one as "never started", so
#     that run must not end here without a record.
# Anything not on this allowlist (including --help, --source, --stage) goes to
# the updater unchanged.  --grace SECONDS and --wait-for-idle [MINUTES] are on
# it: how busy bots are treated says nothing about whether there is anything
# new to install.
UP_TO_DATE_SHORTCUT=1
case "${BOTFLEET_UPDATE_TARGET:-origin/main}" in
  origin/main) ;;
  *) UP_TO_DATE_SHORTCUT=0 ;;
esac
SHORTCUT_ARG_INDEX=0
EXPECT_SHORTCUT_TARGET=0
EXPECT_SHORTCUT_VALUE=0
for arg in "$@"; do
  SHORTCUT_ARG_INDEX=$((SHORTCUT_ARG_INDEX + 1))
  if [[ "$EXPECT_SHORTCUT_TARGET" == "1" ]]; then
    EXPECT_SHORTCUT_TARGET=0
    [[ "$arg" == "origin/main" ]] || UP_TO_DATE_SHORTCUT=0
    continue
  fi
  # How busy work is treated changes nothing about whether there is anything
  # to install, so these keep the up-to-date shortcut.
  if [[ "$EXPECT_SHORTCUT_VALUE" == "1" ]]; then
    EXPECT_SHORTCUT_VALUE=0
    [[ "$arg" =~ ^[0-9]+(\.[0-9]+)?$ ]] && continue
  fi
  case "$arg" in
    update) [[ "$SHORTCUT_ARG_INDEX" == "1" ]] || UP_TO_DATE_SHORTCUT=0 ;;
    --force|-f|--no-open|--target=origin/main|--grace=*|--wait-for-idle=*) ;;
    --grace|--wait-for-idle) EXPECT_SHORTCUT_VALUE=1 ;;
    --target) EXPECT_SHORTCUT_TARGET=1 ;;
    *) UP_TO_DATE_SHORTCUT=0 ;;
  esac
done
[[ "$EXPECT_SHORTCUT_TARGET" == "0" ]] || UP_TO_DATE_SHORTCUT=0
if [[ "${BOTFLEET_FORCE:-}" == "1" ]]; then
  echo "WARNING:  BOTFLEET_FORCE=1 - running updater even if $BOTFLEET_CHECKOUT is already at origin/main.  This also interrupts busy bots and routines at once, with no grace (they resume after the update)."
elif [[ "$UP_TO_DATE_SHORTCUT" == "1" && "$BOTFLEET_CHECKOUT_IS_GIT" == "1" ]]; then
  if git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin main 2>/dev/null; then
    LOCAL_HEAD=$(git -C "$BOTFLEET_CHECKOUT" rev-parse HEAD)
    REMOTE_HEAD=$(git -C "$BOTFLEET_CHECKOUT" rev-parse origin/main)
    if [[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]]; then
      IS_UP_TO_DATE=1

      # 1. Compare against the installed Mac app's build identity.  Absence of
      # the manifest is "we cannot tell what is installed", not "out of date":
      # a developer checkout, a fixture, or an uninstalled app must not block
      # the shortcut on its own.  Only a manifest that names a different commit
      # counts as positive evidence of a mismatch.
      APP_MANIFEST="${BOTFLEET_APP_PATH:-/Applications/BotFleet.app}/Contents/Resources/server/build-identity.json"
      if [[ -f "$APP_MANIFEST" ]]; then
        INSTALLED_COMMIT=$(APP_MANIFEST_PATH="$APP_MANIFEST" "$NODE_BIN" -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.env.APP_MANIFEST_PATH, "utf8")).sourceCommit) } catch { console.log("") }' 2>/dev/null) || INSTALLED_COMMIT=""
        if [[ "$INSTALLED_COMMIT" =~ ^[0-9a-f]{40}$ && "$INSTALLED_COMMIT" != "$LOCAL_HEAD" ]]; then
          IS_UP_TO_DATE=0
        fi
      fi

      # 2. Compare against the running server's runtime commit.  Absence of
      # the owner file or an unreachable runtime is also "no live harness to
      # ask", not "out of date": only a runtime we could authenticate against
      # and that answered with a different commit turns the shortcut off.
      if [[ "$IS_UP_TO_DATE" == "1" ]]; then
        OWNER_FILE="${BOTFLEET_DATA_DIR:-$HOME/.botfleet}/harness-owner.json"
        if [[ -f "$OWNER_FILE" ]]; then
          # The bearer credential is never read from harness-owner.json in this
          # wrapper: it must arrive via BOTFLEET_OWNER_NONCE.  A live owner
          # record means the harness was adopted, so a missing or rejected
          # credential must fail fast instead of pretending the runtime check
          # passed.  The helper reads only the port from the owner file and
          # writes just a commit SHA to stdout.
          : "${BOTFLEET_OWNER_NONCE:?BotFleet updater: BOTFLEET_OWNER_NONCE is required when a harness owner record exists.}"
          RUNTIME_PROBE_ERR="$(mktemp "${TMPDIR:-/tmp}/botfleet-runtime-probe.XXXXXX")"
          if ! RUNTIME_COMMIT=$(OWNER_FILE_PATH="$OWNER_FILE" BOTFLEET_OWNER_NONCE="$BOTFLEET_OWNER_NONCE" "$NODE_BIN" "$SCRIPT_DIR/update-botfleet-runtime-commit.mjs" 2>"$RUNTIME_PROBE_ERR"); then
            if [[ -s "$RUNTIME_PROBE_ERR" ]]; then
              cat "$RUNTIME_PROBE_ERR" >&2
            fi
            rm -f "$RUNTIME_PROBE_ERR"
            echo "BotFleet updater: could not verify the running harness commit (credential BOTFLEET_OWNER_NONCE)." >&2
            exit 1
          fi
          rm -f "$RUNTIME_PROBE_ERR"
          if [[ "$RUNTIME_COMMIT" =~ ^[0-9a-f]{40}$ && "$RUNTIME_COMMIT" != "$LOCAL_HEAD" ]]; then
            IS_UP_TO_DATE=0
          fi
        fi
      fi

      if [[ "$IS_UP_TO_DATE" == "1" ]]; then
        CURRENT=$(git -C "$BOTFLEET_CHECKOUT" log --oneline -1)
        echo "OK: Already at $CURRENT.  Nothing to update.  (Set BOTFLEET_FORCE=1 or pass --force to reinstall anyway; that also interrupts busy bots and routines.)"
        exit 0
      fi
    fi
  else
    echo "WARNING:  Could not fetch origin/main from $BOTFLEET_CHECKOUT; running updater anyway."
  fi
fi

# Bootstrap from the target commit before importing any updater policy from the
# live detached checkout. This is load-bearing during signing-identity or bundle
# identifier transitions: the old updater cannot validate a candidate using
# rules it does not know yet. Copy the small updater module graph out of the
# fetched target and run that immutable copy instead.
# bash 3.2 (stock macOS /bin/bash) treats expanding an EMPTY array under
# `set -u` as an unbound-variable error, so every call site below expands
# UPDATER_ARGS through the ${UPDATER_ARGS[@]+...} guard.
UPDATER_ARGS=("$@")
if [[ "$BOTFLEET_CHECKOUT_IS_GIT" == "1" ]]; then
  # Keep the updater policy and candidate source on the same requested ref.
  # The command-line option wins over the environment, matching the updater
  # interface parsed by update-botfleet-mac.mjs.
  BOOTSTRAP_REF="${BOTFLEET_UPDATE_TARGET:-origin/main}"
  EXPECT_BOOTSTRAP_TARGET=0
  HAS_BOOTSTRAP_TARGET=0
  for arg in "$@"; do
    if [[ "$EXPECT_BOOTSTRAP_TARGET" == "1" ]]; then
      BOOTSTRAP_REF="$arg"
      EXPECT_BOOTSTRAP_TARGET=0
      HAS_BOOTSTRAP_TARGET=1
    elif [[ "$arg" == "--target" ]]; then
      EXPECT_BOOTSTRAP_TARGET=1
    elif [[ "$arg" == --target=* ]]; then
      BOOTSTRAP_REF="${arg#--target=}"
      HAS_BOOTSTRAP_TARGET=1
    fi
  done
  # unquiesce is the recovery action that releases runtime admission, so it
  # must run even while BOTFLEET_UPDATE_TARGET (or a stray --target) names an
  # unmerged ref: the ancestry check below would otherwise exit before the
  # recovery could run, leaving admission fenced.  parseArguments hard-rejects
  # options on unquiesce, so a target can never reach it as an argument;
  # ignore targets for its bootstrap too and recover with origin/main's
  # updater.
  if [[ "${1:-update}" == "unquiesce" ]]; then
    BOOTSTRAP_REF="origin/main"
  fi
  # BOTFLEET_UPDATE_TARGET is part of the wrapper interface, so forward it to
  # commands that resolve a candidate as well as using it for bootstrap policy.
  # apply gets its immutable target from prepared.json; unquiesce takes no options.
  if [[ -n "${BOTFLEET_UPDATE_TARGET:-}" && "$HAS_BOOTSTRAP_TARGET" == "0" &&
        "${1:-update}" != "apply" && "${1:-update}" != "unquiesce" ]]; then
    UPDATER_ARGS+=(--target "$BOTFLEET_UPDATE_TARGET")
  fi
  # `apply --stage PATH` takes no --target: its target is the immutable commit
  # the stage was prepared from, recorded as sourceCommit in prepared.json.
  # Bootstrap that exact commit's updater, not whatever origin/main names now;
  # if main advanced between prepare and apply, newer policy could reject or
  # mishandle the prepared stage.  An unreadable manifest fails closed.
  BOOTSTRAP_FROM_STAGE=0
  if [[ "${1:-}" == "apply" ]]; then
    BOOTSTRAP_STAGE=""
    EXPECT_BOOTSTRAP_STAGE=0
    for arg in "$@"; do
      if [[ "$EXPECT_BOOTSTRAP_STAGE" == "1" ]]; then
        BOOTSTRAP_STAGE="$arg"
        EXPECT_BOOTSTRAP_STAGE=0
      elif [[ "$arg" == "--stage" ]]; then
        EXPECT_BOOTSTRAP_STAGE=1
      fi
    done
    if [[ -n "$BOOTSTRAP_STAGE" ]]; then
      STAGE_COMMIT="$("$NODE_BIN" -e '
        const manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const commit = manifest && manifest.sourceCommit;
        if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) process.exit(1);
        process.stdout.write(commit);
      ' "$BOOTSTRAP_STAGE/prepared.json" 2>/dev/null)" || STAGE_COMMIT=""
      if [[ ! "$STAGE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
        echo "BotFleet updater: refusing to apply $BOOTSTRAP_STAGE: its prepared.json does not record a full source commit." >&2
        exit 1
      fi
      BOOTSTRAP_REF="$STAGE_COMMIT"
      BOOTSTRAP_FROM_STAGE=1
    fi
  fi
  # Refresh the selected target even for forced updates. A forced run skips the
  # up-to-date check above, so without this fetch origin/main (or an overridden
  # target) may still name stale updater policy in the local checkout.  A stage
  # commit is a bare SHA: fetching main brings in every commit that can pass
  # the ancestry check below, so that is the ref to refresh.  A revision
  # expression such as origin/main~1 or origin/main^{commit} is not a valid
  # refspec, so fetch the ref it is based on and let the rev-parse below
  # resolve the full expression locally.
  BOOTSTRAP_FETCH_REF="${BOOTSTRAP_REF#origin/}"
  BOOTSTRAP_FETCH_REF="${BOOTSTRAP_FETCH_REF%%[~^@:]*}"
  if [[ -z "$BOOTSTRAP_FETCH_REF" ]]; then
    BOOTSTRAP_FETCH_REF="main"
  fi
  if [[ "$BOOTSTRAP_FROM_STAGE" == "1" ]]; then
    BOOTSTRAP_FETCH_REF="main"
  fi
  BOOTSTRAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botfleet-updater.XXXXXX")"
  cleanup_bootstrap() { rm -rf "$BOOTSTRAP_DIR"; }
  trap cleanup_bootstrap EXIT
  # Canonicalize the directory.  On macOS TMPDIR is under /var/folders and /var
  # is a symlink to /private/var, so the unresolved path differs from the one
  # Node's ESM loader reports for the entry module.  The updater compares
  # physical paths itself, but hand it the physical one anyway.  The trap above
  # is already armed, so a failure here still removes the directory.
  if BOOTSTRAP_PHYSICAL="$(cd "$BOOTSTRAP_DIR" && pwd -P)" && [[ -n "$BOOTSTRAP_PHYSICAL" ]]; then
    BOOTSTRAP_DIR="$BOOTSTRAP_PHYSICAL"
  else
    echo "BotFleet updater: could not resolve the bootstrap directory $BOOTSTRAP_DIR." >&2
    exit 1
  fi
  # Choose the commit when the operator did not name one: the newest on
  # origin/main whose hosted Mac build succeeded and that is newer than the
  # installed build, instead of main's tip, whose build is usually still
  # queued or was cancelled by the next push.  Only a plain update or prepare
  # with no target of any kind qualifies: an explicit --target (or
  # BOTFLEET_UPDATE_TARGET) is installed exactly as named, apply installs the
  # stage it was handed, unquiesce takes no options, and --source/--bundle
  # import a build of one particular checkout.
  #
  # This sits BEFORE the archive below on purpose.  The updater policy must come
  # from the commit that is about to be installed (a bundle-id or signing
  # transition is judged by the candidate's own rules), so the choice has to be
  # known before anything is archived.  It reads only ci-build-resolver.mjs
  # from the tip, read on its own with git show, and it fails OPEN: any doubt (no network,
  # no installed-build record, an installed commit this checkout cannot place on
  # main, a resolver without the selection export) falls through to the tip
  # exactly as before, whose own download then reports the real problem.  The
  # one answer that is not a fall-through is "nothing newer is green": that is
  # handed to the tip's updater in BOTFLEET_UPDATE_SELECTION_FAILURE so the
  # explanation lands in the run's progress record (the harness, the desktop
  # app and the phone read that, and call a run that ends here "never started").
  SELECT_NEWEST_GREEN=0
  if [[ "$HAS_BOOTSTRAP_TARGET" == "0" && -z "${BOTFLEET_UPDATE_TARGET:-}" ]]; then
    case "${1:-update}" in
      apply|unquiesce) ;;
      *) SELECT_NEWEST_GREEN=1 ;;
    esac
    for arg in "$@"; do
      case "$arg" in
        --source|--bundle|--dependencies|--help|-h) SELECT_NEWEST_GREEN=0 ;;
      esac
    done
  fi
  if [[ "$SELECT_NEWEST_GREEN" == "1" ]]; then
    SELECT_TIP=""
    if git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin main 2>/dev/null; then
      SELECT_TIP="$(git -C "$BOTFLEET_CHECKOUT" rev-parse --verify "origin/main^{commit}" 2>/dev/null)" || SELECT_TIP=""
    fi
    SELECTION_OUT=""
    if [[ "$SELECT_TIP" =~ ^[0-9a-f]{40}$ ]] &&
        mkdir -p "$BOOTSTRAP_DIR/select" &&
        git -C "$BOTFLEET_CHECKOUT" show "$SELECT_TIP:scripts/ci-build-resolver.mjs" > "$BOOTSTRAP_DIR/select/ci-build-resolver.mjs"; then
      # Three lines on stdout: the status (selected, none, skip, warn), the
      # chosen commit, and a one-line message.  Nothing else is printed.
      SELECTION_OUT="$(
        BOTFLEET_SELECT_RESOLVER="$BOOTSTRAP_DIR/select/ci-build-resolver.mjs" \
        BOTFLEET_SELECT_CHECKOUT="$BOTFLEET_CHECKOUT" \
        BOTFLEET_SELECT_APP="${BOTFLEET_APP_PATH:-/Applications/BotFleet.app}" \
        "$NODE_BIN" --input-type=module -e '
          const { pathToFileURL } = await import("node:url");
          const emit = (status, commit, message) => {
            console.log([status, commit, message].map((line) => String(line).replace(/\s*[\r\n]+\s*/g, "  ")).join("\n"));
          };
          // A hung lookup must not hold the update: give up and fall through.
          // This all happens before the updater writes its first progress
          // record, and the harness settles a run with none after two minutes
          // (LAUNCH_GRACE_MS in server/update-control.ts) as never started, so
          // the whole lookup gets well under that.
          const watchdog = setTimeout(() => {
            emit("warn", "", "Looking up the hosted builds timed out.");
            process.exit(0);
          }, 45000);
          try {
            const resolver = await import(pathToFileURL(process.env.BOTFLEET_SELECT_RESOLVER).href);
            if (typeof resolver.selectUpdateTarget !== "function") {
              emit("skip", "", "");
            } else {
              const choice = await resolver.selectUpdateTarget({
                checkout: process.env.BOTFLEET_SELECT_CHECKOUT,
                appPath: process.env.BOTFLEET_SELECT_APP,
              });
              emit(
                choice.status === "selected" || choice.status === "none" ? choice.status : "skip",
                choice.commit || "",
                choice.message || "",
              );
            }
          } catch (error) {
            emit("warn", "", "Could not choose among the hosted builds (" + (error && error.message ? error.message : error) + ").");
          }
          clearTimeout(watchdog);
        ' 2>/dev/null
      )" || SELECTION_OUT=""
    fi
    SELECTION_STATUS="$(printf '%s\n' "$SELECTION_OUT" | sed -n 1p)"
    SELECTION_COMMIT="$(printf '%s\n' "$SELECTION_OUT" | sed -n 2p)"
    SELECTION_MESSAGE="$(printf '%s\n' "$SELECTION_OUT" | sed -n 3p)"
    case "$SELECTION_STATUS" in
      selected)
        if [[ "$SELECTION_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
          echo "$SELECTION_MESSAGE"
          # A bare SHA is fetched through main, which brings in every commit
          # the ancestry check below accepts.
          BOOTSTRAP_REF="$SELECTION_COMMIT"
          BOOTSTRAP_FETCH_REF="main"
        fi
        ;;
      none)
        BOTFLEET_UPDATE_SELECTION_FAILURE="$SELECTION_MESSAGE"
        export BOTFLEET_UPDATE_SELECTION_FAILURE
        ;;
      warn)
        echo "WARNING:  $SELECTION_MESSAGE  Updating to origin/main's tip instead." >&2
        ;;
    esac
  fi
  if git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin "$BOOTSTRAP_FETCH_REF" 2>/dev/null; then
    # Enforce resolveTarget()'s origin/main ancestry rule BEFORE any code from
    # the target is archived or executed: an unmerged ref must never supply
    # updater policy.  Refresh origin/main as resolveTarget() does so a forced
    # run (which skips the up-to-date fetch above) is not validated against a
    # stale main.  If that refresh fails, fall through to the installed
    # implementation, whose resolveTarget() re-fetches and re-checks.
    if git -C "$BOTFLEET_CHECKOUT" fetch --quiet origin main 2>/dev/null; then
      BOOTSTRAP_COMMIT="$(git -C "$BOTFLEET_CHECKOUT" rev-parse --verify "${BOOTSTRAP_REF}^{commit}" 2>/dev/null)" || BOOTSTRAP_COMMIT=""
      if [[ ! "$BOOTSTRAP_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
        echo "BotFleet updater: refusing to bootstrap from $BOOTSTRAP_REF: the target did not resolve to a full commit." >&2
        exit 1
      fi
      if ! git -C "$BOTFLEET_CHECKOUT" merge-base --is-ancestor "$BOOTSTRAP_COMMIT" origin/main 2>/dev/null; then
        echo "BotFleet updater: refusing to bootstrap from $BOOTSTRAP_REF: target ${BOOTSTRAP_COMMIT:0:12} is not reachable from origin/main." >&2
        exit 1
      fi
      # Archive the validated commit itself, never the symbolic ref, and pin
      # the candidate to that same commit: origin/main can advance between
      # this fetch and the updater's own resolveTarget() fetch, and policy
      # archived from the older commit must not build the newer one.  apply
      # takes its immutable target from prepared.json and unquiesce accepts
      # no options, so only commands that resolve a candidate get --target.
      if git -C "$BOTFLEET_CHECKOUT" archive "$BOOTSTRAP_COMMIT" -- \
          scripts/update-botfleet-mac.mjs \
          scripts/mac-update-transaction.mjs \
          scripts/update-progress.mjs \
          scripts/ci-build-resolver.mjs \
          scripts/stage-entries.mjs \
          electron/update-credential-preparation.mjs | tar -x -C "$BOOTSTRAP_DIR"; then
        PINNED_ARGS=()
        if [[ "${1:-update}" != "apply" && "${1:-update}" != "unquiesce" ]]; then
          SKIP_TARGET_VALUE=0
          for arg in ${UPDATER_ARGS[@]+"${UPDATER_ARGS[@]}"}; do
            if [[ "$SKIP_TARGET_VALUE" == "1" ]]; then
              SKIP_TARGET_VALUE=0
              continue
            fi
            case "$arg" in
              --target) SKIP_TARGET_VALUE=1 ;;
              --target=*) ;;
              *) PINNED_ARGS+=("$arg") ;;
            esac
          done
          PINNED_ARGS+=(--target "$BOOTSTRAP_COMMIT")
        else
          PINNED_ARGS=(${UPDATER_ARGS[@]+"${UPDATER_ARGS[@]}"})
        fi
        "$NODE_BIN" "$BOOTSTRAP_DIR/scripts/update-botfleet-mac.mjs" ${PINNED_ARGS[@]+"${PINNED_ARGS[@]}"} </dev/null
        exit $?
      fi
    fi
  fi
  if [[ "$BOOTSTRAP_FROM_STAGE" == "1" ]]; then
    # The installed implementation may carry newer or older policy than the
    # stage was prepared under; never let it apply the stage in its place.
    echo "BotFleet updater: could not bootstrap the stage's updater from ${BOOTSTRAP_REF:0:12}; refusing to apply it with a different implementation." >&2
    exit 1
  fi
  echo "WARNING:  Could not bootstrap updater from $BOOTSTRAP_REF; using the installed implementation." >&2
  cleanup_bootstrap
  trap - EXIT
fi

if [[ -f "$LOCAL_IMPL" ]]; then
  exec "$NODE_BIN" "$LOCAL_IMPL" ${UPDATER_ARGS[@]+"${UPDATER_ARGS[@]}"} </dev/null
fi
if [[ -f "$TRACKED_IMPL" ]]; then
  exec "$NODE_BIN" "$TRACKED_IMPL" ${UPDATER_ARGS[@]+"${UPDATER_ARGS[@]}"} </dev/null
fi

echo "BotFleet updater implementation is missing.  Expected $TRACKED_IMPL" >&2
exit 1


