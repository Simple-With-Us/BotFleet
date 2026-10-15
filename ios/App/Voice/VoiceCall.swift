// One voice call: token, session, capture, playback, transcript, approvals.
//
// The orchestrator owns everything except the socket (the StsSession) and
// the transport (Session/Client).  State is a single enum so the screen can
// switch on it exhaustively -- a call is always in exactly one state, and
// every state has a sentence, a control set, and a cleanup path.
//
// Two deliberate omissions, both honest:
//
//  * No `bot_engine` tool.  The phone cannot run a synchronous engine turn:
//    sends are async and replies arrive over SSE, so a tool `run` would be a
//    guess strapped to a timeout.  The model answers from its own knowledge
//    and the call screen says so once, up front, instead of marking every
//    line bypassed.  Spoken approvals still dispatch through the real
//    respond route -- that is the tool execution with a permission boundary,
//    and it works.
//  * The chained path is the fallback when no speech-to-speech provider is
//    available: dictation, an ordinary send, and Personal Voice, sequenced
//    as a call.  A call that cannot start either way says why and offers
//    the way back to text.
import AVFoundation
import Combine
import Foundation
import CompanionCore

/// Every state a call can be in.  One enum, exhaustive switch on the screen.
public enum VoiceCallPhase: Hashable, Sendable {
    /// Resolving status, minting the token, opening the socket.
    case connecting
    /// Live: mic open, provider listening.
    case listening
    /// The provider is producing (model thinking or engine working).
    case thinking
    /// Audio scheduled or sounding.
    case speaking
    /// The socket dropped mid-call; retrying with backoff.
    case reconnecting(attempt: Int)
    /// Over.  Carries the sentence the screen shows, if any.
    case ended(reason: String?)
    /// Never started.  Carries the actionable reason.
    case failed(reason: String, recovery: VoiceCallRecovery)
}

/// What the failed screen offers.  Every case is a working button, never a
/// dead label: an unavailable capability must have a truthful reason AND a
/// working recovery action.
public enum VoiceCallRecovery: Hashable, Sendable {
    /// Try the whole start sequence again.
    case retry
    /// Open the system Settings app (permission denial).
    case openSettings
    /// Back to the text composer.
    case backToText
}

@MainActor
public final class VoiceCall: ObservableObject {
    @Published public private(set) var phase: VoiceCallPhase = .connecting
    @Published public private(set) var lines: [StsLineView] = []
    /// The provider that took this call, once known.
    @Published public private(set) var provider: StsProviderKind?
    @Published public private(set) var muted = false
    /// Live mic level 0...1 for the level meter.  Decays when quiet.
    @Published public private(set) var level: Double = 0

    /// The chat this call belongs to.  Final transcript lines land here as
    /// text continuity when the call ends.
    let chat: Chat
    public let botName: String

    private let session: Session
    private var capture: VoiceCapture?
    private var playback: VoicePlayback?
    private var sts: (any StsSession)?
    /// The chained path, when no speech-to-speech provider is available.
    /// Exactly one of `sts` and `chained` is ever live.
    private var chained: ChainedVoiceEngine?
    private var cancellations: [() -> Void] = []
    private var lineKeys = 0
    private var decided = Set<String>()
    private var stopped = false
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var endTask: Task<Void, Never>?
    private var runTask: Task<Void, Never>?
    /// Bumped on start, on end, and when a start fails.  A teardown
    /// scheduled by an older attempt must not tear down, or re-phase, the
    /// attempt that replaced it, and a start still awaiting the socket
    /// cannot land on listening after the failure was decided.
    private var generation = 0

    /// Announced once per call: without the engine tool, the model answers
    /// from its own knowledge.  Said on the screen, not stamped on every
    /// line -- the bypass marker is for turns that were SUPPOSED to have the
    /// engine and lost it, not for a call that never offered it.
    public static let noEngineNote =
        "On this call I answer from my own knowledge -- I can't reach my tools here. Anything needing them belongs in text."

    /// Said once when the call runs on the chained path.  It does not name the
    /// reason: a missing key sends you to the Mac, and a microphone does not
    /// matter here, so the one useful thing to say is that the call still
    /// works and the tools do not come with it.
    public static let chainedFallbackNote =
        "This call has no live speech model, so I answer a little slower: you talk, I listen, I write back, and I read it aloud."

    init(chat: Chat, botName: String, session: Session) {
        self.chat = chat
        self.botName = botName
        self.session = session
    }

    // MARK: - Start

    public func start() {
        guard !stopped else { return }
        generation += 1
        let gen = generation
        // Try Again is a new call.  Reconnect calls run() directly and must
        // keep the transcript and the attempt count, so the reset lives here
        // and not at the top of run().
        let failed = { if case .failed = self.phase { return true } else { return false } }()
        let restart = callTryAgain(fromFailedPhase: failed, reconnectAttempt: reconnectAttempt)
        if restart.clearTranscript {
            lines.removeAll(keepingCapacity: true)
            lineKeys = 0
            decided.removeAll()
        }
        reconnectAttempt = restart.reconnectAttempt
        runTask?.cancel()
        runTask = Task { [weak self] in
            await self?.run(generation: gen)
        }
    }

#if DEBUG
    /// Fixture mode (`-voice-fixture`): a scripted session, no token, no
    /// socket, no microphone.  Proves layout, not audio.
    func startFixture(provider: StsProviderKind = .xai) {
        guard !stopped else { return }
        self.provider = provider
        setPhase(.connecting)
        let fixture = FixtureStsSession(provider: provider)
        self.sts = fixture
        // Capture/playback stay nil: every control that needs them checks
        // isLive and the phase, and the fixture phase path never requires
        // audio objects to exist.
        attachFixture(session: fixture)
        Task {
            try? await fixture.start(options: StsStartOptions(instructions: "fixture"))
            if !self.stopped {
                self.setPhase(.listening)
            }
        }
    }

    private func attachFixture(session fixture: FixtureStsSession) {
        cancellations.forEach { $0() }
        cancellations.removeAll()
        let gen = generation
        cancellations.append(fixture.onLine { [weak self] line in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.receive(line: line)
            }
        })
        cancellations.append(fixture.onClosed { [weak self] reason in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.vendorClosed(reason: reason)
            }
        })
    }
#endif

    /// Run the call the way the desktop does when there is no provider key:
    /// dictation in, the bot's ordinary reply out, spoken, then listening
    /// again.  No socket, no token, and no key — which is the point.
    /// Outside the debug fixture on purpose: a Release archive is what ships,
    /// and this is the fallback that archive has to be able to compile.
    private func runChained(generation gen: Int, status _: StsStatus, reason _: CallModeReason) {
        guard owns(gen) else { return }
        let voiceId: String = {
            guard case let .bot(bot) = chat else { return "" }
            return bot.voice(for: .iphone) ?? ""
        }()
        let engine = ChainedVoiceEngine(session: session, chat: chat, botName: botName, voiceId: voiceId)
        chained = engine
        engine.onLine = { [weak self] line in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.receive(line: line)
            }
        }
        engine.onFailure = { [weak self] text, recovery in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.fail(text, recovery: recovery)
            }
        }
        // Said once per call, not once per entry.  Reconnect runs `run`
        // again and keeps the transcript, so a second landing here must
        // not stack another copy of the same sentence.  The fallback
        // reasons stay quiet: a call that opens by explaining why it
        // could not be better is worse than one that simply works.
        if shouldEmitCallNote(Self.chainedFallbackNote, alreadyShown: lines.map(\.text)) {
            emitSystemLine(Self.chainedFallbackNote)
        }
        engine.start()
        setPhase(.listening)
    }

    private func run(generation gen: Int) async {
        guard owns(gen) else { return }
        // A reconnect used to leave the previous microphone and socket
        // running and open a second pair on top.  Drop them first.
        if capture != nil || playback != nil || sts != nil || chained != nil || !cancellations.isEmpty {
            await teardown(generation: gen)
            guard owns(gen) else { return }
        }
        setPhase(.connecting)
        // 1. What can this computer actually do?
        let status: StsStatus
        do {
            status = try await session.voiceCallStatus()
        } catch {
            guard owns(gen) else { return }
            return fail(
                "Could not reach your computer. Check that it is awake and try again.",
                recovery: .retry
            )
        }
        guard owns(gen) else { return }
        guard status.isKnown else {
            return fail(
                "This computer does not offer voice calls. It may need an update.",
                recovery: .backToText
            )
        }
        // The mode is a property of the computer, not of this phone, so it is
        // decided by the same rule the desktop uses.  Without a provider key
        // the call used to fail here and offer to go back to text; that is the
        // one thing the desktop never does, because it always has the chained
        // path to fall back to.
        let decision = decideCallMode(keyStatus: status, microphoneAvailable: true)
        guard decision.mode == .sts, let kind = decision.provider else {
            return runChained(generation: gen, status: status, reason: decision.reason)
        }
        self.provider = kind
        // 2. One short-lived token.  The permanent key never leaves the Mac.
        let token: StsSessionToken
        do {
            token = try await session.voiceCallToken(provider: kind.rawValue)
        } catch {
            guard owns(gen) else { return }
            return fail(
                "Could not start a voice call (\(friendlyError(error))).",
                recovery: .retry
            )
        }
        guard owns(gen) else { return }
        guard !token.token.isEmpty else {
            return fail("The computer would not issue a call token.", recovery: .retry)
        }
        // 3. Playback first (no permission gate), then capture (permission
        // gate).  A denied mic fails here, before any socket opens, so there
        // is never a live call with no way to speak.  Objects stay local
        // until they are actually started, so End during an await cannot
        // miss them and also cannot be overwritten by a later assignment.
        guard let playback = VoicePlayback() else {
            return fail("This phone cannot play call audio.", recovery: .backToText)
        }
        do {
            try playback.start()
        } catch {
            playback.stop()
            guard owns(gen) else { return }
            return fail("Could not start call audio. Try again.", recovery: .retry)
        }
        guard owns(gen) else {
            playback.stop()
            return
        }
        self.playback = playback
        let capture = VoiceCapture()
        do {
            try await capture.start()
        } catch let failure as VoiceCapture.Failure {
            capture.stop()
            guard owns(gen) else { return }
            switch failure {
            case .permissionDenied:
                return fail(failure.localizedDescription, recovery: .openSettings)
            case .noMicrophone, .engineStartFailed:
                return fail(failure.localizedDescription, recovery: .retry)
            }
        } catch {
            capture.stop()
            guard owns(gen) else { return }
            return fail("Could not start the microphone.", recovery: .retry)
        }
        guard owns(gen) else {
            capture.stop()
            return
        }
        // Mute is the call's, not the capture object's.  A reconnect builds
        // a new capture, and it used to come back unmuted.
        if muted { capture.setMuted(true) }
        self.capture = capture
        // 4. The provider session.  No engine tool (see the file header).
        let sts: any StsSession =
            kind == .xai
            ? XaiRealtimeSession(token: token.token, playback: playback)
            : GeminiLiveSession(token: token.token, playback: playback)
        self.sts = sts
        attach(session: sts, capture: capture)
        do {
            try await sts.start(options: StsStartOptions(
                instructions: callPersona(),
                engine: nil,
                engineTimeoutMs: 10_000
            ))
        } catch {
            guard owns(gen) else { return }
            return fail("Could not open the speech session (\(friendlyError(error))).", recovery: .retry)
        }
        guard owns(gen) else { return }
        reconnectAttempt = 0
        setPhase(.listening)
        // Reconnect runs this again.  The note is once per call, not once
        // per socket.
        if shouldEmitCallNote(Self.noEngineNote, alreadyShown: lines.map(\.text)) {
            emitSystemLine(Self.noEngineNote)
        }
    }

    // MARK: - Controls

    /// Mute the mic.  Capture keeps running so unmuting is instant; no
    /// frames leave the phone while muted.
    public func setMuted(_ muted: Bool) {
        self.muted = muted
        if let chained {
            chained.setMuted(muted)
            return
        }
        capture?.setMuted(muted)
    }

    /// Stop playback now without ending the call.  Distinct from mute (which
    /// gates the mic) and from End (which tears everything down): this is
    /// "stop talking", for when the bot is reading something long.
    public func stopPlayback() {
        if let chained {
            // Cancels the speak chain and the turn that would otherwise
            // finish the reply and open the mic on its own.  The engine
            // opens the mic once, which is this screen's "tap Stop, then
            // speak": duplex capture was already hot, and this path had
            // closed it in order to talk.
            chained.stopPlayback()
            return
        }
        playback?.stopPlayback()
    }

    /// Barge in: cut playback and let the caller speak.  The session's own
    /// VAD usually beats a finger here; this is the manual path for when it
    /// does not (or for providers whose VAD lags).
    public func interrupt() {
        if let chained {
            chained.interrupt()
            setPhase(.listening)
            return
        }
        // The session, not the view, knows how to stop a reply: it is the only
        // thing that can say how much of the reply was actually heard and tell
        // the vendor to drop the rest, and it holds the same playback object
        // this call does.  Stopping the speaker here alone left the model
        // finishing a turn nobody heard.
        sts?.interrupt()
        setPhase(.listening)
    }

    /// End the call: stop capture, playback, and socket, write continuity,
    /// and park in .ended.  Idempotent -- End during reconnect, End twice,
    /// and End racing a vendor close all land here once.
    public func end() {
        guard !stopped else { return }
        stopped = true
        generation += 1
        let gen = generation
        runTask?.cancel()
        runTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        endTask?.cancel()
        let held = detach()
        endTask = Task { [weak self] in
            guard let self else { return }
            await self.finish(held, generation: gen)
            self.writeContinuity()
            self.setPhase(.ended(reason: nil))
        }
    }

    // MARK: - Wiring

    private func attach(session sts: any StsSession, capture: VoiceCapture) {
        cancellations.forEach { $0() }
        cancellations.removeAll()
        let gen = generation
        capture.onFrame = { [weak self] data in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.sts?.sendAudio(data)
            }
        }
        capture.onError = { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.fail("The microphone stopped (\(error.localizedDescription)).", recovery: .retry)
            }
        }
        cancellations.append(sts.onLine { [weak self] line in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.receive(line: line)
            }
        })
        cancellations.append(sts.onError { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.fail("\(error.localizedDescription)", recovery: .retry)
            }
        })
        cancellations.append(sts.onClosed { [weak self] reason in
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen else { return }
                self.vendorClosed(reason: reason)
            }
        })
        // Route changes (headphones in/out) and interruptions pause the call
        // rather than killing it: the socket stays, capture restarts.
        cancellations.append(observeAudioSession())
    }

    private func receive(line: StsTranscriptLine) {
        lineKeys += 1
        lines = appendStsLine(lines, line: line, key: "call-\(lineKeys)")
        // Phase follows the transcript: provisional or final bot text means
        // the provider is producing; a final line settles back to listening
        // unless audio is still scheduled.
        switch (line.from, line.final) {
        case (.bot, false):
            setPhase(.thinking)
        case (.bot, true):
            setPhase((playback?.isPlaying ?? false) ? .speaking : .listening)
        case (.user, _):
            if line.final { setPhase(.listening) }
        }
        // Speaking tracks the player, not the transcript: audio keeps
        // arriving after the final line.
        if line.from == .bot {
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(300))
                guard let self, !self.stopped else { return }
                if self.playback?.isPlaying ?? false {
                    self.setPhase(.speaking)
                } else if case .speaking = self.phase {
                    self.setPhase(.listening)
                }
            }
        }
    }

    // MARK: - Approvals

    /// The engine tool is absent on calls, but approvals still arrive: the
    /// model learns one is waiting through the transcript and hands the
    /// caller's words back via the approval tool.  This resolves those turns
    /// with the same anchored rules as text, and dispatches through the same
    /// respond route -- a spoken "yes" and a clicked "Allow" are one decision
    /// with one record.
    func resolveApproval(action: StsApprovalAction, requestId: String?, answer: String?, pending: [StsApprovalView]) async -> String {
        let outcome = resolveStsApproval(action: action, requestId: requestId, answer: answer, pending: pending, decided: decided)
        switch outcome {
        case let .decided(id, decision):
            // Claimed BEFORE dispatch, exactly as the desktop does: until
            // the durable card patch lands this request is still on screen
            // and must not be answered a second time.
            decided.insert(id)
            let ok = await session.answer(
                threadId: chat.threadId,
                requestId: id,
                choice: decision == .allow ? "Allow" : "Deny",
                isPermission: true,
                quietly: true
            )
            if !ok {
                // The server refused: hand the claim back so the request can
                // be answered again, and say so rather than leaving the model
                // waiting out a deadline in silence.
                decided.remove(id)
                return "That approval could not be saved. Ask the caller to answer it again."
            }
            return decision == .allow ? "Approved." : "Denied."
        case let .stale(text):
            return text
        case let .unclear(_, text):
            return text
        case let .ask(_, text):
            return text
        case let .status(text):
            return text
        }
    }

    // MARK: - Reconnect

    private func vendorClosed(reason: String) {
        guard !stopped else { return }
        reconnectAttempt += 1
        let attempt = reconnectAttempt
        setPhase(.reconnecting(attempt: attempt))
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            // Backoff: 1s, 2s, 4s, capped at 8s.  Past 4 tries the call is
            // over -- a call that retries forever is a call that never says
            // it failed.
            guard let self else { return }
            if attempt > 4 {
                let gen = self.generation
                await self.teardown(generation: gen)
                // A newer start or an End owns the phase now.
                guard self.generation == gen, !self.stopped else { return }
                self.writeContinuity()
                self.setPhase(.ended(reason: "The call dropped and could not reconnect. \(reason)"))
                return
            }
            try? await Task.sleep(for: .seconds(min(8, 1 << min(attempt, 3))))
            guard !Task.isCancelled, !self.stopped else { return }
            await self.run(generation: self.generation)
        }
    }

    // MARK: - Teardown

    /// Resources a teardown owns.  Detached synchronously so a newer start
    /// can install its own without the older task destroying them.
    private struct HeldResources {
        var cancellations: [() -> Void] = []
        var chained: ChainedVoiceEngine?
        var capture: VoiceCapture?
        var sts: (any StsSession)?
        var playback: VoicePlayback?
    }

    private func owns(_ gen: Int) -> Bool {
        generation == gen && !stopped && !Task.isCancelled
    }

    private func detach() -> HeldResources {
        let held = HeldResources(
            cancellations: cancellations,
            chained: chained,
            capture: capture,
            sts: sts,
            playback: playback
        )
        cancellations = []
        chained = nil
        capture = nil
        sts = nil
        playback = nil
        return held
    }

    private func teardown(generation gen: Int) async {
        await finish(detach(), generation: gen)
    }

    private func finish(_ held: HeldResources, generation gen: Int) async {
        held.cancellations.forEach { $0() }
        // Only the attempt that still owns the call may silence the shared
        // synthesizer or deactivate the session.  A newer attempt may
        // already be using both.
        let stillOurs = generation == gen && capture == nil && chained == nil
        held.chained?.stop(haltSharedSpeech: stillOurs)
        held.capture?.stop(deactivateSession: false)
        await held.sts?.stop()
        held.playback?.stop()
        guard generation == gen, capture == nil, playback == nil, chained == nil else { return }
        PersonalVoiceService.shared.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func fail(_ reason: String, recovery: VoiceCallRecovery) {
        // Invalidate the in-flight run first.  Otherwise a start() that is
        // still awaiting the socket can land on .listening after this
        // teardown has already decided the call failed.
        generation += 1
        let gen = generation
        runTask?.cancel()
        let held = detach()
        endTask?.cancel()
        endTask = Task { [weak self] in
            guard let self else { return }
            await self.finish(held, generation: gen)
            // A Try Again or an End that landed during teardown owns the
            // phase now.  Writing .failed here would clobber it.
            guard self.generation == gen, !self.stopped else { return }
            self.setPhase(.failed(reason: reason, recovery: recovery))
        }
    }

    /// Text continuity: the call's final lines land in the chat as one
    /// message, so ending a call never loses what was said.  Provisional
    /// lines are dropped -- only what was final counts.
    private func writeContinuity() {
        let finals = lines.filter(\.final)
        guard !finals.isEmpty else { return }
        let text = finals.map(stsLineText).joined(separator: "\n")
        Task {
            _ = await session.send(
                "On a voice call, \(botName) said:\n\(text)",
                to: chat
            )
        }
    }

    private func emitSystemLine(_ text: String) {
        lineKeys += 1
        lines = appendStsLine(lines, line: StsTranscriptLine(text: text, from: .bot, final: true), key: "call-\(lineKeys)")
    }

    private func setPhase(_ phase: VoiceCallPhase) {
        self.phase = phase
    }

    private func callPersona() -> String {
        "You are \(botName), speaking on a live voice call. Keep replies short enough to say aloud -- one or two sentences unless the caller asks for more."
    }

    private func friendlyError(_ error: Error) -> String {
        if let api = error as? APIError {
            return api.localizedDescription
        }
        return error.localizedDescription
    }

    /// Audio-session interruptions (phone call, Siri) and route changes
    /// (headphones yanked): pause capture, keep the socket.  The provider
    /// tolerates seconds of silence far better than a torn-down call.
    private func observeAudioSession() -> () -> Void {
        let center = NotificationCenter.default
        var tokens: [NSObjectProtocol] = []
        tokens.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor [weak self] in
                guard let self, !self.stopped else { return }
                let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
                if type == AVAudioSession.InterruptionType.began.rawValue {
                    self.capture?.stop(deactivateSession: false)
                } else if type == AVAudioSession.InterruptionType.ended.rawValue {
                    let capture = self.capture
                    try? await capture?.start()
                    // End may have detached this capture while permission
                    // or the engine start was in flight.  Restarting it
                    // then would leave a microphone nobody owns.
                    guard self.capture === capture, !self.stopped else {
                        capture?.stop(deactivateSession: false)
                        return
                    }
                    if self.muted { capture?.setMuted(true) }
                }
            }
        })
        tokens.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.stopped else { return }
                // Restart capture so the new route (speaker vs headphones)
                // actually carries the mic.
                let capture = self.capture
                capture?.stop(deactivateSession: false)
                try? await capture?.start()
                guard self.capture === capture, !self.stopped else {
                    capture?.stop(deactivateSession: false)
                    return
                }
                if self.muted { capture?.setMuted(true) }
            }
        })
        return {
            tokens.forEach { center.removeObserver($0) }
        }
    }
}
