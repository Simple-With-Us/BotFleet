import Foundation

/// The native host's administrative error types.  They are declared outside the
/// macOS-only runtime on purpose: the reason-code map is public and
/// cross-platform, so every error type it classifies has to exist and be
/// classified the same way on every supported platform.

/// A failed private control channel operation.
public enum NativeHostControlError: Error, Equatable {
    case unsafeSocket
    case socketUnavailable
    /// The host did not report a validated running state when the start was checked.
    case startNotVerified(state: String)
    /// The control channel did not answer, so the start could not be confirmed.
    case controlChannelUnreachable
}

extension NativeHostControlError {
    /// A stable, secret-free reason code for a failed control operation.
    public var reasonCode: String {
        switch self {
        case .unsafeSocket: return "unsafeSocket"
        case .socketUnavailable: return "socketUnavailable"
        case .startNotVerified(let state): return "startNotVerified:\(state)"
        case .controlChannelUnreachable: return "controlChannelUnreachable"
        }
    }
}

/// A launch request the native host refused to parse.
public enum NativeHostLaunchArgumentsError: Error {
    case invalidArguments
}

extension NativeHostLaunchArgumentsError {
    /// A stable reason code for a rejected launch request.
    public var reasonCode: String { "invalidArguments" }
}
