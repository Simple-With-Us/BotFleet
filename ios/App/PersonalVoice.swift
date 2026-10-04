// On-device Apple Personal Voice integration for BotFleet companion.
//
// Uses AVFoundation's AVSpeechSynthesizer on iOS 17+ / macOS 14+ to:
//   1. Request and inspect Personal Voice authorization (TCC).
//   2. Discover user-created Personal Voices (matching `.isPersonalVoice` trait).
//   3. Directly synthesize and speak bot replies on-device with zero server latency.
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
    @Published private(set) var currentUtteranceText: String?

    private let synthesizer = AVSpeechSynthesizer()
    private enum ChunkOutcome {
        case finished
        case cancelled
    }

    private var chunkContinuation: CheckedContinuation<ChunkOutcome, Never>?
    private var turnGuard = SpeechTurnGuard()
    private var cancellables = Set<AnyCancellable>()

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

    /// Speak text aloud using a Personal Voice directly on the device.
    ///
    /// Splits long replies into natural sentence-bounded chunks to avoid
    /// on-device utterance size limits, synthesizing each chunk with per-chunk
    /// retry and smooth prosody transitions between chunks.
    func speak(text: String, voiceId: String) async throws {
        stop()

        if authorizationStatus == .notDetermined {
            _ = await requestAuthorization()
        }

        guard let targetVoice = resolveVoice(for: voiceId) ?? personalVoices.first else {
            throw APIError.transport("Apple Personal Voice '\(voiceId)' is not available or authorized.")
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let chunks = PersonalVoiceChunker.chunk(text: trimmed)
        guard !chunks.isEmpty else { return }

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audioSession.setActive(true)

        isSpeaking = true
        currentUtteranceText = trimmed

        for chunk in chunks {
            guard isSpeaking else { break }

            var attempts = 0
            let maxAttempts = 2
            var chunkSuccess = false

            while attempts < maxAttempts && !chunkSuccess && isSpeaking {
                attempts += 1
                let utterance = AVSpeechUtterance(string: chunk)
                utterance.voice = targetVoice
                utterance.rate = AVSpeechUtteranceDefaultSpeechRate
                utterance.postUtteranceDelay = 0.05

                let outcome = await speakChunkUtterance(utterance)
                switch outcome {
                case .finished:
                    chunkSuccess = true
                case .cancelled:
                    // If isSpeaking was flipped to false (explicit stop), exit immediately.
                    if !isSpeaking { break }
                    // Otherwise, an internal synthesizer error occurred; retry once before continuing.
                    if attempts < maxAttempts {
                        try? await Task.sleep(nanoseconds: 50_000_000)
                    }
                }
            }
        }

        isSpeaking = false
        currentUtteranceText = nil
    }

    private func speakChunkUtterance(_ utterance: AVSpeechUtterance) async -> ChunkOutcome {
        await withCheckedContinuation { continuation in
            self.chunkContinuation = continuation
            self.turnGuard.begin(utterance: utterance)
            self.synthesizer.speak(utterance)
        }
    }

    /// Stop ongoing speech playback immediately.
    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        turnGuard.stop()
        isSpeaking = false
        currentUtteranceText = nil
        let cont = chunkContinuation
        chunkContinuation = nil
        cont?.resume(returning: .cancelled)
    }

    // MARK: - AVSpeechSynthesizerDelegate

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
