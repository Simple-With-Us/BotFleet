#if DEBUG
// A scripted conversation for checking the chat screen in the simulator
// without a paired Mac.  DEBUG builds only.
//
//   xcrun simctl launch booted app.botfleet.ios \
//     -store-preview -open-first -chat-fixture
//
// One thread carrying every shape the transcript has to survive: a long
// Markdown reply with headings, lists, a quote, a link and two code blocks;
// a completed tool run; a failed one and the retry that recovered it; a run
// still in flight; a permission card waiting on an answer beside one already
// answered; and a long unbroken user message.
//
// Ids and timestamps are fixed, so a screenshot taken twice is the same
// screenshot and a diff between two runs shows a real change rather than a
// clock.
//
// By default the bot is left mid-turn, so the screen also shows the things
// that only exist while it works: the live reply, the typing caret, and the
// composer's Stop.  `-chat-fixture-settled` ends the turn instead, for the
// idle screen.
//
// `-chat-fixture-code` seeds a short thread instead, ending on a code block
// with a line long enough to scroll sideways, plus a failed tool call — the
// pieces that are a screen away in the full fixture and unreachable in a
// screenshot of it.
import Foundation
import CompanionCore

@MainActor
enum ChatFixture {
    static func startIfRequested(_ session: Session) {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.contains("-chat-fixture") || arguments.contains("-chat-fixture-code"),
              let bot = session.state.bots.first
        else { return }

        if arguments.contains("-chat-fixture-code") {
            seedCodeBlockFocus(session, threadId: bot.threadId)
            return
        }

        let threadId = bot.threadId
        // Start from the thread's existing leaf.  Seeding from `nil` would
        // give this fixture a second root, and `versions(of:)` groups user
        // text by parent id — two roots read as two versions of one message
        // and the transcript grows a version switcher nobody asked for.
        var parent = session.state.visibleTranscript(forThread: threadId).last?.id
        var at = Date().timeIntervalSince1970 * 1000 - 22 * 60_000

        func step() -> Double {
            at += 9_000
            return at
        }

        func add(role: String, kind: String, text: String? = nil,
                 tool: [String: Any]? = nil, card: [String: Any]? = nil) {
            let id = "fixture-\(parent ?? "root")-\(role)-\(at)"
            apply(session, message(threadId, id, role: role, kind: kind,
                                   at: step(), parent: parent, text: text,
                                   tool: tool, card: card))
            parent = id
        }

        // A question long enough to wrap several times and to carry the
        // punctuation that breaks naive wrapping.
        add(role: "user", kind: "text", text: """
        Before this goes up, can you walk me through what actually changed on the conversation screen?  I care most about the parts someone would notice in the first ten seconds: whether I can tell at a glance who I am talking to and whether the phone is still connected, whether a long reply is readable, and whether I can copy a command out of it.
        """)

        // The long-form reply: every block MarkdownText has to draw, in the
        // order a model most often emits them.
        add(role: "bot", kind: "text", text: """
        ## What changed on the conversation screen

        Four things, and one of them is the reason the other three were worth doing.

        ### 1. The header says who you are talking to

        The bot's name now sits beside a connection mark.  It reads **Connected** in green while the phone is talking to the Mac, *Working* in the bot's own colour while it holds the turn, and drops to an orange **Reconnecting…** when the link drops.

        > A dropped connection outranks a working turn on purpose.  "Working" claims a reply is still coming, which is exactly what a lost connection denies.

        ### 2. Markdown that moves when you ask it to

        Every size in the transcript is now relative rather than fixed, so the whole thread scales with the reader's text size instead of staying frozen at whatever it was built at.

        1. Headings, lists and quotes keep their shape.
        2. Code blocks stay selectable and scroll sideways.
        3. Long lines are still readable without wrapping.

        The font scaling is the one that matters.  A fixed point size does not move when someone changes their text size, which means the reply was the one thing on the screen that could not be made larger:

        ```swift
        // Before: 17pt at every accessibility setting.
        Text(reply).font(.system(size: 17))

        // After: same size by default, and it scales from there.
        Text(reply).font(.system(size: 17, relativeTo: .body))
        ```

        ### 3. Code you can take with you

        Every fenced block now has a Copy button in its header row, outside the horizontal scroll view so it stays reachable on a long line.  It copies the block verbatim: no line numbers, no fence, nothing added.

        ```bash
        xcrun simctl launch booted app.botfleet.ios \\
          -store-preview -open-first -chat-fixture
        ```

        ### 4. The composer grew two controls

        The microphone is always on screen rather than appearing only once dictation is already running, and **Stop** sits beside Send while the bot holds the turn.  Both are 44pt targets.

        The reasoning is in the [companion pull request](https://example.com/botfleet/pull/1612) if you want the before and after side by side.
        """)

        // A completed run.  Grouped into one foldable card by the transcript.
        add(role: "bot", kind: "activity", tool: [
            "name": "view_file", "ok": true, "target": "ios/App/ChatView.swift",
            "durationMs": 412, "detail": "2,941 lines",
        ])
        add(role: "bot", kind: "activity", tool: [
            "name": "run_command", "ok": true, "target": "grep -rn 'relativeTo:' ios/App",
            "durationMs": 1_284, "detail": "30 matches",
        ])
        add(role: "bot", kind: "activity", tool: [
            "name": "call_mcp_tool", "ok": true, "target": "simctl.screenshot",
            "durationMs": 903, "detail": "wrote chat-after.png",
        ])

        add(role: "bot", kind: "text", text: """
        That is the whole change.  The tool steps above are the reads I did to confirm it, folded into one card so they do not take over the thread.
        """)

        // A failure that recovers.  The red edge and the Failed badge are the
        // part worth seeing, and so is the retry that follows.
        add(role: "bot", kind: "activity", tool: [
            "name": "run_command", "ok": false, "target": "xcodebuild -scheme BotFleet -destination 'generic/platform=iOS'",
            "durationMs": 6_120,
            "detail": """
            error: Signing for "BotFleet" requires a development team.
            The build stopped at the signing step; nothing was written.
            Fix: pass CODE_SIGNING_ALLOWED=NO for a simulator build.
            """,
        ])

        add(role: "bot", kind: "text", text: """
        That one is recoverable, and worth leaving in the fixture for exactly that reason.  The build failed at **signing**, not at compile time — a simulator build does not need a team, so passing `CODE_SIGNING_ALLOWED=NO` fixes it.  Nothing was half-written.

        I re-ran it with the flag and it passed, which is the retry below.
        """)

        add(role: "bot", kind: "activity", tool: [
            "name": "run_command", "ok": true, "target": "CODE_SIGNING_ALLOWED=NO xcodebuild …",
            "durationMs": 214_880, "detail": "** BUILD SUCCEEDED **",
        ])

        // Two cards: one still waiting, one already answered.  A thread
        // holding both is the case that has to read clearly.
        add(role: "bot", kind: "options", card: [
            "title": "Approval needed",
            "subtitle": "Run the iOS verification gate and open a pull request?",
            "options": ["Allow", "Deny"],
            "requestId": "fixture-request-1",
            "tool": "run_command",
        ])

        add(role: "bot", kind: "options", card: [
            "title": "Ship it?",
            "subtitle": "Upload build 1.0.30 to TestFlight for internal testing?",
            "options": ["Yes", "Not yet"],
            "requestId": "fixture-request-0",
            "tool": "upload",
            "answered": "Not yet",
        ])

        // A run still in flight.
        add(role: "bot", kind: "activity", tool: [
            "name": "view_file", "ok": nil, "target": "ios/App/Cards/SkillExecutionReceiptView.swift",
        ])

        if ProcessInfo.processInfo.arguments.contains("-chat-fixture-settled") {
            setBusy(session, threadId: threadId, busy: false)
            return
        }

        // Leave it mid-turn, so one screenshot shows the live row, the caret
        // and the composer's Stop at the same time.
        setBusy(session, threadId: threadId, busy: true)
        for token in ["I have the screenshots.  ", "The header, the code block, ",
                      "and the composer with Stop showing — "] {
            apply(session, frame(["kind": "runtime", "event": [
                "type": "content.delta", "threadId": threadId,
                "delta": token, "streamKind": "assistant_text",
            ]]))
        }
    }

    // MARK: - The code-block focus fixture

    /// A thread short enough to fit on one screen with its last message —
    /// the code block — fully visible, so the Copy button, the language tag
    /// and the sideways scroll can be checked without scrolling to find them.
    /// The full fixture buries its code blocks under a screen of prose, which
    /// is the right shape for a transcript and the wrong one for a
    /// screenshot.
    private static func seedCodeBlockFocus(_ session: Session, threadId: String) {
        var parent = session.state.visibleTranscript(forThread: threadId).last?.id
        let at = Date().timeIntervalSince1970 * 1000

        func add(role: String, kind: String, text: String? = nil,
                 tool: [String: Any]? = nil, card: [String: Any]? = nil) {
            let id = "codefix-\(role)-\(at)-\(UUID().uuidString.prefix(6))"
            apply(session, message(threadId, id, role: role, kind: kind,
                                   at: at, parent: parent, text: text,
                                   tool: tool, card: card))
            parent = id
        }

        add(role: "user", kind: "text", text: "Show me the check as code.")

        add(role: "bot", kind: "text", text: """
        Here is the gate, and it is the one that catches a signed-but-not-uploaded build:

        ```bash
        xcodebuild -project BotFleet.xcodeproj -scheme BotFleet -destination 'platform=iOS Simulator,name=BF Scroll iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO build | tail -3
        ```
        """)

        add(role: "bot", kind: "activity", tool: [
            "name": "run_command", "ok": false,
            "target": "xcrun simctl ui booted content_size",
            "durationMs": 410,
            "detail": "error: no booted simulator — the device had been shut down.",
        ])
    }

    // MARK: - Frames

    private static func setBusy(_ session: Session, threadId: String, busy: Bool) {
        session.debugMutateState { state in
            if let index = state.bots.firstIndex(where: { $0.threadId == threadId }) {
                state.bots[index].busy = busy
            }
        }
    }

    private static func apply(_ session: Session, _ frame: Frame?) {
        guard let frame else { return }
        session.debugMutateState { $0.apply(frame) }
    }

    private static func message(
        _ threadId: String,
        _ id: String,
        role: String,
        kind: String,
        at: Double,
        parent: String?,
        text: String? = nil,
        tool: [String: Any]? = nil,
        card: [String: Any]? = nil
    ) -> Frame? {
        var body: [String: Any] = ["id": id, "role": role, "kind": kind, "at": at]
        if let parent { body["parentId"] = parent }
        if let text { body["text"] = text }
        if let tool { body["tool"] = tool }
        if let card { body["card"] = card }
        return frame(["kind": "message", "threadId": threadId, "message": body])
    }

    private static func frame(_ json: [String: Any]) -> Frame? {
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(StreamFrame.self, from: data).frame
    }
}
#endif