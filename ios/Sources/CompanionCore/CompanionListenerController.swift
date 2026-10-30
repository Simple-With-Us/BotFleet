import Foundation

// The native Mac app's half of BF-2511's wiring (BF-2590): who starts and
// stops the companion listener, and when.  Jay ruled on BF-2510 that the
// native Mac app hosts the companion API; `NativeCompanionServer` is the
// server, and until this file nothing in the app constructed one.
//
// The setting is off by default and stays off until the pairing contract the
// phone expects is served natively (the other half of BF-2511), so a Mac on
// main behaves exactly as it did.  Everything here is testable with a stub
// backend: no socket is opened and no desktop input happens in a test.

/// What the companion listener is doing, as the lifecycle Settings section
/// shows it.  Every case is an observation; none is a promise.
public enum CompanionListenerState: Equatable, Sendable {
    /// The setting is off, so nothing was started.
    case off
    /// A start was asked for and has not answered yet.
    case starting
    /// The listener accepted its socket.  `port` is the bound port when the
    /// backend could read it back, and `advertisedAs` the Bonjour instance
    /// name it asked for.
    case listening(port: UInt16?, advertisedAs: String?)
    /// The listener was up and was stopped on purpose.
    case stopped
    /// A start or running listener failed; `reason` is the error's own words.
    case failed(reason: String)

    /// One line for the Settings section.
    public var summary: String {
        switch self {
        case .off:
            return "Off.\u{00A0} The phone pairs with the Node harness until the native pairing contract lands (BF-2511)."
        case .starting:
            return "Starting…"
        case .listening(let port, let advertisedAs):
            var text = "Listening"
            if let port { text += " on port \(port)" }
            if let advertisedAs { text += ", advertised on this network as \(advertisedAs)" }
            return text + "."
        case .stopped:
            return "Stopped."
        case .failed(let reason):
            return "Listener failed: \(reason)"
        }
    }
}

/// How the listener announces itself on the local network, so the phone's
/// Bonjour browser (`ios/App/Discovery.swift`) finds it by name.
public struct CompanionListenerAdvertisement: Equatable, Sendable {
    /// The service type the phone browses for.
    public static let serviceType = "_botfleet._tcp"
    /// The instance name the phone shows; this Mac's own name by default.
    public var name: String

    public init(name: String) {
        self.name = name
    }
}

/// The lifecycle events the exit policy answers.
public enum CompanionListenerExitEvent: Equatable, Sendable {
    /// The app's main window closed; the app may stay in the menubar.
    case mainWindowClosed
    /// The app is quitting.
    case appTerminating
}

/// What the controller drives.  The real backend wraps one
/// `NativeCompanionServer`; tests use a stub that records calls and opens
/// nothing.
public protocol CompanionListenerBackend: Sendable {
    /// Starts the listener and answers the bound port when it can be read.
    /// Reports a later failure through this start's callback, never a newer
    /// start's callback; an intentional stop does not report a failure.
    func start(
        advertising: CompanionListenerAdvertisement?,
        onFailure: @escaping @Sendable (String) async -> Void
    ) async throws -> UInt16?
    /// Stops the listener; a stop with nothing running is not an error.
    func stop() async
}

/// Owns the companion listener's lifecycle for the native Mac app.
///
/// The listener starts at launch only when the setting is on.  Closing the
/// last window keeps the listener up when `persistOnExit` is on and stops it
/// otherwise, which is the same reading of that setting the harness shutdown
/// uses (`MacLifecycleClient.evaluateQuitAction`); quitting the app always
/// stops it, so the Bonjour registration is withdrawn cleanly rather than
/// left for the system to time out.
@MainActor
public final class CompanionListenerController {
    /// What the listener is doing now.
    public private(set) var state: CompanionListenerState = .off {
        didSet { onStateChange?(state) }
    }
    /// Whether the person turned the listener on.  Read from the policy store
    /// at construction; written by `setEnabled`.
    public private(set) var isEnabled: Bool
    /// Called on the main actor on every state change, so the session can
    /// mirror the state into its published properties.
    public var onStateChange: ((CompanionListenerState) -> Void)?

    private let backend: CompanionListenerBackend
    private let policyStore: MacPersistencePolicyStore
    private let advertisement: CompanionListenerAdvertisement?
    /// Bumped by every start and stop, so a start that finishes after a later
    /// stop cannot write a stale state over the newer one, nor a stop over a
    /// newer start.
    private var serial = 0
    /// Whether the newest request was a start or a stop, whatever has
    /// answered so far.  A start while the newest request is already a start
    /// would only restart a listener that is up, or on its way, on a new
    /// port, so it is skipped unless that start failed and this is the retry.
    private enum Request { case start, stop }
    private var newestRequest: Request?

    public init(
        backend: CompanionListenerBackend,
        policyStore: MacPersistencePolicyStore,
        advertisement: CompanionListenerAdvertisement?
    ) {
        self.backend = backend
        self.policyStore = policyStore
        self.advertisement = advertisement
        self.isEnabled = policyStore.readCompanionListenerEnabled() ?? false
    }

    /// The default advertisement: this Mac's own name, which is what the
    /// phone shows in its list of computers.  Nil when the name is unknown,
    /// so the listener still starts and simply does not advertise.  Pure, so
    /// it is callable off the main actor too.
    nonisolated public static func defaultAdvertisement(computerName: String?) -> CompanionListenerAdvertisement? {
        guard let computerName else { return nil }
        let trimmed = computerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return CompanionListenerAdvertisement(name: trimmed)
    }

    /// A deliberate app launch: starts the listener when the setting is on,
    /// and otherwise records that it is off.
    public func applyLaunch() async {
        guard isEnabled else {
            state = .off
            return
        }
        await start()
    }

    /// Turns the setting on or off, writes it down first so a launch after a
    /// crash sees the same answer, then starts or stops to match.
    public func setEnabled(_ enabled: Bool) async throws {
        try policyStore.writeCompanionListenerEnabled(enabled)
        isEnabled = enabled
        if enabled {
            await start()
        } else {
            await stop(then: .off)
        }
    }

    /// Applies the exit policy the same way the harness shutdown reads it.
    public func applyExitPolicy(_ event: CompanionListenerExitEvent, persistOnExit: Bool) async {
        switch event {
        case .appTerminating:
            await stop()
        case .mainWindowClosed:
            if MacLifecycleClient.evaluateQuitAction(persistOnExit: persistOnExit) == .shutDownServerAndVM {
                await stop()
            }
        }
    }

    /// Starts the listener and records what the backend answered, never what
    /// was hoped for.  A start while the newest request is already a start is
    /// a no-op, unless that start failed and this is the retry: a second
    /// click on the toggle must not restart a listener that is up, or about
    /// to be, on a new port.
    public func start() async {
        if newestRequest == .start {
            switch state {
            case .starting, .listening: return
            case .off, .stopped, .failed: break
            }
        }
        newestRequest = .start
        serial += 1
        let mine = serial
        state = .starting
        do {
            let port = try await backend.start(advertising: advertisement) { [weak self] reason in
                await self?.listenerFailed(reason: reason, serial: mine)
            }
            // A failure can arrive after socket readiness but before this
            // await returns, so it must not be replaced with "listening".
            guard mine == serial, case .starting = state else { return }
            state = .listening(port: port, advertisedAs: advertisement?.name)
        } catch {
            guard mine == serial, case .starting = state else { return }
            state = .failed(reason: error.localizedDescription)
        }
    }

    private func listenerFailed(reason: String, serial failedSerial: Int) {
        guard failedSerial == serial, newestRequest == .start else { return }
        switch state {
        case .starting, .listening:
            state = .failed(reason: reason)
        case .off, .stopped, .failed:
            break
        }
    }

    /// Stops the listener.  A listener that was never up keeps its state, so
    /// "off" and "could not start" are not overwritten with "stopped".
    public func stop() async {
        await stop(then: .stopped)
    }

    /// Stops the listener and, when no newer start or stop ran while the
    /// backend answered, records `outcome`: `.stopped` only when something
    /// was up, `.off` always, because the setting itself was turned off.
    private func stop(then outcome: CompanionListenerState) async {
        newestRequest = .stop
        serial += 1
        let mine = serial
        let wasUp: Bool
        switch state {
        case .listening, .starting: wasUp = true
        case .off, .stopped, .failed: wasUp = false
        }
        await backend.stop()
        guard mine == serial else { return }
        if wasUp || outcome == .off {
            state = outcome
        }
    }
}

#if canImport(Network)
/// The real backend: one `NativeCompanionServer`, built on the first start
/// from the closure the app provides, listening on the port and bind address
/// given here.
public actor NativeCompanionListenerBackend: CompanionListenerBackend {
    private let port: UInt16
    private let options: NativeCompanionServer.ListenerOptions
    private let makeServer: @Sendable () throws -> NativeCompanionServer
    private var server: NativeCompanionServer?

    /// - Parameters:
    ///   - port: the port to bind; 0 lets the system pick one.
    ///   - options: the bind address and LAN opt-in; the advertisement name is
    ///     filled in per start.
    ///   - makeServer: builds the server on first use, so the app opens no
    ///     store until the listener is actually turned on.
    public init(
        port: UInt16 = 0,
        options: NativeCompanionServer.ListenerOptions = NativeCompanionServer.ListenerOptions(),
        makeServer: @escaping @Sendable () throws -> NativeCompanionServer
    ) {
        self.port = port
        self.options = options
        self.makeServer = makeServer
    }

    public func start(
        advertising: CompanionListenerAdvertisement?,
        onFailure: @escaping @Sendable (String) async -> Void
    ) async throws -> UInt16? {
        let server: NativeCompanionServer
        if let existing = self.server {
            server = existing
        } else {
            server = try makeServer()
            self.server = server
        }
        var options = self.options
        options.advertisedName = advertising?.name
        // The server answers once the socket is ready, with the port it bound,
        // or throws the listener's own error; a loopback bind drops the
        // advertisement whatever was asked.
        return try await server.startListening(port: port, options: options, onFailure: onFailure)
    }

    public func stop() async {
        guard let server else { return }
        await server.stopListening()
    }
}
#endif
