#if DEBUG
// A reply being read aloud, for checking the karaoke highlight in the
// simulator without a harness or a voice.  DEBUG builds only.
//
//   xcrun simctl launch booted app.botfleet.ios \
//     -store-preview -open-first -karaoke-demo [-karaoke-demo-word passed] [-karaoke-demo-fraction 0.5]
//
// Adds a markdown reply to the first preview bot's thread and follows it
// with the same script, spans, alignment and timing a hosted voice uses
// (clip windows estimated from the text).  With `-karaoke-demo-word`, the
// clock is pinned partway through the first display word with that text
// (`-karaoke-demo-fraction`, default 0.5), so a screenshot is the same
// every time.  Without it, the reply plays through once.
import CompanionCore
import Foundation
import QuartzCore

@MainActor
enum KaraokeDemo {
    static let messageId = "karaoke-demo-reply"

    static let reply = """
    ## Release Check

    The archive is signed, and build 749 passed every check in 3.5 minutes.  I read the [privacy manifest](https://example.com/privacy) and the review notes before answering.

    - TestFlight accepts the upload.
    - The widget refresh drops to every 15 minutes.

    ```swift
    let ready = checks.allSatisfy(\\.passed)
    ```

    Say the word and I will open the pull request.
    """

    private static var arguments: [String] { ProcessInfo.processInfo.arguments }

    static func startIfRequested(_ session: Session) {
        guard arguments.contains("-karaoke-demo"), let bot = session.state.bots.first else { return }
        let threadId = bot.threadId
        let parent = session.state.visibleTranscript(forThread: threadId).last?.id
        var body: [String: Any] = [
            "id": messageId, "role": "bot", "kind": "text",
            "at": Date().timeIntervalSince1970 * 1000, "text": reply,
        ]
        if let parent { body["parentId"] = parent }
        let json: [String: Any] = ["kind": "message", "threadId": threadId, "message": body]
        guard let data = try? JSONSerialization.data(withJSONObject: json),
              let frame = try? JSONDecoder().decode(StreamFrame.self, from: data).frame
        else { return }
        session.debugMutateState { $0.apply(frame) }
        session.debugSetSpeaking(messageId)

        // The script the harness sends for a reply read as written.
        let source = SpeechProjection.writtenReply(reply)
        let spoken = SpeechSpans.utterancesWithSpans(source)
        let script = KaraokeScript.fromWire(
            utterances: spoken.map(\.text),
            wire: SpokenSpansWire.encode(sourceText: source, utterances: spoken)
        )
        guard let karaoke = KaraokeCenter.shared.begin(messageId: messageId, messageText: reply, script: script, mode: .clips) else { return }

        if let index = arguments.firstIndex(of: "-karaoke-demo-word"), index + 1 < arguments.count {
            let fraction = number(after: "-karaoke-demo-fraction") ?? 0.5
            if let pinned = karaoke.debugTime(ofWord: arguments[index + 1], fraction: fraction) {
                karaoke.debugClock = { pinned }
                karaoke.renderNow()
                return
            }
        }
        let started = CACurrentMediaTime()
        karaoke.debugClock = { (CACurrentMediaTime() - started) * 1000 }
        karaoke.debugStart()
    }

    private static func number(after flag: String) -> Double? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return Double(arguments[index + 1])
    }
}

extension MessageKaraoke {
    /// The clock time `fraction` of the way through the first display word
    /// spelled `text`.
    func debugTime(ofWord text: String, fraction: Double) -> Double? {
        guard let index = display.words.firstIndex(where: { $0.text == text }) else { return nil }
        let (start, end) = debugWindow(index)
        return start + (end - start) * fraction
    }
}
#endif
