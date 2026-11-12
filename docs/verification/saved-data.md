# Saved Data Faults

The saved-data fixtures verify what BotFleet does when `bots.json`, `groups.json`, `routines.json` or `config.json` cannot be used.  Before this, an unreadable store read as "nothing there" and the next save replaced it, so one bad byte became an empty roster on disk (audit rows A7 and C3).  Now the file is set aside, never deleted, the state is logged and shown, and nothing that depends on the roster is allowed to treat an empty roster as the truth.

Every fixture uses a temporary home directory and a free port.  None of them touches port 8799 or the real `~/.botfleet`.

## Setup

```sh
pnpm install --frozen-lockfile
```

## Steps

```sh
# 1. The shared helpers and the notice list
pnpm exec vitest run server/store-guard.test.ts server/data-faults.test.ts

# 2. Each store, with each kind of damage
pnpm exec vitest run server/store-quarantine.test.ts server/routines-quarantine.test.ts

# 3. config.json: salvage, the once-only warning, and set-aside on save
pnpm exec vitest run server/config-salvage.test.ts
node --test electron/config-file-lock.node-test.mjs

# 4. Cleanup stays paused while a roster is set aside
pnpm exec vitest run server/retention-hold.test.ts

# 5. The real server over damaged data (slow: it boots node server/index.ts)
pnpm exec vitest run server/data-faults-boot.test.ts

# 6. The words, and the bar in the app
pnpm exec vitest run src/lib/data-faults.test.ts
pnpm exec playwright test tests/e2e/data-fault-banner.spec.ts
```

## Expected Evidence

A passing run shows:

- **Truncated JSON, wrong type, empty file:** the file is renamed to `<name>.corrupt-<epoch ms>` with its bytes unchanged, the store starts empty, the log names both paths and says nothing was deleted, and the next save writes a fresh file without touching the set-aside one.
- **A value that parses but is not a list:** `bots.json` holding `{}`, `null`, `"text"` or `[1,2]` used to throw out of the `Store` constructor, so the server would not start.  It now starts.
- **Byte-order mark:** the file loads as if the mark were not there and is not set aside.
- **A few bad entries among good ones:** the good ones load, the whole original is copied aside, and the notice counts what was left out.
- **A file that cannot be read or moved:** it stays where it is, BotFleet refuses to save over it, the refusal is logged once, and the notice says changes are not being saved.  This is the only case in which saving stops.
- **Second boot:** with `bots.json` gone and `bots.json.corrupt-<epoch>` waiting, the next boot does not seed a Director and does not strip rooms of their members.
- **Cleanup hold:** while a set-aside `bots.json` or `groups.json` exists, the orphan transcript sweep, the workspace sweep and the message-row prune are skipped, and each skip is logged.
- **config.json:** a schema-invalid field leaves the other sections in use, one warning names the file and the failing paths (never a value), and the warning repeats only when the problem changes.  An unparseable file is renamed aside under the config lock just before a save would replace it.
- **The app:** a bar across the top names the file, where the copy went, and how to restore it; it reads as an error when changes are not being saved; it is absent with no notices and with an older server that has no such route.

## Restoring A Set-Aside File

1. Quit BotFleet.
2. Open `~/.botfleet` and repair the set-aside file, or copy the parts you need out of it.
3. Put the repaired file back under its original name, for example `bots.json`.
4. Open BotFleet again.  Move any other set-aside copy out of the folder when you are done with it; cleanup stays paused while one is there.

BotFleet never deletes a set-aside file.

## Not Proven Here

The iPhone companion does not show the bar.  The Playwright spec mocks `GET /api/data-faults`; the route itself is covered by `server/data-faults-boot.test.ts`.  The packaged Mac app is not driven.

## Cleanup

The test suites clean up their temporary directories.  The Playwright run leaves screenshots in `test-results/`.
