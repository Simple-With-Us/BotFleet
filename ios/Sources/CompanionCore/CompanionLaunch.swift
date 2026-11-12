import Foundation

/// What CompanionApp does while the process is coming up, and which lane
/// each piece is allowed to use.
///
/// BOTFLEET-W is a fully blocking hang of about 2.6s to 4.5s whose sample
/// lands in UIKit's accessibility bundle load (`NSBundle` `access()`), with
/// `CompanionApp.$main` as the only in-app frame.  That sample is the main
/// thread still inside `UIApplicationMain`: keychain, app-group defaults,
/// and the saved-connection decode were running synchronously in `App.init`
/// before the run loop could drain.  The watchdog stays at 2 seconds so a
/// stall this long is still reported.
public enum CompanionLaunchWork: String, CaseIterable, Sendable {
    case liveActivityRoute
    case notificationDelegate
    case sentry
    case notificationCategories
    case voiceSessionObservers
    case pairingBlob
    case keychainToken
    case connectionDecode
    case streamConnect
    case testFlightCheck
    case notificationAuthorization
}

public enum CompanionLaunchLane: String, Sendable, Equatable {
    /// Still on the main thread inside `App.init`, before the run loop drains.
    /// Keep this list tiny.  Sentry stays here on purpose: calling
    /// `SentrySDK.start` off the main thread makes sentry-cocoa hop back to
    /// the main thread asynchronously, and the launch window would then be
    /// unwatched.
    case beforeFirstFrame
    /// File, keychain, and JSON.  Never the main thread.
    case offMainThread
    /// After the first frame has been committed, or after a background launch
    /// has yielded once so UIKit's accessibility startup can run.
    case afterFirstFrame
}

public enum CompanionLaunchSchedule {
    /// Fully blocking hang threshold.  BOTFLEET-W sits above this (about
    /// 2.6s to 4.5s).  Raising it would drop those events without making
    /// launch shorter.
    public static let appHangTimeoutInterval: TimeInterval = 2

    /// Fully blocking app hangs stay enabled.  Turning this off is how a
    /// launch stall stops being reported.
    public static let tracksFullyBlockingAppHangs = true

    public static func lane(_ work: CompanionLaunchWork) -> CompanionLaunchLane {
        switch work {
        case .liveActivityRoute, .notificationDelegate, .sentry:
            return .beforeFirstFrame
        case .pairingBlob, .keychainToken, .connectionDecode:
            return .offMainThread
        case .notificationCategories, .voiceSessionObservers, .streamConnect,
             .testFlightCheck, .notificationAuthorization:
            return .afterFirstFrame
        }
    }
}

/// A saved connection read off the main thread, before the keychain.
public struct CompanionLaunchSavedConnection: Equatable, Sendable {
    public var connection: Connection
    public var source: CompanionConnectionStore.Source
    public var data: Data

    public init(
        connection: Connection,
        source: CompanionConnectionStore.Source,
        data: Data
    ) {
        self.connection = connection
        self.source = source
        self.data = data
    }
}

public enum CompanionLaunchTokenRead: Equatable, Sendable {
    case token(String)
    case missing
    /// `message` is the keychain error text.  It is shown only when
    /// `isLocked` is false.  A locked phone uses
    /// `CompanionLaunchRestore.keychainLockedMessage` instead, so a reboot
    /// before first unlock does not look like a lost pairing.
    case unavailable(isLocked: Bool, message: String)
}

public enum CompanionLaunchRestoreDecision: Equatable, Sendable {
    case unpaired
    case connect(Connection, token: String)
    case waitForKeychain(Connection, message: String)
}

/// Pairing restore used to run inside `Session.init` on the main thread.
/// The file and JSON half lives here so a test can run it off the main
/// thread without UIKit or the keychain.
public enum CompanionLaunchRestore {
    public static let keychainLockedMessage = "Unlock this phone to reach your computer."

    /// Read and decode the pairing blob.  Safe to call off the main thread.
    /// This function does not write.  Promotion into the app group happens
    /// after the caller has checked that the launch generation is still
    /// current, so a sign-out on the main thread cannot be undone by a
    /// background copy of the blob it just deleted.
    ///
    /// A blob that does not decode is the same as no blob: the caller stays
    /// unpaired and the bytes are left where the next launch will see them.
    public static func loadDecoded(
        shared: UserDefaults? = UserDefaults(suiteName: CompanionAppGroup.suiteName),
        standard: UserDefaults = .standard
    ) -> CompanionLaunchSavedConnection? {
        guard let loaded = CompanionConnectionStore.loadConnectionData(
            shared: shared,
            standard: standard
        ) else { return nil }
        guard let connection = try? JSONDecoder().decode(Connection.self, from: loaded.data) else {
            return nil
        }
        return CompanionLaunchSavedConnection(
            connection: connection,
            source: loaded.source,
            data: loaded.data
        )
    }

    public static func decide(
        saved: Connection?,
        token: CompanionLaunchTokenRead
    ) -> CompanionLaunchRestoreDecision {
        guard let saved else { return .unpaired }
        switch token {
        case .missing:
            return .unpaired
        case .token(let token):
            return .connect(saved, token: token)
        case .unavailable(let isLocked, let message):
            let shown = isLocked ? keychainLockedMessage : message
            return .waitForKeychain(saved, message: shown)
        }
    }

    /// A notification tapped before restore finishes is replayed only when a
    /// saved pairing can still come back.  Settling unpaired drops it, so the
    /// next pair does not open a chat from a computer this phone is not
    /// connected to.  A locked keychain still retains it: that phone is
    /// paired, and the tap should land once the token can be read.
    public static func retainsQueuedNotification(
        _ decision: CompanionLaunchRestoreDecision
    ) -> Bool {
        switch decision {
        case .unpaired:
            return false
        case .connect, .waitForKeychain:
            return true
        }
    }
}
