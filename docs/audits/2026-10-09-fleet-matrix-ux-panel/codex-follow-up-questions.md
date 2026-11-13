# Follow-Up Questions: Architecture, Framework, And UI/UX

Proposed by the CODEX seat at the owner's request, as a companion to R8 rather than an expansion of its six-question position.  These are decision questions, not approved implementation work.  Answer each with a recommendation, the strongest counterargument, evidence, and a smallest useful experiment.  Treat framework changes as proposals requiring measured justification.

## App Architecture

1. **What Is The Durable Unit Of Work?**  Is it a thread, a task with an outcome, a routine run, or something else?  What should survive a bot replacement, a retry, a model change, or a move between apps?  Produce an entity diagram separating identity, ownership, membership, and execution, with one complete example from request to accepted result.

2. **What Does An App Own?**  Can an app contain several repositories, rooms, workspaces, and deliverables, and can one thread contribute to several apps?  Decide which relationships are authoritative and which are saved views.  Explain the consequences for a non-coding use case and for an app spanning two repositories.

3. **Which Actions May Change Shared Execution State?**  What should happen when the Mac opens one thread, the phone reads another, and a routine fires?  Define separate contracts for viewing, composing, scheduling, and executing; specify the conflict response and demonstrate it in a two-client test.

4. **What Is The Shared Attention Contract?**  What precisely constitutes unread, working, blocked, failed, stale, and awaiting approval?  For each state, name its owner, scope, timestamp, acknowledgement rule, and destination.  Show how one incident appears consistently in a badge, a list, a notification, and the phone without becoming four obligations.

## Framework And Implementation Boundaries

5. **What Would Justify A Framework Change?**  Which measured constraints in startup, memory, streaming responsiveness, native integration, accessibility, or delivery speed would trigger reconsideration?  Compare an incremental prototype in the current stack with a narrowly scoped alternative, including migration, testing, distribution, and maintenance cost.  Set the success threshold before building either.

6. **What Should Desktop And iOS Share?**  Which contracts, domain rules, design tokens, fixtures, and workflows must be identical, and where should interaction remain platform-specific?  Define parity through complete user journeys, including voice, notifications, background recovery, and resuming a conversation.  Give each shared contract an owner and compatibility test.

7. **Where Should State Live?**  Classify server truth, cached server data, navigation history, device preferences, drafts, and derived summaries.  How do reconnects, out-of-order events, multiple windows, and optimistic updates reconcile?  Produce a state-ownership map and failure scenarios before selecting a state-management library.

8. **Which Module Boundaries Make Change Safer?**  Where should navigation, conversation data, attention, execution, settings, and platform adapters meet?  Identify the smallest extraction that lets a new overview view ship without changing execution routing.  Define dependency rules, typed interfaces, and tests that prevent those responsibilities from coupling again.

## UI/UX And Product Validation

9. **Which Three Jobs Define A Successful Session?**  Rank starting work, resuming a conversation, supervising several apps, unblocking a bot, and reviewing results for the intended audience.  Set task-completion and wrong-destination baselines for new and experienced users; use those results to choose the landing view and navigation hierarchy.

10. **Can A Person Predict Every Click?**  Before opening a cell, badge, card, notification, or search result, can they tell the exact thread, app, and action they will reach?  Specify breadcrumbs, back behavior, multi-thread choices, empty states, and preservation of drafts and reading position.  Test identical destinations from every entry point.

11. **How Does The Interface Scale Across Ability And Fleet Size?**  What changes between one bot and hundreds of active conversations?  Test narrow windows, long names, keyboard-only use, screen readers, large text, reduced motion, and color-independent status recognition.  Require a usable answer to “What needs me?” at every size.

12. **Which Choices Must Users Understand, And Which Can Be Progressive?**  What must be configured before the first useful result, and what can appear when needed?  For each arrangement, identify an observable benefit and a reversible transition; cover existing threads, incompatible clients, failed saves, and rollback.  Decide how to measure whether an option reduces effort enough to justify its long-term support.

## Suggested Decision Order

Resolve questions 1–4 and 9 first: the work model, state boundaries, attention contract, and primary jobs.  Then use 6–8 to choose implementation boundaries, 10–12 to validate the interaction, and 5 to determine whether measured evidence warrants a framework experiment.

## Source Anchors For The Next Round

These anchors explain why the questions are relevant; they are source-traced at `4e296b8c8`, not runtime measurements:

- App binding is a group ID plus a captured execution directory: `shared/task-workspace-context.ts:1-14` (questions 1–2).
- App navigation can dispatch an active-task switch, and dispatch sends a POST: `src/App.tsx:157-163`; `src/state/store.tsx:2890-2893` (questions 3, 7–8, 10).
- The deck derives attention from rooms and bots: `src/components/AppDeck.tsx:62-77` (question 4).
- The desktop entry is Electron, with React and Vite dependencies: `package.json:17`, `package.json:112-113`, `package.json:129`, `package.json:138`; the iOS Updates view uses SwiftUI: `ios/App/UpdatesSheet.swift:6-9` (questions 5–6).
- The overview currently requires a non-DM room and an active chat view: `src/App.tsx:105`, `src/App.tsx:457` (questions 9, 11–12).
