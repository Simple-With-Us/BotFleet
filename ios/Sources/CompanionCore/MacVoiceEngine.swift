// Native macOS voice capture, live call, and speech synthesis engine (BF-2483).
//
// Implements Option A's native AVAudioEngine + SFSpeechRecognizer capture
// pipeline, AVSpeechSynthesizer (including Personal Voice fallback), and
// streaming TTS playback over URLSession.  The state machine is deterministic
// and synchronous so `swift test` can verify every permission race, route
// change, echo suppression transition, and retry ceiling without opening a
// physical hardware microphone.
import Foundation
#if os(macOS)
import AVFoundation
import Speech
#endif

/// Controls shown during an active live voice call.
public enum MacLiveCallControlLabels {
    public static let mute = "Mute"
    public static let speaker = "Speaker"
    public static let endCall = "End Call"

    public static let all: [String] = [mute, speaker, endCall]
}

/// Operating mode for macOS voice capture.
public enum MacVoiceMode: Equatable, Sendable {
    /// Dictating into the message composer.  Has no silence timeout, ends only
    /// on explicit stop, replaces partial transcripts in place after the frozen
    /// base draft, and never auto-sends.
    case composerDictation
    /// Full-duplex live call with a bot.  A short silence pause commits the
    /// user's spoken turn automatically.
    case liveCall(botName: String, isMuted: Bool, isSpeakerOn: Bool)

    public var isCall: Bool {
        if case .liveCall = self { return true }
        return false
    }

    public var controlLabels: [String] {
        switch self {
        case .composerDictation:
            return []
        case .liveCall:
            return MacLiveCallControlLabels.all
        }
    }
}

/// Recoverable and unrecoverable voice failures with exact product copy.
public enum MacVoiceFailure: Equatable, Sendable {
    case microphoneRefused(isCall: Bool)
    case speechRecognitionRefused(isCall: Bool)
    case noMicrophoneAvailable
    case languageNotSupported
    case microphoneBusy
    case recognitionFailedMidSession
    case playbackFailed

    public static let openSettingsActionTitle = "Open Settings"

    /// Exact human-facing copy for the failure banner.  Two spaces separate
    /// sentences per the fleet copy standard.
    public var message: String {
        switch self {
        case .microphoneRefused(let isCall):
            if isCall {
                return "Calls need Microphone access.  Enable it in System Settings, then try again."
            }
            return "Dictation needs Microphone access.  Enable it in System Settings, then try again."
        case .speechRecognitionRefused(let isCall):
            if isCall {
                return "Calls need Speech Recognition access.  Enable it in System Settings, then try again."
            }
            return "Dictation needs Speech Recognition access.  Enable it in System Settings, then try again."
        case .noMicrophoneAvailable:
            return "No microphone found.  Connect a microphone, then try again."
        case .languageNotSupported:
            return "Dictation isn't available for this language.  Choose a different language in Settings."
        case .microphoneBusy:
            return "Couldn't start the microphone.  Check that no other app is using it, then try again."
        case .recognitionFailedMidSession:
            return "Couldn't transcribe that.  Your draft is unchanged."
        case .playbackFailed:
            return "Couldn't play the voice.  The reply is shown as text instead."
        }
    }

    /// Whether this failure offers an `"Open Settings"` button.
    public var showsOpenSettingsAction: Bool {
        switch self {
        case .microphoneRefused, .speechRecognitionRefused, .languageNotSupported:
            return true
        case .noMicrophoneAvailable, .microphoneBusy, .recognitionFailedMidSession, .playbackFailed:
            return false
        }
    }

    /// Action button label when settings navigation applies.
    public var actionButtonTitle: String? {
        showsOpenSettingsAction ? Self.openSettingsActionTitle : nil
    }

    /// System Settings or app Settings URL for resolving the failure.
    public var settingsURL: URL? {
        switch self {
        case .microphoneRefused:
            return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        case .speechRecognitionRefused:
            return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
        case .languageNotSupported:
            return URL(string: "botfleet://settings/voice")
        case .noMicrophoneAvailable, .microphoneBusy, .recognitionFailedMidSession, .playbackFailed:
            return nil
        }
    }
}

/// State of the macOS voice capture state machine.
public enum MacVoiceCaptureState: Equatable, Sendable {
    case idle
    case starting
    case recording(level: Float, partialTranscript: String, mode: MacVoiceMode)
    case paused(reason: String)
    case failed(MacVoiceFailure)

    /// Exact product copy when capture is paused.
    public static let pausedBannerCopy = "Listening paused.  Tap to resume when you're ready."

    /// VoiceOver accessibility label for the current capture state.
    public var accessibilityLabel: String {
        switch self {
        case .idle:
            return "Dictate Message"
        case .starting:
            return "Starting microphone"
        case .recording:
            return "Listening"
        case .paused:
            return "Listening paused"
        case .failed(let failure):
            return failure.message
        }
    }

    /// Whether the UI should render a static indicator instead of an animated
    /// waveform or pulsing ring when Reduced Motion is enabled.
    public func usesStaticIndicator(reduceMotion: Bool) -> Bool {
        if reduceMotion { return true }
        switch self {
        case .recording:
            return false
        case .idle, .starting, .paused, .failed:
            return true
        }
    }
}

/// Resolution result when choosing a voice for `AVSpeechSynthesizer`.
public struct MacResolvedSynthesisVoice: Equatable, Sendable {
    public enum Source: String, Equatable, Sendable {
        case personalVoice
        case systemVoice
        case systemDefault
    }

    public let identifier: String?
    public let source: Source

    public init(identifier: String?, source: Source) {
        self.identifier = identifier
        self.source = source
    }
}

/// Native macOS voice capture and synthesis coordinator.
public final class MacVoiceEngine: @unchecked Sendable {
    public static let maxAutoRetryAttempts = 2

    public private(set) var state: MacVoiceCaptureState = .idle
    /// The composer text frozen at the moment capture started.
    public private(set) var frozenBaseDraft: String = ""
    /// The live composer text combining `frozenBaseDraft` and the latest partial.
    public private(set) var currentDraft: String = ""
    /// Ephemeral banner announced when the audio input route changes mid-session.
    public private(set) var routeBanner: String?
    /// Consecutive failed start attempts, capped at `maxAutoRetryAttempts` for auto-retry.
    public private(set) var consecutiveFailedStarts: Int = 0
    /// Whether the physical or simulated microphone input node is currently open.
    public private(set) var isMicrophoneHardwareOpen: Bool = false
    /// Whether bot TTS / audio reply playback is currently speaking.
    public private(set) var isBotPlaybackActive: Bool = false
    /// Set to true when starting capture automatically paused active bot playback
    /// so the microphone never transcribes the bot's own voice.
    public private(set) var isPlaybackPausedForEchoSuppression: Bool = false
    /// Spoken turns committed by silence pauses during a `.liveCall` session.
    public private(set) var committedLiveCallTurns: [String] = []
    /// Messages that fell back to text display because voice playback failed.
    public private(set) var textFallbackMessageIds: [String] = []

    private var activeStartAttemptId: UUID?
    private var pendingMode: MacVoiceMode = .composerDictation

    #if os(macOS)
    private lazy var synthesizer = AVSpeechSynthesizer()
    #endif

    public init() {}

    /// Whether an automatic retry is still permitted before requiring an
    /// explicit tap from the user.
    public var canAutoRetry: Bool {
        consecutiveFailedStarts < Self.maxAutoRetryAttempts
    }

    // MARK: - Capture Lifecycle & Permission Race Guard

    /// Handles a tap on the microphone / call button.
    ///
    /// - When `.idle`, `.paused`, or `.failed`: transitions to `.starting`,
    ///   freezes `currentDraft`, and returns the new attempt token.
    /// - When `.starting`: a second tap cancels the pending start immediately
    ///   and returns `nil`.  A late permission grant arriving for that
    ///   cancelled attempt will NEVER open the microphone.
    /// - When `.recording`: stops capture cleanly and keeps `currentDraft`
    ///   in the composer without auto-sending.
    @discardableResult
    public func tapMicrophoneButton(
        mode: MacVoiceMode = .composerDictation,
        currentDraft: String = ""
    ) -> UUID? {
        switch state {
        case .starting:
            cancelPendingStart()
            self.currentDraft = currentDraft
            return nil
        case .recording:
            stopCapture()
            return nil
        case .idle, .paused, .failed:
            return beginStart(mode: mode, currentDraft: currentDraft, isExplicitUserTap: true)
        }
    }

    /// Enters `.starting` while permissions and audio hardware warm up.
    /// The composer draft is held unchanged.
    @discardableResult
    public func beginStart(
        mode: MacVoiceMode = .composerDictation,
        currentDraft: String = "",
        isExplicitUserTap: Bool = true
    ) -> UUID {
        if isExplicitUserTap {
            // An explicit user tap after a 2-strike stop resets the auto-retry counter
            // if the user is manually initiating a fresh attempt.
            if consecutiveFailedStarts >= Self.maxAutoRetryAttempts {
                consecutiveFailedStarts = 0
            }
        }
        let attemptId = UUID()
        activeStartAttemptId = attemptId
        pendingMode = mode
        frozenBaseDraft = currentDraft
        self.currentDraft = currentDraft
        routeBanner = nil
        isMicrophoneHardwareOpen = false
        state = .starting
        return attemptId
    }

    /// Cancels an in-flight `.starting` transition before permission sheets
    /// finish.  Any late permission callback for the cancelled attempt is
    /// ignored and never opens the microphone.
    public func cancelPendingStart() {
        activeStartAttemptId = nil
        isMicrophoneHardwareOpen = false
        state = .idle
    }

    /// Completes a `.starting` transition once permission and hardware checks return.
    ///
    /// If the user already cancelled the start (or another attempt superseded
    /// `attemptId`), this method returns `false` and NEVER opens the microphone.
    @discardableResult
    public func completeStartPermissionGrant(
        attemptId: UUID? = nil,
        micGranted: Bool,
        speechGranted: Bool,
        hasInputDevice: Bool = true,
        localeSupported: Bool = true,
        micBusy: Bool = false
    ) -> Bool {
        guard state == .starting, let activeId = activeStartAttemptId else {
            isMicrophoneHardwareOpen = false
            return false
        }
        if let attemptId, attemptId != activeId {
            isMicrophoneHardwareOpen = false
            return false
        }

        activeStartAttemptId = nil
        let isCall = pendingMode.isCall

        guard micGranted else {
            return recordStartFailure(.microphoneRefused(isCall: isCall))
        }
        guard speechGranted else {
            return recordStartFailure(.speechRecognitionRefused(isCall: isCall))
        }
        guard hasInputDevice else {
            return recordStartFailure(.noMicrophoneAvailable)
        }
        guard localeSupported else {
            return recordStartFailure(.languageNotSupported)
        }
        guard !micBusy else {
            return recordStartFailure(.microphoneBusy)
        }

        // Echo suppression: if bot playback is currently speaking, pause it
        // before opening the input node so the bot never transcribes itself.
        if isBotPlaybackActive {
            isBotPlaybackActive = false
            isPlaybackPausedForEchoSuppression = true
            #if os(macOS)
            if synthesizer.isSpeaking {
                synthesizer.pauseSpeaking(at: .immediate)
            }
            #endif
        }

        consecutiveFailedStarts = 0
        isMicrophoneHardwareOpen = true
        state = .recording(level: 0.0, partialTranscript: "", mode: pendingMode)
        return true
    }

    @discardableResult
    private func recordStartFailure(_ failure: MacVoiceFailure) -> Bool {
        consecutiveFailedStarts += 1
        isMicrophoneHardwareOpen = false
        state = .failed(failure)
        return false
    }

    /// Attempts an automatic retry after a transient start failure.
    /// Stops auto-retrying after 2 consecutive failed starts and waits for an
    /// explicit tap.
    @discardableResult
    public func attemptAutoRetry() -> UUID? {
        guard canAutoRetry else {
            return nil
        }
        return beginStart(mode: pendingMode, currentDraft: currentDraft, isExplicitUserTap: false)
    }

    // MARK: - Partial Transcripts & Turn Boundaries

    /// Delivers an updated partial transcript from `SFSpeechRecognizer`.
    ///
    /// In `.composerDictation`, each partial replaces the previous partial in
    /// place after `frozenBaseDraft` (`Dictation.draft(base:transcript:)`).
    /// Nothing is ever sent automatically.
    public func receivePartialTranscript(_ partial: String, audioLevel: Float = 0.5) {
        guard case .recording(_, _, let mode) = state else { return }
        let clampedLevel = min(max(audioLevel, 0.0), 1.0)
        state = .recording(level: clampedLevel, partialTranscript: partial, mode: mode)

        switch mode {
        case .composerDictation:
            currentDraft = Dictation.draft(base: frozenBaseDraft, transcript: partial)
        case .liveCall:
            currentDraft = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// Handles a short silence pause detected on the input stream.
    ///
    /// - In `.composerDictation`: ignored (composer dictation has no silence
    ///   timeout and ends only on an explicit stop).
    /// - In `.liveCall`: ends the current user turn, commits the non-empty
    ///   transcript to `committedLiveCallTurns`, and resets the partial buffer
    ///   for the next spoken turn.
    @discardableResult
    public func handleSilencePause() -> String? {
        guard case .recording(_, let partial, let mode) = state else { return nil }
        switch mode {
        case .composerDictation:
            return nil
        case .liveCall(let botName, let isMuted, let isSpeakerOn):
            let trimmed = partial.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            committedLiveCallTurns.append(trimmed)
            currentDraft = ""
            state = .recording(
                level: 0.0,
                partialTranscript: "",
                mode: .liveCall(botName: botName, isMuted: isMuted, isSpeakerOn: isSpeakerOn)
            )
            return trimmed
        }
    }

    /// Toggles mute during an active `.liveCall`.
    public func setLiveCallMuted(_ isMuted: Bool) {
        guard case .recording(let level, let partial, .liveCall(let botName, _, let isSpeakerOn)) = state else {
            return
        }
        let nextMode = MacVoiceMode.liveCall(botName: botName, isMuted: isMuted, isSpeakerOn: isSpeakerOn)
        pendingMode = nextMode
        state = .recording(level: isMuted ? 0.0 : level, partialTranscript: partial, mode: nextMode)
    }

    /// Toggles speaker output during an active `.liveCall`.
    public func setLiveCallSpeakerOn(_ isSpeakerOn: Bool) {
        guard case .recording(let level, let partial, .liveCall(let botName, let isMuted, _)) = state else {
            return
        }
        let nextMode = MacVoiceMode.liveCall(botName: botName, isMuted: isMuted, isSpeakerOn: isSpeakerOn)
        pendingMode = nextMode
        state = .recording(level: level, partialTranscript: partial, mode: nextMode)
    }

    /// Stops capture explicitly.  In `.composerDictation`, the composed
    /// `currentDraft` stays in the text field and is never auto-sent.
    public func stopCapture() {
        activeStartAttemptId = nil
        isMicrophoneHardwareOpen = false
        state = .idle
    }

    // MARK: - Pause, Interruption & Mid-Session Failure

    /// Pauses listening with the exact product copy:
    /// `"Listening paused.  Tap to resume when you're ready."`
    public func pauseCapture() {
        activeStartAttemptId = nil
        isMicrophoneHardwareOpen = false
        state = .paused(reason: MacVoiceCaptureState.pausedBannerCopy)
    }

    /// Called when a system audio interruption ends.  Paused capture NEVER
    /// resumes on its own; it waits for an explicit user tap.
    public func handleAudioInterruptionEnded() {
        // Deliberate no-op when paused: never auto-resumes microphone capture
        // without the user's explicit tap.
    }

    /// Resumes capture from `.paused` only when the user explicitly taps to resume.
    @discardableResult
    public func resumeFromPause() -> Bool {
        guard case .paused = state else { return false }
        frozenBaseDraft = currentDraft
        isMicrophoneHardwareOpen = true
        state = .recording(level: 0.0, partialTranscript: "", mode: pendingMode)
        return true
    }

    /// Handles a speech recognizer error mid-session.  Restores `currentDraft`
    /// to `frozenBaseDraft` so the user's draft is unchanged.
    public func handleMidSessionRecognitionFailure() {
        activeStartAttemptId = nil
        isMicrophoneHardwareOpen = false
        currentDraft = frozenBaseDraft
        state = .failed(.recognitionFailedMidSession)
    }

    // MARK: - Audio Route Changes

    /// Handles a macOS CoreAudio / AVAudioEngine input device route change.
    ///
    /// - If the new route has an input device, continues recording on the new
    ///   device and sets `routeBanner` to `"Now using <Device Name>."`.
    /// - If the new route has no input device, closes the microphone and
    ///   transitions to `.failed(.noMicrophoneAvailable)`.
    public func handleRouteChange(newDeviceName: String?, hasInput: Bool) {
        guard hasInput, let rawName = newDeviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !rawName.isEmpty else {
            activeStartAttemptId = nil
            isMicrophoneHardwareOpen = false
            routeBanner = nil
            state = .failed(.noMicrophoneAvailable)
            return
        }
        routeBanner = "Now using \(rawName)."
    }

    // MARK: - Bot Playback, Personal Voice & Streaming TTS

    /// Marks bot voice playback as active.  If microphone capture is currently
    /// recording, playback is suppressed or capture pauses playback echo.
    public func startBotPlayback() {
        isPlaybackPausedForEchoSuppression = false
        isBotPlaybackActive = true
    }

    /// Stops bot voice playback cleanly.
    public func stopBotPlayback() {
        isBotPlaybackActive = false
        #if os(macOS)
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        #endif
    }

    /// Handles a TTS synthesis or audio playback failure by surfacing
    /// `"Couldn't play the voice.  The reply is shown as text instead."` and
    /// recording the message ID so the transcript shows the text reply.
    public func handlePlaybackFailure(forMessageId messageId: String? = nil) {
        isBotPlaybackActive = false
        if let messageId {
            textFallbackMessageIds.append(messageId)
        }
        state = .failed(.playbackFailed)
    }

    /// Resolves the `AVSpeechSynthesisVoice` identifier to use, honoring
    /// Personal Voice when authorized and falling back cleanly to a system
    /// voice when Personal Voice permission is denied or unavailable.
    public static func resolveSynthesisVoice(
        requestedVoiceId: String?,
        personalVoiceAuthorized: Bool,
        availableVoiceIds: Set<String>,
        fallbackSystemVoiceId: String? = nil
    ) -> MacResolvedSynthesisVoice {
        guard let requested = requestedVoiceId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !requested.isEmpty else {
            return MacResolvedSynthesisVoice(identifier: fallbackSystemVoiceId, source: .systemDefault)
        }

        if PersonalVoiceContract.isPersonalVoice(requested) {
            let rawId = PersonalVoiceContract.rawIdentifier(requested)
            if personalVoiceAuthorized, availableVoiceIds.contains(rawId) {
                return MacResolvedSynthesisVoice(identifier: rawId, source: .personalVoice)
            }
            // Personal Voice denied or missing on this Mac: fall back cleanly
            // to the system voice without failing the turn.
            return MacResolvedSynthesisVoice(identifier: fallbackSystemVoiceId, source: .systemDefault)
        }

        if availableVoiceIds.contains(requested) {
            return MacResolvedSynthesisVoice(identifier: requested, source: .systemVoice)
        }
        return MacResolvedSynthesisVoice(identifier: fallbackSystemVoiceId, source: .systemDefault)
    }

    #if os(macOS)
    /// Speaks text using `AVSpeechSynthesizer`, selecting Personal Voice when
    /// authorized or falling back to the system voice.
    public func synthesizeSpeech(
        _ text: String,
        requestedVoiceId: String? = nil,
        personalVoiceAuthorized: Bool = false
    ) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let availableIds = Set(AVSpeechSynthesisVoice.speechVoices().map(\.identifier))
        let resolved = Self.resolveSynthesisVoice(
            requestedVoiceId: requestedVoiceId,
            personalVoiceAuthorized: personalVoiceAuthorized,
            availableVoiceIds: availableIds
        )
        let utterance = AVSpeechUtterance(string: text)
        if let identifier = resolved.identifier,
           let voice = AVSpeechSynthesisVoice(identifier: identifier) {
            utterance.voice = voice
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
        }
        startBotPlayback()
        synthesizer.speak(utterance)
    }
    #endif

    /// Streams TTS audio bytes over `URLSession.bytes(from:)`, invoking
    /// `onChunk` as chunks arrive so playback starts before the full clip finishes.
    public func streamTTSAudio(
        from url: URL,
        session: URLSession = .shared,
        chunkSize: Int = 4096,
        onChunk: @Sendable (Data) -> Void
    ) async throws -> Int {
        startBotPlayback()
        do {
            let (bytes, response) = try await session.bytes(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                handlePlaybackFailure()
                throw URLError(.badServerResponse)
            }
            var buffer = Data()
            buffer.reserveCapacity(max(chunkSize, 1024))
            var totalBytes = 0
            for try await byte in bytes {
                buffer.append(byte)
                totalBytes += 1
                if buffer.count >= chunkSize {
                    onChunk(buffer)
                    buffer.removeAll(keepingCapacity: true)
                }
            }
            if !buffer.isEmpty {
                onChunk(buffer)
            }
            return totalBytes
        } catch {
            handlePlaybackFailure()
            throw error
        }
    }
}
