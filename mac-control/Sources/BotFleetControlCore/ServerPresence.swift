import Foundation
import Darwin

/// What the Control app can prove about the BotFleet Server's own port.
public enum ServerPresence: Equatable {
    /// Nothing is listening on the server's port, so no server is running.
    case absent
    /// Something is listening on the server's port.
    case present
    /// The probe could not tell.
    case unknown
}

/// Asks the operating system whether anything is listening on the BotFleet
/// Server's port.
///
/// This is the honest test for "the server is not running".  An API that
/// cannot be reached proves nothing: the request may have timed out, the
/// server may be busy under load, or it may still be booting.  A port with no
/// listener behind it is proof, and only proof is enough to stop a service
/// that would otherwise be left running against a server that is not there.
public struct ServerPresenceProbe {
    /// The port the BotFleet Server listens on.
    public static let defaultPort = 8799

    private let port: Int
    private let connect: (Int) -> ServerPresence

    public init(port: Int = ServerPresenceProbe.defaultPort,
                connect: @escaping (Int) -> ServerPresence = ServerPresenceProbe.socketConnect) {
        self.port = port
        self.connect = connect
    }

    /// Whether anything is listening on the server's port.
    public func presence() -> ServerPresence { connect(port) }

    /// Waits until nothing answers on the port, and reports the last answer.
    ///
    /// `.absent` is the only answer that proves the server is gone, so it is
    /// the only one that ends the wait early.  At the deadline the last
    /// answer is returned as it was: `.present` means something still
    /// listens, and `.unknown` means the probe could not tell, which the
    /// caller must not report as a listener.
    public func waitUntilAbsent(within seconds: TimeInterval,
                                interval: TimeInterval = 2.5) async -> ServerPresence {
        let budget = seconds.isFinite ? max(seconds, 0) : 0
        let step = interval.isFinite ? min(max(interval, 0), 60) : 0
        let deadline = Date().addingTimeInterval(budget)
        while true {
            let answer = presence()
            if answer == .absent { return .absent }
            if Date() >= deadline { return answer }
            try? await Task.sleep(nanoseconds: UInt64(step * 1_000_000_000))
        }
    }

    /// Opens a loopback connection to the port.
    ///
    /// A refused connection means nothing is listening there.  An accepted
    /// one means something is, whether or not it answers.  Anything else is
    /// unknown, because an unknown answer is not evidence.
    public static func socketConnect(_ port: Int) -> ServerPresence {
        let handle = socket(AF_INET, SOCK_STREAM, 0)
        guard handle >= 0 else { return .unknown }
        defer { close(handle) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = UInt16(truncatingIfNeeded: port).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let outcome = withUnsafePointer(to: &address) { pointer -> (Int32, Int32) in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                let result = Darwin.connect(handle, sockaddrPointer,
                                            socklen_t(MemoryLayout<sockaddr_in>.size))
                return (result, result == 0 ? 0 : errno)
            }
        }
        if outcome.0 == 0 { return .present }
        if outcome.1 == ECONNREFUSED { return .absent }
        return .unknown
    }
}
