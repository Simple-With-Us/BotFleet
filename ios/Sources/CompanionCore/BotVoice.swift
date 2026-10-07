// Which voice a bot speaks with on which device.
//
// The Swift mirror of `shared/bot-voice.ts`.  A bot keeps one shared `voice`
// (every client has always written it) plus an optional per-device override
// in `voices`.  Apple Personal Voice ids are device-local, so the Mac and the
// iPhone each need their own choice; a MiniMax voice works anywhere, so either
// device can pick one for the other.
//
// Both sides assert the same cases in
// `Tests/CompanionCoreTests/Fixtures/bot-voice.json`.  Change the rules here
// and in TypeScript together, then add the case to that fixture.
import Foundation

/// A device that can speak a bot's replies.  Raw values are the wire names.
public enum SpeechDevice: String, Codable, CaseIterable, Hashable, Sendable {
    case mac
    case iphone
}

/// The stored per-device override.  A device that is absent (or blank) uses
/// the bot's shared `voice`.
public struct BotVoices: Codable, Hashable, Sendable {
    public var mac: String?
    public var iphone: String?

    public init(mac: String? = nil, iphone: String? = nil) {
        self.mac = mac
        self.iphone = iphone
    }

    public subscript(device: SpeechDevice) -> String? {
        get {
            switch device {
            case .mac: return mac
            case .iphone: return iphone
            }
        }
        set {
            switch device {
            case .mac: mac = newValue
            case .iphone: iphone = newValue
            }
        }
    }

    private enum CodingKeys: String, CodingKey { case mac, iphone }

    /// Lenient on purpose.  `Fleet` decodes bots through `Lossy`, so a throw
    /// here would drop the whole bot from the roster over one odd value.  A
    /// value that is not a string reads as no override for that device.
    public init(from decoder: Decoder) throws {
        guard let container = try? decoder.container(keyedBy: CodingKeys.self) else {
            mac = nil
            iphone = nil
            return
        }
        mac = (try? container.decodeIfPresent(String.self, forKey: .mac)) ?? nil
        iphone = (try? container.decodeIfPresent(String.self, forKey: .iphone)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(mac, forKey: .mac)
        try container.encodeIfPresent(iphone, forKey: .iphone)
    }
}

public enum BotVoice {
    /// Apple Personal Voice ids carry one of two prefixes.  Strict, like
    /// `isPersonalVoiceId` in `shared/bot-voice.ts`: case-sensitive and never
    /// trimmed, so this phone and the harness agree on every id.
    public static func isPersonalVoiceId(_ voiceId: String?) -> Bool {
        guard let voiceId, !voiceId.isEmpty else { return false }
        return voiceId.hasPrefix(PersonalVoiceContract.prefix)
            || voiceId.hasPrefix(PersonalVoiceContract.legacyPrefix)
    }

    /// The voice used on `device`: the device's own choice when it has one,
    /// otherwise the shared voice.  An empty shared voice means the workspace
    /// default and comes back as "".  No voice at all is nil.  Values come
    /// back exactly as stored.
    public static func resolve(voice: String?, voices: BotVoices?, device: SpeechDevice) -> String? {
        if let own = voices?[device], !own.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return own
        }
        return voice
    }
}

extension Bot {
    /// The voice this bot speaks with on `device`.  See `BotVoice.resolve`.
    public func voice(for device: SpeechDevice) -> String? {
        BotVoice.resolve(voice: voice, voices: voices, device: device)
    }
}

/// What a profile save sends when the person edits the per-device pickers.
///
/// Each picker shows the voice that device actually uses, so a save has to
/// turn "this is what each device should use" back into the stored shape
/// (shared `voice` plus overrides) without moving the other device.  Only
/// the device keys that change are sent, and `voices: null` is never sent.
public struct BotVoiceEdit: Equatable, Sendable {
    /// The shared voice to send, or nil to leave it alone.
    public var voice: String?
    /// The per-device keys to send, or nil to leave `voices` alone.
    public var voices: BotProfilePatch.VoicesPatch?

    public init(voice: String? = nil, voices: BotProfilePatch.VoicesPatch? = nil) {
        self.voice = voice
        self.voices = voices
    }

    public static func plan(
        sharedVoice: String?,
        voices: BotVoices?,
        iphone desiredIphone: String,
        mac desiredMac: String
    ) -> BotVoiceEdit {
        let shared = sharedVoice ?? ""
        let desired: [SpeechDevice: String] = [.iphone: desiredIphone, .mac: desiredMac]
        func current(_ device: SpeechDevice) -> String {
            BotVoice.resolve(voice: sharedVoice, voices: voices, device: device) ?? ""
        }
        func hasOverride(_ device: SpeechDevice) -> Bool {
            guard let own = voices?[device] else { return false }
            return !own.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        let changed = SpeechDevice.allCases.filter { desired[$0] != current($0) }
        guard !changed.isEmpty else { return BotVoiceEdit() }

        var patch = BotProfilePatch.VoicesPatch()
        // "Workspace default" is an empty voice.  An empty override only
        // falls back to the shared voice, so when the shared voice is set the
        // shared voice itself has to become empty, and a device that was
        // following it is pinned to what it already used.
        let needsEmptyShared = !shared.isEmpty && changed.contains { desired[$0]?.isEmpty == true }
        if needsEmptyShared {
            for device in SpeechDevice.allCases {
                let target = desired[device] ?? ""
                if target.isEmpty {
                    if hasOverride(device) { patch[device] = .clear }
                } else if voices?[device] != target {
                    patch[device] = .set(target)
                }
            }
            return BotVoiceEdit(voice: "", voices: patch.isEmpty ? nil : patch)
        }
        for device in changed {
            let target = desired[device] ?? ""
            patch[device] = target == shared ? .clear : .set(target)
        }
        return BotVoiceEdit(voices: patch.isEmpty ? nil : patch)
    }
}

// MARK: - A computer that predates per-device voices

extension BotVoiceEdit {
    /// True when the computer refused `voices` because it predates
    /// per-device voices.  The phone ships to TestFlight on its own clock, so
    /// it can be paired with an older companion sidecar, whose field
    /// allowlist answers 403 "voices can only be changed in BotFleet on your
    /// computer", or an older harness, whose strict parser answers 400
    /// "unsupported profile field: voices".  Either refuses the whole save.
    public static func isDeviceVoicesUnsupported(_ error: Error) -> Bool {
        guard case let .status(code, message)? = error as? APIError, let message else { return false }
        switch code {
        case 403: return message.hasPrefix("voices ")
        case 400: return message == "unsupported profile field: voices"
        default: return false
        }
    }

    /// The shared voice to save in place of `voices` for such a computer,
    /// which keeps one voice per bot: the iPhone's choice (what this app
    /// always wrote), or the Mac's when only the Mac changed.  Nil when
    /// neither device changed.
    public static func sharedVoiceFallback(
        sharedVoice: String?,
        voices: BotVoices?,
        iphone desiredIphone: String,
        mac desiredMac: String
    ) -> String? {
        func current(_ device: SpeechDevice) -> String {
            BotVoice.resolve(voice: sharedVoice, voices: voices, device: device) ?? ""
        }
        if desiredIphone != current(.iphone) { return desiredIphone }
        if desiredMac != current(.mac) { return desiredMac }
        return nil
    }
}
