#if DEBUG
// A scripted busy thread for checking transcript scrolling in the simulator
// without a harness.  DEBUG builds only.
//
//   xcrun simctl launch booted app.botfleet \
//     -store-preview -open-first -scroll-demo [-scroll-demo-delay 20] [-scroll-demo-cycles 3]
//
// `-scroll-demo` seeds every preview bot with a long thread, waits
// `-scroll-demo-delay` seconds (default 15) so there is time to scroll up,
// then plays `-scroll-demo-cycles` turns (default 3) into the open chat.
// With `-scroll-demo-manual` nothing plays on a timer; each Darwin
// notification plays one turn, so a script decides exactly when:
//
//   xcrun simctl spawn booted notifyutil -p app.botfleet.scroll-demo.turn
// Each turn has five tool steps, a streamed reply of about 150 tokens, and a
// short follow-up message.  Frames go through the same reducer the live
// stream uses.  Follow decisions are logged under the `transcript-scroll`
// category.
import Foundation
import notify
import CompanionCore

@MainActor
enum TranscriptScrollDemo {
    private static var arguments: [String] { ProcessInfo.processInfo.arguments }

    static func startIfRequested(_ session: Session) {
        guard arguments.contains("-scroll-demo") else { return }
        for bot in session.state.bots {
            seed(session, threadId: bot.threadId, leafId: bot.activeLeafId)
        }
        if arguments.contains("-scroll-demo-manual") {
            listenForTurns(session)
            return
        }
        let delay = number(after: "-scroll-demo-delay") ?? 15
        let cycles = Int(number(after: "-scroll-demo-cycles") ?? 3)
        Task { @MainActor [weak session] in
            try? await Task.sleep(for: .seconds(delay))
            for cycle in 0..<cycles {
                guard let session else { return }
                await playTurn(session, cycle: cycle)
                try? await Task.sleep(for: .seconds(4))
            }
            TranscriptScrollLog.note("demo: finished")
        }
    }

    private static var notifyToken: Int32 = 0
    private static var manualCycle = 0
    private static var playing = false

    private static func listenForTurns(_ session: Session) {
        notify_register_dispatch("app.botfleet.scroll-demo.turn", &notifyToken, .main) { [weak session] _ in
            MainActor.assumeIsolated {
                guard let session, !playing else { return }
                playing = true
                let cycle = manualCycle
                manualCycle += 1
                Task { @MainActor in
                    await playTurn(session, cycle: cycle)
                    playing = false
                }
            }
        }
        TranscriptScrollLog.note("demo: waiting for app.botfleet.scroll-demo.turn")
    }

    private static func number(after flag: String) -> Double? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return Double(arguments[index + 1])
    }

    // MARK: - Seed

    private static let topics = [
        "the TestFlight checklist", "the privacy manifest", "the widget timeline",
        "push token registration", "the reconnect backoff", "the pairing flow",
        "Live Activity refresh", "the routine scheduler", "attachment uploads",
        "the search index", "voice playback", "the settings sync",
    ]

    private static func seed(_ session: Session, threadId: String, leafId: String?) {
        var parent = leafId
        let start = Date().timeIntervalSince1970 * 1000 - 40 * 60_000
        var step = 0
        func next() -> (id: String, at: Double) {
            step += 1
            return ("seed-\(threadId)-\(step)", start + Double(step) * 20_000)
        }
        for (index, topic) in topics.enumerated() {
            let ask = next()
            apply(session, message(threadId, ask.id, role: "user", kind: "text", at: ask.at, parent: parent,
                                   text: "Can you check \(topic) and tell me what is left?"))
            parent = ask.id
            if index % 3 == 1 {
                for tool in ["view_file", "run_command"] {
                    let activity = next()
                    apply(session, message(threadId, activity.id, role: "bot", kind: "activity", at: activity.at, parent: parent,
                                           tool: ["name": tool, "ok": true, "target": "ios/App", "durationMs": 420]))
                    parent = activity.id
                }
            }
            let reply = next()
            apply(session, message(threadId, reply.id, role: "bot", kind: "text", at: reply.at, parent: parent,
                                   text: replyText(topic: topic, index: index)))
            parent = reply.id
        }
    }

    private static func replyText(topic: String, index: Int) -> String {
        var text = "Here is where \(topic) stands.  I read through the code and the open board rows before answering, so this reflects main as of this morning.\n\n"
        text += "- The happy path works end to end on the simulator.\n- One edge case still needs a decision from you.\n- Nothing here blocks the next TestFlight build.\n\n"
        if index % 4 == 2 {
            text += "```swift\nlet ready = checklist.allSatisfy(\\.done)\nprint(ready ? \"ship\" : \"wait\")\n```\n\n"
        }
        text += "Say the word and I will open a pull request for the remaining piece."
        return text
    }

    // MARK: - A turn

    private static let streamedReply = """
    I went through all five checks.  The build is signed, the privacy manifest lists every API the app touches, and the review notes explain how to reach the paired computer without a real one.

    Two things are worth your attention before the next upload:

    1. The widget timeline refreshes every fifteen minutes, which is more often than the data changes.  Halving it would save battery without anyone noticing.
    2. The reconnect backoff tops out at thirty seconds.  That is fine on Wi-Fi, but on a weak cellular link it gives up on a stream that would have come back.

    Neither blocks the release.  I can make both changes in one small pull request, or leave them for after the build goes out.  The rest of the list is done, and the transcript of each check is in the tool steps above if you want to look.
    """

    private static func playTurn(_ session: Session, cycle: Int) async {
        guard let threadId = NotificationCoordinator.shared.viewingThreadId ?? session.state.bots.first?.threadId else { return }
        TranscriptScrollLog.note("demo: turn \(cycle) starting in \(threadId)")
        setBusy(session, threadId: threadId, busy: true)
        try? await Task.sleep(for: .milliseconds(800))

        var parent = session.state.visibleTranscript(forThread: threadId).last?.id
        let now = Date().timeIntervalSince1970 * 1000
        for step in 0..<5 {
            let id = "demo-\(cycle)-tool-\(step)"
            apply(session, message(threadId, id, role: "bot", kind: "activity", at: now + Double(step), parent: parent,
                                   tool: ["name": step % 2 == 0 ? "run_command" : "view_file", "ok": true, "target": "check \(step + 1)", "durationMs": 300]))
            parent = id
            try? await Task.sleep(for: .milliseconds(250))
        }

        // About 150 tokens, one every 30ms.
        let tokens = streamedReply.split(separator: " ", omittingEmptySubsequences: false).map { String($0) + " " }
        for token in tokens {
            apply(session, frame(["kind": "runtime", "event": [
                "type": "content.delta", "threadId": threadId, "delta": token, "streamKind": "assistant_text",
            ]]))
            try? await Task.sleep(for: .milliseconds(30))
        }
        let replyId = "demo-\(cycle)-reply"
        apply(session, message(threadId, replyId, role: "bot", kind: "text", at: now + 100, parent: parent, text: streamedReply))
        TranscriptScrollLog.note("demo: turn \(cycle) reply settled")
        try? await Task.sleep(for: .milliseconds(900))

        let followUpId = "demo-\(cycle)-followup"
        apply(session, message(threadId, followUpId, role: "bot", kind: "text", at: now + 200, parent: replyId,
                               text: "Turn \(cycle + 1) is finished.  Ready for the next one."))
        apply(session, frame(["kind": "runtime", "event": ["type": "turn.completed", "threadId": threadId]]))
        setBusy(session, threadId: threadId, busy: false)
        TranscriptScrollLog.note("demo: turn \(cycle) finished")
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
        tool: [String: Any]? = nil
    ) -> Frame? {
        var body: [String: Any] = ["id": id, "role": role, "kind": kind, "at": at]
        if let parent { body["parentId"] = parent }
        if let text { body["text"] = text }
        if let tool { body["tool"] = tool }
        return frame(["kind": "message", "threadId": threadId, "message": body])
    }

    private static func frame(_ json: [String: Any]) -> Frame? {
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(StreamFrame.self, from: data).frame
    }
}
#endif
