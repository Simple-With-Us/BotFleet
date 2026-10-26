// Native macOS system integration: NSStatusItem menubar, Carbon global hotkeys,
// and time-sensitive UserNotifications (BF-2484).
//
// Follows BF-DESIGNER's exact specification:
// - Menubar icon state prioritizes `waitingForPerson` over `working`, respects
//   Reduced Motion, and renders the 12-part menu layout.
// - Two Carbon `RegisterEventHotKey` shortcuts ("Show or Hide BotFleet" and
//   "Push to Talk"), both off by default, guarded by `IsSecureEventInputEnabled()`,
//   with collision detection (`eventHotKeyExistsErr`) and Escape/Delete recording.
// - Notifications fire ONLY for the three person-blocking events (approval,
//   question, call/mention), suppress when the thread is already on screen,
//   and request permission lazily on the first blocking event rather than at launch.
import Foundation
import UserNotifications
#if os(macOS)
import AppKit
import Carbon.HIToolbox
#endif

// MARK: - 1. Menubar State & Controller

/// Visual states for the macOS `NSStatusItem` menubar mark.
public enum MacMenubarIconState: String, Equatable, Sendable {
    /// Plain BotFleet mark when all bots are idle.
    case idle
    /// Mark with a solid filled status dot while bots are working.
    case working
    /// Mark with a pulsing attention dot when any bot needs the person.
    /// Always takes priority over `.working`.
    case waitingForPerson
    /// Slashed mark when the local or remote harness connection is lost.
    case connectionLost

    public var symbolName: String {
        switch self {
        case .idle:
            return "cpu"
        case .working:
            return "cpu.fill"
        case .waitingForPerson:
            return "bell.badge.fill"
        case .connectionLost:
            return "bolt.slash.fill"
        }
    }
}

/// One waiting bot entry displayed in the menubar menu.
public struct MacWaitingBotItem: Equatable, Identifiable, Sendable {
    public let id: String
    public let botName: String
    public let threadId: String
    /// Short sentence-case need description such as `"Approve a change"` or
    /// `"Answer a question"`.
    public let needDescription: String

    public init(id: String, botName: String, threadId: String, needDescription: String) {
        self.id = id
        self.botName = botName
        self.threadId = threadId
        self.needDescription = needDescription
    }

    public var menuTitle: String {
        "\(botName) — \(needDescription)"
    }
}

/// Semantic rows in the BotFleet menubar menu.
public enum MacMenubarMenuItem: Equatable, Sendable {
    case openBotFleet
    case separator
    case statusLine(String)
    case composeNewMessage
    case dictateMessage
    case waitingBot(MacWaitingBotItem)
    case togglePauseResumeAll(title: String, isPaused: Bool)
    case settings
    case quitBotFleet

    /// Exact human-facing title for non-separator items.
    public var title: String? {
        switch self {
        case .openBotFleet:
            return "Open BotFleet"
        case .separator:
            return nil
        case .statusLine(let text):
            return text
        case .composeNewMessage:
            return "Compose New Message"
        case .dictateMessage:
            return "Dictate Message"
        case .waitingBot(let item):
            return item.menuTitle
        case .togglePauseResumeAll(let title, _):
            return title
        case .settings:
            return "Settings"
        case .quitBotFleet:
            return "Quit BotFleet"
        }
    }
}

/// Pure, testable value model for the macOS menubar status item and menu.
public struct MacMenubarState: Equatable, Sendable {
    public static let connectionLostStatusCopy = "Connection lost.  Your bots will reconnect on their own"
    public static let allBotsIdleStatusCopy = "All bots idle"

    public var isConnected: Bool
    public var workingBotCount: Int
    public var waitingBots: [MacWaitingBotItem]
    public var allBotsPaused: Bool
    public var reduceMotion: Bool

    public init(
        isConnected: Bool = true,
        workingBotCount: Int = 0,
        waitingBots: [MacWaitingBotItem] = [],
        allBotsPaused: Bool = false,
        reduceMotion: Bool = false
    ) {
        self.isConnected = isConnected
        self.workingBotCount = max(0, workingBotCount)
        self.waitingBots = waitingBots
        self.allBotsPaused = allBotsPaused
        self.reduceMotion = reduceMotion
    }

    /// Icon priority rule:
    /// 1. `.connectionLost` when disconnected.
    /// 2. `.waitingForPerson` whenever any bot is waiting for the person
    ///    (waiting ALWAYS wins over working).
    /// 3. `.working` when one or more bots are busy.
    /// 4. `.idle` otherwise.
    public var iconState: MacMenubarIconState {
        if !isConnected {
            return .connectionLost
        }
        if !waitingBots.isEmpty {
            return .waitingForPerson
        }
        if workingBotCount > 0 {
            return .working
        }
        return .idle
    }

    /// Pulsing animation is active only in `.waitingForPerson` when Reduced
    /// Motion is off.
    public var shouldPulseIcon: Bool {
        iconState == .waitingForPerson && !reduceMotion
    }

    /// Live status line in sentence case.
    public var statusLine: String {
        guard isConnected else {
            return Self.connectionLostStatusCopy
        }
        let waitingCount = waitingBots.count
        if workingBotCount == 0 && waitingCount == 0 {
            return Self.allBotsIdleStatusCopy
        }
        if workingBotCount > 0 && waitingCount > 0 {
            let workingPart = workingBotCount == 1 ? "1 bot working" : "\(workingBotCount) bots working"
            return "\(workingPart), \(waitingCount) waiting for you"
        }
        if workingBotCount > 0 {
            return workingBotCount == 1 ? "1 bot working" : "\(workingBotCount) bots working"
        }
        return waitingCount == 1 ? "1 bot waiting for you" : "\(waitingCount) bots waiting for you"
    }

    /// Swapping title for the fleet-wide pause/resume item.
    public var pauseResumeTitle: String {
        allBotsPaused ? "Resume All Bots" : "Pause All Bots"
    }

    /// Builds the menubar menu items in the exact specification order:
    /// 1. `"Open BotFleet"`
    /// 2. Separator
    /// 3. Live status line
    /// 4. `"Compose New Message"`
    /// 5. `"Dictate Message"`
    /// 6. Separator
    /// 7. One row per waiting bot (`botName` + need description)
    /// 8. Separator
    /// 9. `"Pause All Bots"` / `"Resume All Bots"`
    /// 10. `"Settings"`
    /// 11. Separator
    /// 12. `"Quit BotFleet"`
    public var menuItems: [MacMenubarMenuItem] {
        var items: [MacMenubarMenuItem] = [
            .openBotFleet,
            .separator,
            .statusLine(statusLine),
            .composeNewMessage,
            .dictateMessage,
            .separator,
        ]
        for waiting in waitingBots {
            items.append(.waitingBot(waiting))
        }
        items.append(.separator)
        items.append(.togglePauseResumeAll(title: pauseResumeTitle, isPaused: allBotsPaused))
        items.append(.settings)
        items.append(.separator)
        items.append(.quitBotFleet)
        return items
    }

    /// Derives `MacMenubarState` from `CompanionState`.
    public static func from(
        state: CompanionState,
        isConnected: Bool,
        allBotsPaused: Bool = false,
        reduceMotion: Bool = false
    ) -> MacMenubarState {
        var workingCount = 0
        var waitingItems: [MacWaitingBotItem] = []

        for bot in state.bots where !bot.isOff {
            if bot.busy == true {
                workingCount += 1
            }
            let messages = state.messages[bot.threadId] ?? bot.messages ?? []
            if let pendingCard = messages.reversed().compactMap(\.card).first(where: \.isPending) {
                let need = pendingCard.isPermission ? "Approve a change" : "Answer a question"
                waitingItems.append(
                    MacWaitingBotItem(
                        id: bot.id,
                        botName: bot.name,
                        threadId: bot.threadId,
                        needDescription: need
                    )
                )
            }
        }

        return MacMenubarState(
            isConnected: isConnected,
            workingBotCount: workingCount,
            waitingBots: waitingItems,
            allBotsPaused: allBotsPaused,
            reduceMotion: reduceMotion
        )
    }
}

#if os(macOS)
/// Manages the live `NSStatusItem` in the macOS system menubar.
@MainActor
public final class MacMenubarController: NSObject {
    public private(set) var currentState: MacMenubarState = MacMenubarState()
    private var statusItem: NSStatusItem?

    public var onOpenBotFleet: (() -> Void)?
    public var onComposeNewMessage: (() -> Void)?
    public var onDictateMessage: (() -> Void)?
    public var onSelectWaitingBot: ((MacWaitingBotItem) -> Void)?
    public var onTogglePauseResumeAll: (() -> Void)?
    public var onOpenSettings: (() -> Void)?
    public var onQuitBotFleet: (() -> Void)?

    public override init() {
        super.init()
    }

    public func installIfNeeded() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        apply(currentState)
    }

    public func apply(_ state: MacMenubarState) {
        currentState = state
        guard let statusItem else { return }
        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: state.iconState.symbolName,
                accessibilityDescription: state.statusLine
            )
            button.toolTip = state.statusLine
        }
        statusItem.menu = buildNSMenu(from: state)
    }

    public func buildNSMenu(from state: MacMenubarState) -> NSMenu {
        let menu = NSMenu(title: "BotFleet")
        menu.autoenablesItems = false

        for entry in state.menuItems {
            switch entry {
            case .separator:
                menu.addItem(.separator())
            case .statusLine(let text):
                let item = NSMenuItem(title: text, action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            case .openBotFleet:
                let item = NSMenuItem(title: "Open BotFleet", action: #selector(handleOpenBotFleet), keyEquivalent: "")
                item.target = self
                menu.addItem(item)
            case .composeNewMessage:
                let item = NSMenuItem(title: "Compose New Message", action: #selector(handleComposeNewMessage), keyEquivalent: "n")
                item.target = self
                menu.addItem(item)
            case .dictateMessage:
                let item = NSMenuItem(title: "Dictate Message", action: #selector(handleDictateMessage), keyEquivalent: "d")
                item.target = self
                menu.addItem(item)
            case .waitingBot(let waiting):
                let item = NSMenuItem(title: waiting.menuTitle, action: #selector(handleWaitingBot(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = waiting.id
                menu.addItem(item)
            case .togglePauseResumeAll(let title, _):
                let item = NSMenuItem(title: title, action: #selector(handleTogglePauseResume), keyEquivalent: "")
                item.target = self
                menu.addItem(item)
            case .settings:
                let item = NSMenuItem(title: "Settings", action: #selector(handleOpenSettings), keyEquivalent: ",")
                item.target = self
                menu.addItem(item)
            case .quitBotFleet:
                let item = NSMenuItem(title: "Quit BotFleet", action: #selector(handleQuitBotFleet), keyEquivalent: "q")
                item.target = self
                menu.addItem(item)
            }
        }
        return menu
    }

    @objc private func handleOpenBotFleet() { onOpenBotFleet?() }
    @objc private func handleComposeNewMessage() { onComposeNewMessage?() }
    @objc private func handleDictateMessage() { onDictateMessage?() }
    @objc private func handleTogglePauseResume() { onTogglePauseResumeAll?() }
    @objc private func handleOpenSettings() { onOpenSettings?() }
    @objc private func handleQuitBotFleet() {
        if let onQuitBotFleet {
            onQuitBotFleet()
        } else {
            NSApplication.shared.terminate(nil)
        }
    }

    @objc private func handleWaitingBot(_ sender: NSMenuItem) {
        guard let botId = sender.representedObject as? String,
              let item = currentState.waitingBots.first(where: { $0.id == botId }) else { return }
        onSelectWaitingBot?(item)
    }
}
#endif

// MARK: - 2. Global Hotkeys (Carbon RegisterEventHotKey)

/// The two global shortcuts supported by BotFleet on macOS.
public enum MacGlobalHotkeyAction: String, CaseIterable, Codable, Hashable, Sendable {
    case showOrHideBotFleet
    case pushToTalk

    /// Exact human-facing label in Settings -> Keyboard Shortcuts.
    public var displayTitle: String {
        switch self {
        case .showOrHideBotFleet:
            return "Show or Hide BotFleet"
        case .pushToTalk:
            return "Push to Talk"
        }
    }

    public var carbonHotKeyID: UInt32 {
        switch self {
        case .showOrHideBotFleet: return 1
        case .pushToTalk: return 2
        }
    }
}

/// Key code + Carbon modifier mask for a global shortcut.
public struct MacKeyCombo: Codable, Equatable, Hashable, Sendable {
    public var keyCode: UInt32
    public var carbonModifiers: UInt32

    public init(keyCode: UInt32, carbonModifiers: UInt32) {
        self.keyCode = keyCode
        self.carbonModifiers = carbonModifiers
    }
}

/// Binding state for one global shortcut.  Both shortcuts default to off (`isEnabled == false`, `keyCombo == nil`).
public struct MacHotkeyBinding: Codable, Equatable, Sendable {
    public let action: MacGlobalHotkeyAction
    public var isEnabled: Bool
    public var keyCombo: MacKeyCombo?

    public init(action: MacGlobalHotkeyAction, isEnabled: Bool = false, keyCombo: MacKeyCombo? = nil) {
        self.action = action
        self.isEnabled = isEnabled
        self.keyCombo = keyCombo
    }
}

/// State of the Settings shortcut recorder control.
public enum MacShortcutRecorderState: Equatable, Sendable {
    case idle
    case recording(MacGlobalHotkeyAction)
}

/// Result of attempting to register a Carbon hotkey with the window server.
public enum MacCarbonRegistrationStatus: Equatable, Sendable {
    case success
    case conflict
    case failure(Int32)
}

/// Manages global shortcuts via Carbon `RegisterEventHotKey` (requiring no
/// Input Monitoring TCC permission), enforces the secure event input guard,
/// and drives the Settings shortcut recorder state machine.
public final class MacGlobalHotkeyManager: @unchecked Sendable {
    /// Exact inline error copy when `RegisterEventHotKey` reports `eventHotKeyExistsErr`.
    public static let shortcutCollisionCopy = "That shortcut is used by another app.  Choose a different one."

    /// Virtual key codes for Escape and Delete on macOS.
    public static let escapeKeyCode: UInt32 = 53
    public static let deleteKeyCode: UInt32 = 51
    public static let forwardDeleteKeyCode: UInt32 = 117

    public private(set) var bindings: [MacGlobalHotkeyAction: MacHotkeyBinding]
    public private(set) var recorderState: MacShortcutRecorderState = .idle
    public private(set) var inlineCollisionError: String?
    public private(set) var triggeredHistory: [MacGlobalHotkeyAction] = []

    private let secureInputProvider: () -> Bool
    private let carbonRegistrar: (MacGlobalHotkeyAction, MacKeyCombo) -> MacCarbonRegistrationStatus
    private let carbonUnregistrar: (MacGlobalHotkeyAction) -> Void
    private var occupiedSystemCombos: Set<MacKeyCombo> = []

    #if os(macOS)
    private var hotKeyRefs: [MacGlobalHotkeyAction: EventHotKeyRef] = [:]
    #endif

    public init(
        secureInputProvider: (() -> Bool)? = nil,
        carbonRegistrar: ((MacGlobalHotkeyAction, MacKeyCombo) -> MacCarbonRegistrationStatus)? = nil,
        carbonUnregistrar: ((MacGlobalHotkeyAction) -> Void)? = nil
    ) {
        // Both hotkeys MUST be off by default until enabled in Settings -> Keyboard Shortcuts.
        self.bindings = [
            .showOrHideBotFleet: MacHotkeyBinding(action: .showOrHideBotFleet, isEnabled: false, keyCombo: nil),
            .pushToTalk: MacHotkeyBinding(action: .pushToTalk, isEnabled: false, keyCombo: nil),
        ]

        if let secureInputProvider {
            self.secureInputProvider = secureInputProvider
        } else {
            #if os(macOS)
            self.secureInputProvider = { IsSecureEventInputEnabled() }
            #else
            self.secureInputProvider = { false }
            #endif
        }

        if let carbonRegistrar {
            self.carbonRegistrar = carbonRegistrar
        } else {
            self.carbonRegistrar = { _ , _ in .success }
        }

        if let carbonUnregistrar {
            self.carbonUnregistrar = carbonUnregistrar
        } else {
            self.carbonUnregistrar = { _ in }
        }
    }

    /// Marks a key combo as already claimed by another app (or tests Carbon
    /// `eventHotKeyExistsErr` collision handling deterministically).
    public func setSystemOccupiedCombos(_ combos: Set<MacKeyCombo>) {
        occupiedSystemCombos = combos
    }

    public func binding(for action: MacGlobalHotkeyAction) -> MacHotkeyBinding {
        bindings[action] ?? MacHotkeyBinding(action: action, isEnabled: false, keyCombo: nil)
    }

    /// Starts recording the next key combo for `action` in Settings -> Keyboard Shortcuts.
    public func beginRecording(for action: MacGlobalHotkeyAction) {
        inlineCollisionError = nil
        recorderState = .recording(action)
    }

    /// Processes a key press while the shortcut recorder is active:
    /// - `Escape` cancels recording without modifying the current binding.
    /// - `Delete` (or Forward Delete) clears the shortcut back to off.
    /// - Any other key combo attempts registration; on collision (`eventHotKeyExistsErr`),
    ///   surfaces `"That shortcut is used by another app.  Choose a different one."`.
    @discardableResult
    public func handleRecordedKey(
        keyCode: UInt32,
        carbonModifiers: UInt32,
        isEscape: Bool = false,
        isDelete: Bool = false
    ) -> Bool {
        guard case .recording(let action) = recorderState else {
            return false
        }

        if isEscape || (keyCode == Self.escapeKeyCode && carbonModifiers == 0) {
            recorderState = .idle
            return false
        }

        if isDelete || ((keyCode == Self.deleteKeyCode || keyCode == Self.forwardDeleteKeyCode) && carbonModifiers == 0) {
            clearShortcut(for: action)
            recorderState = .idle
            return true
        }

        let combo = MacKeyCombo(keyCode: keyCode, carbonModifiers: carbonModifiers)

        // Check conflict with another app or with the other BotFleet hotkey.
        let conflictsWithOtherAction = bindings.values.contains {
            $0.action != action && $0.isEnabled && $0.keyCombo == combo
        }
        if occupiedSystemCombos.contains(combo) || conflictsWithOtherAction {
            inlineCollisionError = Self.shortcutCollisionCopy
            recorderState = .idle
            return false
        }

        let status = carbonRegistrar(action, combo)
        switch status {
        case .conflict:
            inlineCollisionError = Self.shortcutCollisionCopy
            recorderState = .idle
            return false
        case .failure:
            inlineCollisionError = Self.shortcutCollisionCopy
            recorderState = .idle
            return false
        case .success:
            bindings[action] = MacHotkeyBinding(action: action, isEnabled: true, keyCombo: combo)
            inlineCollisionError = nil
            recorderState = .idle
            return true
        }
    }

    /// Clears a shortcut back to off and unregisters its Carbon hotkey.
    public func clearShortcut(for action: MacGlobalHotkeyAction) {
        carbonUnregistrar(action)
        #if os(macOS)
        if let ref = hotKeyRefs.removeValue(forKey: action) {
            UnregisterEventHotKey(ref)
        }
        #endif
        bindings[action] = MacHotkeyBinding(action: action, isEnabled: false, keyCombo: nil)
        inlineCollisionError = nil
    }

    /// Checks whether macOS Secure Event Input (`IsSecureEventInputEnabled()`)
    /// is currently active (e.g. a password field is focused).
    public var isSecureEventInputEnabled: Bool {
        secureInputProvider()
    }

    /// Attempts to trigger `action`.  Refuses to fire when the shortcut is
    /// disabled or when `IsSecureEventInputEnabled()` is true.
    @discardableResult
    public func triggerIfAllowed(_ action: MacGlobalHotkeyAction) -> Bool {
        guard let current = bindings[action], current.isEnabled, current.keyCombo != nil else {
            return false
        }
        guard !isSecureEventInputEnabled else {
            return false
        }
        triggeredHistory.append(action)
        return true
    }

    #if os(macOS)
    /// Performs live Carbon `RegisterEventHotKey` registration when running in
    /// the macOS app process.
    public func registerCarbonHotKeyInSystem(action: MacGlobalHotkeyAction, combo: MacKeyCombo) -> MacCarbonRegistrationStatus {
        if let existing = hotKeyRefs.removeValue(forKey: action) {
            UnregisterEventHotKey(existing)
        }
        let hotKeyID = EventHotKeyID(signature: OSType(0x42464C54), id: action.carbonHotKeyID) // 'BFLT'
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            combo.keyCode,
            combo.carbonModifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        if status == OSStatus(eventHotKeyExistsErr) {
            inlineCollisionError = Self.shortcutCollisionCopy
            return .conflict
        }
        guard status == noErr, let ref else {
            return .failure(status)
        }
        hotKeyRefs[action] = ref
        return .success
    }
    #endif
}

// MARK: - 3. Native Notifications Coordinator

/// Candidate events evaluated by `MacNotificationCoordinator`.
///
/// Only the first three blocking kinds ever produce a macOS user notification;
/// routine progress, normal completions, and connection state transitions are
/// strictly filtered out.
public enum MacCandidateNotificationEvent: Equatable, Sendable {
    case botNeedsApproval(
        botId: String,
        botName: String,
        threadId: String,
        requestId: String,
        summary: String
    )
    case botAskedQuestion(
        botId: String,
        botName: String,
        threadId: String,
        requestId: String,
        question: String
    )
    case callOrMentionNeedsPerson(
        botId: String,
        botName: String,
        threadId: String,
        message: String
    )
    /// Routine tool / step progress: NEVER notifies.
    case routineProgress(botId: String, threadId: String, detail: String)
    /// Normal turn completion: NEVER notifies.
    case normalCompletion(botId: String, threadId: String, summary: String)
    /// Harness connection lost or restored: NEVER notifies.
    case connectionStateChanged(isConnected: Bool)

    public var threadId: String? {
        switch self {
        case .botNeedsApproval(_, _, let threadId, _, _),
             .botAskedQuestion(_, _, let threadId, _, _),
             .callOrMentionNeedsPerson(_, _, let threadId, _),
             .routineProgress(_, let threadId, _),
             .normalCompletion(_, let threadId, _):
            return threadId
        case .connectionStateChanged:
            return nil
        }
    }

    public var requiresPersonAttention: Bool {
        switch self {
        case .botNeedsApproval, .botAskedQuestion, .callOrMentionNeedsPerson:
            return true
        case .routineProgress, .normalCompletion, .connectionStateChanged:
            return false
        }
    }
}

/// Built notification payload ready for `UNUserNotificationCenter`.
public struct MacDeliverableNotification: Equatable, Sendable {
    public enum InterruptionLevel: String, Equatable, Sendable {
        case timeSensitive
    }

    public let identifier: String
    public let title: String
    public let body: String
    public let categoryIdentifier: String
    public let actionTitles: [String]
    public let supportsInlineTextReply: Bool
    public let interruptionLevel: InterruptionLevel
    public let threadId: String
    public let botId: String
    public let requestId: String?

    public init(
        identifier: String,
        title: String,
        body: String,
        categoryIdentifier: String,
        actionTitles: [String],
        supportsInlineTextReply: Bool,
        interruptionLevel: InterruptionLevel = .timeSensitive,
        threadId: String,
        botId: String,
        requestId: String?
    ) {
        self.identifier = identifier
        self.title = title
        self.body = body
        self.categoryIdentifier = categoryIdentifier
        self.actionTitles = actionTitles
        self.supportsInlineTextReply = supportsInlineTextReply
        self.interruptionLevel = interruptionLevel
        self.threadId = threadId
        self.botId = botId
        self.requestId = requestId
    }
}

/// Evaluation outcome for a candidate notification event.
public enum MacNotificationDecision: Equatable, Sendable {
    case deliver(MacDeliverableNotification)
    case suppressedNonBlockingEvent
    case suppressedAlreadyOnScreen
    case suppressedPermissionDenied(statusBanner: String, actionTitle: String)
}

/// Authorization states for macOS notifications.
public enum MacNotificationPermissionState: Equatable, Sendable {
    case notDetermined
    case authorized
    case denied
}

/// Coordinates macOS native notifications, enforcing the 3-kind filter,
/// active-thread suppression, lazy permission prompting, and denied-permission
/// Settings status copy.
public final class MacNotificationCoordinator: @unchecked Sendable {
    public static let notificationsOffStatusCopy = "Notifications are off.  Bots that need you will wait in the menubar"
    public static let openSettingsActionTitle = "Open Settings"

    public private(set) var permissionState: MacNotificationPermissionState
    public private(set) var hasRequestedPermission: Bool = false
    public private(set) var deliveredNotifications: [MacDeliverableNotification] = []
    public var activeOnScreenThreadId: String?
    public var isMainWindowVisibleAndFocused: Bool = true

    private let permissionGrantResult: Bool

    public init(
        initialPermission: MacNotificationPermissionState = .notDetermined,
        permissionGrantResult: Bool = true
    ) {
        // Never requests permission at launch (`hasRequestedPermission` starts false).
        self.permissionState = initialPermission
        self.permissionGrantResult = permissionGrantResult
    }

    /// Status banner shown in Settings when notification permission is refused.
    public var settingsStatusBanner: String? {
        permissionState == .denied ? Self.notificationsOffStatusCopy : nil
    }

    /// Action button label shown next to `settingsStatusBanner` when denied.
    public var settingsActionTitle: String? {
        permissionState == .denied ? Self.openSettingsActionTitle : nil
    }

    /// Evaluates a candidate event and delivers it if allowed.
    ///
    /// 1. Routine progress, normal completions, and connection changes NEVER notify
    ///    and NEVER trigger a permission request.
    /// 2. If `event.threadId == activeOnScreenThreadId` while the window is active,
    ///    the notification is suppressed.
    /// 3. If permission is `.notDetermined`, requests permission now (at the first
    ///    moment a bot actually needs the person).
    /// 4. If permission is `.denied`, suppresses delivery and surfaces
    ///    `"Notifications are off.  Bots that need you will wait in the menubar"`
    ///    with action `"Open Settings"`.
    @discardableResult
    public func handleEvent(_ event: MacCandidateNotificationEvent) -> MacNotificationDecision {
        guard event.requiresPersonAttention else {
            return .suppressedNonBlockingEvent
        }

        if isMainWindowVisibleAndFocused,
           let eventThreadId = event.threadId,
           let activeThreadId = activeOnScreenThreadId,
           eventThreadId == activeThreadId {
            return .suppressedAlreadyOnScreen
        }

        if permissionState == .notDetermined {
            hasRequestedPermission = true
            permissionState = permissionGrantResult ? .authorized : .denied
        }

        guard permissionState == .authorized else {
            return .suppressedPermissionDenied(
                statusBanner: Self.notificationsOffStatusCopy,
                actionTitle: Self.openSettingsActionTitle
            )
        }

        let payload = buildDeliverableNotification(for: event)
        deliveredNotifications.append(payload)
        return .deliver(payload)
    }

    private func buildDeliverableNotification(for event: MacCandidateNotificationEvent) -> MacDeliverableNotification {
        switch event {
        case .botNeedsApproval(let botId, let botName, let threadId, let requestId, let summary):
            return MacDeliverableNotification(
                identifier: "approval:\(threadId):\(requestId)",
                title: "\(botName) needs approval",
                body: summary,
                categoryIdentifier: NotificationCategoryIdentifier.approval,
                actionTitles: ["Approve", "Deny"],
                supportsInlineTextReply: false,
                interruptionLevel: .timeSensitive,
                threadId: threadId,
                botId: botId,
                requestId: requestId
            )
        case .botAskedQuestion(let botId, let botName, let threadId, let requestId, let question):
            return MacDeliverableNotification(
                identifier: "question:\(threadId):\(requestId)",
                title: "\(botName) asked a question",
                body: question,
                categoryIdentifier: NotificationCategoryIdentifier.question,
                actionTitles: ["Reply"],
                supportsInlineTextReply: true,
                interruptionLevel: .timeSensitive,
                threadId: threadId,
                botId: botId,
                requestId: requestId
            )
        case .callOrMentionNeedsPerson(let botId, let botName, let threadId, let message):
            return MacDeliverableNotification(
                identifier: "mention:\(threadId):\(UUID().uuidString)",
                title: botName,
                body: message,
                categoryIdentifier: NotificationCategoryIdentifier.update,
                actionTitles: ["Open"],
                supportsInlineTextReply: false,
                interruptionLevel: .timeSensitive,
                threadId: threadId,
                botId: botId,
                requestId: nil
            )
        case .routineProgress, .normalCompletion, .connectionStateChanged:
            preconditionFailure("Non-blocking events are filtered before building a notification payload.")
        }
    }
}
