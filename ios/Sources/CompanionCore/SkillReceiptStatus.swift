import Foundation

/// How a tool receipt should read.
///
/// Done is only a real success.  Failed is only a real failure.  Cancelled
/// or stopped is a plain Stopped.  Pending, empty, and anything else stay
/// Running, so the card never claims a result it does not have.
public enum SkillReceiptStatus: String, Sendable, Equatable {
    case running
    case success
    case failure
    case stopped

    public init(_ raw: String) {
        switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "success", "succeeded":
            self = .success
        case "error", "failed", "failure", "errored":
            self = .failure
        case "cancelled", "canceled", "stopped":
            self = .stopped
        default:
            self = .running
        }
    }

    /// The word on the badge.
    public var label: String {
        switch self {
        case .running:
            return "Running"
        case .success:
            return "Done"
        case .failure:
            return "Failed"
        case .stopped:
            return "Stopped"
        }
    }
}
