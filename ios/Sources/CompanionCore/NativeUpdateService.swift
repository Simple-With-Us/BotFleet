import Foundation
import Combine

public struct NativeUpdateConfiguration: Equatable, Sendable {
    public let feedURL: URL
    public let publicKey: String

    public init(feedURL: String?, publicKey: String?) throws {
        guard let feedURL, let parts = URLComponents(string: feedURL),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              let url = parts.url else { throw ConfigurationError.feedUnavailable }
        guard let publicKey, let key = Data(base64Encoded: publicKey), key.count == 32,
              key.base64EncodedString() == publicKey else { throw ConfigurationError.keyUnavailable }
        self.feedURL = url; self.publicKey = publicKey
    }

    public enum ConfigurationError: Error { case feedUnavailable, keyUnavailable }
}

public enum NativeUpdateEvent: Equatable, Sendable {
    case availabilityChanged(Bool)
    case found(version: String)
    case downloading(version: String)
    case downloaded(version: String)
    case downloadCancelled
    case finished(failureClass: String?)
}

/// Sparkle owns scheduling, download verification, installation and its own preferences.
@MainActor
public protocol NativeUpdateDriver: AnyObject {
    var canCheckForUpdates: Bool { get }
    var automaticChecksEnabled: Bool { get set }
    var checkInterval: TimeInterval { get set }
    var onEvent: ((NativeUpdateEvent) -> Void)? { get set }
    var mayPerformCheck: ((_ automatic: Bool) -> Bool)? { get set }
    func start() throws
    func checkForUpdates()
    /// Called only immediately after start; all subsequent scheduling belongs to the driver.
    func checkForUpdatesOnLaunch()
}

@MainActor
public protocol NativeUpdateStateStore {
    func load() -> Data?
    func save(_ data: Data)
}

/// Only the policy outcome is persisted here; Sparkle owns its documented preference keys.
@MainActor
public struct NativeUpdateDefaultsStore: NativeUpdateStateStore {
    private let defaults: UserDefaults
    private let key = "nativeUpdatePolicy.v1"
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func load() -> Data? { defaults.data(forKey: key) }
    public func save(_ data: Data) { defaults.set(data, forKey: key) }
}

@MainActor
public final class NativeUpdateService: ObservableObject {
    public enum State: Equatable, Sendable {
        case unavailable
        case idle
        case checking
        case available(String)
        case downloading(String)
        case downloaded(String)
        case failed
    }
    @Published public private(set) var state: State = .unavailable
    @Published public private(set) var canCheckForUpdates = false
    @Published public private(set) var automaticChecksEnabled = false

    public var statusMessage: String {
        switch state {
        case .unavailable: return "Updates are unavailable in this build."
        case .idle: return "No update check is running."
        case .checking: return "Checking for updates…"
        case .available(let version): return "Version \(version) is available."
        case .downloading(let version): return "Downloading version \(version)…"
        case .downloaded(let version): return "Version \(version) is ready to install."
        case .failed:
            return canCheckForUpdates ? "The update check failed.\u{00A0} Try Check For Updates again."
                : "Updates are currently unavailable."
        }
    }

    private var driver: (any NativeUpdateDriver)?
    private let store: any NativeUpdateStateStore
    private let now: () -> Date
    private let fingerprint: () -> String
    private var throttle: NativeUpdateThrottle
    private var activeCheck: (at: Date, fingerprint: String, automatic: Bool)?
    private var started = false
    private var running = false

    /// A missing or invalid release configuration never creates or starts a network driver.
    public init(configuration: NativeUpdateConfiguration?, store: any NativeUpdateStateStore,
                now: @escaping () -> Date = Date.init, fingerprint: @escaping () -> String,
                makeDriver: (NativeUpdateConfiguration) -> any NativeUpdateDriver) {
        self.store = store; self.now = now; self.fingerprint = fingerprint
        self.throttle = store.load().flatMap { try? JSONDecoder().decode(NativeUpdateThrottle.self, from: $0) }
            ?? NativeUpdateThrottle()
        if let configuration { driver = makeDriver(configuration) }
    }

    public func start() {
        guard !started, let driver else { return }
        started = true
        state = .unavailable
        driver.onEvent = { [weak self] in self?.receive($0) }
        driver.mayPerformCheck = { [weak self] automatic in self?.beginCheck(automatic: automatic) ?? false }
        applyInterval()
        do {
            try driver.start()
            running = true
            if state == .unavailable { state = .idle }
            canCheckForUpdates = driver.canCheckForUpdates
            automaticChecksEnabled = driver.automaticChecksEnabled
            if activeCheck == nil && automaticChecksEnabled && throttle.shouldAutoCheck(now: now(), fingerprint: fingerprint()) {
                driver.checkForUpdatesOnLaunch()
            }
        } catch {
            started = false; running = false; activeCheck = nil
            automaticChecksEnabled = false
            state = .failed; canCheckForUpdates = false
        }
    }

    /// Manual checks bypass the automatic throttle, while preserving Sparkle's busy-state guard.
    public func checkForUpdates() {
        guard running, canCheckForUpdates, driver?.canCheckForUpdates == true else { return }
        driver?.checkForUpdates()
    }

    public func setAutomaticChecksEnabled(_ enabled: Bool) {
        guard running, let driver else { return }
        driver.automaticChecksEnabled = enabled
        automaticChecksEnabled = driver.automaticChecksEnabled
    }

    private func beginCheck(automatic: Bool) -> Bool {
        guard started, activeCheck == nil, let driver else { return false }
        let stamp = now(), identity = fingerprint()
        guard !automatic || (driver.automaticChecksEnabled && throttle.shouldAutoCheck(now: stamp, fingerprint: identity)) else { return false }
        if !automatic {
            throttle.resetFailureBackoff()
            if let data = try? JSONEncoder().encode(throttle) { store.save(data) }
            applyInterval()
        }
        activeCheck = (stamp, identity, automatic)
        state = .checking
        return true
    }

    private func receive(_ event: NativeUpdateEvent) {
        // The attempt guard also admits synchronous callbacks during driver startup.
        guard started else { return }
        switch event {
        case .availabilityChanged(let allowed):
            guard running else { return }
            canCheckForUpdates = allowed
            automaticChecksEnabled = driver?.automaticChecksEnabled ?? false
        case .found(let version): state = .available(version)
        case .downloading(let version): state = .downloading(version)
        case .downloaded(let version): state = .downloaded(version)
        case .downloadCancelled: state = .idle
        case .finished(let failureClass):
            // A policy refusal never becomes a fresh attempt or extends the backoff.
            guard let activeCheck else { return }
            self.activeCheck = nil
            if activeCheck.automatic {
                throttle.recordCheck(now: activeCheck.at, fingerprint: activeCheck.fingerprint, failureClass: failureClass)
                if let data = try? JSONEncoder().encode(throttle) { store.save(data) }
            }
            applyInterval()
            if failureClass != nil { state = .failed }
            else if state == .checking { state = .idle }
        }
    }

    private func applyInterval() {
        let interval = throttle.failureStreak >= NativeUpdateThrottle.failureStreakThreshold
            ? NativeUpdateThrottle.failureBackoff : NativeUpdateThrottle.autoCheckInterval
        if driver?.checkInterval != interval { driver?.checkInterval = interval }
    }
}
