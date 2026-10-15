// The chained call path: capture, send, speak, listen again.
//
// This is the mode the desktop falls back to and the phone did not have.
// A duplex session replaces the whole loop -- capture, understanding and
// speech in one socket -- but it needs a provider key, and an install that
// has never set one still deserves a working call.  So this runs the old
// loop explicitly: Apple dictation hears the caller, the text goes to the
// bot as an ordinary message, and the reply is spoken.
//
// The parts are deliberately the app's existing ones.  `SpeechDictation` is
// already the composer dictation, `Session.send` is already how a typed
// message is delivered, and `PersonalVoiceService` is already how a reply
// is read aloud.  Nothing here is a second implementation of any of them;
// this is the sequencing those three need in order to form a call.
//
// Two properties earn their own attention:
//
//  * Speech starts while the bot is still writing.  `session.state.streaming`
//    carries the reply as it arrives, so the caller hears the beginning of a
//    sentence while the model is still finishing it, which is the difference
//    between a conversation and a walkie-talkie.
//  * Talking over the bot is the interrupt.  `stop()` ends the utterance and
//    the capture opens again, which is what barge-in means on a path with no
//    socket to truncate.
import AVFoundation
import Foundation
import CompanionCore

@MainActor
final class ChainedVoiceEngine: ObservableObject {
    /// What the call is doing, in the terms the call screen already uses.
    enum State: Equatable {
        case idle
        /// The microphone is open and nothing has been said yet.
        case listening
        /// Text is in, waiting for the bot.
        case thinking
        /// The bot is being read aloud.
        case speaking
    }

    @Published private(set) var state: State = .idle

    private let session: Session
    private let chat: Chat
    private let threadId: String
    private let botName: String
    private let voiceId: String

    private var dictation: SpeechDictation?
    private var turnTask: Task<Void, Never>?
    private var speakTask: Task<Void, Never>?
    private var priorUserMessageIDs: Set<String> = []
    private var stopped = false
    /// Bumped when a turn is cancelled.  speakReply only opens the mic if
    /// it is still the turn that started it, so Stop cannot fall through
    /// into a second handoff.
    private var turnGeneration = 0
    /// Bumped when speech is silenced.  A queued chunk whose generation
    /// no longer matches does not start another utterance.
    private var speakGeneration = 0

    /// Called with each settled turn, so the call screen can draw the same
    /// transcript the duplex path produces.
    var onLine: ((StsTranscriptLine) -> Void)?
    /// A failure worth showing, with the recovery the call screen offers.
    var onFailure: ((String, VoiceCallRecovery) -> Void)?

    init(session: Session, chat: Chat, botName: String, voiceId: String) {
        self.session = session
        self.chat = chat
        self.botName = botName
        self.voiceId = voiceId
        self.threadId = chat.threadId
    }

    // MARK: - Lifecycle

    func start() {
        guard !stopped else { return }
        let dictation = SpeechDictation()
        self.dictation = dictation
        openMic()
    }

    func stop(haltSharedSpeech: Bool = true) {
        guard !stopped else { return }
        stopped = true
        turnGeneration += 1
        speakGeneration += 1
        turnTask?.cancel()
        turnTask = nil
        speakTask?.cancel()
        speakTask = nil
        dictation?.stop()
        dictation?.discardRecording()
        dictation = nil
        // A newer call may already be the one speaking.  Stopping the
        // shared synthesizer then would cut that call off.
        if haltSharedSpeech {
            PersonalVoiceService.shared.stop()
        }
        state = .idle
    }

    // MARK: - Controls

    /// Talking over the bot is the interrupt.  There is no socket here to
    /// truncate, so it is exactly two things: stop saying it, and listen.
    func interrupt() {
        guard !stopped else { return }
        // Cancel the turn before opening the mic, or speakReply finishes
        // the reply and opens the mic a second time.
        turnGeneration += 1
        silenceSpeech()
        turnTask?.cancel()
        turnTask = nil
        state = .listening
        openMic()
    }

    /// Stop is the manual barge-in on this path.  Duplex capture is already
    /// hot while the bot speaks.  This path closed the mic in order to
    /// speak, so silence alone would leave nobody listening.  The in-flight
    /// speakReply must not also open the mic when it notices the cancel.
    func stopPlayback() {
        interrupt()
    }

    func setMuted(_ muted: Bool) {
        guard !stopped else { return }
        if muted {
            turnGeneration += 1
            turnTask?.cancel()
            turnTask = nil
            dictation?.stop()
            dictation?.discardRecording()
        } else {
            openMic()
        }
    }

    // MARK: - Capture

    /// Open the microphone and wait for a finished utterance.
    ///
    /// The composer dictation is press-to-stop; a call has no second hand, so
    /// this drives it to a stop on its own once the recognizer settles.  A
    /// partial that never settles is abandoned rather than sent: a half
    /// sentence put into the chat as if it were whole is worse than a turn
    /// that did not happen.
    private func openMic() {
        guard !stopped, let dictation else { return }
        if !dictation.isListening && !dictation.isStarting {
            // stop() keeps the WAV, and start() refuses to run while one
            // is saved.  The call never surfaces that clip.  The transcript
            // is the whole artifact, so discard before every capture or the
            // second utterance never opens the microphone.
            dictation.discardRecording()
            dictation.startCapturing(base: "")
        }
        turnGeneration += 1
        let generation = turnGeneration
        turnTask?.cancel()
        turnTask = Task { @MainActor [weak self] in
            guard let self else { return }
            var last = ""
            var stableFor = 0
            while !Task.isCancelled, !self.stopped, self.turnGeneration == generation {
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled, !self.stopped, self.turnGeneration == generation else { return }
                let said = dictation.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                // Two consecutive identical reads means the recognizer has
                // stopped revising and is telling us the whole sentence.
                if said == last, !said.isEmpty {
                    stableFor += 1
                    if stableFor >= 2 {
                        dictation.stop()
                        dictation.discardRecording()
                        await self.deliver(said, generation: generation)
                        return
                    }
                } else {
                    stableFor = 0
                    if !said.isEmpty {
                        onLine?(StsTranscriptLine(text: said, from: .user, final: false))
                    }
                }
                last = said
            }
        }
    }

    // MARK: - A turn

    /// Send what was said, wait for the reply, and read it aloud.
    private func deliver(_ text: String, generation: Int) async {
        guard !stopped, turnGeneration == generation else { return }
        onLine?(StsTranscriptLine(text: text, from: .user, final: true))
        state = .thinking
        priorUserMessageIDs = Set(
            session.state.transcript(forThread: threadId)
                .filter { $0.role == .user }
                .map(\.id)
        )
        let outcome = await session.send(text, to: chat)
        guard !stopped, turnGeneration == generation else { return }
        guard outcome.ok else {
            // The call keeps going: a failed turn is this turn's problem, not
            // the call's.  The desktop behaves the same way.
            state = .listening
            openMic()
            return
        }
        await speakReply(generation: generation)
    }

    /// Read the reply as it is written, then open the mic again.
    ///
    /// The bot's turn ends when it stops streaming and stops being busy.  The
    /// final text is whatever the transcript holds at that point, which is why
    /// this reads the settled message rather than the stream: a stream read
    /// once would only ever say the first few words.
    private func speakReply(generation: Int) async {
        guard !stopped, turnGeneration == generation else { return }
        var spoken = ""
        var lastLength = 0
        var stableFor = 0
        while !Task.isCancelled, !stopped, turnGeneration == generation {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, !stopped, turnGeneration == generation else { return }
            let streaming = session.state.streaming[threadId] ?? ""
            if streaming.count != lastLength {
                // Something new arrived.  Speak it now rather than at the end:
                // the caller should not wait for a whole paragraph before
                // hearing the first sentence of it.  Chunks are queued, not
                // cancelled: speak() stops whatever is already playing, so
                // two of them at once would drop the beginning.
                let fresh = streaming.count > spoken.count
                    ? String(streaming.dropFirst(spoken.count))
                    : ""
                if !fresh.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    enqueueSpeech(fresh)
                }
                spoken = streaming
                lastLength = streaming.count
                stableFor = 0
                if !streaming.isEmpty { state = .speaking }
            } else {
                stableFor += 1
            }
            let busy = BotState.forChat(chat, in: session.state).showsActivity
            if chainedSpeakShouldStop(ChainedSpeakTick(
                streamingEmpty: streaming.isEmpty,
                spokenEmpty: spoken.isEmpty,
                busy: busy,
                stableFor: stableFor
            )) { break }
        }
        guard !stopped, turnGeneration == generation else { return }
        // Let the last utterance finish before handing the floor back, or the
        // caller talks into the tail of the sentence they interrupted.
        while PersonalVoiceService.shared.isSpeaking, !Task.isCancelled, !stopped, turnGeneration == generation {
            try? await Task.sleep(for: .milliseconds(120))
        }
        guard !stopped, turnGeneration == generation else { return }
        let settled = session.state.transcript(forThread: threadId)
            .filter { $0.role == .bot }
            .last(where: { !priorUserMessageIDs.contains($0.id) && $0.text?.isEmpty == false })
        if let text = settled?.text {
            onLine?(StsTranscriptLine(text: text, from: .bot, final: true))
        }
        state = .listening
        openMic()
    }

    /// Speak the next slice after the previous slice finishes.  Cancelling
    /// the previous task would drop the words the caller has not heard yet,
    /// because each speak() replaces the synthesizer's current utterance.
    private func enqueueSpeech(_ fresh: String) {
        let previous = speakTask
        let generation = speakGeneration
        speakTask = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, !Task.isCancelled, !self.stopped, self.speakGeneration == generation else { return }
            try? await PersonalVoiceService.shared.speak(
                segments: SpeechProjection.segments(fromReply: fresh),
                voiceId: self.voiceId
            )
        }
    }

    private func silenceSpeech() {
        speakGeneration += 1
        speakTask?.cancel()
        speakTask = nil
        PersonalVoiceService.shared.stop()
    }
}