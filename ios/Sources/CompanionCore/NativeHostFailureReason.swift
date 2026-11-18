import Foundation

/// A stable, secret-free reason for a failed native host operation.
///
/// Every code comes from a fixed set of internal cases.  A code never carries a
/// message, a path, a token or any other value that a private service root
/// could turn into a disclosure, so it is safe to write to a launchd stream, a
/// log or a control reply.  An error the host does not recognise is reported as
/// `unclassified` instead of by its description, because a description may
/// quote a path or a credential.  Every error type it classifies is declared
/// outside the macOS-only runtime, so the mapping is never platform-conditional
/// and no error type loses its code on a build that does not run the host.
public enum NativeHostFailureReason {
    public static func code(for error: any Error) -> String {
        switch error {
        case let error as NativeHeadlessHostError:
            return error.reasonCode
        case let error as DatabaseError:
            return error.reasonCode
        case let error as NativeHostControlError:
            return error.reasonCode
        case let error as NativeHostLaunchArgumentsError:
            return error.reasonCode
        default:
            return "unclassified"
        }
    }
}

extension NativeHeadlessHostError {
    /// A stable reason code for a failed host operation.
    public var reasonCode: String {
        switch self {
        case .invalidServiceRoot: return "invalidServiceRoot"
        case .unsafeServicePath: return "unsafeServicePath"
        case .ownerAlreadyRunning: return "ownerAlreadyRunning"
        case .ownerLockFailed: return "ownerLockFailed"
        case .invalidBotConfiguration: return "invalidBotConfiguration"
        case .botConfigurationIsImmutable: return "botConfigurationIsImmutable"
        case .stopped: return "stopped"
        case .reentrantShutdown: return "reentrantShutdown"
        case .stopMarkerFailed: return "stopMarkerFailed"
        }
    }
}

extension DatabaseError {
    /// A stable reason code; the underlying message is never carried.
    public var reasonCode: String {
        switch self {
        case .openFailed: return "databaseOpenFailed"
        case .executionFailed: return "databaseExecutionFailed"
        case .prepareFailed: return "databasePrepareFailed"
        case .stepFailed: return "databaseStepFailed"
        case .notFound: return "databaseNotFound"
        case .messageThreadConflict: return "databaseMessageThreadConflict"
        }
    }
}
