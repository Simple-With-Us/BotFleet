import Foundation

/// Whether the bot's live cloud desktop can be opened from this phone.
///
/// The button used to appear for every bot whose `computers` include "cloud"
/// and whose raw `cloudBackend` was not "vps".  A bot that was never pinned
/// has no `cloudBackend` at all, so under a workspace default of "vps" it
/// still showed the button, and tapping it answered 409.  The harness
/// resolves the backend against the workspace default (`resolveCloudBackend`),
/// and now says what it resolved in `effectiveCloudBackend`; this reads that.
public enum CloudDesktopAvailability: Equatable, Sendable {
    /// The bot has no cloud computer, so there is nothing to explain.
    case notCloud
    /// Hosted Box: the live desktop exists.
    case available
    /// Cloud, but not a desktop this phone can open.  Show the reason in the
    /// place of the button.
    case unavailable(Reason)

    public enum Reason: Equatable, Sendable {
        /// The user's own server.  Its live desktop is a loopback SSH viewer
        /// on the Mac, which a phone cannot reach.
        case ownServer
        /// A backend this build has never heard of.
        case otherBackend

        /// Rendered UI copy, so the sentence gap is a real no-break space
        /// followed by a space.
        public var message: String {
            switch self {
            case .ownServer:
                return "This bot's cloud computer is your own server, which has no live desktop on the phone.\u{00A0} Open it in BotFleet on your Mac."
            case .otherBackend:
                return "This bot's cloud computer has no live desktop on the phone.\u{00A0} Open it in BotFleet on your Mac."
            }
        }
    }
}

public extension Bot {
    /// The backend this bot's cloud computer runs on.  Prefers what the
    /// harness resolved, then the stored value (a harness that predates
    /// `effectiveCloudBackend` and has no workspace default to apply), then
    /// the hosted Box that an unconfigured install uses.
    var resolvedCloudBackend: String {
        effectiveCloudBackend ?? cloudBackend ?? "box"
    }

    var cloudDesktopAvailability: CloudDesktopAvailability {
        guard computers?.contains("cloud") == true else { return .notCloud }
        switch resolvedCloudBackend {
        case "box": return .available
        case "vps": return .unavailable(.ownServer)
        default: return .unavailable(.otherBackend)
        }
    }
}
