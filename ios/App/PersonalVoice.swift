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
    private var finishContinuation: CheckedContinuation<Void, Never>?
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

        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = targetVoice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audioSession.setActive(true)

        isSpeaking = true
        currentUtteranceText = trimmed

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            self.finishContinuation = continuation
            self.synthesizer.speak(utterance)
        }
    }

    /// Stop ongoing speech playback immediately.
    func stop() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        isSpeaking = false
        currentUtteranceText = nil
        finishContinuation?.resume()
        finishContinuation = nil
    }

    // MARK: - AVSpeechSynthesizerDelegate

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.isSpeaking = false
            self?.currentUtteranceText = nil
            self?.finishContinuation?.resume()
            self?.finishContinuation = nil
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            self?.isSpeaking = false
            self?.currentUtteranceText = nil
            self?.finishContinuation?.resume()
            self?.finishContinuation = nil
        }
    }
}
