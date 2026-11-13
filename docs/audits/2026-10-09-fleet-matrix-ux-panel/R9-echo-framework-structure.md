# Framework: Three Files Carry The Product, And The Overview Work Lands In Them

Seat: Echo.  Lens: framework and code structure.  Evidence at origin/main `4e296b8c`, line counts by `wc -l`, nothing profiled or built.  Scope is where overview and arrangement work will physically land, not a rewrite proposal.

## Verdict

The structure is sound where it is split and strained where it is not.  The split parts, `shared/` contracts and lazy panels, are why the packet's fixes landed in small PRs.  The unsplit parts are the next defect source.

## What Is Sound

- **A shared contract layer.**  `shared/` holds the vocabulary both sides import: `conversation-mode.ts`, `task-workspace-context.ts`, `terminology.ts`, `plugin-manifest.ts`.  The settings copy fix (#1022) changed `shared/conversation-mode.ts:96-101` and every surface followed.
- **Code splitting where it matters.**  Settings, group settings and plugin views are `lazy` (`src/App.tsx:23-39`), so the main chunk is not paying for rarely opened panels.
- **Tests beside code.**  Most server modules have a sibling `.test.ts` (238 `*.test.ts` files among 427 files in `server/`).  The panel's four fixes each came with tests.

## What Is Strained

| File | Lines | Why it matters here |
|---|---|---|
| `server/index.ts` | 17,916 | Routes, turn dispatch and telemetry share one file (routes at `:13798`, turn telemetry at `:4677`, spend gate at `:1230`) |
| `src/state/store.tsx` | 3,439 | One store holds selection, attention and thread actions (`markRoutineRunSeen`, `answerCard`, per R2) |
| `src/components/Sidebar.tsx` | 3,338 | The room list, extra threads (`:2663`) and terminology plurals live together |
| `src/components/SettingsPanel.tsx` | 977 | Smaller, but the arrangement choice sits beside engine and usage settings |

Inferences, marked: a 17,916-line server file makes every route change a merge-conflict candidate in a fleet that runs several seats at once (the repo's own coordination notes assume many concurrent lanes).  I did not measure conflict rates.

## Why This Matters To The Panel

Every overview proposal in R1-R7 adds to `App.tsx` (616 lines, deck at `:422`, overview at `:455`), `Sidebar.tsx` or `store.tsx`.  The attention selector at `src/state/attention-index.ts:277` is the right shape, a pure function that took a fix cleanly (#1026).  That is the pattern to copy: new overview logic should be selectors with tests, not new branches in the 3,000-line files.

## Positions

1. **Selectors first, components second.**  Needs You, scoped counts and sidebar badges should each be a pure selector over existing state, as `summarizeFleetAttention` is.
2. **Carve `server/index.ts` by route family, but only along seams the work already crosses.**  Start with threads and attention routes, not a full split.
3. **Do not add a state library.**  The problem is file size and ownership, not the store technology.  I have no evidence a library would help, and it would move the churn.

## Ranked Recommendations

1. **S:** Rule for new overview work: a selector with a unit test before any component change.
2. **M:** Extract `Sidebar.tsx`'s room and thread lists into their own module before sidebar badges land (R1, R3, R7 all ask for them).
3. **L:** Split `server/index.ts` routes by family, starting with threads and attention.

## The Owner's Decision

Is a refactor window acceptable while seats are shipping fixes?  A split of the large files is cheapest when few lanes are open and most expensive tonight.  The owner owns that timing.
