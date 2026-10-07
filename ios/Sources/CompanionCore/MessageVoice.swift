// The answer to POST /api/threads/:t/messages/:m/audio, and how a phone
// walks the clips it promises.
//
// Server side: `server/tts/message-audio.ts`.  The rules a client has to get
// right are the ones that bit the desktop first:
//   - `onDevice: true` is the only signal to speak locally.  A progressive
//     answer with `audio: []` and `complete: false` means "not ready yet",
//     never "speak it yourself".
//   - Walk `0..<total`, not the clips that happened to be ready.
//   - A clip GET can answer 425 while the clip is still being made, and 404
//     once a job was forgotten (a restart, or a failure aged out).
import Foundation

public struct MessageVoice: Decodable, Equatable, Sendable {
    /// The clips ready when the harness answered, in order.  Possibly none.
    public var audio: [VoiceClip]
    /// The text the voice speaks (a summary or the plain reply).
    public var voiceText: String?
    /// The projected sentences the clips (or an on-device voice) follow.
    public var utterances: [String]?
    /// How many clips the whole reply has.  Absent from an older harness,
    /// which only ever answered once every clip existed.
    public var total: Int?
    public var complete: Bool?
    /// True only when the resolved voice is an Apple Personal Voice, which
    /// this device speaks itself from `utterances`.
    public var onDevice: Bool?
    public var personalVoice: Bool?
    /// The voice the harness resolved for the requested device.
    public var voice: String?

    public init(
        audio: [VoiceClip] = [],
        voiceText: String? = nil,
        utterances: [String]? = nil,
        total: Int? = nil,
        complete: Bool? = nil,
        onDevice: Bool? = nil,
        personalVoice: Bool? = nil,
        voice: String? = nil
    ) {
        self.audio = audio
        self.voiceText = voiceText
        self.utterances = utterances
        self.total = total
        self.complete = complete
        self.onDevice = onDevice
        self.personalVoice = personalVoice
        self.voice = voice
    }

    private enum CodingKeys: String, CodingKey {
        case audio, voiceText, utterances, total, complete, onDevice, personalVoice, voice
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        audio = try container.decodeIfPresent([VoiceClip].self, forKey: .audio) ?? []
        voiceText = try container.decodeIfPresent(String.self, forKey: .voiceText)
        utterances = try container.decodeIfPresent([String].self, forKey: .utterances)
        total = try container.decodeIfPresent(Int.self, forKey: .total)
        complete = try container.decodeIfPresent(Bool.self, forKey: .complete)
        onDevice = try container.decodeIfPresent(Bool.self, forKey: .onDevice)
        personalVoice = try container.decodeIfPresent(Bool.self, forKey: .personalVoice)
        voice = try container.decodeIfPresent(String.self, forKey: .voice)
    }

    /// Speak this reply on the device.  Only `onDevice` says so.
    public var speaksOnDevice: Bool { onDevice == true }

    /// How many clips to fetch.  An older harness sends no `total` because
    /// it answered only after making every clip.
    public var clipCount: Int { max(total ?? audio.count, audio.count) }
}

/// What to do after one clip GET failed.
public enum VoiceClipFetchDecision: Equatable, Sendable {
    /// Wait, then ask for the same clip again.
    case retry(after: TimeInterval)
    /// The job is gone: POST the reply again (progressive) once, then retry.
    case resume
    /// Give up on the reply.
    case fail
}

/// Bounded retries for one clip.  Every GET already waits up to 15 seconds
/// on the harness, so eight "still preparing" answers is a couple of
/// minutes for one sentence, well past any healthy synthesis.
public struct VoiceClipFetchPolicy: Equatable, Sendable {
    public static let maxNotReadyRetries = 8
    public static let maxTransportRetries = 1

    public private(set) var notReadyRetries = 0
    public private(set) var transportRetries = 0
    public private(set) var resumed = false

    public init() {}

    /// `statusCode` is nil when the request never got an answer.
    public mutating func decide(statusCode: Int?) -> VoiceClipFetchDecision {
        switch statusCode {
        case nil:
            guard transportRetries < Self.maxTransportRetries else { return .fail }
            transportRetries += 1
            return .retry(after: 1)
        case 425?:
            guard notReadyRetries < Self.maxNotReadyRetries else { return .fail }
            notReadyRetries += 1
            return .retry(after: 1)
        case 404?:
            guard !resumed else { return .fail }
            resumed = true
            return .resume
        default:
            return .fail
        }
    }
}
