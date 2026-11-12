import Foundation

/// Platform-neutral result for an iOS background notification refresh.
/// The app target maps this onto `UIBackgroundFetchResult` after the
/// operation settles, so iOS is not told work finished while it is in flight.
public enum BackgroundRefreshOutcome: Equatable, Sendable {
    case newData
    case noData
    case failed
}

public enum BackgroundRefreshCoordinator {
    /// Cancel one refresh when its deadline expires.  Structured concurrency
    /// still waits for the operation to observe cancellation before returning;
    /// production callers must check cancellation before applying fetched data.
    public static func run(
        timeoutNanoseconds: UInt64,
        operation: @escaping @Sendable () async throws -> Bool
    ) async -> BackgroundRefreshOutcome {
        await withTaskGroup(of: BackgroundRefreshOutcome.self) { group in
            group.addTask {
                do {
                    return try await operation() ? .newData : .noData
                } catch {
                    return .failed
                }
            }
            group.addTask {
                do {
                    try await Task.sleep(nanoseconds: timeoutNanoseconds)
                    return .failed
                } catch {
                    return .failed
                }
            }

            let result = await group.next() ?? .failed
            group.cancelAll()
            return result
        }
    }
}

/// Navigation is a user-response effect.  Background delivery may wake and
/// hydrate the app, but it never yields a destination capable of switching
/// the active task on the paired Mac.
public enum RemoteNotificationSource: Sendable {
    case backgroundDelivery
    case userResponse
}

public extension NotificationTarget {
    static func navigationTarget(
        fromRemoteUserInfo userInfo: [AnyHashable: Any],
        source: RemoteNotificationSource
    ) -> NotificationTarget? {
        guard source == .userResponse else { return nil }
        return fromRemoteUserInfo(userInfo)
    }
}
