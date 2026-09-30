// Wire protocol and identifier formatting for Apple Personal Voice.
//
// Kept in CompanionCore (Foundation only, no AVFoundation) so parsing and
// formatting can be tested without simulator dependencies.
import Foundation

public enum PersonalVoiceContract {
    public static let prefix = "personal:"
    public static let legacyPrefix = "apple-personal:"

    /// Returns true if the voice identifier represents an Apple Personal Voice.
    public static func isPersonalVoice(_ voiceId: String?) -> Bool {
        guard let voiceId = voiceId?.trimmingCharacters(in: .whitespacesAndNewlines), !voiceId.isEmpty else {
            return false
        }
        return voiceId.hasPrefix(prefix) || voiceId.hasPrefix(legacyPrefix)
    }

    /// Formats a raw system voice identifier as a BotFleet Personal Voice reference.
    public static func formattedIdentifier(_ rawIdentifier: String) -> String {
        let trimmed = rawIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix(prefix) || trimmed.hasPrefix(legacyPrefix) {
            return trimmed
        }
        return "\(prefix)\(trimmed)"
    }

    /// Extracts the raw system voice identifier from a BotFleet Personal Voice reference.
    public static func rawIdentifier(_ voiceId: String) -> String {
        let trimmed = voiceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix(prefix) {
            return String(trimmed.dropFirst(prefix.count))
        }
        if trimmed.hasPrefix(legacyPrefix) {
            return String(trimmed.dropFirst(legacyPrefix.count))
        }
        return trimmed
    }
}
