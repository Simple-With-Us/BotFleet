// The speech-to-speech providers BotFleet can hold a key for.
//
// Portable on purpose.  This started in the App target with the session seam,
// but the call-mode rule in `StsCallMode` needs it too, and CompanionCore
// cannot see the App target -- so a type that decides whether a call runs at
// all has to live below both of them.  `StsStatus` already speaks these names
// as strings, so putting the enum next to it is where it was always headed.
import Foundation

public enum StsProviderKind: String, Hashable, Sendable, CaseIterable {
    case xai
    case gemini

    /// The realtime model each provider documents for this path.
    public var realtimeModel: String {
        switch self {
        case .xai: return "grok-voice-latest"
        case .gemini: return "gemini-3.8-live"
        }
    }
}