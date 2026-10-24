// Enable Automatic Update Checks, and the answer shape the phone's narrow
// writes share when a screen shows the outcome inline.
//
// The preference is `autoUpdate.enabled` in the harness config.  The phone
// reads it from `GET /api/config` and writes it through
// `PATCH /api/auto-update` with `{"enabled": Bool}`, because `/api/config`
// also carries API keys and the paired phone's sidecar keeps it write-closed.
import Foundation

/// `autoUpdate` in `GET /api/config`.  Absent on a harness that predates the
/// desktop updater; read `enabled` as unknown then, never as off.
public struct ConfigAutoUpdate: Codable, Hashable, Sendable {
    public var enabled: Bool?
    /// When the Mac last checked, in milliseconds since 1970.  Null until the
    /// first automatic check.
    public var lastCheckMs: Double?

    public init(enabled: Bool? = nil, lastCheckMs: Double? = nil) {
        self.enabled = enabled
        self.lastCheckMs = lastCheckMs
    }
}

/// How a narrow write from the phone ended, for a screen that says so in
/// place rather than through the app-wide alert.
public enum PhoneWriteOutcome<Value: Sendable>: Sendable {
    /// The computer took it and answered with this.
    case saved(Value)
    /// The paired Mac's BotFleet predates this route: its sidecar answers
    /// `404 no route`.  Nothing is wrong; the Mac needs an update first.
    case needsMacUpdate
    /// Refused or unreachable.  The message is written for people; nil means
    /// there is nothing worth saying (the request was cancelled, or the
    /// pairing stopped working and the app already shows that).
    case failed(String?)

    /// The outcome for a thrown error.  A 404 is the older-Mac answer; every
    /// other refusal carries the harness's own sentence.
    public static func failure(_ error: Error) -> PhoneWriteOutcome<Value> {
        if let api = error as? APIError, api.isNotFound {
            return .needsMacUpdate
        }
        return .failed(error.localizedDescription)
    }
}

extension PhoneWriteOutcome: Equatable where Value: Equatable {}
