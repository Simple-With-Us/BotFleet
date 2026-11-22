# Optional Secret Store Fixture

BF-2622 asks for evidence that the optional secret store can be pointed at one project with an explicit authentication choice and project-scoped tokens.  The peer review narrowed the remaining evidence to one fake-credential fixture and readback covering three facts: primary selection, an independent read reference and write reference, and mode isolation.

This document records that fixture.  It is evidence, not an activation: no live host, no real credential, no access and no wake work are part of it, and the runtime acceptance for BF-2622 stays open.

## Which Surface Owns Which Fact

The three facts are decided in two different places, and the fixture puts each one where it is actually decided.

| Fact | Decided by | Evidence |
|---|---|---|
| The primary project, environment and folder the operator selected are what a read uses | `server/config.ts` resolves the selection and `server/infisical.ts` binds a read to the source at that exact scope | `server/infisical-settings-fixture.test.ts` |
| A read reference and a write reference are independent of one another | `server/config.ts` keeps one read reference and one write reference per project apart, and `server/infisical.ts` picks the locator by operation | `server/infisical-settings-fixture.test.ts` |
| The optional connection and the local-only resolution do not leak into one another | `server/infisical.ts` refuses a turned-off connection before a credential reference is opened, and `server/secret-map.ts` keeps this computer's own copy of a mapped credential in force when the store holds nothing | `server/infisical-settings-fixture.test.ts` |
| The operator's selection survives the save and the readback | the native Settings form, over the same `PUT /api/config` body and `GET /api/infisical/status` answer the product uses | `ios/Tests/CompanionCoreTests/InfisicalSettingsFixtureTests.swift` |

The native form owns the operator's side of the round trip and the server owns the read.  Neither one alone can show that a selection the operator made in the form is the scope a read actually uses, so the evidence is split across the two and both halves are needed.

A note on the mode-isolation wording: this fixture reads the two modes as the optional connection to the secret store and the local-only resolution that stays in force when that connection is off.  BF-2622's own acceptance text was not available to the worker that wrote this fixture, because Linear is not configured on that host, so the mapping is stated here rather than assumed.

## The Fixture

The Node fixture saves one operator selection through the real config path, reads it back through the real settings resolver, and then reads from a stubbed vault.

- The token references are fake: a token file path inside the throwaway test home that `server/testing/setup.ts` creates for every test file, and the environment variable names `BF_FIXTURE_WRITE_ONLY_TOKEN` and `BF_FIXTURE_READ_ONLY_TOKEN`.
- The values are placeholders that are obviously not credentials: `fake-read-token-not-a-credential` and its three siblings.
- The transport is stubbed.  `fetch` is replaced before the manager calls it, so the fixture answers the service-token metadata and the secrets list itself and records every request: the URL, the method and the bearer.
- The vault holds one mapped name, `COMPOSIO_API_KEY`, so a read has something to return without a workspace.

It cannot touch a real credential, and the guards are the reason.  A token file is only read from the BotFleet config directory, as a regular file, owned by the caller and mode `0600`; a reference outside that directory is refused before it is opened.  The fixture writes its files inside the throwaway home with mode `0600` and never outside it.

The Swift fixture stands in for the settings server with a `URLProtocol` subclass.  It stores the section the form saved and answers the status route from that stored section, so the test sees the real request body and the real answer the product sends and receives.  Its gate credential is a placeholder string that never leaves the test process.

## The Readback

Before this fixture, a reader could see the pieces of the contract in separate tests: one test for the scope rules, one for the token-reference rules, one for the turn-off rules, and one native test for the form's own validation.  What no reader could see was one operator selection, saved and read back, with the three facts visible at once.

The readback now shows:

- The scope of the request that a read made: the workspace, the environment and the folder in the URL, and the bearer that carried it, so the selection in the saved section and the selection the read used are the same thing in one place.
- The primary selection in the status answer, beside the per-source read and write flags, so a source that has no write reference is visible as read-only and a source that has no read reference is visible as write-only.
- The refusals, each with the reference it refused and no token value in the message: a write-only source that cannot answer a read, a read-only source that cannot answer a write, a second read reference for one project, and a turned-off connection that never opened its reference.
- The native round trip: the selection in the saved body, the selection in the readback, and the selection the form shows again afterwards.

## Isolated Recipe

On the Mac, in a lane of this repository:

```sh
cd ios && swift test --filter InfisicalSettingsFixtureTests
```

The complete Swift package run is the wider gate:

```sh
cd ios && swift test
```

On the server, with Node 26:

```sh
node ./node_modules/vitest/vitest.mjs run server/infisical-settings-fixture.test.ts
```

Both files are already inside the suites the repository runs: `server/**\/*.test.ts` is in the Vitest include list that `pnpm test` drives through `scripts/test-floor.mjs`, and `ios/Tests/CompanionCoreTests` is what `swift test --package-path ios` runs in the hosted iOS job.

The fixtures use a temporary home, a stubbed transport and a stubbed URL protocol.  They never open the real Keychain, never contact a running harness, never reach a live workspace and never read a credential.

## Recorded Run

On the owner's Mac, in the lane `minimax-bf-2622-infisical-evidence`:

- `swift test --filter InfisicalSettingsFixtureTests`: 3 tests in 1 suite passed.
- `swift test`: XCTest executed 1265 tests with 0 failures, and Swift Testing ran 524 tests in 42 suites with every one of them passed.

On the server, with Node 26.13.1:

- `node ./node_modules/vitest/vitest.mjs run server/infisical-settings-fixture.test.ts`: 5 tests passed.
- `node scripts/test-floor.mjs`: the repository's own wrapper over the whole Vitest suite, which collected and counted the new file.

### The Tests Fail Without The Behaviour They Pin

Every row below was produced by removing one piece of production behaviour, running the fixture again, and recording the failure.  The production source was restored after each one, and no production file is part of this change.

| Surface | Behaviour removed | Test that failed |
|---|---|---|
| Server | the primary vault matches its source by environment and folder | "does not let a source at another folder configure the primary vault" |
| Server | a write picks the write locator instead of the read one | "keeps a read reference and a write reference independent of one another" |
| Server | the two turned-off guards that refuse before a credential reference is opened | "keeps the optional connection and the local-only resolution apart" |
| Native | the readback keeps the selected primary folder | "The selected primary project, environment and folder survive the save and read back" |
| Native | the write reference travels in its own field | "A read reference and a write reference stay separate across the save and the readback" |
| Native | the selected authentication method survives the readback | "The optional connection and the selected authentication method never activate one another" |

The turned-off guard is defended in two places in the server, so removing one of them alone changed nothing; the row above removes both.

## What This Proves And What It Does Not

It proves, in isolation and deterministically:

- The primary project, environment and folder the operator selected are the scope a read uses, and that selection survives the save and the readback.
- A write reference is never used as a read reference, a read reference is never used as a write reference, and the two travel as separate fields in the save, the readback and the request.
- A turned-off optional connection opens no credential reference and makes no request, and the local-only resolution of this computer's own copy stays in force.
- The selected authentication method is the only one used: a missing service token never activates a configured machine identity.

It does **not** prove:

- That any live host can reach a real workspace, or that a real credential is valid, correctly scoped or unexpired.  The values in this fixture are placeholders and the transport is stubbed.
- That the vault honours a read-only grant on a real project.  The metadata the fixture answers with is written by the fixture.
- That the runtime is switched on, that a bootstrap token was replaced, or that any credential was rotated.  Nothing in this fixture changes a live configuration.
- That the native Mac app, the desktop app and the harness agree on anything beyond the wire format the fixture pins.

## Remaining Runtime Acceptance For BF-2622

The runtime acceptance stays open, and this fixture does not close it.  Still outstanding: the live handoff of the managed bindings and the scoped service token, the activation of the managed bootstrap on a real host, the real project scopes and their read-only grants, and the write-through activation under the operator's own key.

The predecessor row BF-2610 is the primary-vault selector and one read and write pair.  This fixture covers the same ground with a fixture credential and adds the isolation evidence, so BF-2610 can be closed as superseded while BF-2622 stays open on the runtime work.
