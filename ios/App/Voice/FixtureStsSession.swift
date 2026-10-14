// A scripted StsSession for screenshots and interaction checks without a
// provider key, a network, or a microphone.
//
// DEBUG builds only, behind `-voice-fixture`: seeds the call screen with a
// mid-conversation state (provisional line becoming final, a failed tool
// surfaced as bypass, an approval-shaped line) so layout, Dynamic Type and
// dark mode can be verified deterministically.  It never touches audio
// hardware and never opens a socket -- simulated provider tests prove
// layout, not audio.  Live audio verification needs a real call.
#if DEBUG
import CompanionCore
import Foundation

/// A session that plays a fixed script instead of opening a socket.
final class FixtureStsSession: StsSession, @unchecked Sendable {
    let provider: StsProviderKind
    private var lineHandlers = [UUID: @Sendable (StsTranscriptLine) -> Void]()
    private var closedHandlers = [UUID: @Sendable (String) -> Void]()
    private let lock = NSLock()
    private var stopped = false
    private var scriptTask: Task<Void, Never>?

    init(provider: StsProviderKind = .xai) {
        self.provider = provider
    }

    func start(options: StsStartOptions) async throws {
        lock.lock()
        stopped = false
        lock.unlock()
        scriptTask = Task { [weak self] in
            guard let self else { return }
            // A beat of "connecting" before the first line, so the status
            // transition itself is screenshottable.
            try? await Task.sleep(for: .milliseconds(600))
            self.emit(StsTranscriptLine(text: "Hey -- what are we", from: .user, final: false))
            try? await Task.sleep(for: .milliseconds(700))
            self.emit(StsTranscriptLine(text: "Hey -- what are we working on?", from: .user, final: true))
            try? await Task.sleep(for: .milliseconds(900))
            self.emit(StsTranscriptLine(text: "Let me check the", from: .bot, final: false))
            try? await Task.sleep(for: .milliseconds(700))
            self.emit(StsTranscriptLine(
                text: "The gate is green and the receipts are in. Want me to open the pull request?",
                from: .bot,
                final: true
            ))
        }
    }

    func sendAudio(_ pcm: Data) {
        // Dropped: there is no socket and no VAD.  A fixture that echoed
        // would pretend at interactivity it does not have.
    }

    func stop() async {
        lock.lock()
        stopped = true
        lock.unlock()
        scriptTask?.cancel()
        scriptTask = nil
    }

    func onLine(_ handler: @escaping @Sendable (StsTranscriptLine) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock()
        lineHandlers[id] = handler
        lock.unlock()
        return { [weak self] in
            self?.lock.lock()
            self?.lineHandlers.removeValue(forKey: id)
            self?.lock.unlock()
        }
    }

    func onError(_ handler: @escaping @Sendable (Error) -> Void) -> () -> Void { {} }

    func onClosed(_ handler: @escaping @Sendable (String) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock()
        closedHandlers[id] = handler
        lock.unlock()
        return { [weak self] in
            self?.lock.lock()
            self?.closedHandlers.removeValue(forKey: id)
            self?.lock.unlock()
        }
    }

    private func emit(_ line: StsTranscriptLine) {
        lock.lock()
        let alive = !stopped
        let handlers = Array(lineHandlers.values)
        lock.unlock()
        guard alive else { return }
        for handler in handlers { handler(line) }
    }
}
#endif
