# Security Dependency Remediation

## Scope

GitHub Dependabot reported 26 open alerts across the Electron packaging toolchain, the docs application, the test runner, and transitive XML, YAML, archive, and image-processing packages.  The repository contained no evidence that the docs advisories had been exploited or that a vulnerable docs deployment was currently exposed.

## Changes

- Upgrade `electron-builder` from 24.13.3 to 26.16.1, which resolves `app-builder-lib` 26.16.1, `builder-util-runtime` 9.7.0, and `tar` 7.5.22.
- Upgrade the root and control-plane `vitest` requirements to 4.1.11.
- Upgrade the docs application from Next.js 16.3.2 to 16.3.3.
- Override only the vulnerable transitive versions of `@xmldom/xmldom` 0.8.13, `js-yaml` 4.3.1, and Sharp 0.35.2–0.35.3 to their first patched releases.
- Nest the custom Linux launcher metadata under `linux.desktop.entry`, the configuration shape required by Electron Builder 26.

The lockfile resolves `@xmldom/xmldom` 0.8.15, `js-yaml` 4.3.2, Sharp 0.35.4, Vitest 4.1.11, and Next.js 16.3.3.  The old versions appear only as override selectors and are absent as resolved package nodes.

## Validation

PR CI run [34634973302](https://github.com/Simple-With-Us/BotFleet/actions/runs/34634973302) passed the repository typecheck and test gate on macOS, Ubuntu, and Windows, the control-plane checks and tests, the unsigned iOS build, and the full Ubuntu package/install/launch job.  The Linux package verifier confirmed `app-builder-lib` 26.16.1 and inspected the generated AppImage `AppRun` search-path expansions.

Artifact-only native run [34634988323](https://github.com/Simple-With-Us/BotFleet/actions/runs/34634988323) passed both jobs on packaging SHA `5b034a70`.  The macOS job passed docs type generation and the Next.js 16.3.3 production build, disabled the configured signing identity, built an arm64 app directory, exercised the Electron Builder 26 `afterPack` hook, inspected the Mach-O launcher and packaged helpers, started the packaged server, and retained unsigned artifact `10278675350`.  The Windows job created an NSIS installer, checked the packaged tree and updater feed, started the packaged server, and retained artifact `10277074718`.  Neither job signed, notarized, drafted a release, or published through Electron Builder.

The first hosted package attempt exposed the Electron Builder 26 desktop-entry schema migration before artifact generation; the corrected job passed.  Local package validation could not be completed because the machine's pnpm content-addressable store was internally inconsistent.  The repeated repair loop was stopped, its 19 owned partial copies were moved recoverably to Trash, and one pristine snapshot remains outside Git.  GitHub still reports the starting 26 alerts against the unmerged default branch; Dependabot state must be refreshed after this change lands.
