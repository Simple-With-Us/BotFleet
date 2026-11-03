# Reviewer Hold Acceptance Check (Design Only)

**Date:** Tue, Nov 3, 2026  
**Seat:** MM  
**Linear:** BF-2553 (canonical; the row is a design and acceptance record, not an implementation grant)  
**Board:** `66b428b0-ac92-4383-b1bd-4e64ab07b2d2`

## Decision

A reviewer hold becomes **state that a landing command can read**, and a landing is refused
while an active hold stands.  This document proposes the state model, the enforcement point
and the acceptance check that a later implementation must satisfy.

**Nothing here changes branch protection, permissions, workflows, security settings, merge
behaviour or a release.**  The row that carries this work is explicitly a design and
acceptance record: it does not authorize a rollback, a cancellation, or the fixture correction
that sits on its own pull request.  Every change named below is an owner gate, listed at the
end.

## Why

Two landings in this repository went through while a hold was standing.

**Pull request #1317.**  The merged head is `cb631e62df96ba157f0f4dc64cd5f551f5f5cd2d`; the
squash commit is `1b2f32a655a13dbd0c7ded0dee0565aedb7ced90`.  `swu-echo` disabled auto-merge
at 6:22am (11:22:01Z).  GitHub records the merge at 6:23am (11:23:31Z) with actor
`jaywedgeworth22`, which is the fleet's pull-request write path, so the login by itself is not
a personal approval.  The only APPROVED review is from `kody-ai` at 4:46am (09:46:36Z), and it
names commit `002980f5a353`, not the merged head.  No APPROVED review names the merged head.

**The coordinator's activation hold.**  On the coordinator's rename pull request the hold is
stated in a topic and in the pull request's own body, and the Mac's sync job is paused on the
side.  Nothing in the repository knows the hold is there.  A hold written as prose is
documentation, and documentation does not stop a merge button.

**A third case, today.**  This seat's own environment pull request is held by a
`[do-not-merge]` marker in its title, because the relay refused the label verb
(`workflow_request_refused`).  The title marker is readable by anyone who looks and invisible
to every automated path.  It is the same failure in a smaller costume: the hold is a sentence,
not a state.

## The principle

1. **A hold is a record, not a sentence.**  It names the pull request, the reviewer who placed
   it, the head it was placed against, the time, and whether it has been lifted.
2. **Only the placing reviewer, or the owner, lifts a hold.**  Lifting is an explicit action
   that removes the record.  It is not inferred.
3. **An approval counts only when it names the commit being landed.**  An approval on an older
   commit is not a verdict on the merged head.
4. **A favorable source note, a passing test, or an approval from another seat is not a hold
   lift.**
5. **A hold survives a push.**  A new head does not clear it, and a new head does not satisfy
   it.  The reviewer looks at the new head and lifts the hold explicitly, or leaves it standing.

## The state model

A ledger of holds, kept in the repository next to the pull requests it governs, with one
record per active hold:

```json
{
  "pullRequest": 1317,
  "reviewer": "swu-echo",
  "placedAt": "2026-10-25T11:22:01Z",
  "placedAgainst": "cb631e62df96ba157f0f4dc64cd5f551f5f5cd2d",
  "reason": "activation hold; the rename is not safe to deploy yet",
  "liftedBy": null,
  "liftedAt": null
}
```

Two properties make this different from a label:

- **The record names its owner.**  A label has no owner, no timestamp and no lift semantics, and
  any account can add or remove one.  A record with a `reviewer` field can be lifted by that
  reviewer and by nobody else.
- **The record is diffable.**  Placing a hold and lifting a hold are both commits, so the
  history of a hold is reviewable and a hold cannot be removed without leaving a trace.

The ledger is the *state*.  Where it is read is the *enforcement point*, and the two are
separate decisions.

## The enforcement point

The check must run where a landing is actually refused.  In this repository that is the merge
button, which GitHub disables while a required status check is not successful.

So the design has two halves: a small command that reads the ledger and reports whether the
pull request may land, and a required check named for that command, so the merge button is
greyed while a hold stands and lights up when the hold is lifted.

**Why this and not a label.**  A `do-not-merge` label cannot be enforced, cannot carry an
owner, and can be removed by anyone.  A status check can be enforced, because it is required by
the ruleset, and it can be re-run at any time against the current head.

**Why a ledger and not the issue tracker.**  The board's claim metadata is protected, the
tracker is not the merge authority, and a tracker round trip is slow enough that a landing
attempt would race it.  The hosted check on the repository's own head is the authority the
repository already trusts.

**The owner gate.**  Making the check required is a change to branch protection for `main`, and
that is not granted here.  The check itself, the ledger, and the command that writes a hold are
all ordinary repository work and can land without it.

## The acceptance check

A later implementation must satisfy every row.  Each row is a fixture with one expected
outcome; a fixture that produces a different outcome fails the check.

| # | Fixture | Expected outcome |
|---|---|---|
| 1 | A pull request with an active hold, no lift record, and a landing attempt at the head the hold was placed against | Refused, and the message names the reviewer and the hold's timestamp |
| 2 | The same pull request, with the hold lifted by the placing reviewer, and a landing attempt | Allowed, if every other gate passes |
| 3 | The same pull request, with the hold lifted by a seat other than the placing reviewer | Refused, and the message says the lift came from the wrong reviewer |
| 4 | A pull request with an active hold, and a landing attempt at a **newer** head than the hold was placed against | Refused, and the message says the hold stands against a newer head |
| 5 | A pull request with an active hold, and a new head pushed | The hold is still active, and the check reports it as active |
| 6 | A pull request whose only APPROVED review names a commit other than the head being landed | Refused, and the message names the reviewed commit and the head being landed |
| 7 | A pull request with an active hold and a passing test suite, no lift record | Refused, and the message says a passing test is not a lift |
| 8 | A pull request with an active hold and a favorable source note from another seat, no lift record | Refused, and the message says a source note is not a lift |
| 9 | A pull request with no hold record at all | Allowed, if every other gate passes |
| 10 | A pull request whose hold record names a pull request other than this one | The record is ignored, and the check says so |

Rows 3, 7 and 8 are the ones that failed in the incident.  They are the reason this is a
record with an owner rather than a flag.

## Out of scope

- **Branch protection, permissions, workflows, security settings and merge behaviour.**  Named
  as owner gates below.
- **`dismiss_stale_reviews_on_push`.**  A separate owner decision, explicitly not granted here.
  The check in row 6 is deliberately independent of that setting, so the protection does not
  depend on it.
- **The fixture correction** on the other pull request.  It stays on its own pull request.
- **The auto-merge workflow.**  The check has to work for a manual landing as well, because a
  manual landing is what failed.
- **Any change to the coordinator's review tooling.**  This is a repository-local design.

## Owner gates

1. Make the hold check a required status check on `main`, so the merge button is disabled while
   a hold stands.
2. Decide whether the ledger lives in this repository or in the coordinator, when the
   coordinator's tooling is the one that places holds.
3. Decide whether the placing reviewer lifts by commit to the ledger or by a command that
   writes the lift record.
4. Decide whether an owner lift is recorded differently from a reviewer's lift, so the two can
   be told apart later.

## What this document is not

It is not an implementation, it is not a change to any setting, and it does not lift or place
any hold.  The acceptance table above is the deliverable the row asks for: a check that a later
design can implement, with the failure cases written down before the code exists.
