# Issue #NNNN — [Short title]

## Problem

One or two sentences describing what is broken, incomplete, or needs improvement.  The reader should immediately understand why this issue exists.

## Users

Who is affected and how?  Examples:

- Bot owners who need X
- iOS users doing Y
- Desktop users affected by Z
- Developers building features on top of W

Describe the user impact, not the implementation.

## Constraints

Technical, product, or timeline limits that shape the solution.  Examples:

- Must not change the database schema
- Must maintain backward compatibility with v1.0.30
- Must work on iOS 14+
- Must complete before the v1.1 release date
- Must not break offline-first sync

Leave this section empty if there are no hard constraints beyond the acceptance criteria.

## Acceptance

Concrete, testable criteria that describe the finished state.  Write each as a fact about how the system behaves, not as a step to implement.  Examples (good):

- Threads appear in reverse chronological order by their most recent message
- The update feed includes both macOS ZIP and DMG artifacts
- A bot owner can revoke a connector grant immediately

Examples (not requirements, implementation):

- Sort threads by updatedAt descending
- Add latest-mac.yml to the release
- Remove the grant from the database

When a criterion is specific or complex, add the reasoning or the evidence proving it works.

## Out of Scope

What does this issue NOT cover?  Be explicit so a later maintainer knows what was considered but excluded.  Examples:

- Thread drag-and-drop reordering
- Android thread ordering (separate issue #NNN)
- Notifications for unread threads
- Bundling old releases

## Related Issues

Other issues this depends on or overlaps with (if any).
