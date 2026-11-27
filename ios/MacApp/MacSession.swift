import Foundation
import SwiftUI
import AppKit
import CoreVideo
import CompanionCore
#if os(macOS)
import AppKit
import UserNotifications
#endif

public enum MacConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected(endpoint: String)
    case failed(String)

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    public var statusPillKind: MacStatusPillKind {
        switch self {
        case .connected:
            return .connected
        case .connecting:
            return .reconnecting
        case .disconnected:
            return .offline
        case .failed:
            return .error
        }
    }

    public var statusColor: Color {
        switch statusPillKind {
        case .connected: return .green
        case .reconnecting: return .yellow
        case .offline: return .gray
        case .error: return .red
        }
    }

    public var displayText: String {
        switch self {
        case .connected(let endpoint): return "Connected (\(endpoint))"
        case .connecting: return "Connecting…"
        case .disconnected: return "Disconnected"
        case .failed(let msg): return "Error: \(msg)"
        }
    }
}

public enum SidebarSelection: Hashable, Sendable {
    case bot(String)
    case room(String)
}

@MainActor
public protocol MacSessionSourceProtocol: AnyObject {
    var state: CompanionState { get }
    var status: MacConnectionStatus { get }
    var selection: SidebarSelection? { get set }
    var selectedThreadId: String? { get set }
    var activeThreadId: String? { get }
    var activeTitle: String { get }
    var activeSubtitle: String { get }
    var activeMessages: [Message] { get }
    var activeStreamingText: String? { get }
    var activeReasoningText: String? { get }
    var unreadSummary: MacUnreadBadgeSummary { get }

    func connect(host: HostRecord)
    func disconnect()
    @discardableResult
    func sendMessage(_ text: String) async -> Bool
    func stopActiveTurn() async
}

@MainActor
public final class MacSession: ObservableObject, MacSessionSourceProtocol {
    @Published public var state: CompanionState = CompanionState()
    @Published public var status: MacConnectionStatus = .disconnected
    @Published public var selection: SidebarSelection? {
        didSet {
            reconcileWaitingThreadPin()
        }
    }
    @Published public var selectedThreadId: String?
    @Published public var isSending: Bool = false
    /// True while the sidebar's add-a-bot action is waiting on the harness.
    /// The button stays disabled for exactly this interval, so a slow create
    /// cannot be double-submitted.
    @Published public private(set) var isCreatingBot: Bool = false
    /// The last fleet-action failure in the owner's words, shown in the
    /// sidebar.  Nil after any successful fleet action.
    @Published public var fleetActionErrorMessage: String?
    @Published public private(set) var host: String = "127.0.0.1"
    @Published public private(set) var port: Int = 8799
    public let servers: ServersCoordinator
    public let resources: ResourcesCoordinator

    // Lifecycle & Remote Wake state (BF-2497)
    @Published public var lifecycleSettings = MacLifecycleSettings()
    @Published public var isShuttingDownServer = false
    /// The last lifecycle-save failure, so the Settings panel can say why the
    /// toggles went back to their previous values.
    @Published public var lifecycleErrorMessage: String?

    // Server status, Local VM controls and startup policy (BF-2688, Decision 1 Option C)
    /// What `GET /api/system/control` last answered.  `nil` until the first
    /// read lands, and left in place after a failed read so the section shows
    /// the last known state beside the reason the refresh failed.
    @Published public var controlStatus: MacControlStatus?
    /// Why the last status read or VM action failed.
    @Published public var controlStatusError: String?
    @Published public var isRefreshingControlStatus = false
    @Published public var isControllingVM = false
    /// What the last VM action did, so the button is not the only witness.
    @Published public var vmActionMessage: String?
    /// The harness startup policy as the data directory's markers state it.
    @Published public var startupPolicy: MacServerLoginPolicy = .legacy
    /// Whether the installed wrapper honours the policy markers at all.  A
    /// wrapper from before the policy ignores them, and the toggle says so
    /// instead of writing files that change nothing.
    @Published public private(set) var supportsStartupPolicy = false
    /// Why the last startup-policy change failed.
    @Published public var startupPolicyErrorMessage: String?
    /// The startup-policy store for this Mac's data directory.
    public let startupPolicyStore: MacStartupPolicyStore
    /// What the last status read proved about whether the harness is up.
    ///
    /// The read's own outcome, never `controlStatus`:  a failed read keeps
    /// the last known status in place beside the reason, so the status alone
    /// would call a server that answered and has since stopped an answering
    /// one and hold the start control off for good.
    @Published public private(set) var controlPresence: MacServerPresence = .unknown
    /// The state of the installed LaunchAgent, as launchd last said it.
    @Published public private(set) var installedServerState: MacInstalledServerState?
    /// Whether a start is running, so the button waits with it instead of
    /// firing a second request the launchd fence would refuse anyway.
    @Published public private(set) var isStartingServer = false
    /// What the last start attempt did, or why the control is not offered.
    @Published public var serverStartMessage: String?
    /// The presence the last outcome was about.  An outcome is evidence about
    /// the state it was observed in; once the state moves, showing it would
    /// describe a server that is no longer there.
    @Published private var serverStartMessagePresence: MacServerPresence?

    // Native companion listener lifecycle (BF-2590, the lifecycle half of BF-2511)
    /// What the native companion listener is doing, mirrored from the
    /// controller so the Settings section observes it.
    @Published public var companionListenerState: CompanionListenerState = .off
    /// Whether the person turned the native companion listener on.  Off by
    /// default until the native pairing contract lands.
    @Published public var companionListenerEnabled: Bool = false
    /// Owns the listener's start and stop; the backend opens the app's store
    /// only on the first start, so nothing is created while the setting is off.
    public let companionListener: CompanionListenerController
    /// The concrete listener backend behind `companionListener`, kept so the
    /// Phone settings tab can open pairing windows and list devices without
    /// going through the controller's start/stop lifecycle.
    private let nativeListenerBackend: NativeCompanionListenerBackend

    // Native engine composition (sole-writer handoff from AG).  The
    // supervisor is owned here so its supervised-process count is readable
    // even before the listener first starts; the engine turns are read
    // through the listener-built runtime below.  Together they feed the
    // graceful-stop drain counters (AG busy-flag note).
    private let nativeProcessSupervisor: ProcessSupervisorActor
    private let nativeRuntimeBox: MacNativeRuntimeBox
    /// The one native runtime the listener and the chat window share
    /// (BF-2705).  It opens on first use by either, so nothing is created
    /// while neither is in use.
    private let nativeRuntimeHost: NativeMacRuntimeHost
    /// Native engine work currently in flight on the listener graph, for the
    /// server-bridge session state.  Zero until the listener first starts.
    @Published public private(set) var nativeBusy = MacNativeBusySnapshot()
    /// What the last quit-time native drain did, in the owner's words.
    @Published public private(set) var nativeDrainSummary: String?

    // CUA Live Stream & Safety state (BF-2499)
    @Published public var showCuaViewer: Bool = false
    @Published public var isCuaStreaming: Bool = false
    @Published public var cuaPixelBuffer: CVPixelBuffer?
    @Published public var cuaStatusMessage: String?
    @Published public var cuaRevocationBanner: String?

    // Phase 3: Voice, System Integration, Streaming Transcript & Settings Routing
    @Published public var voiceState: MacVoiceCaptureState = .idle
    @Published public var voiceRouteBanner: String?
    @Published public var activeSettingsSection: MacSettingsSection = .general
    @Published public var allBotsPaused: Bool = false
    /// The composer's text.  The session owns it so the menubar can compose
    /// and dictate without a view in the window being the source of truth.
    @Published public var composerDraft: String = ""
    /// Published model windows, keyed by instance and model.  Empty until a
    /// conversation asks for them.
    @Published public private(set) var modelWindows: [String: Int] = [:]
    /// Bumped whenever something asks the composer to take the keyboard.
    @Published public var composerFocusToken: Int = 0

    public let voiceEngine = MacVoiceEngine()
    public let transcriptEngine = MacTranscriptEngine()
    public let hotkeyManager = MacGlobalHotkeyManager()
    public let notificationCoordinator = MacNotificationCoordinator()
    public let capabilities = MacDesktopCapabilities()
    #if os(macOS)
    public let menubarController = MacMenubarController()
    #endif

    private var client: CompanionClient?
    /// The chat window on the native engine, set while This Mac has no Node
    /// harness installed and the native store has been read (BF-2705).
    /// Messages go here instead of to `client` while it is set.
    private var nativeChat: NativeDesktopChat?
    /// Whether the current connection is the native one, from the moment it
    /// starts, so an installed-state read does not start it twice.
    private var isNativeConnection = false
    /// Native turns the window is reading, by thread, so Stop cancels the
    /// one in the open thread.  The id keeps a finished turn from removing
    /// a newer one on the same thread.
    private var nativeTurns: [String: (id: UUID, task: Task<Void, Never>)] = [:]
    private var streamTask: Task<Void, Never>?
    private var connectionGeneration = UUID()
    private var reconnectAttempt = 0
    private let policyStore: MacPersistencePolicyStore
    /// Starts the installed harness LaunchAgent on request (BF-2700).  Its
    /// boot-session reader is injected so the app reads the real boot and a
    /// test can supply its own.
    private let serverLaunchController: MacServerLaunchController
    private let permissionMonitor: CuaPermissionMonitor
    private let cuaStatusState = CuaStatusState()
    private var hasLaunched = false
    private var didDeliberatelyStopServer = false
    private weak var mainWindow: NSWindow?
    private var mainWindowObservers: [NSObjectProtocol] = []
    private var surfaceSyncThrottle = MacSystemSurfaceSyncThrottle()
    private var waitingThreadPin = MacWaitingThreadPin()
    private var pendingSystemSurfaceSync: Task<Void, Never>?
    private var notificationAuthorizationTask: Task<Bool, Never>?
    #if os(macOS)
    private var voiceCaptureCoordinator: MacVoiceCaptureCoordinator?
    private var settingsSceneOpener: (() -> Void)?
    #endif

    public init(
        policyStore: MacPersistencePolicyStore = MacPersistencePolicyStore(),
        startupPolicyStore: MacStartupPolicyStore = MacStartupPolicyStore(),
        serverLaunchController: MacServerLaunchController? = nil,
        permissionMonitor: CuaPermissionMonitor = CuaPermissionMonitor()
    ) {
        self.policyStore = policyStore
        self.startupPolicyStore = startupPolicyStore
        self.serverLaunchController = serverLaunchController ?? MacServerLaunchController(
            store: startupPolicyStore,
            bootSession: { try startupPolicyStore.readBootSession() }
        )
        let hostStore = HostStore(fileURL: policyStore.dataDir.appendingPathComponent("hosts.json"))
        self.servers = ServersCoordinator(store: hostStore)
        self.resources = ResourcesCoordinator(store: hostStore)
        self.resources.observeHosts(from: self.servers)
        self.permissionMonitor = permissionMonitor
        if let localPersist = policyStore.readPersistOnExit() {
            self.lifecycleSettings = MacLifecycleSettings(
                allowRemoteDesktopLaunch: nil,
                persistOnExit: localPersist
            )
        }
        // BF-2511's acceptance has landed: durable device credentials
        // (digest-only `devices.json`, revocation, the fleet cap), Origin
        // rejection on every device route, and the pairing contract now
        // stand between a network peer and this listener.  So the LAN
        // opt-in and the Bonjour advertisement turn on together here —
        // and only together: both read the one explicit opt-in
        // (`OMB_COMPANION_ALLOW_CLEARTEXT_LAN`, as the Node sidecar reads
        // it), and with nothing configured the listener still binds
        // loopback and advertises nothing a phone could not connect to.
        // The listener itself also stays off until it is turned on.
        let lanPolicy = CompanionLANPolicy.read()
        let listenerOptions = NativeCompanionServer.ListenerOptions(
            allowCleartextLAN: lanPolicy.allowCleartextLAN
        )
        let advertisement = listenerOptions.allowCleartextLAN
            ? CompanionListenerController.defaultAdvertisement(computerName: Host.current().localizedName)
            : nil
        let storeURL = policyStore.dataDir
            .appendingPathComponent("native", isDirectory: true)
            .appendingPathComponent("companion.sqlite")
        // The paired fleet's durable home, beside the listener's store:
        // digests only, so a paired phone survives an app restart.
        let deviceStoreURL = storeURL.deletingLastPathComponent()
            .appendingPathComponent("devices.json")
        // Session-owned composition pieces: the supervisor is created now
        // (no disk I/O) and injected into the listener graph on first start,
        // so the session reads the one supervised-process count its drain
        // counters use.  The box ferries the built runtime back out for
        // quit-time drain; it stays empty while the setting is off, and an
        // empty box honestly reads as nothing to drain.
        let nativeProcessSupervisor = ProcessSupervisorActor()
        let nativeRuntimeBox = MacNativeRuntimeBox()
        self.nativeProcessSupervisor = nativeProcessSupervisor
        self.nativeRuntimeBox = nativeRuntimeBox
        // BF-2705: the listener and the chat window share one native runtime,
        // opened by whichever needs it first.  A store of the app's own,
        // under the Mac's data directory; where the native engine's store
        // finally lives is BF-2504's call, and this path is the provisional
        // one the BF-2590 PR named.  Workspaces are confined beside it.
        //
        // BF-2710: on the first launch with no harness plist under any label
        // it has used, the legacy `bots.json` and `messages.db` are copied
        // into that store before the stored bots register, so the window
        // opens with the bots the harness had.  Beside an installed harness
        // nothing is copied.
        let legacyImport = NativeLegacyStoreImport.forMacDataDirectory(
            policyStore.dataDir,
            harnessPlists: Self.harnessAgentLabels.map { startupPolicyStore.launchAgentPlist(label: $0) }
        )
        let nativeRuntimeHost = NativeMacRuntimeHost(prepare: { database in
            switch await legacyImport.runIfNeeded(into: database) {
            case .imported(let bots, let threads, let messages, let parityVerified):
                NSLog(
                    "BF-2710: imported %ld bots, %ld threads and %ld messages from the legacy store (parity %@)",
                    bots, threads, messages, parityVerified ? "verified" : "NOT verified"
                )
            case .failed(let reason):
                NSLog("BF-2710: the legacy store import failed and will be tried again next launch: %@", reason)
            case .skipped:
                break
            }
        }) {
            try FileManager.default.createDirectory(
                at: storeURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let database = try DatabaseService(path: storeURL.path)
            let workspacesRoot = storeURL.deletingLastPathComponent()
                .appendingPathComponent("workspaces", isDirectory: true)
            let macRuntime = NativeMacCompanionRuntime(
                database: database,
                workspacesRoot: workspacesRoot,
                processSupervisor: nativeProcessSupervisor,
                credentials: DatabaseCliLoginCredentials(database: database)
            )
            nativeRuntimeBox.store(macRuntime)
            return (database, macRuntime)
        }
        self.nativeRuntimeHost = nativeRuntimeHost
        // BF-2690: the action behind the phone's "Open on Mac".  It brings the
        // app forward without reading the session, so it is given here, before
        // the session exists.  The gate it sits behind is mirrored from the
        // owner's Mac settings by `mirrorDesktopLaunchGate`.
        let backend = NativeCompanionListenerBackend(
            port: 0,
            options: listenerOptions,
            desktopLaunch: CompanionDesktopLaunchWiring(
                onDesktopOpen: { await MacSession.bringApplicationForward() }
            )
        ) { desktopLaunch in
            // Inject the shared native runtime so the wait routes serve
            // instead of answering 503.  The server retains the runtime (and
            // through it the graph's actors); the listener stays default-off
            // and stop stays socket-only.
            let opened = try nativeRuntimeHost.open()
            let database = opened.database
            let macRuntime = opened.runtime
            // BF-2689 composition: the host registered every stored bot that
            // derives a native profile, with its real driver, so satisfied
            // waits dispatch instead of holding unclaimed.  Registration is
            // best-effort per bot — a bot that cannot register stays
            // admission-held and is named in the log, never substituted.
            Task {
                let report = await opened.registration.value
                if let loadFailure = report.loadFailure {
                    NSLog("BF-2689: stored bots could not be loaded for native registration: %@", loadFailure)
                }
                for skip in report.skipped {
                    NSLog("BF-2689: bot %@ not registered natively: %@", skip.botId, skip.reason)
                }
            }
            return NativeCompanionServer(
                database: database,
                deviceStoreURL: deviceStoreURL,
                config: CompanionServerConfig(
                    allowRemoteDesktopLaunch: desktopLaunch.allowRemoteDesktopLaunch
                ),
                nativeRuntime: macRuntime.runtime,
                onDesktopOpen: desktopLaunch.onDesktopOpen
            )
        }
        self.companionListener = CompanionListenerController(
            backend: backend,
            policyStore: policyStore,
            advertisement: advertisement
        )
        self.companionListenerEnabled = self.companionListener.isEnabled
        self.nativeListenerBackend = backend
        self.companionListener.onStateChange = { [weak self] state in
            self?.companionListenerState = state
        }
        // Registering the notification categories is not asking for
        // permission:  the permission prompt stays lazy, at the first event
        // that actually needs the person.
        MacNotificationCenter.registerCategories()
    }

    public var unreadSummary: MacUnreadBadgeSummary {
        MacUnreadBadgeSummary.from(state: state)
    }

    public var menubarState: MacMenubarState {
        #if os(macOS)
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #else
        let reduceMotion = false
        #endif
        return MacMenubarState.from(
            state: state,
            isConnected: status.isConnected,
            allBotsPaused: allBotsPaused,
            reduceMotion: reduceMotion
        )
    }

    public var selectedBotId: String? {
        get {
            if case .bot(let id) = selection { return id }
            return nil
        }
        set {
            if let id = newValue {
                selection = .bot(id)
            } else if case .bot = selection {
                selection = nil
            }
        }
    }

    public var selectedRoomId: String? {
        get {
            if case .room(let id) = selection { return id }
            return nil
        }
        set {
            if let id = newValue {
                selection = .room(id)
            } else if case .room = selection {
                selection = nil
            }
        }
    }

    public var activeBot: Bot? {
        if let id = selectedBotId {
            return state.bots.first(where: { $0.id == id })
        }
        if selection == nil {
            return state.bots.first
        }
        return nil
    }

    public var activeRoom: Room? {
        guard let id = selectedRoomId else { return nil }
        return state.rooms.first(where: { $0.id == id })
    }

    public var activeTitle: String {
        if let bot = activeBot { return bot.name }
        if let room = activeRoom { return room.name }
        return "BotFleet"
    }

    public var activeSubtitle: String {
        if let bot = activeBot { return bot.modelSelection.model }
        if let room = activeRoom { return "\(room.memberIds.count) members" }
        return ""
    }

    public var activeThreadId: String? {
        if let selected = selectedThreadId { return selected }
        if let room = activeRoom { return room.threadId }
        return activeBot?.threadId
    }

    public var activeMessages: [Message] {
        guard let threadKey = activeThreadId else { return [] }
        return state.messages[threadKey] ?? []
    }

    public var activeStreamingText: String? {
        guard let threadKey = activeThreadId else { return nil }
        return state.streaming[threadKey]
    }

    public var activeReasoningText: String? {
        guard let threadKey = activeThreadId else { return nil }
        return state.reasoning[threadKey]
    }

    // MARK: - Voice & System Sync

    /// Handles a tap on the composer's microphone button.
    ///
    /// The returned text is what the composer should show afterwards.  A
    /// cancelled pending start keeps the caller's draft verbatim, because the
    /// engine's frozen snapshot predates anything typed while the microphone
    /// was warming up.
    public func toggleComposerDictation(currentDraft: String) -> String {
        let outcome = voiceEngine.tapMicrophoneButtonReportingOutcome(
            mode: .composerDictation,
            currentDraft: currentDraft
        )
        switch outcome {
        case .startedCapture(let attemptId):
            Task { @MainActor in
                await startComposerCapture(attemptId: attemptId)
            }
        case .stoppedCapture:
            stopVoiceCapture()
        case .cancelledPendingStart:
            break
        }
        voiceState = voiceEngine.state
        voiceRouteBanner = voiceEngine.routeBanner
        return voiceEngine.composerDraftAfterTap(incomingDraft: currentDraft)
    }

    /// Asks the system for microphone and speech access, then completes the
    /// attempt the engine is waiting on and opens the capture stack.
    private func startComposerCapture(attemptId: UUID) async {
        #if os(macOS)
        let outcome = await MacVoiceCaptureCoordinator.requestPermissions()
        let opened = voiceEngine.completeStartPermissionGrant(
            attemptId: attemptId,
            micGranted: outcome.micGranted,
            speechGranted: outcome.speechGranted,
            hasInputDevice: outcome.hasInputDevice,
            localeSupported: outcome.localeSupported,
            micBusy: outcome.micBusy
        )
        voiceState = voiceEngine.state
        voiceRouteBanner = voiceEngine.routeBanner
        guard opened else { return }

        let coordinator = MacVoiceCaptureCoordinator(
            onPartialTranscript: { [weak self] partial, level in
                Task { @MainActor in
                    guard let self else { return }
                    self.voiceEngine.receivePartialTranscript(partial, audioLevel: level)
                    self.voiceState = self.voiceEngine.state
                    // The composer is live while dictation runs:  the
                    // partials stream into it, exactly like the Electron
                    // composer, which shows the text typed before the
                    // microphone went on and then the latest partial.
                    if let liveDraft = self.voiceEngine.liveComposerDraft {
                        self.composerDraft = liveDraft
                    }
                }
            },
            onRecognitionEnded: { [weak self] end in
                Task { @MainActor in
                    guard let self else { return }
                    self.handleVoiceCaptureEnded(end)
                }
            }
        )
        voiceCaptureCoordinator = coordinator
        if !coordinator.start() {
            voiceEngine.handleMidSessionRecognitionFailure()
            voiceState = voiceEngine.state
        }
        #else
        _ = attemptId
        #endif
    }

    /// Leaves the recording state when the capture stack ends on its own.
    ///
    /// A recognizer that fails or finishes closes the microphone without a
    /// tap, so the session has to hear about it:  otherwise the composer
    /// keeps showing a recording that no longer exists.
    private func handleVoiceCaptureEnded(_ end: MacVoiceCaptureEnd) {
        voiceCaptureCoordinator = nil
        voiceEngine.handleCaptureEnded(end)
        voiceState = voiceEngine.state
        switch end {
        case .recognitionFailed:
            // A failed recognition restores the text the user had before
            // dictating, so a half-transcribed fragment never stays behind
            // as if it were what they said.
            composerDraft = voiceEngine.currentDraft
        case .completed:
            // The final transcript is already in the composer;  the engine
            // only stops.
            break
        }
    }

    /// Closes the microphone and stops recognition.
    private func stopVoiceCapture() {
        #if os(macOS)
        voiceCaptureCoordinator?.stop()
        voiceCaptureCoordinator = nil
        #endif
    }

    /// Routes a `botfleet://settings/...` deep link and presents Settings.
    public func routeSettingsDeepLink(_ url: URL) {
        if let section = MacSettingsDeepLinkRouter.section(for: url) {
            activeSettingsSection = section
            presentSettingsScene()
        }
    }

    #if os(macOS)
    /// Registers SwiftUI's `@Environment(\.openSettings)` action so every
    /// programmatic Settings trigger opens the native macOS 14+ `Settings`
    /// scene instead of relying on removed AppKit selectors.
    public func registerSettingsSceneOpener(_ opener: @escaping () -> Void) {
        settingsSceneOpener = opener
    }
    #endif

    /// Presents the app's Settings scene.
    public func presentSettingsScene() {
        #if os(macOS)
        NSApp.activate(ignoringOtherApps: true)
        if let opener = settingsSceneOpener {
            opener()
            if Self.settingsWindowIsPresent {
                Self.focusSettingsWindowIfPresent()
                return
            }
            // SwiftUI presents the Settings scene asynchronously, so a
            // window missing in this same runloop turn may still be on its
            // way.  Verify on the next main-queue turn; only discard the
            // opener and fall through to the AppKit fallbacks if the window
            // is still absent then.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if Self.settingsWindowIsPresent {
                    Self.focusSettingsWindowIfPresent()
                } else {
                    self.settingsSceneOpener = nil
                    self.presentSettingsViaAppKitFallbacks()
                }
            }
            return
        }
        presentSettingsViaAppKitFallbacks()
        #endif
    }

    #if os(macOS)
    private static var settingsWindowIsPresent: Bool {
        NSApp.windows.contains { $0.identifier?.rawValue == "com_apple_SwiftUI_Settings_window" }
    }

    /// The AppKit fallback chain for presenting Settings when no SwiftUI
    /// scene opener produced a window: the main-menu Settings item first,
    /// then the legacy `showSettingsWindow:` / `showPreferencesWindow:`
    /// selectors.
    private func presentSettingsViaAppKitFallbacks() {
        if Self.triggerMainMenuSettingsItem() {
            Self.focusSettingsWindowIfPresent()
            return
        }
        let settingsSelector = NSSelectorFromString("showSettingsWindow:")
        if NSApp.sendAction(settingsSelector, to: nil, from: nil) {
            Self.focusSettingsWindowIfPresent()
            return
        }
        let preferencesSelector = NSSelectorFromString("showPreferencesWindow:")
        _ = NSApp.sendAction(preferencesSelector, to: nil, from: nil)
        Self.focusSettingsWindowIfPresent()
    }
    #endif

    #if os(macOS)
    private static func triggerMainMenuSettingsItem() -> Bool {
        guard let appMenu = NSApp.mainMenu?.items.first?.submenu else {
            return false
        }
        let relevantModifiers: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
        guard let index = appMenu.items.firstIndex(where: { item in
            item.isEnabled
                && item.keyEquivalent == ","
                && item.keyEquivalentModifierMask.intersection(relevantModifiers) == .command
        }) else {
            return false
        }
        appMenu.performActionForItem(at: index)
        // Report success only when a Settings window actually opened; a
        // menu item that handles the action without opening Settings must
        // not suppress the selector fallbacks in the caller.
        return Self.settingsWindowIsPresent
    }

    private static func focusSettingsWindowIfPresent() {
        let focus = {
            if let settingsWindow = NSApp.windows.first(where: { window in
                window.identifier?.rawValue == "com_apple_SwiftUI_Settings_window"
            }) {
                settingsWindow.makeKeyAndOrderFront(nil)
            }
        }
        focus()
        DispatchQueue.main.async(execute: focus)
    }
    #endif

    /// Opens the app's Settings on the section that resolves a voice failure,
    /// and the system privacy pane when the failure needs one.
    public func openSettingsForVoiceFailure(_ failure: MacVoiceFailure) {
        activeSettingsSection = MacSettingsDeepLinkRouter.section(forVoiceFailure: failure)
        // Only the system privacy panes are opened externally.  The app's own
        // deep link is presented as the Settings scene, because the URL scheme
        // is not guaranteed to be registered.
        if let url = failure.settingsURL, url.scheme == "x-apple.systempreferences" {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #endif
        }
        presentSettingsScene()
    }

    // MARK: - Menubar Actions

    /// Brings the main window forward.
    public func activateMainWindow() {
        Self.bringApplicationForward()
    }

    /// The AppKit half of bringing the app forward.  It reads `NSApp` and its
    /// windows, never the session, so the companion listener's desktop-launch
    /// action (BF-2690) can run it without holding a session: the phone's
    /// "Open on Mac" and the menubar bring the same window forward the same
    /// way.
    static func bringApplicationForward() {
        #if os(macOS)
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.isVisible }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            NSApp.sendAction(NSSelectorFromString("reopen:"), to: nil, from: nil)
        }
        #endif
    }

    /// Brings the main window forward and puts the keyboard in the composer.
    public func focusComposer() {
        activateMainWindow()
        composerFocusToken &+= 1
    }

    /// Dictates a message from the menubar.
    public func beginMenubarDictation() {
        activateMainWindow()
        composerDraft = toggleComposerDictation(currentDraft: composerDraft)
    }

    /// Selects a bot that is waiting for the person.
    public func selectWaitingBot(_ item: MacWaitingBotItem) {
        selectedBotId = item.id
        waitingThreadPin.pin(threadId: item.threadId, botId: item.id)
        selectedThreadId = item.threadId
        activateMainWindow()
    }

    /// Drops a menubar thread pin once the sidebar selection moves on.
    ///
    /// The menubar pins the thread it opened, so a later sidebar pick has
    /// to release it:  otherwise the transcript on screen stays on the
    /// thread the menubar picked while the sidebar shows another bot.
    private func reconcileWaitingThreadPin() {
        if waitingThreadPin.dropIfSelectionMoved(toBotId: selectedBotId) {
            selectedThreadId = nil
            return
        }
        // A thread picked under another bot must not stay active when the
        // sidebar moves to a different bot: `activeThreadId` prefers the
        // picked thread, so without this the transcript keeps showing the
        // previous bot's conversation under the new bot's name.  The picked
        // thread survives only while it is the selected bot's own main
        // thread or the thread the menubar pinned for that bot.  A selected
        // bot the roster does not know (deleted, or a pick carried over
        // from before a reconnect) keeps no pick either: every legitimate
        // in-session pick is made while its bot is in the roster or pinned
        // for it, so an unknown bot means the pick is stale, not pending.
        if case .bot(let botId) = selection, let picked = selectedThreadId {
            let bot = state.bots.first(where: { $0.id == botId })
            let keepsPick = bot.map { picked == $0.threadId } ?? false
                || waitingThreadPin.threadId == picked
                || (bot == nil && waitingThreadPin.botId == botId)
            if !keepsPick {
                selectedThreadId = nil
            }
        }
    }

    /// Pauses or resumes every bot.
    public func togglePauseResumeAll() {
        allBotsPaused.toggle()
    }

    /// Opens the app's Settings.
    public func openSettings() {
        presentSettingsScene()
    }

    // MARK: - Notifications

    /// Turns a harness notify frame into the candidate event the coordinator
    /// evaluates.  Routine progress and normal completions never notify.
    private func handleNotificationFrame(_ notification: NotificationFrame) {
        let event = MacCandidateNotificationEvent(notificationFrame: notification)
        guard event.requiresPersonAttention else {
            _ = notificationCoordinator.handleEvent(event)
            return
        }
        Task { @MainActor [weak self] in
            await self?.deliverNotification(event)
        }
    }

    /// Asks the system for notification permission at the first blocking event,
    /// then delivers the notification.
    private func deliverNotification(_ event: MacCandidateNotificationEvent) async {
        if !notificationCoordinator.hasRequestedPermission {
            let granted = await requestNotificationAuthorization()
            notificationCoordinator.applyResolvedPermission(granted)
        }
        let decision = notificationCoordinator.handleEvent(event)
        if case .deliver(let payload) = decision {
            MacNotificationCenter.submit(payload)
        }
    }

    /// Requests notification authorization from the system, once.
    private func requestNotificationAuthorization() async -> Bool {
        if let task = notificationAuthorizationTask {
            return await task.value
        }
        let task = Task<Bool, Never> {
            await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                UNUserNotificationCenter.current().requestAuthorization(
                    options: [.alert, .sound, .badge]
                ) { granted, _ in
                    continuation.resume(returning: granted)
                }
            }
        }
        notificationAuthorizationTask = task
        return await task.value
    }

    private func syncSystemSurfaces(force: Bool = false) {
        let now = Date()
        switch surfaceSyncThrottle.action(for: now, force: force) {
        case .scheduleDeferred:
            scheduleDeferredSystemSurfaceSync()
        case .syncNow:
            // A forced rebuild replaces the pending deferred one:  the
            // surfaces are current, so the deferred rebuild would only
            // repeat it with older state.
            pendingSystemSurfaceSync?.cancel()
            pendingSystemSurfaceSync = nil
            surfaceSyncThrottle.recordSync(at: now)
            performSystemSurfaceSync()
        }
    }

    /// Rebuilds the surfaces once the throttle window has passed, so the last
    /// frame of a burst is never dropped.
    private func scheduleDeferredSystemSurfaceSync() {
        guard pendingSystemSurfaceSync == nil else { return }
        pendingSystemSurfaceSync = Task { @MainActor [weak self] in
            let nanoseconds = UInt64(MacSystemSurfaceSyncPolicy.minimumInterval * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard let self, !Task.isCancelled else { return }
            self.pendingSystemSurfaceSync = nil
            // The deferred rebuild advances the throttle too:  without this
            // the next frame would schedule another rebuild immediately.
            self.surfaceSyncThrottle.recordSync(at: Date())
            self.performSystemSurfaceSync()
        }
    }

    private func performSystemSurfaceSync() {
        notificationCoordinator.activeOnScreenThreadId = activeThreadId
        #if os(macOS)
        menubarController.apply(menubarState)
        NSApplication.shared.dockTile.badgeLabel = unreadSummary.dockBadgeLabel
        #endif
    }

    /// Connects to the local harness.
    ///
    /// A reconnect never clears the deliberate-stop sentinel: the marker is the
    /// only thing keeping the launchd `StartInterval` tick from resurrecting a
    /// harness the operator stopped on purpose.  Only `launch()` clears it.
    public func connect() {
        guard servers.isLoaded, let local = servers.hosts.first(where: \.isLocal) else { return }
        connect(host: local)
    }

    public func connect(host record: HostRecord) {
        // Remote enrollment does not opt the app into remote chat or actions.
        guard record.isLocal, let connection = try? record.companionConnection() else {
            status = .failed("Choose This Mac to connect.")
            return
        }
        self.host = connection.host
        self.port = connection.port
        disconnect()

        // BF-2705: with the Node harness's LaunchAgent gone nothing listens
        // where the client would connect, so This Mac's chat runs on the
        // native engine instead.  Only then: beside an installed harness
        // the native runtime must not answer the harness's bots.
        if harnessIsUninstalled {
            connectNative(record: record)
            return
        }

        if didDeliberatelyStopServer {
            // The harness was deliberately stopped in this session, so a
            // reconnect would only hammer a server that is meant to stay down.
            status = .failed("Server was deliberately stopped.\u{00A0} Start the harness to reconnect.")
            return
        }

        status = .connecting

        // Local loopback does not require a bearer token in dev mode
        let client = CompanionClient(connection: connection, token: nil, hostOrigin: record.origin)
        self.client = client
        servers.connectedRecordID = record.id
        let generation = connectionGeneration

        streamTask = Task { [weak self] in
            await self?.runConnectionLoop(client: client, endpoint: record.origin.url.absoluteString, generation: generation)
        }
    }

    /// Called once when the desktop app is deliberately launched.
    ///
    /// The launch clears the deliberate-stop sentinel so the launchd wrapper is
    /// allowed to start or supervise the harness again.
    public func launch() {
        guard !hasLaunched else { return }
        hasLaunched = true
        _ = try? policyStore.clearStoppedMarker(for: .appLaunch)
        // The native companion listener starts with the app when the
        // setting is on; off by default, so this is a no-op today.
        //
        // The lifecycle settings are read before the listener starts, so the
        // desktop-launch gate the listener's server is built with is the
        // grant the owner actually stored.  A listener that opened its socket
        // first would answer `403` to the phone's "Open on Mac" until the
        // next settings round-trip, which reads as a broken button rather
        // than as a setting that has not been read yet.
        Task { @MainActor [weak self] in
            await self?.refreshLifecycleSettings()
            self?.refreshStartupPolicy()
            //  launchd is asked at launch and not only from the connection's
            //  callback:  a harness that is down never hydrates, so the start
            //  control would otherwise stay unofferable in the one case it
            //  exists for.
            await self?.refreshInstalledServerState()
            await self?.companionListener.applyLaunch()
        }
        let generation = connectionGeneration
        Task { [weak self] in
            guard let self else { return }
            await MacLocalConnectionBootstrap.run(
                loadHosts: {
                    await self.servers.load()
                    return self.servers.isLoaded ? self.servers.hosts : nil
                },
                isCurrent: { self.connectionGeneration == generation && !self.didDeliberatelyStopServer },
                connect: { self.connect(host: $0) }
            )
        }
    }

    /// Turns the native companion listener on or off from Settings.  The
    /// setting is written before the listener moves, and a refusal is shown
    /// on the same line the other lifecycle toggles use.
    public func setCompanionListenerEnabled(_ enabled: Bool) async {
        do {
            try await companionListener.setEnabled(enabled)
            companionListenerEnabled = companionListener.isEnabled
            lifecycleErrorMessage = nil
        } catch {
            companionListenerEnabled = companionListener.isEnabled
            lifecycleErrorMessage = "The companion listener setting could not be saved: \(error.localizedDescription)"
        }
        await refreshNativeBusyState()
    }

    // MARK: - Native Engine Composition (drain counters + graceful stop)

    /// Reads the current native busy snapshot for the server-bridge session
    /// state: engine turns from the listener graph's coordinator and
    /// supervised processes from the session-owned supervisor.  Zero while
    /// the listener has never started.
    public func refreshNativeBusyState() async {
        let engineTurns = await nativeRuntimeBox.runtime?.activeEngineTurnCount() ?? 0
        let processes = await nativeProcessSupervisor.activeProcessCount()
        nativeBusy = MacNativeBusySnapshot(engineTurns: engineTurns, supervisedProcesses: processes)
    }

    /// Reads the snapshot without publishing it, for the drain path.
    private func readNativeBusySnapshot() async -> MacNativeBusySnapshot {
        let engineTurns = await nativeRuntimeBox.runtime?.activeEngineTurnCount() ?? 0
        let processes = await nativeProcessSupervisor.activeProcessCount()
        return MacNativeBusySnapshot(engineTurns: engineTurns, supervisedProcesses: processes)
    }

    /// Bounded graceful drain of the native runtime for app termination.
    ///
    /// Fences admission first so the bounded wait converges, waits for the
    /// in-flight native turns and processes to settle, then runs the
    /// terminal runtime shutdown which stops what remains and flushes the
    /// stores.  Both phases are bounded: quit replies and proceeds even if a
    /// cancelled engine task never exits, because a hung quit is worse than
    /// a shutdown that finishes behind it.  A listener that never started
    /// drains trivially.  This never runs on window close: a persisted
    /// window close keeps the listener up, and the terminal shutdown would
    /// make a later listener start fail.
    public func drainNativeEnginesForTermination(
        deadlineMs: Double = MacNativeComposition.drainDeadlineMs,
        pollMs: Double = MacNativeComposition.drainPollMs,
        shutdownAckTimeoutMs: Double = MacNativeComposition.shutdownAckTimeoutMs
    ) async -> MacNativeDrainResult {
        guard let macRuntime = nativeRuntimeBox.runtime else {
            let result = MacNativeDrainResult(settledCleanly: true)
            nativeDrainSummary = result.summary
            return result
        }
        // Fence first: no new wait dispatches while the bounded wait runs,
        // so the counters it watches can actually reach zero.  In-flight
        // engine turns keep running until they settle or are stopped below.
        // This is the right layer for this composition: the app dispatches
        // native turns through the wait queue, which this shutdown fences,
        // and through the chat window, fenced by dropping `nativeChat` so a
        // later message is refused; supervised processes stop through the
        // engine cancellations the terminal shutdown below performs.
        nativeChat = nil
        await macRuntime.runtime.shutdown()
        var result = await MacNativeGracefulDrain.drain(
            deadlineMs: deadlineMs,
            pollMs: pollMs,
            readSnapshot: { [weak self] in await self?.readNativeBusySnapshot() ?? MacNativeBusySnapshot() }
        )
        // The terminal phase runs detached and only acknowledged: awaiting
        // it directly would hang quit past the bounded window when a
        // cancelled engine task never exits.
        let shutdownAck = MacNativeShutdownAck()
        let runtime = macRuntime.runtime
        Task.detached(priority: .utility) {
            do {
                try await runtime.shutdownAndDrain()
                await shutdownAck.acknowledge(success: true)
            } catch {
                NSLog("Native runtime shutdown failed: %@", error.localizedDescription)
                await shutdownAck.acknowledge(success: false)
            }
        }
        let ackedCleanly = await MacNativeGracefulDrain.waitUntil(
            deadlineMs: shutdownAckTimeoutMs,
            pollMs: pollMs,
            condition: { await shutdownAck.isAcknowledged }
        )
        let shutdownSucceeded = await shutdownAck.didSucceed
        result.didShutDownRuntime = ackedCleanly && shutdownSucceeded
        if !ackedCleanly {
            NSLog("Native runtime shutdown did not answer before quitting; proceeding with termination.")
        }
        await refreshNativeBusyState()
        nativeDrainSummary = result.summary
        return result
    }

    /// Observes the close of the app's main window.
    ///
    /// The observer is bound to the main window instance rather than to every
    /// `NSWindow`, so closing the Settings panel never applies the quit policy.
    public func registerMainWindow(_ window: NSWindow) {
        // SwiftUI can recreate the window, so the previous observers are
        // dropped rather than left pointing at a window that no longer
        // exists.
        for observer in mainWindowObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        mainWindowObservers.removeAll()
        mainWindow = window

        mainWindowObservers.append(
            NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    await self?.handleWindowClose()
                    self?.updateMainWindowFocusState()
                }
            }
        )

        // The notification coordinator only suppresses a banner for the
        // thread on screen while the app is actually in front, so the
        // window's visibility and the app's focus both have to be tracked.
        let windowNotifications: [Notification.Name] = [
            NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification
        ]
        for name in windowNotifications {
            mainWindowObservers.append(
                NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        self?.updateMainWindowFocusState()
                    }
                }
            )
        }
        let applicationNotifications: [Notification.Name] = [
            NSApplication.didBecomeActiveNotification,
            NSApplication.didResignActiveNotification,
            NSApplication.didUnhideNotification
        ]
        for name in applicationNotifications {
            mainWindowObservers.append(
                NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        self?.updateMainWindowFocusState()
                    }
                }
            )
        }
        updateMainWindowFocusState()
    }

    /// Keeps the coordinator's on-screen flag in step with the window.
    ///
    /// The Electron app suppresses a desktop banner whenever the app has
    /// focus, because the chat on screen already shows the card.  The Mac
    /// only suppresses it for the thread actually on screen, so it needs
    /// both facts:  the window is on screen, and the app is active.
    private func updateMainWindowFocusState() {
        #if os(macOS)
        let window = mainWindow
        let windowIsVisible = (window?.isVisible ?? false) && !(window?.isMiniaturized ?? false)
        let applicationIsActive = NSApplication.shared.isActive
        notificationCoordinator.isMainWindowVisibleAndFocused = MacMainWindowFocus.isVisibleAndFocused(
            windowIsVisible: windowIsVisible,
            applicationIsActive: applicationIsActive
        )
        #endif
    }

    public func disconnect() {
        connectionGeneration = UUID()
        streamTask?.cancel()
        streamTask = nil
        client = nil
        // A native turn the window stops reading is cancelled, as when the
        // window goes away: nothing would fold its reply in.
        nativeChat = nil
        isNativeConnection = false
        for turn in nativeTurns.values { turn.task.cancel() }
        nativeTurns.removeAll()
        servers.connectedRecordID = nil
        status = .disconnected
        syncSystemSurfaces(force: true)
    }

    private func runConnectionLoop(client: CompanionClient, endpoint: String, generation: UUID) async {
        while !Task.isCancelled && connectionGeneration == generation {
            do {
                // The roster snapshot and the lifecycle settings are fetched once
                // per successful connection.  Fetching the settings on the
                // connect path as well would double the request count on every
                // reconnect, which is exactly when the harness is least able to
                // serve it.
                try await MacHarnessConnectionCycle.connect(
                    fetchFleet: { try await client.fleet() },
                    hydrate: { [weak self] fleet in
                        guard let self, self.connectionGeneration == generation, !Task.isCancelled else { return }
                        self.state.hydrate(fleet)
                        if self.selection == nil, let first = fleet.bots.first {
                            self.selection = .bot(first.id)
                        }
                    },
                    refreshLifecycleSettings: { [weak self] in
                        guard let self, self.connectionGeneration == generation, !Task.isCancelled else { return }
                        await self.refreshLifecycleSettings()
                        // The policy read is a couple of file stats and
                        // rides here;  the status read can take the harness
                        // tens of seconds, so it runs detached rather than
                        // holding the connection's hydration for it.
                        self.refreshStartupPolicy()
                        Task { [weak self, generation] in
                            guard let self, self.connectionGeneration == generation, !Task.isCancelled else { return }
                            await self.refreshControlStatus()
                        }
                    }
                )
                guard connectionGeneration == generation, !Task.isCancelled else { return }
                self.status = .connected(endpoint: endpoint)
                self.reconnectAttempt = 0
                self.syncSystemSurfaces(force: true)

                let stream = try client.events(since: state.cursor, screens: true)
                for try await frame in stream {
                    if Task.isCancelled || connectionGeneration != generation { break }
                    self.state.apply(frame)
                    if case let .notify(notification) = frame.frame {
                        self.handleNotificationFrame(notification)
                    }
                    if let threadKey = self.activeThreadId,
                       let streaming = self.state.streaming[threadKey] {
                        self.transcriptEngine.updateStreamingText(streaming, messageId: "streaming:\(threadKey)")
                    }
                    self.syncSystemSurfaces()
                }
            } catch {
                if Task.isCancelled || connectionGeneration != generation { break }
                reconnectAttempt += 1
                let baseBackoff = min(Double(reconnectAttempt) * 1.5, 10.0)
                let jitter = Double.random(in: -0.2...0.2) * baseBackoff
                let backoff = max(1.0, baseBackoff + jitter)
                status = .failed("Connection lost.\u{00A0} Retrying in \(Int(backoff))s…")
                syncSystemSurfaces(force: true)
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            }
        }
    }

    // MARK: - Native chat (BF-2705)

    /// What the status pill names while the chat runs on the native engine.
    static let nativeEndpointLabel = "native engine on this Mac"

    /// Every LaunchAgent label the Node harness has been installed under:
    /// today's, and the one from before the 2026-09-22 bundle-id migration
    /// that older installs and `scripts/botfleet-server-start.sh` still use.
    static let harnessAgentLabels = [MacStartupPolicyStore.serverAgentLabel, "com.jay.botfleet-server"]

    /// Whether the Node harness is gone from This Mac: launchd reported its
    /// LaunchAgent not installed, and no plist remains under any label it
    /// has used.  Only then may the native runtime answer its bots.
    private var harnessIsUninstalled: Bool {
        guard installedServerState == .notInstalled else { return false }
        return !Self.harnessAgentLabels.contains { label in
            FileManager.default.fileExists(atPath: startupPolicyStore.launchAgentPlist(label: label).path)
        }
    }

    private func connectNative(record: HostRecord) {
        isNativeConnection = true
        status = .connecting
        servers.connectedRecordID = record.id
        let generation = connectionGeneration
        let host = nativeRuntimeHost
        streamTask = Task { [weak self] in
            await self?.runNativeConnection(host: host, generation: generation)
        }
    }

    /// Opens the shared runtime, moves the registered bots onto it and
    /// hydrates the window from the native store.  There is no event stream
    /// to follow: the window's own turns bring their frames with them.
    private func runNativeConnection(host: NativeMacRuntimeHost, generation: UUID) async {
        let chat: NativeDesktopChat
        let start: NativeDesktopChatStart
        do {
            // Opening creates the store's directory and opens SQLite, so it
            // runs off the main actor rather than holding the window.
            let opened = try await Task.detached { try host.open() }.value
            chat = NativeDesktopChat(opened: opened)
            start = try await chat.start()
        } catch {
            guard !Task.isCancelled, connectionGeneration == generation else { return }
            // Not native after all: a later installed-state read may try
            // again instead of finding a native connection with no chat.
            isNativeConnection = false
            status = .failed("The native store could not be read: \(error.localizedDescription)")
            syncSystemSurfaces(force: true)
            return
        }
        guard !Task.isCancelled, connectionGeneration == generation else { return }
        if let loadFailure = start.registration.loadFailure {
            NSLog("BF-2705: stored bots could not be loaded for native registration: %@", loadFailure)
        }
        for skip in start.cutoverSkipped {
            NSLog("BF-2705: bot %@ stays off the native engine: %@", skip.botId, skip.reason)
        }
        for skip in start.snapshot.skipped {
            NSLog("BF-2705: bot %@ is not shown: %@", skip.botId, skip.reason)
        }
        nativeChat = chat
        state.hydrate(start.snapshot.fleet)
        if selection == nil, let first = start.snapshot.fleet.bots.first {
            selection = .bot(first.id)
        }
        status = .connected(endpoint: Self.nativeEndpointLabel)
        reconnectAttempt = 0
        syncSystemSurfaces(force: true)
    }

    /// Runs one message as a native turn and folds its frames into the
    /// window as they come.  Returns once the turn has started; the reply
    /// keeps streaming after that, like a harness reply does.
    private func sendNative(_ text: String, chat: NativeDesktopChat) async -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let threadId = activeThreadId,
              let bot = activeBot else { return false }
        // One turn per thread, as the engine coordinator enforces: until
        // the window has read the last turn to its end, a second message
        // would fold its reply into the same live bubble.
        guard nativeTurns[threadId] == nil else {
            status = .failed("Send failed: \(NativeDesktopChatError.turnAlreadyActive(threadId: threadId).localizedDescription)")
            return false
        }
        isSending = true
        defer { isSending = false }

        let frames: AsyncStream<Frame>
        do {
            frames = try await chat.send(botId: bot.id, threadId: threadId, text: text)
        } catch {
            status = .failed("Send failed: \(error.localizedDescription)")
            return false
        }
        // A refused send says so in the status; the next one that starts
        // puts the connection back, since nothing else would.
        if case .failed = status, nativeChat != nil {
            status = .connected(endpoint: Self.nativeEndpointLabel)
        }
        let turnId = UUID()
        let task = Task { [weak self] in
            var showedPrompt = false
            for await frame in frames {
                // The turn stores the person's message before its engine
                // runs, so by the first frame it is in the store: show it
                // first, before any live text, so the reply lands under it.
                if !showedPrompt {
                    showedPrompt = true
                    let stored = await chat.settledFrames(threadId: threadId)
                    guard let self, !Task.isCancelled else { return }
                    for settled in stored { self.state.apply(settled) }
                }
                guard let self, !Task.isCancelled else { return }
                self.state.apply(frame)
                if self.activeThreadId == threadId, let streaming = self.state.streaming[threadId] {
                    self.transcriptEngine.updateStreamingText(streaming, messageId: "streaming:\(threadId)")
                }
                self.syncSystemSurfaces()
            }
            guard let self, self.nativeTurns[threadId]?.id == turnId else { return }
            self.nativeTurns[threadId] = nil
        }
        nativeTurns[threadId] = (turnId, task)
        return true
    }

    /// Stops the open thread's native turn: cancelling the window's read
    /// cancels the engine turn under it, and the window clears its own live
    /// bubble because no more frames will come to clear it.
    private func stopNativeTurn() {
        guard let threadId = activeThreadId, let turn = nativeTurns.removeValue(forKey: threadId) else { return }
        turn.task.cancel()
        state.clearStream(threadId)
        syncSystemSurfaces()
    }

    @discardableResult
    public func sendMessage(_ text: String) async -> Bool {
        if let nativeChat { return await sendNative(text, chat: nativeChat) }
        guard let client = client, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard let threadId = activeThreadId else { return false }
        isSending = true
        defer { isSending = false }

        do {
            if let bot = activeBot {
                _ = try await client.send(
                    text: text,
                    toBot: bot.id,
                    threadId: threadId,
                    idempotencyKey: UUID().uuidString
                )
                return true
            } else if let room = activeRoom {
                _ = try await client.send(
                    text: text,
                    toRoom: room.id,
                    threadId: threadId,
                    idempotencyKey: UUID().uuidString
                )
                return true
            }
            return false
        } catch {
            print("Failed to send turn: \(error)")
            status = .failed("Send failed: \(error.localizedDescription)")
            return false
        }
    }

    /// The active bot's main thread: the conversation the sidebar's Main
    /// Thread row selects.  Nil when no bot is selected.
    public var activeMainThreadId: String? {
        activeBot?.threadId
    }

    /// Selects the active bot's main thread in the conversation list.
    public func selectMainThread() {
        selectedThreadId = activeMainThreadId
    }

    /// Creates a bot through the native chat service when running without a
    /// Node harness, or through the connected harness client otherwise.
    /// A failure is reported in `fleetActionErrorMessage` instead of failing
    /// silently behind a button that looks live.
    public func createBot() async {
        guard !isCreatingBot else { return }
        guard nativeChat != nil || client != nil else {
            fleetActionErrorMessage = "Not connected, so a bot cannot be added yet."
            return
        }
        isCreatingBot = true
        defer { isCreatingBot = false }
        do {
            let bot: Bot
            if let chat = nativeChat {
                bot = try await chat.createBot()
            } else if let client = client {
                bot = try await client.createBot()
            } else {
                return
            }
            // Creating a bot does not broadcast, so fold the new bot in
            // optimistically, exactly as the phone does (Session.createBot):
            // the bot is already made, and selecting a bot that is missing
            // from state would leave the sidebar pointing at nothing.  The
            // stream and the next roster snapshot reconcile it from there.
            state.apply(.bot(bot))
            selection = .bot(bot.id)
            selectedThreadId = bot.threadId
            fleetActionErrorMessage = nil
        } catch {
            fleetActionErrorMessage = "Adding a bot failed: \(error.localizedDescription)"
        }
    }

    public func stopActiveTurn() async {
        if nativeChat != nil {
            stopNativeTurn()
            return
        }
        guard let client = client else { return }
        guard let threadId = activeThreadId else { return }
        do {
            if let bot = activeBot {
                try await client.interrupt(botId: bot.id, threadId: threadId)
            } else if let room = activeRoom {
                try await client.interrupt(groupId: room.id, threadId: threadId)
            }
        } catch {
            print("Failed to steer turn: \(error)")
        }
    }

    // MARK: - Lifecycle Controls (BF-2497)

    private func makeLifecycleClient() -> MacLifecycleClient {
        MacLifecycleClient(host: host, port: port, policyStore: policyStore)
    }

    public func refreshLifecycleSettings() async {
        let generation = connectionGeneration
        let lifecycleClient = makeLifecycleClient()
        guard let fetched = try? await lifecycleClient.fetchLifecycleSettings() else { return }
        guard connectionGeneration == generation, !Task.isCancelled else { return }
        // A grant the harness did not report stays unknown, so the next save
        // never writes back a `false` the app never read.
        var merged = fetched
        if merged.allowRemoteDesktopLaunch == nil {
            merged.allowRemoteDesktopLaunch = lifecycleSettings.allowRemoteDesktopLaunch
        }
        lifecycleSettings = merged
        await mirrorDesktopLaunchGate()
    }

    public func saveLifecycleSettings(_ settings: MacLifecycleSettings) async {
        let previous = lifecycleSettings
        let result = await makeLifecycleClient().saveLifecycleSettings(settings, restoring: previous)
        switch result {
        case .saved(let saved):
            lifecycleSettings = saved
            lifecycleErrorMessage = nil
            await mirrorDesktopLaunchGate()
        case .failed(let restored, let message):
            // The write was rejected, so the toggles go back to the last value
            // the harness actually accepted.
            lifecycleSettings = restored
            lifecycleErrorMessage = message
            NSLog("Failed to save lifecycle settings: %@", message)
        }
    }

    // MARK: - Desktop Launch (BF-2690)

    /// Keeps the native companion listener's `POST /api/desktop/open` gate on
    /// the grant the owner set in Mac settings, so the phone's "Open on Mac"
    /// is refused by the native route exactly when those settings disable it.
    /// A grant the harness never reported stays closed.
    private func mirrorDesktopLaunchGate() async {
        await nativeListenerBackend.setAllowRemoteDesktopLaunch(
            lifecycleSettings.nativeDesktopLaunchAllowed
        )
    }

    // MARK: - Server Status & Local VM Controls (BF-2688, Decision 1 Option C)

    /// The message when the control routes must not be asked at all.
    private static let controlClientUnavailableMessage =
        "The server controls answer only to the harness on this Mac."

    /// The control-status client — and only for this Mac's loopback harness.
    ///
    /// The routes it calls answer only to the loopback and carry no token, so
    /// a remote server must never be asked them:  an unauthenticated start or
    /// stop POST sent to a remote address would be both refused and wrong.
    /// `nil` means the connection is not loopback, or the endpoint is
    /// malformed, and the caller says so instead of guessing.
    private func makeControlStatusClient() -> MacControlStatusClient? {
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let isLoopback = normalized == "localhost"
            || normalized == "::1"
            || normalized == "[::1]"
            || normalized.hasPrefix("127.")
        guard isLoopback else { return nil }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        let formattedHost = trimmedHost.contains(":") && !trimmedHost.hasPrefix("[")
            ? "[\(trimmedHost)]"
            : trimmedHost
        guard let baseURL = URL(string: "http://\(formattedHost):\(port)") else { return nil }
        return MacControlStatusClient(baseURL: baseURL)
    }

    /// Reads the harness status once per connection, the same cadence the
    /// other lifecycle reads keep — but detached from them, because the
    /// harness asks its container runtime about every VM before it answers,
    /// and a slow answer must not hold up the event stream.  A failed read
    /// keeps the last known state beside the reason, so a section that
    /// answered a moment ago does not blank out because one request did.
    public func refreshControlStatus() async {
        guard !isRefreshingControlStatus else { return }
        isRefreshingControlStatus = true
        defer { isRefreshingControlStatus = false }
        //  launchd is asked first, before anything that can return early.  The
        //  offer's third fact has to be current even when the endpoint is
        //  refused or the read is cancelled, which is exactly the state a
        //  server that is down leaves behind.
        await refreshInstalledServerState()
        guard let client = makeControlStatusClient() else {
            controlStatus = nil
            controlStatusError = Self.controlClientUnavailableMessage
            controlPresence = .unknown
            return
        }
        let generation = connectionGeneration
        do {
            let status = try await client.fetchStatus()
            guard connectionGeneration == generation, !Task.isCancelled else { return }
            controlStatus = status
            controlStatusError = nil
            controlPresence = .answering
        } catch {
            guard connectionGeneration == generation, !Task.isCancelled else { return }
            controlStatusError = error.localizedDescription
            controlPresence = MacServerPresence.after(status: controlStatus, error: error as? MacControlStatusError)
        }
    }

    /// Reads the installed LaunchAgent's state from launchd (BF-2700).
    ///
    /// A fresh connection asks so the start control is offerable from the
    /// first look, not only after a status read that may never come while the
    /// harness is down.
    public func refreshInstalledServerState() async {
        let state = await serverLaunchController.installedServerState()
        guard !Task.isCancelled else { return }
        installedServerState = state
        // BF-2705: a harness found uninstalled after the window connected
        // (or failed to) moves This Mac's chat onto the native engine.
        if harnessIsUninstalled, !isNativeConnection, servers.connectedRecordID != nil {
            connect()
        }
    }

    /// Starts the shared Local VM from Settings or the menu.
    public func startSharedVM() async {
        await runVMAction { try await $0.startSharedVM() }
    }

    /// Stops every Local VM the harness manages.
    public func stopLocalVMs() async {
        await runVMAction { try await $0.stopLocalVMs() }
    }

    private func runVMAction(_ action: @Sendable (MacControlStatusClient) async throws -> String) async {
        guard !isControllingVM else { return }
        isControllingVM = true
        defer { isControllingVM = false }
        guard let client = makeControlStatusClient() else {
            controlStatusError = Self.controlClientUnavailableMessage
            return
        }
        let generation = connectionGeneration
        do {
            let note = try await action(client)
            guard connectionGeneration == generation, !Task.isCancelled else { return }
            vmActionMessage = note
            controlStatusError = nil
            await refreshControlStatus()
        } catch {
            guard connectionGeneration == generation, !Task.isCancelled else { return }
            vmActionMessage = nil
            controlStatusError = error.localizedDescription
        }
    }

    // MARK: - Start Server (BF-2700)

    /// Whether the Start Server control may be used, and when it may not, the
    /// one sentence that says why.
    ///
    /// `nil` means it is offered.  The three facts are the ones the control's
    /// own fence asks for:  the wrapper can be started through the policy,
    /// nothing answered on the harness port, and the job is installed without
    /// a live process behind the label.  Anything not yet known is a sentence
    /// that says to look again, never an offer.
    public var startServerRefusal: String? {
        guard !isStartingServer else {
            return "The server is starting.\u{00A0} Wait for it to settle."
        }
        return MacServerLaunchController.startRefusal(
            policySupported: supportsStartupPolicy,
            presence: controlPresence,
            installedState: installedServerState
        )
    }

    /// The last start outcome, while it still describes this server.
    ///
    /// Nil once the presence has moved since the outcome was recorded, so a
    /// success cannot sit over a server that has since stopped, and a refusal
    /// cannot outlive the state it explained.
    public var startServerDisplayMessage: String? {
        guard serverStartMessagePresence == controlPresence else { return nil }
        return serverStartMessage
    }

    /// Starts the installed harness LaunchAgent and reports what happened.
    ///
    /// The app does not start the harness itself:  launchd runs the installed
    /// wrapper, and this asks launchd for that one job.  It is refused before
    /// it begins whenever `startServerRefusal` is a sentence, so a control
    /// that is greyed out can never start something the fence would not.
    public func startServer() async {
        guard !isStartingServer else { return }
        if let refusal = startServerRefusal {
            serverStartMessage = refusal
            serverStartMessagePresence = controlPresence
            return
        }
        isStartingServer = true
        defer { isStartingServer = false }
        do {
            let outcome = try await serverLaunchController.startServerAndSettle()
            serverStartMessage = outcome.message
            //  The status read follows the start itself:  a process behind the
            //  label proves launchd took the request, and only the harness
            //  answering proves it is up.  That read also asks launchd for the
            //  installed state, so one start lists the label once.
            await refreshControlStatus()
            //  The outcome is tied to the presence the reads above settled on:
            //  a start that moved the port from refused to answering keeps the
            //  sentence that says so, and a presence that moves later still
            //  hides it.
            serverStartMessagePresence = controlPresence
        } catch {
            serverStartMessage = error.localizedDescription
            installedServerState = await serverLaunchController.installedServerState()
            serverStartMessagePresence = controlPresence
        }
    }

    // MARK: - Startup Policy (BF-2688, Decision 1 Option C)

    /// Reads the startup policy from the data directory's markers.
    ///
    /// File reads, no harness round-trip, so this runs alongside the other
    /// per-connection refreshes and after every change.
    public func refreshStartupPolicy() {
        startupPolicy = startupPolicyStore.loginPolicy()
        supportsStartupPolicy = startupPolicyStore.supportsPolicy()
    }

    /// Sets "Start Server At Login" and records the boot session with it.
    ///
    /// A wrapper that predates the policy is refused with its own reason
    /// instead of writing markers the wrapper would ignore, and a failed
    /// write leaves the toggle on the value the data directory still holds.
    public func setStartsAtLogin(_ enabled: Bool) {
        guard supportsStartupPolicy else {
            startupPolicyErrorMessage = MacStartupPolicyError.updateRequired.localizedDescription
            startupPolicy = startupPolicyStore.loginPolicy()
            return
        }
        do {
            let bootSession = try startupPolicyStore.readBootSession()
            try startupPolicyStore.setStartsAtLogin(enabled, bootSession: bootSession)
            startupPolicy = startupPolicyStore.loginPolicy()
            startupPolicyErrorMessage = nil
        } catch {
            startupPolicy = startupPolicyStore.loginPolicy()
            startupPolicyErrorMessage = error.localizedDescription
        }
    }

    public func shutDownServerAndLocalVM() async {
        guard !isShuttingDownServer else { return }
        isShuttingDownServer = true
        defer { isShuttingDownServer = false }

        triggerCuaEmergencyStop()
        let lifecycleClient = makeLifecycleClient()
        switch await lifecycleClient.performDeliberateShutdown() {
        case .stopped:
            didDeliberatelyStopServer = true
            disconnect()
            status = .disconnected
        case .failed(let message):
            // A failed shutdown must not leave the deliberate-stop marker behind:
            // the harness is still running, and the marker would make the launchd
            // wrapper treat it as deliberately stopped forever.
            NSLog("Server shutdown failed: %@", message)
            status = .failed("Shutdown error: \(message)")
        }
    }

    /// Applies the exit policy when the desktop window closes.
    ///
    /// The Settings toggle reads "Keep Server Running When Window Closes", and
    /// closing the SwiftUI window does not terminate the app, so the policy has
    /// to be evaluated here as well as on termination.
    public func handleWindowClose() async {
        await applyExitPolicy(for: .mainWindowClosed)
    }

    /// Applies the exit policy when the app terminates.
    ///
    /// The native engine graph drains first, inside its bounded window, so
    /// in-flight turns settle or are stopped and flushed before the listener
    /// socket closes and the harness shuts down.
    public func handleAppTermination() async {
        triggerCuaEmergencyStop()
        await drainNativeEnginesForTermination()
        await applyExitPolicy(for: .appTerminating)
    }

    // MARK: - Phone Settings (BF-2652)
    //
    // Thin delegates to the concrete listener backend for the Settings >
    // Phone tab. They never change bind, power, or credential policy: the
    // toggle stays on `setCompanionListenerEnabled` above.

    public func openPhonePairingWindow() async -> NativePairingWindow? {
        await nativeListenerBackend.openPairingWindow()
    }

    public func closePhonePairingWindow() async {
        await nativeListenerBackend.closePairingWindow()
    }

    public func activePhonePairingWindow() async -> NativePairingWindow? {
        await nativeListenerBackend.activePairingWindow()
    }

    public func pairedPhones() async -> [PairedDevice] {
        await nativeListenerBackend.pairedDevices()
    }

    public func revokePairedPhone(id: String) async -> Bool {
        await nativeListenerBackend.revokeDevice(id: id)
    }

    public func phoneAdvertisement() async -> CompanionEndpointAdvertisement {
        await nativeListenerBackend.currentAdvertisement()
    }

    /// Loads the whole Phone tab snapshot through the same loader the
    /// contract tests exercise, so the tested path is the shipped path.
    public func loadPhoneSnapshot() async -> PhoneSettingsSnapshot {
        await PhoneSettingsSnapshotLoader(backend: nativeListenerBackend).loadConsistent()
    }

    private func applyExitPolicy(for event: CompanionListenerExitEvent) async {
        let persist = policyStore.readPersistOnExit() ?? lifecycleSettings.persistOnExit
        // The native listener reads the setting the same way the harness
        // shutdown does: it stays up through a window close that keeps the
        // server running, and stops when the server is shut down or the app
        // quits.
        await companionListener.applyExitPolicy(event, persistOnExit: persist)
        guard MacLifecycleClient.evaluateQuitAction(persistOnExit: persist) == .shutDownServerAndVM else {
            return
        }
        guard !didDeliberatelyStopServer else { return }
        await shutDownServerAndLocalVM()
    }

    // MARK: - CUA Stream & Emergency Safety Stop Controls (BF-2499)

    public func triggerCuaEmergencyStop() {
        _ = MacCuaDriver.shared.emergencyStop()
        permissionMonitor.stopMonitoring()
        if isCuaStreaming {
            stopCuaStreaming(updateStatusMessage: false)
        }
        setCuaStatus(.emergencyStopActivated)
    }

    public func toggleCuaStreaming() {
        if isCuaStreaming {
            stopCuaStreaming()
        } else {
            startCuaStreaming()
        }
    }

    public func startCuaStreaming() {
        let monitor = permissionMonitor
        Task { [weak self] in
            guard let self else { return }
            do {
                MacCuaDriver.shared.resetEmergencyStop()
                self.cuaStatusState.reset()
                self.cuaRevocationBanner = nil
                self.setCuaStatus(.starting)

                monitor.startMonitoring { [weak self] permissionState in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        self.isCuaStreaming = false
                        self.cuaPixelBuffer = nil
                        self.cuaRevocationBanner = permissionState.bannerMessage
                        self.setCuaStatus(.screenRecordingPermissionNeeded)
                    }
                }

                try await ScreenStreamActor.shared.startStreaming(
                    onStreamStoppedWithError: { [weak self] error in
                        let permissionState = monitor.notifyStreamStoppedWithError(error)
                        Task { @MainActor [weak self] in
                            guard let self else { return }
                            self.isCuaStreaming = false
                            self.cuaPixelBuffer = nil
                            switch permissionState {
                            case .authorized:
                                // A benign capture failure is not a lost
                                // permission, so no revocation banner is shown.
                                self.cuaRevocationBanner = nil
                                self.setCuaStatus(.streamStopped)
                            case .missingPermissions, .revoked:
                                self.cuaRevocationBanner = permissionState.bannerMessage
                                self.setCuaStatus(.screenRecordingPermissionNeeded)
                            }
                        }
                    },
                    onFrame: { [weak self] buffer in
                        Task { @MainActor [weak self] in
                            self?.cuaPixelBuffer = buffer
                        }
                    }
                )
                self.isCuaStreaming = true
                self.setCuaStatus(.liveDesktopShared)
            } catch {
                NSLog("CUA stream error: %@", error.localizedDescription)
                monitor.stopMonitoring()
                let hasScreenRecording = MacCuaDriver.shared.checkPermissions().hasScreenRecording
                if let streamError = error as? ScreenStreamError {
                    switch streamError {
                    case .notAuthorized:
                        self.setCuaStatus(.screenRecordingPermissionNeeded)
                    case .noDisplayFound:
                        self.setCuaStatus(.noDisplayAvailable)
                    case .streamInitializationFailed, .captureFailed:
                        self.setCuaStatus(
                            hasScreenRecording ? .liveCaptureUnavailable : .screenRecordingPermissionNeeded
                        )
                    }
                } else {
                    self.setCuaStatus(
                        hasScreenRecording ? .liveCaptureUnavailable : .screenRecordingPermissionNeeded
                    )
                }
                if !hasScreenRecording {
                    self.cuaRevocationBanner = CuaPermissionState.missingPermissions(
                        missingScreenRecording: true,
                        missingAccessibility: !MacCuaDriver.shared.checkPermissions().hasAccessibility
                    ).bannerMessage
                }
                self.isCuaStreaming = false
            }
        }
    }

    public func stopCuaStreaming(updateStatusMessage: Bool = true) {
        permissionMonitor.stopMonitoring()
        Task {
            await ScreenStreamActor.shared.stopStreaming()
            isCuaStreaming = false
            cuaPixelBuffer = nil
            if updateStatusMessage {
                setCuaStatus(.streamStopped)
            }
        }
    }

    /// Records a CUA inspector status update.
    ///
    /// The emergency-stop confirmation is sticky, so the asynchronous
    /// "stream stopped" update that lands right after an emergency stop cannot
    /// replace the safety message the operator just triggered.
    func contextCommands(botId: String, threadId: String) async -> [ContextMeterMath.Command]? {
        guard let client else { return nil }
        return try? await client.contextCommands(botId: botId, threadId: threadId, surface: "desktop")
    }

    func catalogWindow(instanceId: String, model: String) -> Int? {
        modelWindows["\(instanceId)\u{1e}\(model)"]
    }

    func refreshModelWindows() async {
        guard let client else { return }
        guard let list = try? await client.instanceList() else { return }
        var next: [String: Int] = [:]
        for instance in list.instances {
            for option in instance.models.options {
                if let window = option.contextWindow, window > 0 {
                    next["\(instance.instanceId)\u{1e}\(option.id)"] = window
                }
            }
        }
        modelWindows = next
    }

    /// Nil means compact started.  A string is the reason it did not.
    func compactSession(botId: String, commandId: String, threadId: String) async -> String? {
        guard let client else { return ContextMeterMath.unavailable }
        do {
            try await client.runContextCommand(botId: botId, id: commandId, threadId: threadId, surface: "desktop")
            return nil
        } catch {
            let message = (error as? LocalizedError)?.errorDescription?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let message, !message.isEmpty { return message }
            return ContextMeterMath.unavailable
        }
    }

    private func setCuaStatus(_ status: MacCuaStatus) {
        cuaStatusState.record(status)
        cuaStatusMessage = cuaStatusState.current?.message
    }
}
