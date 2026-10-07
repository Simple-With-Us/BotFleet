// On-device Apple Personal Voice integration for BotFleet companion.
//
// Uses AVFoundation's AVSpeechSynthesizer on iOS 17+ to:
//   1. Request and inspect Personal Voice authorization (TCC).
//   2. Discover user-created Personal Voices (matching `.isPersonalVoice` trait).
//   3. Speak bot replies on this device, from the utterances the harness
//      projected for speech (or the local fallback projection).
//
// A long read has to survive what a short one never meets: a synthesizer
// that cancels an utterance on its own, one that stops calling back, a
// phone call, and headphones being unplugged.  Each of those ends in a
// known state here, so `isSpeaking` (and the chat's "Stop Voice") never
// sticks.
//
// Lives in the app target because it links AVFoundation / AVFAudio.
import AVFoundation
import Combine
import CompanionCore
import SwiftUI

@MainActor
final class PersonalVoiceService: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    static let shared = PersonalVoiceService()

    @Published private(set) var authorizationStatus: AVSpeechSynthesizer.PersonalVoiceAuthorizationStatus = .notDetermined
    @Published private(set) var personalVoices: [AVSpeechSynthesisVoice] = []
    @Published private(set) var isSpeaking = false

    enum SpeakError: LocalizedError {
        case noVoice
        case stalled

        var errorDescription: String? {
            switch self {
            case .noVoice:
                return "No voice on this iPhone can read this reply.\u{00A0} Choose a voice for this iPhone in the bot's profile."
            case .stalled:
                return "Personal Voice stopped responding partway through this reply.\u{00A0} Try Read Aloud again."
            }
        }
    }

    /// What happened during one `speak`, for the caller's status and telemetry.
    struct SpeakReport {
        /// The requested Personal Voice is not on this iPhone, so another
        /// voice read the reply.
        var usedFallbackVoice = false
        /// Utterances given up on after their retries ran out.
        var skippedSegments = 0
    }

    private enum ChunkOutcome {
        case finished
        case cancelled
        case stalled
    }

    /// Replaced after a stall: a synthesizer that stopped calling back is
    /// not trusted with the next utterance.
    private var synthesizer = AVSpeechSynthesizer()
    private var chunkContinuation: CheckedContinuation<ChunkOutcome, Never>?
    private var turnGuard = SpeechTurnGuard()
    private var cancellables = Set<AnyCancellable>()

    // Progress of the utterance being spoken, for resume and the watchdog.
    private var nextRangeLocation = 0
    private var sawWordProgress = false
    private var utteranceStartedAt = Date()
    private var lastProgressAt = Date()
    private var activeLength = 0
    private var watchdog: Task<Void, Never>?

    // An audio interruption (a call, Siri, an alarm) pauses the turn.
    private var interrupted = false
    private var pausedAt: Date?
    private var interruptionWaiter: CheckedContinuation<Bool, Never>?
    /// How long a turn waits for an interruption to end before giving up.
    private static let interruptionLimit: TimeInterval = 300
    /// Attempts per utterance, counting the first.
    private static let maxAttempts = 3

    override init() {
        super.init()
        synthesizer.delegate = self
        refreshStatus()

        // Automatically reload when system voices change or user creates/deletes a voice
        NotificationCenter.default.publisher(for: AVSpeechSynthesizer.availableVoicesDidChangeNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.refreshStatus()
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in self?.handleInterruption(note) }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in self?.handleRouteChange(note) }
            .store(in: &cancellables)
    }

    /// Refresh authorization status and personal voice cache.
    func refreshStatus() {
        authorizationStatus = AVSpeechSynthesizer.personalVoiceAuthorizationStatus
        if authorizationStatus == .authorized {
            loadPersonalVoices()
        } else {
            personalVoices = []
        }
    }

    /// Prompt user for Personal Voice authorization.
    func requestAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            AVSpeechSynthesizer.requestPersonalVoiceAuthorization { status in
                Task { @MainActor [weak self] in
                    self?.authorizationStatus = status
                    if status == .authorized {
                        self?.loadPersonalVoices()
                        continuation.resume(returning: true)
                    } else {
                        self?.personalVoices = []
                        continuation.resume(returning: false)
                    }
                }
            }
        }
    }

    /// Load voices with the `.isPersonalVoice` trait.
    func loadPersonalVoices() {
        let allVoices = AVSpeechSynthesisVoice.speechVoices()
        personalVoices = allVoices.filter { $0.voiceTraits.contains(.isPersonalVoice) }
    }

    /// Returns available personal voices converted to CompanionCore `Voice` structs for UI pickers.
    var personalVoiceOptions: [Voice] {
        personalVoices.map { voice in
            Voice(
                id: PersonalVoiceContract.formattedIdentifier(voice.identifier),
                label: voice.name,
                description: "Apple Personal Voice (\(voice.language))",
                isPersonalVoice: true
            )
        }
    }

    /// Resolves an AVSpeechSynthesisVoice matching the provided identifier or name.
    func resolveVoice(for voiceId: String) -> AVSpeechSynthesisVoice? {
        let raw = PersonalVoiceContract.rawIdentifier(voiceId)
        if let direct = AVSpeechSynthesisVoice(identifier: raw), direct.voiceTraits.contains(.isPersonalVoice) {
            return direct
        }
        return personalVoices.first { $0.identifier == raw || $0.name == raw }
    }

    /// True when `voiceId` is a Personal Voice this iPhone has.  Unknown
    /// (false) until Personal Voice is authorized.
    func hasVoice(_ voiceId: String) -> Bool {
        authorizationStatus == .authorized && resolveVoice(for: voiceId) != nil
    }

    /// Speak free text (the profile preview).
    func speak(text: String, voiceId: String) async throws {
        _ = try await speak(segments: SpeechProjection.segments(fromReply: text), voiceId: voiceId)
    }

    /// Speak projected utterances with the Personal Voice `voiceId`.
    ///
    /// A Personal Voice belongs to the device that made it.  When this
    /// iPhone does not have `voiceId`, it reads with this iPhone's own
    /// Personal Voice, or the system voice, and says so in the report rather
    /// than failing silently or not at all.
    func speak(segments: [SpeechSegment], voiceId: String) async throws -> SpeakReport {
        // stop() invalidates any in-flight invocation, including one parked
        // in the retry backoff where no continuation is installed.
        stop()
        let generation = turnGuard.beginInvocation()
        var report = SpeakReport()

        if authorizationStatus == .notDetermined {
            _ = await requestAuthorization()
        }
        // A second speak() can pass this await (AgentProfileView preview
        // never calls Session.stopVoice()) and must not share this turn.
        guard turnGuard.ownsInvocation(generation) else { return report }

        let resolved = resolveVoice(for: voiceId)
        report.usedFallbackVoice = resolved == nil
        guard let targetVoice = resolved
            ?? personalVoices.first
            ?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        else { throw SpeakError.noVoice }

        let pieces = segments.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !pieces.isEmpty else { return report }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audioSession.setActive(true)
        guard turnGuard.ownsInvocation(generation) else { return report }

        isSpeaking = true
        startWatchdog(generation: generation)
        defer {
            // A newer speak() may already be the owner.  Clearing here would
            // mark that turn idle while its audio is still queued.
            if turnGuard.ownsInvocation(generation) {
                isSpeaking = false
                stopWatchdog()
            }
        }

        segmentLoop: for (index, segment) in pieces.enumerated() {
            var text = segment.text
            var attempts = 0
            while true {
                guard isSpeaking, turnGuard.ownsInvocation(generation) else { break segmentLoop }
                if interrupted {
                    // The synthesizer gave the utterance up to the
                    // interruption.  Resume where it stopped once it ends.
                    guard await waitForInterruptionEnd(),
                          isSpeaking, turnGuard.ownsInvocation(generation)
                    else { break segmentLoop }
                }
                attempts += 1
                let utterance = AVSpeechUtterance(string: text)
                utterance.voice = targetVoice
                utterance.rate = AVSpeechUtteranceDefaultSpeechRate
                utterance.postUtteranceDelay = index == pieces.count - 1 ? 0 : (segment.endsParagraph ? 0.25 : 0.05)

                let outcome = await speakChunkUtterance(utterance, generation: generation)
                if outcome == .finished { break }
                // Stopping supersedes this turn.
                guard isSpeaking, turnGuard.ownsInvocation(generation) else { break segmentLoop }

                let length = (text as NSString).length
                if outcome == .stalled {
                    VoiceTelemetry.watchdogTripped(
                        characters: length,
                        attempt: attempts,
                        sawWordProgress: sawWordProgress
                    )
                }
                let remainder = PersonalVoiceResume.remainder(of: text, nextRangeLocation: nextRangeLocation)
                if remainder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { break }
                // A cancel the interruption caused is not the synthesizer
                // failing, so it does not spend this utterance's retries.
                if interrupted && outcome == .cancelled { attempts -= 1 }
                if attempts >= Self.maxAttempts {
                    if outcome == .stalled { throw SpeakError.stalled }
                    // A synthesizer that keeps cancelling one utterance gets
                    // past it rather than ending the read; the skip is
                    // reported, not silent.
                    report.skippedSegments += 1
                    VoiceTelemetry.synthesizerGaveUp(characters: length, attempts: attempts)
                    break
                }
                text = remainder
                if !interrupted { try? await Task.sleep(nanoseconds: 50_000_000) }
            }
        }
        return report
    }

    private func speakChunkUtterance(_ utterance: AVSpeechUtterance, generation: UInt64) async -> ChunkOutcome {
        await withCheckedContinuation { continuation in
            // Do not overwrite a live continuation.  The previous model
            // stored one slot for every speak(), so a superseded call
            // resumed the new turn's waiter early or left it hanging.
            guard self.turnGuard.ownsInvocation(generation), self.chunkContinuation == nil else {
                continuation.resume(returning: .cancelled)
                return
            }
            self.chunkContinuation = continuation
            self.turnGuard.begin(utterance: utterance)
            self.nextRangeLocation = 0
            self.sawWordProgress = false
            self.activeLength = (utterance.speechString as NSString).length
            self.utteranceStartedAt = Date()
            self.lastProgressAt = self.utteranceStartedAt
            self.synthesizer.speak(utterance)
        }
    }

    /// Stop ongoing speech playback immediately.
    func stop() {
        turnGuard.supersedeInvocation()
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isSpeaking = false
        stopWatchdog()
        let cont = chunkContinuation
        chunkContinuation = nil
        cont?.resume(returning: .cancelled)
        let waiter = interruptionWaiter
        interruptionWaiter = nil
        waiter?.resume(returning: false)
    }

    // MARK: - Watchdog

    private func startWatchdog(generation: UInt64) {
        stopWatchdog()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, !Task.isCancelled, self.turnGuard.ownsInvocation(generation) else { return }
                self.checkForStall()
            }
        }
    }

    private func stopWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    private func checkForStall() {
        guard chunkContinuation != nil, !interrupted, pausedAt == nil else { return }
        let deadline = SpeechWatchdog.deadline(
            startedAt: utteranceStartedAt,
            lastProgressAt: lastProgressAt,
            utf16Length: activeLength
        )
        guard Date() > deadline else { return }
        // Do not wait for a didCancel that a wedged synthesizer may never
        // send: end the utterance here, ignore its late callbacks, and give
        // the next attempt a fresh synthesizer.
        turnGuard.stop()
        let wedged = synthesizer
        wedged.delegate = nil
        wedged.stopSpeaking(at: .immediate)
        synthesizer = AVSpeechSynthesizer()
        synthesizer.delegate = self
        let cont = chunkContinuation
        chunkContinuation = nil
        cont?.resume(returning: .stalled)
    }

    // MARK: - Audio session events

    private func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw),
              isSpeaking
        else { return }
        switch type {
        case .began:
            interrupted = true
            pausedAt = Date()
            if synthesizer.isSpeaking { synthesizer.pauseSpeaking(at: .word) }
        case .ended:
            // Only an interruption this read saw begin.  A stale end must
            // not stop a read that started after it.
            guard interrupted else { return }
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            interrupted = false
            resumeClock()
            guard options.contains(.shouldResume) else {
                // Another app kept the audio.  End the read cleanly rather
                // than leave it paused with nothing to resume it.
                stop()
                return
            }
            try? AVAudioSession.sharedInstance().setActive(true)
            if synthesizer.isPaused { synthesizer.continueSpeaking() }
            let waiter = interruptionWaiter
            interruptionWaiter = nil
            waiter?.resume(returning: true)
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard isSpeaking,
              let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
        else { return }
        // Headphones came out: never move a read to the loudspeaker.
        stop()
    }

    /// Paused time does not count against the watchdog.
    private func resumeClock() {
        guard let pausedAt else { return }
        let paused = Date().timeIntervalSince(pausedAt)
        utteranceStartedAt = utteranceStartedAt.addingTimeInterval(paused)
        lastProgressAt = Date()
        self.pausedAt = nil
    }

    /// Waits for the current interruption to end.  False when it ends
    /// without permission to resume, the turn is stopped, or it outlasts
    /// `interruptionLimit`.
    private func waitForInterruptionEnd() async -> Bool {
        guard interrupted else { return true }
        let limit = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.interruptionLimit * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            let waiter = self.interruptionWaiter
            self.interruptionWaiter = nil
            waiter?.resume(returning: false)
        }
        defer { limit.cancel() }
        let resumed = await withCheckedContinuation { continuation in
            interruptionWaiter = continuation
        }
        if !resumed && isSpeaking { stop() }
        return resumed
    }

    // MARK: - AVSpeechSynthesizerDelegate

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.turnGuard.isActive(utterance: utterance) else { return }
            self.lastProgressAt = Date()
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in
            guard let self, self.turnGuard.isActive(utterance: utterance) else { return }
            self.nextRangeLocation = characterRange.location
            self.sawWordProgress = true
            self.lastProgressAt = Date()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.turnGuard.isActive(utterance: utterance), self.pausedAt == nil else { return }
            self.pausedAt = Date()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.turnGuard.isActive(utterance: utterance) else { return }
            self.resumeClock()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.handleUtteranceOutcome(utterance, outcome: .finished)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.handleUtteranceOutcome(utterance, outcome: .cancelled)
        }
    }

    /// Complete the current chunk, ignoring callbacks for superseded
    /// utterances: a delayed didCancel from a stopped utterance must not
    /// finish the next chunk early.
    private func handleUtteranceOutcome(_ utterance: AVSpeechUtterance, outcome: ChunkOutcome) {
        guard turnGuard.finish(utterance: utterance) else { return }
        let cont = chunkContinuation
        chunkContinuation = nil
        cont?.resume(returning: outcome)
    }
}
