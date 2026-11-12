# Requirements Documentation

This directory documents requirements for BotFleet issues in a structured format.  Each issue receives a requirements document that captures the problem statement, affected users, constraints, acceptance criteria, and scope boundaries.

Requirements documentation lives alongside code changes so a later reviewer can understand the original intent, the assumptions that changed, and what was intentionally excluded.

## Format

Each issue gets a file `issue-NNNN-requirements.md` following the template in `TEMPLATE-issue-NNNN-requirements.md`.  The structure is:

- **Problem:** What is broken, incomplete, or needs improvement
- **Users:** Who is affected and how
- **Constraints:** Technical, product, or timeline limits
- **Acceptance:** Concrete, testable criteria (not implementation steps)
- **Out of Scope:** What the issue does NOT cover

The acceptance criteria are stated as facts about the finished state, never as steps to implement.  Example: "Threads appear in reverse chronological order by their most recent message" (good) vs.  "Sort the thread list by updatedAt descending" (not a requirement, that's implementation).

## Example Issues

- [Issue #285 — Complete Desktop Release Feed](issue-285-requirements.md): Packaging and feed distribution for desktop updates

## Reading Requirements

Before starting work on an issue:

1. Read the GitHub issue fully
2. Read the corresponding requirements document to understand boundaries
3. Note what is explicitly out of scope
4. Check constraints that affect design decisions

During implementation:

- Refer to acceptance criteria to verify completeness
- Flag scope creep if you encounter related problems
- Update the requirements if constraints change materially

After landing:

- The requirements document becomes part of the decision log
- A future maintainer can read it to understand what was considered and why
