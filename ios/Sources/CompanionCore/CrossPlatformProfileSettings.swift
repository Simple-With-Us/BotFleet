import Foundation

/// Cross-platform profile presentation rules.  Keep in sync with
/// `shared/cross-platform-profile-settings.ts`.
public enum CrossPlatformProfileSettings {
    public static let computersMacOnlyReason =
        "Computer grants can only be changed in BotFleet on your computer."

    public static let computersAutoCaption =
        "Where this bot runs is inherited from your computer (auto).  Grants you change on the computer sync here."

    public static func isPersonalVoiceId(_ voice: String?) -> Bool {
        guard let voice else { return false }
        return voice.hasPrefix("personal:") || voice.hasPrefix("apple-personal:")
    }

    public static func effectiveSpeechDevices(
        speakReplies: Bool?,
        speechDevices: [String]?
    ) -> Set<String> {
        if let speechDevices, !speechDevices.isEmpty {
            return Set(speechDevices)
        }
        if speakReplies == true { return ["mac"] }
        return []
    }

    public struct SpeechDeviceRow: Equatable, Sendable {
        public var device: String
        public var selected: Bool
        public var editable: Bool
        public var disabledReason: String?
    }

    public static func speechDeviceRow(
        device: String,
        voice: String,
        speakReplies: Bool?,
        speechDevices: Set<String>,
        agentVoiceCanSpeakOnClient: Bool,
        personalVoiceSelected: Bool
    ) -> SpeechDeviceRow {
        let selected = speechDevices.contains(device)
        var reason: String?
        if !agentVoiceCanSpeakOnClient {
            reason = "Pick a voice this agent can speak before enabling playback."
        } else if device == "mac", personalVoiceSelected {
            reason = "Personal Voice plays on this iPhone only.  Mac playback stays off while this voice is selected."
        }
        let editable = reason == nil
        return SpeechDeviceRow(
            device: device,
            selected: selected,
            editable: editable,
            disabledReason: editable ? nil : reason
        )
    }

    public struct ComputerGrantRow: Equatable, Sendable {
        public var id: String
        public var label: String
        public var selected: Bool
        public var editable: Bool
        public var disabledReason: String?
    }

    private static let computerLabels: [String: String] = [
        "local": "Local Mac desktop",
        "cloud": "Self-hosted VPS / Box",
        "vm": "Local VM",
    ]

    public static func computerGrantRows(computers: [String]?) -> [ComputerGrantRow] {
        let grantSet = Set(computers ?? [])
        return ["local", "cloud", "vm"].map { id in
            ComputerGrantRow(
                id: id,
                label: computerLabels[id] ?? id,
                selected: grantSet.contains(id),
                editable: false,
                disabledReason: computersMacOnlyReason
            )
        }
    }

    /// Profile fields the companion proxy accepts from a phone.  Mirrors
    /// `COMPANION_PROFILE_PATCH_FIELDS` in companion/src/routes.ts.
    public static let companionPatchFields: Set<String> = [
        "name", "title", "description", "notifications", "avatarUrl", "avatarCrop",
        "voice", "speakReplies", "speechDevices", "modelSelection",
    ]
}
