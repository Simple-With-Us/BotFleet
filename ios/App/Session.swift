// The app's one long-lived object: who we are paired with, what we know,
// and the stream that keeps it current.
//
// The parsing and folding live in CompanionCore. What lives here is the
// part that cannot be unit-tested and is the actual hard problem in a phone
// client — lifecycle. A phone loses its connection constantly: it locks, it
// backgrounds, it moves between wifi and cellular. So the stream is torn
// down deliberately when the app leaves the screen, and on the way back the
// server is asked what was missed rather than being asked for everything.
import Foundation
import OSLog
import SwiftUI
import CompanionCore
import UserNotifications
import UIKit

/// Stream lifecycle, in Console.app and the Xcode console. A companion that
/// is silently not connected looks exactly like one with nothing to say, so
/// the transitions are worth being able to read.
private let log = Logger(subsystem: "com.botfleet.companion", category: "stream")

@MainActor
final class Session: ObservableObject {
    enum Status: Equatable {
        case unpaired
        case connecting
        case live
        /// The token stopped working — revoked on the computer, most likely.
        case unauthorized
        case offline(String)
        /// A sustained run of gateway failures (502/503/530-family — see
        /// `ReconnectBackoff.gatewayEscalationThreshold`), distinct from an
        /// ordinary `.offline`: Cloudflare, not the app, is answering every
        /// attempt, which means the Mac's sidecar has nothing listening.
        /// The reconnect loop keeps retrying underneath at the raised
        /// backoff cap; this status exists so the UI stops implying a
        /// quick retry will help and offers a manual one instead (IO11).
        case macOffline
    }

    private enum SnapshotHydrationOutcome {
        case applied(changed: Bool)
        case newerState
        case pairingChanged
    }

    @Published private(set) var state = CompanionState()
    @Published private(set) var connection: Connection?
    @Published private(set) var status: Status = .unpaired
    /// Transient, user-facing failures from an action they just took.
    @Published var actionError: String?

    func isCancellation(_ error: Error) -> Bool {
        if Task.isCancelled || error is CancellationError { return true }
        if let api = error as? APIError, api.isCancellation { return true }
        if (error as? URLError)?.code == .cancelled { return true }
        let lower = error.localizedDescription.lowercased()
        return lower == "cancelled" || lower == "canceled"
    }

    func recordActionError(_ error: Error) {
        guard !isCancellation(error) else { return }
        actionError = error.localizedDescription
    }

    /// One exact message the next opened chat should reveal.
    @Published private(set) var focusedMessageId: String?
    @Published private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    /// Distinguishes a real `.notDetermined` result from the in-memory value
    /// used while notification settings are still loading at launch.
    @Published private(set) var notificationAuthorizationResolved = false
    /// A short-lived desktop handoff waiting for PairingView to present it.
    @Published private(set) var pairingInvite: PairingInvite?
    @Published var config: ConfigStatus?
    /// Cached APNs sender health from the sidecar, surfaced as a Settings
    /// row so a closed-app wake problem is visible without opening a
    /// console.  `nil` until the first fetch resolves, OR after a fetch
    /// returns 404 (older sidecar).  See `PushSenderHealthView.notReported`.
    @Published private(set) var pushSenderHealth: PushSenderHealth?
    /// True once a refresh has resolved to 404 — i.e. the sidecar
    /// predates PR #383 and does not report the route.  Distinct from
    /// "have not fetched yet" so the row can render the right copy.
    @Published private(set) var pushSenderHealthNotReported = false

    /// instanceId -> driverKind, cached from the last `instances()` fetch so
    /// the chat header can resolve a bot's current-model provider mark
    /// synchronously instead of firing a network call per render.  Never
    /// parse `instanceId` for this — it is operator-named (e.g.
    /// "claude-bypass", "agy-test") and not reliably prefixed by driver kind.
    @Published private(set) var instanceDriverKinds: [String: String] = [:]
    /// Available instances cached from the last successful fetch. Preserved across
    /// transient sheet dismissals and cancelled tasks so the profile model picker
    /// never empties spuriously.
    @Published private(set) var cachedInstances: [Instance] = []

    /// A notification response that should be pushed by the roster's
    /// NavigationStack after the exact detached task has been activated.
    @Published private(set) var notificationChat: Chat?

    private var client: CompanionClient?
    /// The device token, kept in memory so the client can be rebuilt when the
    /// dial moves to another stored host. The keychain remains the only place
    /// it is persisted.
    private var token: String?
    /// Which of the connection's stored hosts the next attempt dials. The
    /// walk advances on address-shaped failures and the winner is promoted —
    /// and persisted — when a stream goes live.
    private var rotation = CandidateRotation(hosts: [])
    private var streamTask: Task<Void, Never>?
    /// Best-effort authenticated route refresh started by the latest live SSE
    /// hello. Kept separate so endpoint discovery never stalls event delivery.
    private var endpointRefreshTask: Task<Void, Never>?
    /// Polls `state.macUpdateStatus` on a short interval while a run is in
    /// progress.  The updater stops the harness partway through and restarts
    /// it — see `docs/rollouts/2026-09-12-safe-mac-updater.md` — which drops
    /// this event stream along with whatever frame would have said the run
    /// finished.  The reconnect below asks once more on its own; this is the
    /// backstop for the stretch in between, and for a phone that stays
    /// backgrounded through the whole restart and never sees a reconnect at all.
    private var macUpdatePollTask: Task<Void, Never>?
    /// How long to wait before each successive attempt, in seconds, indexed
    /// by how many have failed in a row; the last entry repeats.  A run that
    /// is answering keeps the five-second cadence, and a Mac that has gone
    /// quiet is backed off rather than hammered — the harness's own desktop
    /// hook does the same thing from the other side.
    private static let macUpdatePollBackoff = [5, 10, 30, 60]
    /// How long the poll keeps asking a Mac that has stopped answering
    /// altogether before giving up.  The restart the updater performs is
    /// seconds to a minute; ten minutes of unbroken silence is a Mac that is
    /// not coming back on its own — asleep, wedged, or rolled back without a
    /// restart — and polling it forever only burns battery behind a spinner
    /// that will never move.  Measured from the first failure of the current
    /// run of them, not from the start of the install, so a long but healthy
    /// transaction is never cut short.
    private static let macUpdateGiveUpAfterSilence: TimeInterval = 10 * 60
    /// Set when the poll above gave up with a run still outstanding, so the
    /// card can offer to ask again instead of spinning on "Installing…"
    /// forever.  Cleared by the next status to arrive from anywhere.
    @Published private(set) var macUpdateContactLost = false
    /// Identifies the task currently stored in `streamTask`. A cancelled task
    /// can finish after its replacement starts; its cleanup must not clear
    /// the replacement's handle.
    private var streamGeneration = 0
    /// Bumped on pair / restore / sign-out so an in-flight instances warm
    /// cannot write the previous computer's provider map onto a new pairing.
    private var pairingGeneration = 0
    private var reconnectBackoff = ReconnectBackoff()
    /// Open computer panels per bot.  A view can be pushed twice in a
    /// navigation stack; its last close releases that bot's subscription.
    private var screenWatchers: [String: Int] = [:]
    /// Authenticated avatar bytes shared by roster, header, group and task
    /// surfaces. Both entry count and byte cost are bounded because one valid
    /// uploaded image may be 10 MB.
    private let avatarCache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.countLimit = 64
        cache.totalCostLimit = 32 * 1_024 * 1_024
        return cache
    }()
    /// Concurrent first renders share one download. The id prevents an old
    /// request finishing after sign-out from removing a newer pairing's task
    /// for the same attachment path.
    private var avatarFetches: [String: (id: UUID, task: Task<Data?, Never>)] = [:]
    private var avatarCacheGeneration = 0
    /// Per-mutation success flags for one settings flush.  `status` may be a
    /// recovery GET applied for display even when a PATCH failed; callers must
    /// require their own OK flag before treating the mutation as saved.
    private struct SettingsFlushOutcome: Sendable {
        var status: ConfigStatus?
        var conversationModeOK: Bool? = nil
        var terminologyOK: Bool? = nil
        var featuresOK: Bool? = nil
        var profileOK: Bool? = nil
        var timeoutOK: Bool? = nil

        /// True when at least one mutation in this flush reported failure.
        var hasFailedMutation: Bool {
            conversationModeOK == false
                || terminologyOK == false
                || featuresOK == false
                || profileOK == false
                || timeoutOK == false
        }

        /// Merge a superseded partial with the flush that inherited requeued
        /// fields.  Confirmed successes (`true`) win so an earlier PATCH in the
        /// partial flush is not lost; a requeued field that the replacement
        /// saved upgrades `false` to `true`.
        func mergingRequeuedFollow(from replacement: SettingsFlushOutcome) -> SettingsFlushOutcome {
            func mergeFlag(_ partial: Bool?, _ replacement: Bool?) -> Bool? {
                if partial == true || replacement == true { return true }
                if partial == false || replacement == false { return false }
                return nil
            }
            return SettingsFlushOutcome(
                status: replacement.status ?? status,
                conversationModeOK: mergeFlag(conversationModeOK, replacement.conversationModeOK),
                terminologyOK: mergeFlag(terminologyOK, replacement.terminologyOK),
                featuresOK: mergeFlag(featuresOK, replacement.featuresOK),
                profileOK: mergeFlag(profileOK, replacement.profileOK),
                timeoutOK: mergeFlag(timeoutOK, replacement.timeoutOK)
            )
        }
    }

    /// One-in-flight settings PATCH chain shared by every full-config settings
    /// mutation (conversation mode, terminology, features, profile, room
    /// timeout).  Concurrent cross-type saves each return a full ConfigStatus;
    /// a shared tail keeps those assignments ordered so an older snapshot
    /// cannot finish last and regress session.config.  Field-level coalesce
    /// remains per endpoint; queued work is pairing-bound and cleared on
    /// sign-out / re-pair.  Callers get nil when their own PATCH failed even
    /// if a recovery GET refreshed config for display.
    private var settingsUpdateTail: Task<SettingsFlushOutcome?, Never>?
    private var settingsUpdateGeneration = 0
    private var pendingConversationMode: String?
    private var pendingConversationMergeThreads = false
    private var pendingConversationModeSet = false
    private var pendingTerminology: String?
    private var pendingTerminologyCustom: RoomLabels?
    private var pendingTerminologySet = false
    private var pendingFeaturesShowToolCalls: Bool?
    private var pendingFeaturesSummarizeToolCalls: Bool?
    private var pendingProfileName: String?
    private var pendingProfileEmail: String?
    private var pendingProfileHasName = false
    private var pendingProfileHasEmail = false
    private var pendingRoomTurnTimeoutMinutes: Int?
    private var pendingRoomTurnTimeout = false
    /// A saved connection exists, but its token could not be read yet. Keeps
    /// "the keychain is locked" from being mistaken for "not paired".
    private var restorePending = false
    /// A notification can cold-launch the app before protected Keychain data
    /// is available. Retain the last explicitly tapped destination until the
    /// paired client can be rebuilt after unlock.
    private var pendingNotification: NotificationTarget?

    static let connectionKey = "companion.connection"
    /// The last `PostedPushToken` this phone successfully posted — see
    /// `registerPushToken`.  IO17: without this, a token iOS hands back
    /// unchanged on almost every launch was POSTed unconditionally, every
    /// launch, forever.
    private static let postedPushTokenKey = "companion.pushToken.posted"

    // MARK: - Pairing

    init() {
        _ = NotificationCoordinator.shared
        NotificationCoordinator.shared.responseHandler = { [weak self] target in
            Task { @MainActor in await self?.openNotification(target) }
        }
        NotificationCoordinator.shared.approvalActionHandler = { [weak self] target, approve in
            _ = await self?.answerPendingRequest(target: target, approve: approve)
        }
        // Text-input reply on a question notification.  Same hydrate-and-
        // resolve plumbing as Approve/Deny, because we still need to know
        // which concrete request the body answers; only the leaf call is
        // different (typed text, not a button).
        NotificationCoordinator.shared.replyActionHandler = { [weak self] target, message in
            _ = await self?.replyToPendingRequest(target: target, message: message)
        }
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-store-preview"),
           let url = Bundle.main.url(forResource: "StorePreview", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let fleet = try? JSONDecoder().decode(Fleet.self, from: data) {
            connection = Connection(name: "Preview Mac", host: "preview.tailnet.ts.net", port: 8810)
            state.hydrate(fleet)
            // StorePreview bots all select instanceId "preview"; seed the
            // driver map so the chat-header provider mark appears in the
            // screenshot harness (no live client to warm from).
            instanceDriverKinds = ["preview": "claude"]
            status = .live
            return
        }
#endif
        restore()
        Task { await refreshNotificationAuthorization() }
    }

    /// Drop coalesced settings PATCHes when the paired computer changes so a
    /// queued mode, terminology, name, email, toggle, or timeout cannot land
    /// on the next pairing.  Also detach `settingsUpdateTail` so the next
    /// pairing does not await an in-flight request that still targets the
    /// previous computer (and its request timeout).
    private func cancelPendingSettingsMutations() {
        pendingConversationMode = nil
        pendingConversationMergeThreads = false
        pendingConversationModeSet = false
        pendingTerminology = nil
        pendingTerminologyCustom = nil
        pendingTerminologySet = false
        pendingFeaturesShowToolCalls = nil
        pendingFeaturesSummarizeToolCalls = nil
        pendingProfileName = nil
        pendingProfileEmail = nil
        pendingProfileHasName = false
        pendingProfileHasEmail = false
        pendingRoomTurnTimeoutMinutes = nil
        pendingRoomTurnTimeout = false
        settingsUpdateGeneration += 1
        // Detach before cancel so a concurrent enqueue cannot re-chain onto
        // this task after we bump the generation.
        let abandoned = settingsUpdateTail
        settingsUpdateTail = nil
        abandoned?.cancel()
    }

    /// Rebuild the last connection at launch.
    ///
    /// Three outcomes, and keeping them apart is the whole point. No saved
    /// connection: stay unpaired. A saved connection whose token reads back:
    /// connect. A saved connection whose token cannot be read *yet* — the
    /// locked keychain before a phone's first unlock after reboot, which is
    /// when iOS is most likely to have launched us in the background — hold
    /// on to it and try again. Only the middle case is a real pairing, and
    /// only the first should ever send someone back to the pairing screen.
    private func restore() {
        restorePending = false
        guard let data = UserDefaults.standard.data(forKey: Self.connectionKey),
              let saved = try? JSONDecoder().decode(Connection.self, from: data)
        else { return }

        let stored: String?
        do {
            stored = try Keychain.token(for: saved.id)
        } catch {
            // Keep the connection and say why. `.offline` rather than
            // `.unpaired` matters: the latter is what puts PairingView on
            // screen, and asking for a new code is the one recovery that
            // costs a walk to the computer.
            connection = saved
            restorePending = true
            status = .offline(
                (error as? KeychainError)?.isLocked == true
                    ? "Unlock this phone to reach your computer."
                    : error.localizedDescription
            )
            return
        }
        guard let stored else { return } // no token: genuinely not paired

        connection = saved
        token = stored
        // New connections honor the desktop's transport policy. Automatic
        // walking is credential-safe: protected routes stay protected, while
        // a legacy/local route is only tried when it was the exact saved route.
        rotation = CandidateRotation(endpoints: saved.orderedEndpoints)
        let first = rotation.currentEndpoint.map(saved.dialing) ?? saved
        client = CompanionClient(connection: first, token: stored)
        pairingGeneration += 1
        cancelPendingSettingsMutations()
        cachedInstances = []
        status = .connecting
    }

    /// Redeem a one-time pairing credential. On success the device token goes
    /// to the keychain and the connection to defaults — deliberately apart,
    /// so the thing that gets backed up is never the credential.
    func pair(
        with connection: Connection,
        credential: String,
        deviceName: String,
        pairRequestId: String
    ) async throws {
        var invited = connection
        // QR invites already carry this policy. Manual entry reaches the
        // session as a parsed Connection, so establish the same consent
        // boundary here before any health probe or credential redemption.
        if invited.allowedRouteKinds == nil {
            invited.establishRoutePolicyFromInvite()
        }
        let outcome = try await CompanionClient.pairFirstReachable(
            connection: invited,
            credential: credential,
            deviceName: deviceName,
            pairRequestId: pairRequestId
        )
        let paired = outcome.response
        // prefer the name the computer calls itself over the Bonjour label
        var stored = outcome.connection
        if !paired.serverName.isEmpty { stored.name = paired.serverName }
        // The computer knows every address it answers on, but redemption may
        // not widen the explicit route consent carried by the invite.
        stored.applyPairingAdvertisement(hosts: paired.hosts, endpoints: paired.endpoints)
        let winner = outcome.connection.activeEndpoint ?? CompanionEndpoint.direct(
            host: outcome.connection.host,
            port: outcome.connection.port,
            priority: 10_000
        )
        if let winner { stored.promote(winner) }
        if stored.endpoints?.isEmpty != false {
            stored.hosts = Array(stored.orderedHosts.prefix(8))
        }

        try Keychain.save(paired.token, for: stored.id)
        // Write the first-pair education marker before making the connection
        // restorable. If the process stops between these writes, an orphan
        // marker is harmless while unpaired; the reverse order could restore
        // a pairing which permanently skipped this step.
        // RootView may not have received iOS's notification status yet, and
        // the app may be relaunched before that asynchronous lookup finishes.
        CompanionPairingCommitSequence.persist {
            UserDefaults.standard.set(
                true,
                forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
            )
        } saveConnection: {
            UserDefaults.standard.set(
                try? JSONEncoder().encode(stored),
                forKey: Self.connectionKey
            )
        }

        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .pairingSucceeded
        )
        self.connection = stored
        self.token = paired.token
        let liveRoutes = winner.map { route in
            [route] + stored.orderedEndpoints.filter { $0.url != route.url }
        } ?? stored.orderedEndpoints
        self.rotation = CandidateRotation(endpoints: liveRoutes)
        self.client = CompanionClient(
            connection: winner.map(stored.dialing) ?? stored,
            token: paired.token
        )
        pairingGeneration += 1
        cancelPendingSettingsMutations()
        self.state = CompanionState()
        instanceDriverKinds = [:]
        cachedInstances = []
        // A fresh pairing settles any restore that was still waiting on the
        // keychain — the token is in hand, so there is nothing left to retry.
        restorePending = false
        connect()
    }

    func receiveOpenURL(_ url: URL) {
        if let link = ChatDeepLink.parse(url) {
            Task { await openChat(botId: link.botId, threadId: link.threadId) }
            return
        }
        receivePairingURL(url)
    }

    func receivePairingURL(_ url: URL) {
        guard CompanionPairingInvitePolicy.allowsIncomingInvite(
            hasConnection: connection != nil,
            pairingStateIsUnpaired: status == .unpaired
        ) else {
            actionError = "This phone is already paired. Unpair it in Settings before connecting it to another computer."
            return
        }
        guard let invite = PairingInvite.parse(url) else {
            actionError = "That pairing invitation is not valid. Start pairing again on your computer."
            return
        }
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .received(invite)
        )
    }

    func consumePairingInvite() {
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .consumed
        )
    }

    func signOut() {
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        macUpdatePollTask?.cancel()
        macUpdatePollTask = nil
        macUpdateContactLost = false
        restorePending = false
        pendingNotification = nil
        pairingInvite = CompanionPairingInvitePolicy.nextInvite(
            current: pairingInvite,
            after: .signedOut
        )
        if let id = connection?.id { Keychain.remove(id) }
        UserDefaults.standard.removeObject(forKey: Self.connectionKey)
        UserDefaults.standard.removeObject(
            forKey: CompanionOnboardingPreferences.pendingNotificationOnboardingKey
        )
        // The sidecar forgets this device's token when the pairing is
        // removed, so a later re-pair to the very same Mac must be free to
        // post again even if the token itself never changed.
        UserDefaults.standard.removeObject(forKey: Self.postedPushTokenKey)
        connection = nil
        client = nil
        token = nil
        rotation = CandidateRotation(hosts: [])
        state = CompanionState()
        pushSenderHealth = nil
        pushSenderHealthNotReported = false
        instanceDriverKinds = [:]
        cachedInstances = []
        pairingGeneration += 1
        cancelPendingSettingsMutations()
        resetAvatarCache()
        NotificationCoordinator.shared.setBadge(0)
        status = .unpaired
    }

    // MARK: - Lifecycle

    /// Called when the app comes to the front, and once at launch.
    func connect() {
        // A restore that found the keychain locked left `client` nil on
        // purpose. Coming to the front is the moment worth retrying on: the
        // app is on screen, so the phone is in someone's hand and unlocked.
        if client == nil, restorePending { restore() }
        if client != nil, let pendingNotification {
            self.pendingNotification = nil
            Task { [weak self] in await self?.openNotification(pendingNotification) }
        }
        // back before the grace period ran out: keep the stream, drop the task
        endLinger()
        guard client != nil else { return }
        if let existing = streamTask {
            if case .offline = status {
                existing.cancel()
                streamTask = nil
            } else {
                return
            }
        }
        reconnectBackoff.reset()
        streamGeneration += 1
        let generation = streamGeneration
        streamTask = Task { [weak self] in
            guard let self else { return }
            await self.run()
            guard self.streamGeneration == generation else { return }
            self.streamTask = nil
        }
    }

    /// Pull-to-refresh: reopen the stream, and hold the control open until
    /// the connection has actually settled one way or the other.
    ///
    /// `connect()` returns the moment the task is spawned, so a `refreshable`
    /// that only calls it snaps the spinner shut before a single byte has
    /// arrived — the gesture reads as "nothing happened", on precisely the
    /// occasion it exists for. Waiting for `status` to leave `.connecting`
    /// makes the spinner mean what it appears to mean; the deadline is there
    /// so a network that never answers still gives the control back.
    func refresh() async {
        restartStream()
        connect()
        let deadline = Date().addingTimeInterval(10)
        while status == .connecting, !Task.isCancelled, Date() < deadline {
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    /// Ask the harness to include this bot's computer in the stream, for as
    /// long as something is showing it.
    ///
    /// This costs a reconnect, which is the right trade: the alternative is
    /// a base64 desktop capture arriving every few seconds for the whole
    /// session, including on cellular, whether or not anyone is looking.
    /// The reconnect resumes from the cursor, so nothing is missed.
    func watchScreen(of botId: String) {
        let count = screenWatchers[botId, default: 0]
        screenWatchers[botId] = count + 1
        if count == 0 { restartStream() }
    }

    func stopWatchingScreen(of botId: String) {
        guard let count = screenWatchers[botId] else { return }
        if count > 1 {
            screenWatchers[botId] = count - 1
        } else {
            screenWatchers.removeValue(forKey: botId)
            state.clearScreen(botId)
            restartStream()
        }
    }

    /// Reopen the stream so its query string matches what we now want. The
    /// cursor survives, so this is a gap, not a reset.
    private func restartStream() {
        guard streamTask != nil else { return }
        streamTask?.cancel()
        streamTask = nil
        connect()
    }

    /// Called when the app leaves the screen. iOS will kill the connection
    /// anyway; dropping it deliberately means the cursor is written down at
    /// a known point instead of wherever the socket happened to die.
    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        endpointRefreshTask?.cancel()
        endpointRefreshTask = nil
        macUpdatePollTask?.cancel()
        macUpdatePollTask = nil
        macUpdateContactLost = false
        endLinger()
    }

    private var lingerTask: UIBackgroundTaskIdentifier = .invalid
    private var lingerSleep: Task<Void, Never>?

    /// Leaving the screen: keep the stream alive for the grace period iOS
    /// allows (~30 s) rather than cutting it at once, so an approval that
    /// lands right after you swipe home still reaches the notification
    /// banner and updates the badge.  The Live Activity lifecycle ends every
    /// activity the moment the app backgrounds, so this linger buys it
    /// nothing there — only the banner and badge benefit.  After that, iOS
    /// suspends us anyway; disconnect cleanly so the cursor is written down
    /// at a known point.
    func linger() {
        guard streamTask != nil, lingerTask == .invalid else { disconnect(); return }
        // A previous request can leave a sleeper behind when iOS refuses the
        // background assertion. Never let it outlive the assertion it belongs
        // to or disconnect a later linger window.
        lingerSleep?.cancel()
        lingerSleep = nil
        let task = UIApplication.shared.beginBackgroundTask(withName: "companion.linger") { [weak self] in
            // time is up before our own timer — the system wants us gone now
            self?.disconnect()
        }
        guard task != .invalid else { disconnect(); return }
        lingerTask = task
        lingerSleep = Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard !Task.isCancelled, let self, self.lingerTask != .invalid else { return }
            self.disconnect()
        }
    }

    private func endLinger() {
        lingerSleep?.cancel()
        lingerSleep = nil
        guard lingerTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(lingerTask)
        lingerTask = .invalid
    }

    private func run() async {
        while !Task.isCancelled {
            guard let client else { return }
            status = .connecting
            log.info("opening stream, cursor=\(self.state.cursor ?? "none", privacy: .public)")
            var isGatewayFailure = false
            var offlineMessage: String?
            do {
                // The query is fixed when the connection opens, so changing
                // it means a new connection — `restartStream()` cancels this
                // task and starts another. Cancellation is the only exit;
                // breaking out here instead would fall through to the "the
                // harness went away" path and flash a lost-connection banner
                // on what is actually a deliberate reconnect.
                for try await frame in try client.events(
                    since: state.cursor,
                    screens: !screenWatchers.isEmpty,
                    screenBotIds: Array(screenWatchers.keys).sorted()
                ) {
                    if Task.isCancelled { return }
                    reconnectBackoff.reset()

                    if case let .hello(cursor, resumed) = frame.frame {
                        log.info("stream live, resumed=\(resumed, privacy: .public)")
                        // false means the server could not replay the gap —
                        // the one case that costs a full hydrate. Commit the
                        // hello cursor only after that hydrate succeeds: if
                        // the request dies halfway through replay/hydration,
                        // reconnecting must still ask for the missing gap.
                        if !resumed {
                            coldHydration: while true {
                                switch try await hydrateSnapshot(using: client) {
                                case .applied:
                                    state.resetCursor(cursor)
                                    break coldHydration
                                case .newerState:
                                    // A local action changed state while the
                                    // snapshot loaded.  Fetch again before
                                    // accepting the hello cursor.
                                    continue
                                case .pairingChanged:
                                    return
                                }
                            }
                        }
                        status = .live
                        // Remember what actually carried the stream for
                        // display and legacy ordering. Typed routes retain
                        // their explicit security priority next launch.
                        rememberWorkingRoute()
                        refreshConnectionMetadata(using: client)
                        // Refresh provider marks after reconnect — instances
                        // may have changed while the phone was backgrounded.
                        Task { await self.warmInstanceDriverKinds() }
                        // The last frame this phone saw before the gap may
                        // have said a run was in progress — and the restart
                        // that gap likely IS took the connection down with
                        // whatever frame would have said it finished.  Ask
                        // once, here, rather than waiting on the poll loop's
                        // own interval to notice the reconnect happened.
                        if state.macUpdateStatus?.running != nil {
                            Task { await self.loadMacUpdateStatus() }
                        }
                        continue
                    }
                    state.apply(frame)
                    if case let .notify(notification) = frame.frame {
                        NotificationCoordinator.shared.deliver(notification, sequence: frame.seq)
                    }
                    NotificationCoordinator.shared.setBadge(state.unreadCount)
                    state.advance(to: frame.seq)
                    if case .updateStatus = frame.frame {
                        pollMacUpdateWhileRunning()
                    }
                }
                // the stream ended without an error — the harness went away
                log.notice("stream ended without an error")
                offlineMessage = "Lost the connection."
            } catch let error as APIError where error.isUnauthorized {
                log.error("stream refused: unauthorized")
                status = .unauthorized
                return
            } catch {
                // backgrounding cancels the stream on purpose; that is not a
                // failure to report, and it must not be retried
                if Task.isCancelled || error is CancellationError {
                    log.info("stream closed by us")
                    return
                }
                log.error("stream failed: \(error.localizedDescription, privacy: .public)")
                isGatewayFailure = ConnectionAdvice.isGatewayOutage(error)
                offlineMessage = failureMessage(for: error)
            }

            if Task.isCancelled { return }
            // 1s, 2s, 4s… to 15s ordinarily; the cap raises to 60s, with
            // ±25% jitter throughout, once `isGatewayFailure` has been true
            // for `ReconnectBackoff.gatewayEscalationThreshold` attempts in
            // a row — Cloudflare answering every attempt with a
            // 502/503/530-family status, which means the Mac's sidecar has
            // nothing listening rather than an ordinary network blip.  That
            // same run of failures is what flips the status to
            // `.macOffline` so the banner stops implying a quick retry will
            // help (IO11).
            let delay = reconnectBackoff.recordFailure(isGatewayFailure: isGatewayFailure)
            status = reconnectBackoff.isMacLikelyOffline ? .macOffline : .offline(offlineMessage ?? "Lost the connection.")
            try? await Task.sleep(nanoseconds: UInt64((delay * 1_000_000_000).rounded()))
        }
    }

    /// Fetch and apply one fleet snapshot without crossing either mutable
    /// boundary: a live reducer update or a pairing/client replacement.
    private func hydrateSnapshot(using requestClient: CompanionClient? = nil) async throws -> SnapshotHydrationOutcome {
        guard let requestClient = requestClient ?? client else { return .pairingChanged }
        let generation = pairingGeneration
        let hydrationToken = state.hydrationToken
        let previousBots = state.bots
        let previousRooms = state.rooms
        let previousMessages = state.messages
        let previousHasMore = state.hasMore
        let previousPending = state.pendingQueued
        let fleet = try await requestClient.fleet(messages: 50)
        try Task.checkCancellation()
        guard pairingGeneration == generation else { return .pairingChanged }
        guard state.hydrate(fleet, ifUnchangedSince: hydrationToken) else { return .newerState }
        log.info("hydrated \(fleet.bots.count, privacy: .public) bots, \(fleet.groups.count, privacy: .public) rooms")
        NotificationCoordinator.shared.setBadge(state.unreadCount)
        return .applied(changed:
            previousBots != state.bots ||
            previousRooms != state.rooms ||
            previousMessages != state.messages ||
            previousHasMore != state.hasMore ||
            previousPending != state.pendingQueued
        )
    }

    // MARK: - Which address to dial

    /// Turn a stream failure into advice a person can act on — and, when the
    /// failure is about the address rather than the pairing, move the dial to
    /// the next stored host so the retry that follows tries somewhere new.
    /// A 401 never reaches here: the unauthorized path returns above, which
    /// is what keeps a token problem from masquerading as an address walk.
    private func failureMessage(for error: Error) -> String {
        guard let connection else { return error.localizedDescription }
        let failed = rotation.currentEndpoint ?? connection.activeEndpoint ??
            CompanionEndpoint.direct(host: connection.host, port: connection.port, priority: 10_000)
        var next: String?
        if let candidate = rotation.advanceEndpoint(after: error), let token {
            client = CompanionClient(connection: connection.dialing(candidate), token: token)
            next = candidate.displayAddress
            log.info("advancing to companion route \(candidate.url, privacy: .public)")
        }
        if let urlError = error as? URLError {
            return ConnectionAdvice.message(
                for: urlError.code,
                host: failed?.displayAddress ?? connection.host,
                port: failed?.port ?? connection.port,
                tryingNext: next
            )
        }
        if let apiError = error as? APIError,
           case let .status(code, _) = apiError,
           ConnectionAdvice.shouldTryAnotherRoute(after: error) {
            return ConnectionAdvice.message(
                forGatewayStatus: code,
                host: failed?.displayAddress ?? connection.host,
                tryingNext: next
            )
        }
        return error.localizedDescription
    }

    /// Persist the route that carried a live stream. Legacy host lists promote
    /// it for the next launch; typed lists keep their explicit policy order.
    private func rememberWorkingRoute() {
        guard let winner = rotation.currentEndpoint, var updated = connection,
              updated.activeEndpoint?.url != winner.url else { return }
        updated.promote(winner)
        connection = updated
        UserDefaults.standard.set(try? JSONEncoder().encode(updated), forKey: Self.connectionKey)
    }

    /// Learn routes enabled after this phone originally paired. The endpoint
    /// response is authenticated with the existing device token and is a
    /// replacement snapshot, but failure is deliberately non-fatal: older
    /// sidecars return 404 and a transient refresh error must not tear down a
    /// perfectly healthy event stream.
    private func refreshConnectionMetadata(using sourceClient: CompanionClient) {
        guard let connectionID = connection?.id else { return }
        let workingEndpoint = rotation.currentEndpoint ?? sourceClient.connection.activeEndpoint
        endpointRefreshTask?.cancel()
        endpointRefreshTask = Task { [weak self] in
            do {
                let metadata = try await sourceClient.connectionMetadata()
                try Task.checkCancellation()
                guard let self,
                      self.connection?.id == connectionID,
                      self.client?.connection.baseURL == sourceClient.connection.baseURL,
                      var updated = self.connection
                else { return }

                updated.reconcile(metadata)
                self.connection = updated
                UserDefaults.standard.set(
                    try? JSONEncoder().encode(updated),
                    forKey: Self.connectionKey
                )

                // Keep the currently live route first until this stream ends.
                // CandidateRotation applies the same no-downgrade policy used
                // by pairing, while the saved connection uses advertised
                // security priorities on the next launch.
                let liveRoutes = workingEndpoint.map { route in
                    [route] + updated.orderedEndpoints.filter { $0.url != route.url }
                } ?? updated.orderedEndpoints
                self.rotation = CandidateRotation(endpoints: liveRoutes)
                log.info("refreshed \(metadata.endpoints.count, privacy: .public) companion routes")
            } catch is CancellationError {
                return
            } catch {
                log.debug("endpoint refresh unavailable: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Replace the stored address by hand, keeping the pairing and its token.
    /// False when the text does not parse as a host or host:port.
    @discardableResult
    func updateAddress(_ text: String) -> Bool {
        guard var updated = connection, let parsed = Connection.parse(text) else { return false }
        guard let endpoint = parsed.activeEndpoint ?? CompanionEndpoint.direct(
            host: parsed.host,
            port: parsed.port,
            priority: 0
        ) else { return false }
        updated.resetRoutePolicy(selecting: endpoint)
        connection = updated
        UserDefaults.standard.set(try? JSONEncoder().encode(updated), forKey: Self.connectionKey)
        rotation = CandidateRotation(endpoints: updated.orderedEndpoints)
        if let token {
            client = CompanionClient(connection: updated.dialing(endpoint), token: token)
        }
        // Dial the new address now rather than on the next backoff tick —
        // someone who just typed an address is watching the banner.
        restartStream()
        connect()
        return true
    }

    // MARK: - Actions
    //
    // Each of these does the thing and lets the event stream deliver the
    // result. The one exception is the user's own send: the draft clears
    // immediately, so a pending row stands in until the matching `message`
    // frame (or 202 queueId) lands. Everything else still waits on the
    // harness so the phone does not invent a second fold.

    @discardableResult
    func send(_ text: String, to chat: Chat, attachments: [PendingChatAttachment] = []) async -> Bool {
        guard let client else { return false }
        do {
            var prompt = text
            if !attachments.isEmpty {
                var uploaded: [ChatPromptAttachment] = []
                uploaded.reserveCapacity(attachments.count)
                for item in attachments {
                    let saved = try await client.uploadChatAttachment(
                        data: item.data,
                        mime: item.mime,
                        filename: item.name
                    )
                    uploaded.append(ChatPromptAttachment(kind: item.kind, path: saved.path))
                }
                prompt = ChatAttachments.composeMessage(text: text, attachments: uploaded)
            }
            guard !prompt.isEmpty else { return false }
            let threadId: String
            switch chat {
            case let .bot(bot): threadId = bot.threadId
            case let .room(room): threadId = room.threadId
            }
            let localId = UUID().uuidString
            state.rememberPendingSend(threadId: threadId, id: localId, text: prompt, queued: false)
            do {
                switch chat {
                case let .bot(bot):
                    let result = try await client.send(
                        text: prompt,
                        toBot: bot.id,
                        threadId: threadId,
                        idempotencyKey: localId
                    )
                    if result.queued == true, let queueId = result.queueId, !queueId.isEmpty {
                        let dest = result.threadId ?? bot.threadId
                        if dest != threadId {
                            state.cancelPendingQueued(threadId: threadId, queueId: localId)
                            state.rememberPendingQueued(threadId: dest, queueId: queueId, text: prompt)
                        } else {
                            state.promotePendingSend(threadId: dest, from: localId, to: queueId)
                        }
                    }
                case let .room(room):
                    try await client.send(
                        text: prompt,
                        toRoom: room.id,
                        threadId: threadId,
                        idempotencyKey: localId
                    )
                }
                return true
            } catch {
                state.cancelPendingQueued(threadId: threadId, queueId: localId)
                if let apiError = error as? APIError, apiError.isConflict {
                    await refreshAfterTaskConflict()
                }
                throw error
            }
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            return false
        } catch {
            recordActionError(error)
            return false
        }
    }

    /// iOS hands the device token back on almost every launch, unchanged —
    /// posting it unconditionally meant every launch was a POST the sidecar
    /// already had the answer to.  Skip it unless the token itself changed
    /// or the paired endpoint did (a token is meaningless to a *different*
    /// Mac, so re-pairing must still post it).  See IO17.
    func registerPushToken(_ hex: String) async {
        let candidate = PostedPushToken(
            token: hex,
            endpointURL: connection?.activeEndpoint?.url ?? connection?.host
        )
        let lastPosted = UserDefaults.standard.data(forKey: Self.postedPushTokenKey)
            .flatMap { try? JSONDecoder().decode(PostedPushToken.self, from: $0) }
        guard PushTokenRegistration.shouldPost(candidate, lastPosted: lastPosted) else { return }

        let posted = await perform(quietly: true) { try await $0.registerPushToken(hex) }
        guard posted, let data = try? JSONEncoder().encode(candidate) else { return }
        UserDefaults.standard.set(data, forKey: Self.postedPushTokenKey)
    }

    func cancelQueued(botId: String, queueId: String) async {
        guard let client else { return }
        func dropLocalChip() {
            if let threadId = state.bot(botId)?.threadId {
                state.cancelPendingQueued(threadId: threadId, queueId: queueId)
            } else {
                for (threadId, entries) in state.pendingQueued where entries.contains(where: { $0.queueId == queueId }) {
                    state.cancelPendingQueued(threadId: threadId, queueId: queueId)
                    break
                }
            }
        }
        do {
            try await client.cancelQueued(botId: botId, queueId: queueId)
            dropLocalChip()
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch let error as APIError where error.isNotFound {
            let message = error.errorDescription ?? ""
            if message.contains("no route") {
                // Packaged companion older than #224 deny-lists DELETE /queue/.
                // Dropping the chip locally would hide a message that still sends.
                actionError = "This Mac is running an older BotFleet.  Update BotFleet on your computer, then you can cancel a queued message."
            } else {
                dropLocalChip()
            }
        } catch {
            recordActionError(error)
        }
    }

    func answer(chat: Chat, card: OptionCard, choice: String) async {
        guard let requestId = card.requestId else { return }
        await answer(
            threadId: chat.threadId,
            requestId: requestId,
            choice: choice,
            isPermission: card.isPermission
        )
    }

    /// The same answer, from something that only has the ids — the Live
    /// Activity's buttons.  Returns whether it reached the harness; the
    /// intent ignores that, a notification action does not.
    ///
    /// `quietly` is for the callers with no screen to show a banner on.  A
    /// lock-screen Approve or Deny that fails is reported by its own
    /// follow-up notification, and writing `actionError` as well would raise
    /// the app-wide "Something went wrong" modal the next time the app is
    /// opened — over, and in place of, whatever message the user may have
    /// been reading.  It defaults to the existing behaviour so the in-app
    /// cards, the Live Activity and `AnswerApprovalIntent` are unchanged.
    @discardableResult
    func answer(
        threadId: String,
        requestId: String,
        choice: String,
        isPermission: Bool,
        quietly: Bool = false
    ) async -> Bool {
        return await perform(quietly: quietly) {
            // Permission cards answer allow/deny; a question answers with
            // the chosen text. The harness tells them apart by `behavior`.
            let behavior = OptionCard.responseBehavior(for: choice, isPermission: isPermission)
            if behavior != "answer" {
                try await $0.respond(
                    threadId: threadId,
                    requestId: requestId,
                    behavior: behavior
                )
            } else {
                try await $0.respond(threadId: threadId, requestId: requestId, behavior: "answer", message: choice)
            }
        }
    }

    /// A bare notification-action background launch gets a much smaller
    /// execution budget than the 15 s full background-fetch grant in
    /// `CompanionAppDelegate` — long enough for one hydrate-and-respond
    /// round trip, plus rebuilding the client first on a cold launch, short
    /// enough to stay well inside what iOS is likely to allow before
    /// reclaiming the process.
    private static let approvalActionTimeoutNanoseconds: UInt64 = 8_000_000_000

    /// Signals "this attempt could not even be made" (no client within the
    /// timeout, or the answer itself failed) to `BackgroundRefreshCoordinator`,
    /// which maps any thrown error to `.failed` — distinct from a clean
    /// `false` return, which means "answered nothing on purpose because the
    /// request was ambiguous."
    private struct ApprovalActionFailed: Error {}

    /// What answering a notification action actually accomplished.  The
    /// banner is gone the instant the user taps an action, so this is the
    /// only way a follow-up notification knows what to say.
    enum ApprovalActionOutcome: Equatable {
        case delivered
        case needsAppOpened
        case failed
    }

    /// Every pending approval the session knows about, flattened to the
    /// three fields the resolver needs.  A method on `Session`, which is
    /// `@MainActor`, so it reads `state` on the actor that owns it.
    private func pendingApprovalRecords() -> [PendingApproval] {
        state.pendingApprovals.compactMap { entry in
            guard let card = entry.message.card, let requestId = card.requestId else { return nil }
            return PendingApproval(
                threadId: entry.threadId,
                requestId: requestId,
                isPermission: card.isPermission
            )
        }
    }

    /// Approve or deny from a notification action — Approve/Deny on a lock
    /// screen banner, or the equivalent remote push.  Resolves which request
    /// to answer with `ApprovalResolver` — never by picking "whatever is
    /// pending on this thread", the bug PR #383's review caught, which can
    /// send a permission deny for a question or a text answer for a
    /// permission card.  Rebuilds the client first if the action
    /// cold-launched the process, the same bootstrap `openNotification`
    /// below already relies on, and bounds the whole attempt so the
    /// notification's completion handler is never left hanging.  Either way
    /// this defers to the same `answer(threadId:requestId:choice:isPermission:)`
    /// above, the one `AnswerApprovalIntent` calls — quietly, because a
    /// notification action has no screen to show an error on and must not
    /// clear a message the user may be looking at.
    @discardableResult
    func answerPendingRequest(target: NotificationTarget, approve: Bool) async -> ApprovalActionOutcome {
        if client == nil { connect() }

        let threadId = target.threadId
        let choice = approve ? "Approve" : "Deny"
        // Declared with the same shape as `CompanionAppDelegate.onRemoteRefresh`,
        // and reached the same way: `run` takes a plain `@Sendable` closure,
        // which is NOT isolated to anything, and `state` and `client` belong
        // to this main-actor type.  Naming the isolation here is what lets
        // the body read them at all.
        let attempt: @MainActor @Sendable () async throws -> Bool = {
            // Poll rather than fail on the first check: a cold launch may
            // still be rebuilding the client — `restore()` reading the
            // keychain — right now, and one moment later it may well exist.
            // No inner cap of its own: `run`'s 8 s deadline above is the
            // only timeout, and cancelling this sleep when that deadline
            // hits is what reaches `.failed` correctly.
            while self.client == nil {
                try await Task.sleep(nanoseconds: 100_000_000)
                self.connect()
            }
            guard let client = self.client else { throw ApprovalActionFailed() }

            var candidates = self.pendingApprovalRecords()
            if candidates.first(where: { $0.threadId == threadId }) == nil {
                // Nothing usable yet — an older harness never named the
                // request, or this is the first thing the session has
                // heard about it after a cold launch.
                _ = try? await self.hydrateSnapshot(using: client)
                candidates = self.pendingApprovalRecords()
            }

            switch ApprovalResolver.resolve(
                threadId: threadId, requestId: target.requestId, kind: target.kind, pending: candidates
            ) {
            case let .answer(requestId, isPermission):
                let sent = await self.answer(
                    threadId: threadId,
                    requestId: requestId,
                    choice: choice,
                    isPermission: isPermission,
                    // No screen to report on, and `ApprovalActionOutcome`
                    // already carries the failure to the follow-up banner.
                    quietly: true
                )
                if !sent { throw ApprovalActionFailed() }
                return true
            case .openApp:
                return false
            }
        }
        let bounded = await BackgroundRefreshCoordinator.run(
            timeoutNanoseconds: Self.approvalActionTimeoutNanoseconds
        ) { try await attempt() }

        let outcome: ApprovalActionOutcome
        switch bounded {
        case .newData: outcome = .delivered
        case .noData: outcome = .needsAppOpened
        case .failed: outcome = .failed
        }

        switch outcome {
        case .delivered:
            break
        case .needsAppOpened:
            // The same destination the explicit Open action already lands
            // on — prepared now so it is there the moment the app opens.
            await openNotification(target)
            NotificationCoordinator.shared.deliverFollowUp(
                title: "Open BotFleet to Answer",
                body: "Open the app to answer this request.",
                target: target
            )
        case .failed:
            NotificationCoordinator.shared.deliverFollowUp(
                title: "Couldn't Deliver That Answer",
                body: "Open BotFleet to try again.",
                target: target
            )
        }
        return outcome
    }

    /// Reply on a question notification, from a `UNTextInputNotificationAction`.
    ///
    /// Mirrors `answerPendingRequest(target:approve:)` exactly — the
    /// hydrate-or-poll-for-client dance, the `ApprovalResolver` lookup,
    /// the bounded background deadline, and the three follow-up banners
    /// are all the same problem under the hood.  Only the leaf call
    /// differs: we always send `behavior: "answer"` with the user's
    /// typed text, because a reply action is always free text on a
    /// question.
    @discardableResult
    func replyToPendingRequest(target: NotificationTarget, message: String) async -> ApprovalActionOutcome {
        if client == nil { connect() }

        let threadId = target.threadId
        let attempt: @MainActor @Sendable () async throws -> Bool = {
            while self.client == nil {
                try await Task.sleep(nanoseconds: 100_000_000)
                self.connect()
            }
            guard let client = self.client else { throw ApprovalActionFailed() }

            var candidates = self.pendingApprovalRecords()
            if candidates.first(where: { $0.threadId == threadId }) == nil {
                _ = try? await self.hydrateSnapshot(using: client)
                candidates = self.pendingApprovalRecords()
            }

            switch ApprovalResolver.resolve(
                threadId: threadId, requestId: target.requestId, kind: target.kind, pending: candidates
            ) {
            case let .answer(requestId, isPermission):
                // A reply is always free text; even on a permission card it
                // is the user opting to answer in their own words.  Pass
                // `isPermission: false` so `OptionCard.responseBehavior`
                // chooses `behavior: "answer"` with a body.
                let sent = await self.answer(
                    threadId: threadId,
                    requestId: requestId,
                    choice: message,
                    isPermission: false,
                    quietly: true
                )
                if !sent { throw ApprovalActionFailed() }
                return true
            case .openApp:
                return false
            }
        }
        let bounded = await BackgroundRefreshCoordinator.run(
            timeoutNanoseconds: Self.approvalActionTimeoutNanoseconds
        ) { try await attempt() }

        let outcome: ApprovalActionOutcome
        switch bounded {
        case .newData: outcome = .delivered
        case .noData: outcome = .needsAppOpened
        case .failed: outcome = .failed
        }

        switch outcome {
        case .delivered:
            break
        case .needsAppOpened:
            await openNotification(target)
            NotificationCoordinator.shared.deliverFollowUp(
                title: "Open BotFleet to Reply",
                body: "Open the app to send that reply.",
                target: target
            )
        case .failed:
            NotificationCoordinator.shared.deliverFollowUp(
                title: "Couldn't Deliver That Reply",
                body: "Open BotFleet to try again.",
                target: target
            )
        }
        return outcome
    }

    /// Refresh the APNs sender health cached for the Settings row.
    ///
    /// A 404 is the explicit success case for this method: it means the
    /// sidecar is older than PR #383 and does not report the route, which
    /// the row renders as `PushSenderHealthView.notReported`.  All other
    /// failures keep the previous cached value (Settings is informational,
    /// not an action), so a transient network blip never blanks the row.
    @discardableResult
    func refreshPushSenderHealth() async -> Bool {
        guard let client else { return false }
        do {
            let health = try await client.pushSenderHealth()
            pushSenderHealth = health
            pushSenderHealthNotReported = false
            return true
        } catch let error as APIError where error.isNotFound {
            pushSenderHealth = nil
            pushSenderHealthNotReported = true
            return false
        } catch {
            return false
        }
    }

    /// Make a new bot. The harness chooses its name, colour and greeting, so
    /// one made here is indistinguishable from one made on the desktop.
    ///
    /// Creating a bot does not broadcast — the desktop adds it optimistically
    /// too — so the new bot is folded in here rather than waited for. Return
    /// it so the caller can open it, which is the only reason anyone taps the
    /// button.
    @discardableResult
    func createBot() async -> Bot? {
        guard let client else { return nil }
        do {
            let bot = try await client.createBot()
            state.apply(.bot(bot))
            return bot
        } catch {
            recordActionError(error)
            return nil
        }
    }

    /// Make a room from the phone. Same shape as `createBot`: fold it in
    /// rather than wait for a broadcast, and hand it back so it can be opened.
    @discardableResult
    func createRoom(name: String?, memberIds: [String]) async -> Room? {
        guard let client else { return nil }
        do {
            let room = try await client.createRoom(name: name, memberIds: memberIds)
            state.apply(.room(room))
            return room
        } catch {
            recordActionError(error)
            return nil
        }
    }

    func interrupt(bot: Bot) async {
        guard let client else { return }
        do {
            try await client.interrupt(botId: bot.id, threadId: bot.threadId)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch let error as APIError where error.isConflict {
            await refreshAfterTaskConflict()
            recordActionError(error)
        } catch {
            recordActionError(error)
        }
    }

    func interrupt(room: Room) async {
        guard let client else { return }
        do {
            try await client.interrupt(groupId: room.id, threadId: room.threadId)
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
        } catch let error as APIError where error.isConflict {
            await refreshAfterTaskConflict()
            recordActionError(error)
        } catch {
            recordActionError(error)
        }
    }

    /// APNs background delivery refreshes the current snapshot without
    /// selecting a chat.  The delegate awaits this before reporting fetch
    /// completion, and `connect` keeps the event stream ready during the
    /// remaining background execution window.
    func refreshFromRemoteNotification() async throws -> Bool {
        if client == nil, restorePending { restore() }
        guard let client else { return false }
        connect()
        switch try await hydrateSnapshot(using: client) {
        case let .applied(changed): return changed
        case .newerState: return true
        case .pairingChanged: return false
        }
    }

    /// Wait for the current app-open to settle before local-only Live
    /// Activities are allowed to reappear, without issuing a second
    /// full-fleet fetch of our own on top of the one `connect()` may
    /// already be doing.
    ///
    /// `run()`'s hello handling already resumes the SSE cursor and, only
    /// when the hello frame reports `resumed: false`, performs the one cold
    /// hydration the app needs.  This used to call `hydrateSnapshot` here
    /// too, unconditionally — a second full-fleet download on every
    /// foreground even when the resume needed none at all (IO13).  So this
    /// now just waits for `connect()`'s own stream to reach `.live`, which
    /// covers both cases: a resumed stream needed no hydrate, and a cold
    /// one already got its hydrate from `run()` before flipping to `.live`.
    /// Only a stream that cannot settle within the deadline — resume not
    /// possible, or no route to the Mac yet — falls back to one direct
    /// hydrate here, so Live Activities still get *something*.
    func refreshLiveActivityState() async -> CompanionState? {
        var clientWaitBackoff = LiveActivityRefreshBackoff()
        while client == nil, !Task.isCancelled {
            if restorePending { restore() }
            guard client == nil else { break }
            let delay = clientWaitBackoff.takeNextDelay()
            try? await Task.sleep(nanoseconds: delay)
        }
        guard !Task.isCancelled, client != nil else { return nil }

        connect()
        let deadline = Date().addingTimeInterval(10)
        while !Task.isCancelled, Date() < deadline {
            switch status {
            case .live:
                return state
            case .unauthorized:
                return nil
            case .unpaired, .connecting, .offline, .macOffline:
                break
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        guard !Task.isCancelled else { return nil }

        // The stream did not settle in time — fall back to one direct
        // hydrate, with the same bounded retry the direct fetch always had.
        var retryBackoff = LiveActivityRefreshBackoff()
        while !Task.isCancelled {
            guard let requestClient = client else { return nil }
            do {
                switch try await hydrateSnapshot(using: requestClient) {
                case .applied:
                    return state
                case .newerState:
                    let delay = retryBackoff.takeNextDelay()
                    try? await Task.sleep(nanoseconds: delay)
                    continue
                case .pairingChanged:
                    continue
                }
            } catch is CancellationError {
                return nil
            } catch let error as APIError where error.isUnauthorized {
                status = .unauthorized
                return nil
            } catch {
                let delay = retryBackoff.takeNextDelay()
                try? await Task.sleep(nanoseconds: delay)
            }
        }
        return nil
    }

    private func refreshAfterTaskConflict() async {
        do {
            _ = try await hydrateSnapshot()
        } catch {
            restartStream()
            connect()
        }
    }

    /// Ask for one fresh cloud viewer URL. Unlike ordinary actions this
    /// returns the value to a browser sheet and never writes it to app state.
    func cloudDesktop(for bot: Bot) async throws -> URL {
        guard let client else { throw APIError.transport("This computer is offline.") }
        do {
            return try await client.cloudDesktop(botId: bot.id).url
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    /// Ask the paired Mac to open or unhide the BotFleet desktop app.
    func openDesktopApp() async throws {
        guard let client else { throw APIError.transport("This computer is not paired.") }
        do {
            try await client.openDesktopApp()
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            throw error
        }
    }

    func markRead(_ chat: Chat) async {
        await perform(quietly: true) {
            switch chat {
            case let .bot(bot): try await $0.markRead(botId: bot.id)
            case let .room(room): try await $0.markRead(roomId: room.id)
            }
        }
    }

    func loadOlder(threadId: String) async {
        guard let client, let oldest = state.transcript(forThread: threadId).first else { return }
        do {
            let page = try await client.messages(threadId: threadId, before: oldest.id, limit: 50)
            state.prepend(page, toThread: threadId)
        } catch {
            recordActionError(error)
        }
    }

    func image(threadId: String, messageId: String) async -> Data? {
        try? await client?.image(threadId: threadId, messageId: messageId)
    }

    func search(_ query: String) async -> [SearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2, let client else { return [] }
        do { return try await client.search(trimmed) }
        catch {
            recordActionError(error)
            return []
        }
    }

    /// Resolve a SQLite search hit into the live task/branch, load a page
    /// around it, and hand navigation the current chat record.
    func open(_ hit: SearchHit) async -> Chat? {
        guard let client else { return nil }
        do {
            if let botId = hit.botId, var bot = state.bot(botId) {
                if bot.threadId != hit.threadId {
                    bot = try await client.switchTask(botId: bot.id, threadId: hit.threadId)
                    state.apply(.bot(bot))
                }
                if !hit.onActivePath {
                    let leaf = try await client.setActiveBranch(botId: bot.id, messageId: hit.messageId)
                    state.apply(.thread(threadId: hit.threadId, activeLeafId: leaf))
                }
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return state.bot(bot.id).map(Chat.bot)
            }
            if let groupId = hit.groupId,
               let room = state.rooms.first(where: { $0.id == groupId }) {
                let page = try await client.messages(threadId: hit.threadId, around: hit.messageId)
                state.merge(page, intoThread: hit.threadId)
                focusedMessageId = hit.messageId
                return .room(room)
            }
        } catch { recordActionError(error) }
        return nil
    }

    func consumeFocus(_ messageId: String) {
        if focusedMessageId == messageId { focusedMessageId = nil }
    }

    func createTask(for bot: Bot, title: String?) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.createTask(botId: bot.id, title: title))) }
        catch { recordActionError(error) }
    }

    func switchTask(_ task: BotTask, for bot: Bot) async {
        guard let client, task.threadId != bot.threadId else { return }
        do { state.apply(.bot(try await client.switchTask(botId: bot.id, threadId: task.threadId))) }
        catch { recordActionError(error) }
    }

    func renameTask(_ task: BotTask, for bot: Bot, title: String) async {
        guard let client else { return }
        do {
            try await client.renameTask(botId: bot.id, threadId: task.threadId, title: title)
            await refresh()
        } catch { recordActionError(error) }
    }

    /// Snooze one thread, or wake it with nil.  Refreshes rather than
    /// guessing: the harness heals a deadline that has already passed, so
    /// what it hands back is the only reading of "asleep" worth painting.
    @discardableResult
    func snoozeTask(_ task: BotTask, for bot: Bot, snoozedUntil: Double?) async -> Bool {
        guard let client else { return false }
        do {
            try await client.snoozeTask(botId: bot.id, threadId: task.threadId, snoozedUntil: snoozedUntil)
            await refresh()
            return true
        } catch {
            recordActionError(error)
            return false
        }
    }

    func deleteTask(_ task: BotTask, for bot: Bot) async {
        guard let client else { return }
        do { state.apply(.bot(try await client.deleteTask(botId: bot.id, threadId: task.threadId))) }
        catch { recordActionError(error) }
    }

    // MARK: - Agent profile

    @MainActor
    func updateRoom(
        id: String,
        name: String?,
        bulletin: String?,
        avatarCrop: AvatarCrop?,
        cwd: String? = nil,
        extraCwds: [String]? = nil,
        defaultResponder: GroupResponder? = nil,
        memberIds: [String]? = nil
    ) async -> Bool {
        guard let client else { return false }
        do {
            let patch = RoomPatch(
                name: name,
                bulletin: bulletin,
                avatarCrop: avatarCrop,
                cwd: cwd,
                extraCwds: extraCwds,
                defaultResponder: defaultResponder,
                memberIds: memberIds
            )
            let updated = try await client.updateRoom(id: id, patch: patch)
            if state.rooms.contains(where: { $0.id == updated.id }) {
                state.apply(.room(updated))
            }
            return true
        } catch {
            recordActionError(error)
            return false
        }
    }

    @MainActor
    func updateRoomAvatar(id: String, avatarUrl: String?) async {
        guard let client else { return }
        do {
            let urlVal: BotProfilePatch.AvatarURL?
            if let url = avatarUrl {
                urlVal = .set(url)
            } else {
                urlVal = .clear
            }
            let currentCrop = state.rooms.first(where: { $0.id == id })?.avatarCrop ?? .rounded
            let patch = RoomPatch(avatarUrl: urlVal, avatarCrop: currentCrop)
            let updated = try await client.updateRoom(id: id, patch: patch)
            if state.rooms.contains(where: { $0.id == updated.id }) {
                state.apply(.room(updated))
            }
        } catch {
            recordActionError(error)
        }
    }

    @MainActor
    func uploadRoomAvatar(id: String, data: Data, mime: String) async {
        guard let client else { return }
        do {
            let url = try await client.uploadAvatar(data: data, mime: mime)
            await updateRoomAvatar(id: id, avatarUrl: url)
        } catch {
            recordActionError(error)
        }
    }

    @MainActor
    func updateProfile(_ patch: BotProfilePatch, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.updateProfile(botId: bot.id, patch: patch)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            recordActionError(error)
            return nil
        }
    }

    func uploadAvatar(_ data: Data, mime: String, for bot: Bot, crop: AvatarCrop) async -> Bot? {
        guard let client else { return nil }
        do {
            let avatarUrl = try await client.uploadAvatar(data: data, mime: mime)
            guard !Task.isCancelled else { return nil }
            let current = state.bot(bot.id) ?? bot
            return await updateProfile(
                BotProfilePatch(avatarUrl: .set(avatarUrl), avatarCrop: crop),
                for: current
            )
        } catch {
            recordActionError(error)
            return nil
        }
    }

    func generateAvatar(prompt: String, for bot: Bot) async -> Bot? {
        guard let client else { return nil }
        do {
            let updated = try await client.generateAvatar(botId: bot.id, prompt: prompt)
            guard !Task.isCancelled else { return nil }
            state.apply(.bot(updated))
            return updated
        } catch {
            recordActionError(error)
            return nil
        }
    }

    func avatarData(forPath path: String?) async -> Data? {
        guard let path = path, let client else { return nil }
        let key = path as NSString
        if let cached = avatarCache.object(forKey: key) { return cached as Data }
        let generation = avatarCacheGeneration
        let fetch: (id: UUID, task: Task<Data?, Never>)
        if let pending = avatarFetches[path] {
            fetch = pending
        } else {
            let pending = (
                id: UUID(),
                task: Task<Data?, Never> { try? await client.avatar(path: path) }
            )
            avatarFetches[path] = pending
            fetch = pending
        }
        let data = await fetch.task.value
        if avatarFetches[path]?.id == fetch.id { avatarFetches.removeValue(forKey: path) }
        guard !Task.isCancelled, generation == avatarCacheGeneration, let data else { return nil }
        avatarCache.setObject(data as NSData, forKey: key, cost: data.count)
        return data
    }

    private func resetAvatarCache() {
        avatarCacheGeneration += 1
        for fetch in avatarFetches.values { fetch.task.cancel() }
        avatarFetches.removeAll()
        avatarCache.removeAllObjects()
    }

    func voiceOptions() async -> [Voice] {
        guard let client else { return [] }
        do { return try await client.voices() }
        catch { recordActionError(error); return [] }
    }

    func previewVoice(_ voiceId: String, for bot: Bot) async -> Data? {
        guard let client else { return nil }
        do { return try await client.previewVoice(text: "Hello, I'm \(bot.name).", voiceId: voiceId) }
        catch { recordActionError(error); return nil }
    }

    @MainActor
    func configStatus() async -> ConfigStatus? {
        // Departure can await saveProfile() then enqueue saveRoomTimeout(),
        // replacing `settingsUpdateTail` and bumping generation while a single
        // await of the prior tail is suspended.  Keep awaiting until generation
        // is unchanged across an await of the current tail (tail stable), then
        // capture that generation for the GET guard so we never run concurrent
        // with a replacement PATCH and apply a stale full status last.
        let generation: Int
        while true {
            let generationAtAwait = settingsUpdateGeneration
            _ = await settingsUpdateTail?.value
            if settingsUpdateGeneration == generationAtAwait {
                generation = generationAtAwait
                break
            }
        }
        guard let client else { return nil }
        let status = try? await client.config()
        guard let status else { return nil }
        guard settingsUpdateGeneration == generation else { return nil }
        self.config = status
        return status
    }

    @MainActor
    func updateConversationMode(_ conversationMode: String, mergeThreads: Bool = false) async -> ConfigStatus? {
        pendingConversationMode = conversationMode
        pendingConversationMergeThreads = mergeThreads
        pendingConversationModeSet = true
        let outcome = await enqueueSettingsUpdate()
        guard let outcome, outcome.conversationModeOK == true else { return nil }
        return outcome.status
    }

    @MainActor
    func updateTerminology(_ terminology: String, custom: RoomLabels? = nil) async -> ConfigStatus? {
        pendingTerminology = terminology
        pendingTerminologyCustom = custom
        pendingTerminologySet = true
        let outcome = await enqueueSettingsUpdate()
        guard let outcome, outcome.terminologyOK == true else { return nil }
        return outcome.status
    }

    @MainActor
    func updateFeatures(showToolCalls: Bool? = nil, summarizeToolCalls: Bool? = nil) async -> ConfigStatus? {
        if let showToolCalls {
            pendingFeaturesShowToolCalls = showToolCalls
        }
        if let summarizeToolCalls {
            pendingFeaturesSummarizeToolCalls = summarizeToolCalls
        }
        guard pendingFeaturesShowToolCalls != nil || pendingFeaturesSummarizeToolCalls != nil else {
            return config
        }
        let outcome = await enqueueSettingsUpdate()
        guard let outcome, outcome.featuresOK == true else { return nil }
        return outcome.status
    }

    @MainActor
    func updateRoomTurnTimeout(minutes: Int) async -> ConfigStatus? {
        pendingRoomTurnTimeoutMinutes = minutes
        pendingRoomTurnTimeout = true
        let outcome = await enqueueSettingsUpdate()
        guard let outcome, outcome.timeoutOK == true else { return nil }
        return outcome.status
    }

    @MainActor
    func updateProfile(name: String? = nil, email: String? = nil) async -> ConfigStatus? {
        // nil means omit (dirty-only PATCH).  Only non-nil args join the coalesce.
        if let name {
            pendingProfileName = name
            pendingProfileHasName = true
        }
        if let email {
            pendingProfileEmail = email
            pendingProfileHasEmail = true
        }
        guard pendingProfileHasName || pendingProfileHasEmail else { return config }
        let outcome = await enqueueSettingsUpdate()
        guard let outcome, outcome.profileOK == true else { return nil }
        return outcome.status
    }

    /// Chain one settings flush behind any in-flight full-config settings work.
    /// The latest generation drains every pending field group so a superseded
    /// task cannot leave another endpoint's coalesce stranded.  Superseded
    /// waiters follow `settingsUpdateTail` to that drain instead of treating
    /// latest-wins as a failed save.
    @MainActor
    private func enqueueSettingsUpdate() async -> SettingsFlushOutcome? {
        settingsUpdateGeneration += 1
        let generation = settingsUpdateGeneration
        let enqueuePairing = pairingGeneration
        let previous = settingsUpdateTail
        let task = Task<SettingsFlushOutcome?, Never> { @MainActor in
            _ = await previous?.value
            guard self.pairingGeneration == enqueuePairing else { return nil }
            // Latest-wins: a newer enqueue already holds our coalesced fields.
            // Return nil from this generation's task; the waiter below follows
            // the replacement tail so callers are not told the save failed.
            guard self.settingsUpdateGeneration == generation else { return nil }
            return await self.flushPendingSettingsMutations(
                enqueuePairing: enqueuePairing,
                generation: generation
            )
        }
        settingsUpdateTail = task
        if let outcome = await task.value {
            // Superseded flush may requeue failed fields into a newer generation
            // and still return a non-nil partial outcome (e.g. timeoutOK == false).
            // Follow that replacement like the nil supersession path so callers
            // are not told the save failed when the inheriting flush succeeds.
            if outcome.hasFailedMutation, settingsUpdateGeneration > generation {
                if let followed = await awaitSettingsFlushAfterSupersede(
                    generation: generation,
                    enqueuePairing: enqueuePairing
                ) {
                    return outcome.mergingRequeuedFollow(from: followed)
                }
            }
            return outcome
        }
        return await awaitSettingsFlushAfterSupersede(
            generation: generation,
            enqueuePairing: enqueuePairing
        )
    }

    /// After latest-wins skips our generation, await the flush that inherited
    /// our pending fields so `updateRoomTurnTimeout` (and siblings) observe
    /// that outcome instead of a false nil / "Could not save".
    @MainActor
    private func awaitSettingsFlushAfterSupersede(
        generation: Int,
        enqueuePairing: Int
    ) async -> SettingsFlushOutcome? {
        var accumulated: SettingsFlushOutcome?
        while true {
            guard pairingGeneration == enqueuePairing else { return nil }
            let generationAtAwait = settingsUpdateGeneration
            // We were still the tip and finished with nil → real failure / empty.
            guard generationAtAwait > generation else { return accumulated }
            guard let tail = settingsUpdateTail else { return accumulated }
            let outcome = await tail.value
            if let outcome {
                let merged = accumulated.map { $0.mergingRequeuedFollow(from: outcome) } ?? outcome
                // Superseded partial failure: failed fields were requeued into a
                // newer flush — keep following, preserving any successes already
                // confirmed in this chain.
                if merged.hasFailedMutation, settingsUpdateGeneration > generationAtAwait {
                    accumulated = merged
                    continue
                }
                return merged
            }
            // That tail was also superseded. Loop if a newer generation exists.
            if settingsUpdateGeneration == generationAtAwait {
                return accumulated
            }
        }
    }


    /// After a mid-flush supersede, restore profile fields that were snapshotted
    /// but never PATCHed, skipping any field a newer call already coalesced.
    @MainActor
    private func requeueUnsentProfileAfterSupersede(
        sendName: String?,
        sendEmail: String?,
        hadProfile: Bool
    ) {
        guard hadProfile else { return }
        if let sendName, !pendingProfileHasName {
            pendingProfileName = sendName
            pendingProfileHasName = true
        }
        if let sendEmail, !pendingProfileHasEmail {
            pendingProfileEmail = sendEmail
            pendingProfileHasEmail = true
        }
    }

    @MainActor
    private func requeueUnsentTimeoutAfterSupersede(
        timeoutMinutes: Int?,
        hadTimeout: Bool
    ) {
        guard hadTimeout, let timeoutMinutes, !pendingRoomTurnTimeout else { return }
        pendingRoomTurnTimeoutMinutes = timeoutMinutes
        pendingRoomTurnTimeout = true
    }

    @MainActor
    private func requeueUnsentConversationModeAfterSupersede(
        mode: String?,
        mergeThreads: Bool,
        hadMode: Bool
    ) {
        guard hadMode, let mode, !pendingConversationModeSet else { return }
        pendingConversationMode = mode
        pendingConversationMergeThreads = mergeThreads
        pendingConversationModeSet = true
    }

    @MainActor
    private func requeueUnsentTerminologyAfterSupersede(
        terminology: String?,
        custom: RoomLabels?,
        hadTerminology: Bool
    ) {
        guard hadTerminology, let terminology, !pendingTerminologySet else { return }
        pendingTerminology = terminology
        pendingTerminologyCustom = custom
        pendingTerminologySet = true
    }

    @MainActor
    private func requeueUnsentFeaturesAfterSupersede(
        show: Bool?,
        summarize: Bool?
    ) {
        if show != nil, pendingFeaturesShowToolCalls == nil {
            pendingFeaturesShowToolCalls = show
        }
        if summarize != nil, pendingFeaturesSummarizeToolCalls == nil {
            pendingFeaturesSummarizeToolCalls = summarize
        }
    }

    /// Re-queue every still-unsent snapshot after a mid-flush supersede.
    @MainActor
    private func requeueUnsentAfterSupersede(
        mode: String?,
        mergeThreads: Bool,
        hadMode: Bool,
        terminology: String?,
        terminologyCustom: RoomLabels?,
        hadTerminology: Bool,
        show: Bool?,
        summarize: Bool?,
        sendName: String?,
        sendEmail: String?,
        hadProfile: Bool,
        timeoutMinutes: Int?,
        hadTimeout: Bool
    ) {
        requeueUnsentConversationModeAfterSupersede(
            mode: mode,
            mergeThreads: mergeThreads,
            hadMode: hadMode
        )
        requeueUnsentTerminologyAfterSupersede(
            terminology: terminology,
            custom: terminologyCustom,
            hadTerminology: hadTerminology
        )
        requeueUnsentFeaturesAfterSupersede(show: show, summarize: summarize)
        requeueUnsentProfileAfterSupersede(
            sendName: sendName,
            sendEmail: sendEmail,
            hadProfile: hadProfile
        )
        requeueUnsentTimeoutAfterSupersede(
            timeoutMinutes: timeoutMinutes,
            hadTimeout: hadTimeout
        )
    }

    /// Snapshot and send whatever settings fields are pending, in a fixed order.
    /// Confirmed applies still update `config` for this pairing; a mid-flush
    /// generation bump stops further PATCHes so the newer tail can drain what
    /// remains (including requeued fields after a superseded failure).  When a
    /// PATCH fails, a recovery GET still refreshes `config` for display, but
    /// the matching OK flag stays false so callers do not advance dirty baselines.
    @MainActor
    private func flushPendingSettingsMutations(
        enqueuePairing: Int,
        generation: Int
    ) async -> SettingsFlushOutcome? {
        let mode = pendingConversationModeSet ? pendingConversationMode : nil
        let mergeThreads = pendingConversationMergeThreads
        let hadMode = pendingConversationModeSet
        pendingConversationModeSet = false
        pendingConversationMode = nil
        pendingConversationMergeThreads = false

        let terminology = pendingTerminologySet ? pendingTerminology : nil
        let terminologyCustom = pendingTerminologySet ? pendingTerminologyCustom : nil
        let hadTerminology = pendingTerminologySet
        pendingTerminologySet = false
        pendingTerminology = nil
        pendingTerminologyCustom = nil

        let show = pendingFeaturesShowToolCalls
        let summarize = pendingFeaturesSummarizeToolCalls
        pendingFeaturesShowToolCalls = nil
        pendingFeaturesSummarizeToolCalls = nil

        let sendName = pendingProfileHasName ? pendingProfileName : nil
        let sendEmail = pendingProfileHasEmail ? pendingProfileEmail : nil
        let hadProfile = pendingProfileHasName || pendingProfileHasEmail
        pendingProfileHasName = false
        pendingProfileHasEmail = false
        pendingProfileName = nil
        pendingProfileEmail = nil

        let timeoutMinutes = pendingRoomTurnTimeout ? pendingRoomTurnTimeoutMinutes : nil
        let hadTimeout = pendingRoomTurnTimeout
        pendingRoomTurnTimeout = false
        pendingRoomTurnTimeoutMinutes = nil

        guard hadMode || hadTerminology || show != nil || summarize != nil || hadProfile || hadTimeout else {
            return SettingsFlushOutcome(status: config)
        }
        guard let client else { return nil }

        var outcome = SettingsFlushOutcome(status: config)
        var latest = config

        func applyRecoveryConfig() async {
            if let status = try? await client.config(),
               pairingGeneration == enqueuePairing,
               settingsUpdateGeneration == generation {
                config = status
                latest = status
                outcome.status = status
            }
        }

        if hadMode, let mode {
            do {
                let updated = try await client.updateConversationMode(mode, mergeThreads: mergeThreads)
                guard pairingGeneration == enqueuePairing else {
                    return SettingsFlushOutcome(status: updated, conversationModeOK: true)
                }
                config = updated
                latest = updated
                outcome.status = updated
                outcome.conversationModeOK = true
            } catch {
                guard pairingGeneration == enqueuePairing else { return outcome }
                if settingsUpdateGeneration != generation {
                    requeueUnsentAfterSupersede(
                        mode: mode,
                        mergeThreads: mergeThreads,
                        hadMode: true,
                        terminology: terminology,
                        terminologyCustom: terminologyCustom,
                        hadTerminology: hadTerminology,
                        show: show,
                        summarize: summarize,
                        sendName: sendName,
                        sendEmail: sendEmail,
                        hadProfile: hadProfile,
                        timeoutMinutes: timeoutMinutes,
                        hadTimeout: hadTimeout
                    )
                    outcome.conversationModeOK = false
                    return outcome
                }
                recordActionError(error)
                outcome.conversationModeOK = false
                await applyRecoveryConfig()
            }
            if settingsUpdateGeneration != generation || pairingGeneration != enqueuePairing {
                requeueUnsentAfterSupersede(
                    mode: nil,
                    mergeThreads: false,
                    hadMode: false,
                    terminology: terminology,
                    terminologyCustom: terminologyCustom,
                    hadTerminology: hadTerminology,
                    show: show,
                    summarize: summarize,
                    sendName: sendName,
                    sendEmail: sendEmail,
                    hadProfile: hadProfile,
                    timeoutMinutes: timeoutMinutes,
                    hadTimeout: hadTimeout
                )
                return outcome
            }
        }

        if hadTerminology, let terminology {
            do {
                let updated = try await client.updateTerminology(terminology, custom: terminologyCustom)
                guard pairingGeneration == enqueuePairing else {
                    return SettingsFlushOutcome(status: updated, terminologyOK: true)
                }
                config = updated
                latest = updated
                outcome.status = updated
                outcome.terminologyOK = true
            } catch {
                guard pairingGeneration == enqueuePairing else { return outcome }
                if settingsUpdateGeneration != generation {
                    requeueUnsentAfterSupersede(
                        mode: nil,
                        mergeThreads: false,
                        hadMode: false,
                        terminology: terminology,
                        terminologyCustom: terminologyCustom,
                        hadTerminology: true,
                        show: show,
                        summarize: summarize,
                        sendName: sendName,
                        sendEmail: sendEmail,
                        hadProfile: hadProfile,
                        timeoutMinutes: timeoutMinutes,
                        hadTimeout: hadTimeout
                    )
                    outcome.terminologyOK = false
                    return outcome
                }
                recordActionError(error)
                outcome.terminologyOK = false
                await applyRecoveryConfig()
            }
            if settingsUpdateGeneration != generation || pairingGeneration != enqueuePairing {
                requeueUnsentAfterSupersede(
                    mode: nil,
                    mergeThreads: false,
                    hadMode: false,
                    terminology: nil,
                    terminologyCustom: nil,
                    hadTerminology: false,
                    show: show,
                    summarize: summarize,
                    sendName: sendName,
                    sendEmail: sendEmail,
                    hadProfile: hadProfile,
                    timeoutMinutes: timeoutMinutes,
                    hadTimeout: hadTimeout
                )
                return outcome
            }
        }

        if show != nil || summarize != nil {
            do {
                let updated = try await client.updateFeatures(
                    showToolCalls: show,
                    summarizeToolCalls: summarize
                )
                guard pairingGeneration == enqueuePairing else {
                    return SettingsFlushOutcome(status: updated, featuresOK: true)
                }
                config = updated
                latest = updated
                outcome.status = updated
                outcome.featuresOK = true
            } catch {
                guard pairingGeneration == enqueuePairing else { return outcome }
                if settingsUpdateGeneration != generation {
                    requeueUnsentAfterSupersede(
                        mode: nil,
                        mergeThreads: false,
                        hadMode: false,
                        terminology: nil,
                        terminologyCustom: nil,
                        hadTerminology: false,
                        show: show,
                        summarize: summarize,
                        sendName: sendName,
                        sendEmail: sendEmail,
                        hadProfile: hadProfile,
                        timeoutMinutes: timeoutMinutes,
                        hadTimeout: hadTimeout
                    )
                    outcome.featuresOK = false
                    return outcome
                }
                recordActionError(error)
                outcome.featuresOK = false
                // Keep going so a feature failure does not drop a pending
                // profile or timeout that shared this flush snapshot.
                await applyRecoveryConfig()
            }
            if settingsUpdateGeneration != generation || pairingGeneration != enqueuePairing {
                requeueUnsentAfterSupersede(
                    mode: nil,
                    mergeThreads: false,
                    hadMode: false,
                    terminology: nil,
                    terminologyCustom: nil,
                    hadTerminology: false,
                    show: nil,
                    summarize: nil,
                    sendName: sendName,
                    sendEmail: sendEmail,
                    hadProfile: hadProfile,
                    timeoutMinutes: timeoutMinutes,
                    hadTimeout: hadTimeout
                )
                return outcome
            }
        }

        if hadProfile, sendName != nil || sendEmail != nil {
            do {
                let updated = try await client.updateProfile(name: sendName, email: sendEmail)
                guard pairingGeneration == enqueuePairing else {
                    return SettingsFlushOutcome(status: updated, profileOK: true)
                }
                config = updated
                latest = updated
                outcome.status = updated
                outcome.profileOK = true
            } catch {
                guard pairingGeneration == enqueuePairing else { return outcome }
                if settingsUpdateGeneration != generation {
                    requeueUnsentAfterSupersede(
                        mode: nil,
                        mergeThreads: false,
                        hadMode: false,
                        terminology: nil,
                        terminologyCustom: nil,
                        hadTerminology: false,
                        show: nil,
                        summarize: nil,
                        sendName: sendName,
                        sendEmail: sendEmail,
                        hadProfile: true,
                        timeoutMinutes: timeoutMinutes,
                        hadTimeout: hadTimeout
                    )
                    outcome.profileOK = false
                    return outcome
                }
                recordActionError(error)
                outcome.profileOK = false
                // Continue so a pending timeout in this snapshot still sends.
                await applyRecoveryConfig()
            }
            if settingsUpdateGeneration != generation || pairingGeneration != enqueuePairing {
                requeueUnsentTimeoutAfterSupersede(
                    timeoutMinutes: timeoutMinutes,
                    hadTimeout: hadTimeout
                )
                return outcome
            }
        }

        if hadTimeout, let timeoutMinutes {
            do {
                let updated = try await client.updateRoomTurnTimeout(minutes: timeoutMinutes)
                guard pairingGeneration == enqueuePairing else {
                    return SettingsFlushOutcome(status: updated, timeoutOK: true)
                }
                config = updated
                latest = updated
                outcome.status = updated
                outcome.timeoutOK = true
            } catch {
                guard pairingGeneration == enqueuePairing else { return outcome }
                if settingsUpdateGeneration != generation {
                    requeueUnsentTimeoutAfterSupersede(
                        timeoutMinutes: timeoutMinutes,
                        hadTimeout: true
                    )
                    outcome.timeoutOK = false
                    return outcome
                }
                recordActionError(error)
                outcome.timeoutOK = false
                // Refresh display from server, but keep timeoutOK false so
                // saveRoomTimeout does not advance savedRoomTimeout.
                await applyRecoveryConfig()
            }
        }

        outcome.status = latest
        return outcome
    }

    func instances() async -> [Instance] {
        guard let client else { return [] }
        let generation = pairingGeneration
        do {
            let fetched = try await client.instances()
            guard pairingGeneration == generation else { return fetched }
            cachedInstances = fetched
            instanceDriverKinds = Dictionary(
                fetched.map { ($0.instanceId, $0.driverKind) },
                uniquingKeysWith: { _, latest in latest }
            )
            return fetched
        } catch {
            recordActionError(error)
            if pairingGeneration == generation && !cachedInstances.isEmpty {
                return cachedInstances
            }
            return []
        }
    }

    /// Background warm of `instanceDriverKinds` for the chat-header provider
    /// mark. Failures stay silent so merely opening the chat list does not
    /// pop the global action-error alert when the paired computer is offline
    /// or the task is cancelled. Results are dropped if pairing changed
    /// mid-flight so a signed-out warm cannot poison the next computer.
    func warmInstanceDriverKinds() async {
        guard let client else { return }
        let generation = pairingGeneration
        do {
            let fetched = try await client.instances()
            guard pairingGeneration == generation else { return }
            cachedInstances = fetched
            instanceDriverKinds = Dictionary(
                fetched.map { ($0.instanceId, $0.driverKind) },
                uniquingKeysWith: { _, latest in latest }
            )
        } catch {
            // Quiet: connectivity / cancel while the roster is open.
        }
    }

    // MARK: - Routines

    func loadRoutines() async -> (routines: [Routine], runs: [RoutineRun]) {
        guard let client else { return ([], []) }
        do { return try await client.routines() }
        catch { recordActionError(error); return ([], []) }
    }

    func loadRoutineRunAvailability() async -> RoutineRunAvailability? {
        guard let client else { return nil }
        do {
            async let config = client.config()
            async let instances = client.instances()
            return try await RoutineRunAvailability(config: config, instances: instances)
        } catch {
            recordActionError(error)
            return nil
        }
    }

    func saveRoutine(_ input: RoutineInput, id: String?) async -> Routine? {
        guard let client else { return nil }
        do {
            if let id { return try await client.updateRoutine(id: id, input: input) }
            return try await client.createRoutine(input)
        } catch { recordActionError(error); return nil }
    }

    func setRoutineEnabled(_ routine: Routine, enabled: Bool) async -> Routine? {
        guard let client else { return nil }
        do { return try await client.setRoutineEnabled(id: routine.id, enabled: enabled) }
        catch { recordActionError(error); return nil }
    }

    func runRoutine(_ routine: Routine) async -> RoutineRun? {
        guard let client else { return nil }
        do { return try await client.runRoutine(id: routine.id) }
        catch { recordActionError(error); return nil }
    }

    func deleteRoutine(_ routine: Routine) async -> Bool {
        guard let client else { return false }
        do { try await client.deleteRoutine(id: routine.id); return true }
        catch { recordActionError(error); return false }
    }

    // MARK: - Notification navigation

    func openNotification(_ target: NotificationTarget) async {
        guard let client else {
            // Do not carry a stale destination into a future, unrelated
            // pairing. Only a saved connection waiting for Keychain access is
            // eligible for replay.
            if restorePending {
                pendingNotification = target
                connect()
            } else {
                actionError = "Pair this phone with your computer to open that task."
            }
            return
        }
        pendingNotification = nil
        do {
            var bot = state.bot(target.botId)
            if bot == nil {
                if case .pairingChanged = try await hydrateSnapshot(using: client) { return }
                bot = state.bot(target.botId)
            }
            // A room's approval/question notification carries the asker bot
            // with the ROOM's thread id — open the room rather than asking
            // the bot to switch to a thread it does not own (a 404).
            if let room = state.rooms.first(where: { $0.threadId == target.threadId }) {
                notificationChat = .room(room)
                return
            }
            guard var selected = bot else { throw APIError.status(code: 404, message: "That agent no longer exists.") }
            if target.requiresTaskSwitch(activeThreadId: selected.threadId) {
                do {
                    selected = try await client.switchTask(botId: selected.id, threadId: target.threadId)
                    state.apply(.bot(selected))
                } catch {
                    // The thread may be gone (task deleted, stale payload).
                    // Landing in the bot's current chat still beats an error
                    // banner and no navigation at all.
                }
            }
            notificationChat = .bot(selected)
        } catch { recordActionError(error) }
    }

    func consumeNotificationChat() { notificationChat = nil }

    /// Lock-screen Live Activity (and any `botfleet://chat` URL) lands on
    /// the named bot, switching task when the thread is not the active one.
    func openChat(botId: String, threadId: String) async {
        guard let target = NotificationTarget(botId: botId, threadId: threadId) else { return }
        await openNotification(target)
    }

    func react(to message: Message, in threadId: String, emoji: String) async {
        guard let client else { return }
        do {
            let patched = try await client.toggleReaction(threadId: threadId, messageId: message.id, emoji: emoji)
            state.apply(.messagePatch(threadId: threadId, message: patched))
        } catch { recordActionError(error) }
    }

    func edit(_ message: Message, for bot: Bot, text: String) async {
        await perform { try await $0.edit(botId: bot.id, messageId: message.id, text: text) }
    }

    func switchVersion(to message: Message, for bot: Bot) async {
        guard let client else { return }
        do {
            let leaf = try await client.setActiveBranch(botId: bot.id, messageId: message.id)
            state.apply(.thread(threadId: bot.threadId, activeLeafId: leaf))
        } catch { recordActionError(error) }
    }

    func export(threadId: String, format: String) async -> URL? {
        guard let client else { return nil }
        do {
            let exported = try await client.export(threadId: threadId, format: format)
            let name = URL(fileURLWithPath: exported.filename).lastPathComponent
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try exported.data.write(to: url, options: .atomic)
            return url
        } catch {
            recordActionError(error)
            return nil
        }
    }

    // MARK: - Connected apps

    func loadConnectorCatalog() async -> ConnectorCatalog? {
        guard let client else { return nil }
        do { return try await client.connectorCatalog() }
        catch { recordActionError(error); return nil }
    }

    func loadAllConnectorStatuses() async -> ConnectorStatuses? {
        guard let client else { return nil }
        do { return try await client.allConnectorStatuses() }
        catch { recordActionError(error); return nil }
    }

    func authorizeConnector(_ slug: String, alias: String?) async -> URL? {
        guard let client else { return nil }
        do { return try await client.authorizeConnector(slug: slug, alias: alias) }
        catch { recordActionError(error); return nil }
    }

    /// Detach one connected account.  Returns whether it went through, so the
    /// caller can refresh only on success and leave the row alone otherwise.
    func removeConnectorAccount(_ slug: String, accountId: String) async -> Bool {
        guard let client else { return false }
        do {
            try await client.removeConnectorAccount(slug: slug, accountId: accountId)
            return true
        } catch {
            recordActionError(error)
            return false
        }
    }

    func refreshNotificationAuthorization() async {
        // Before reading the status: an install authorized before the app
        // asked for `.timeSensitive` needs the added option requested once,
        // and the request cannot lower a grant it already holds.
        await NotificationCoordinator.shared.requestTimeSensitiveIfNeeded()
        notificationAuthorization = await NotificationCoordinator.shared.authorizationStatus()
        notificationAuthorizationResolved = true
        registerForRemoteNotificationsIfAllowed()
    }

    // MARK: - Mac update

    /// Fetch the paired Mac's update status once, without asking it to look
    /// again.  The card calls this on appear; after that, live `update.status`
    /// events keep `state.macUpdateStatus` current on their own.
    ///
    /// A failure here deliberately never reaches `actionError`, the same way
    /// `checkForMacUpdate()` below does not.  Nobody asked for this fetch:
    /// the card is shown for any paired phone, connected or not, so a Mac
    /// that is merely asleep — or running a BotFleet that predates these
    /// routes, which answers `no route: GET /api/update/status` verbatim —
    /// would otherwise throw "Something went wrong" over Settings carrying
    /// raw developer text.  The card already has the right answer inline:
    /// `nil` back here with `state.macUpdateStatus` still empty is what
    /// raises its `loadFailed` -> "Mac Update not available" row, which says
    /// the same thing in the user's language and offers Retry.  The poll
    /// below depends on this too — the window it exists to cover is exactly
    /// the window in which this GET fails, every five seconds.
    @discardableResult
    func loadMacUpdateStatus() async -> MacUpdateStatus? {
        guard let client else { return nil }
        do {
            let status = try await client.updateStatus()
            state.apply(.updateStatus(status))
            pollMacUpdateWhileRunning()
            return status
        } catch {
            return nil
        }
    }

    /// The Check button: ask the harness to look again right now.
    ///
    /// A check the harness could not complete still answers with a status —
    /// the installed build and the capabilities are current, only the
    /// comparison is missing — so that status is folded in exactly like a
    /// successful one, carrying `checkError` for the card to render in place
    /// of the answer it does not have.  It deliberately does not go to
    /// `actionError`: an unreachable update source is an ordinary thing for
    /// a laptop to report, and the card says so inline rather than throwing
    /// an alert over the screen, the same as a refused run.
    @discardableResult
    func checkForMacUpdate() async -> MacUpdateStatus? {
        guard let client else { return nil }
        do {
            let status = try await client.checkForUpdates()
            state.apply(.updateStatus(status))
            pollMacUpdateWhileRunning()
            return status
        } catch let failure as MacUpdateCheckFailure {
            state.apply(.updateStatus(failure.status))
            pollMacUpdateWhileRunning()
            return failure.status
        } catch {
            recordActionError(error)
            return nil
        }
    }

    /// Start the install.  Returns the harness's own reason when it refused
    /// (a run already in progress, or one of `capabilities.reasons`) so the
    /// card can show that sentence inline — `nil` on success, and also on
    /// any other failure, which already went to `actionError` above.
    /// Everything after a successful start arrives as `update.status` events
    /// into `state`, which is what the card actually renders progress from;
    /// both outcomes fold their own copy of `status` in immediately so the
    /// card never has to wait on that stream (or a follow-up GET) just to
    /// know why a refusal happened.
    @discardableResult
    func runMacUpdate() async -> String? {
        guard let client else { return nil }
        do {
            let started = try await client.runUpdate()
            state.apply(.updateStatus(started.status))
            pollMacUpdateWhileRunning()
            return nil
        } catch let refusal as MacUpdateRunRefusal {
            state.apply(.updateStatus(refusal.status))
            pollMacUpdateWhileRunning()
            return refusal.message
        } catch {
            recordActionError(error)
            return nil
        }
    }

    /// Keeps `state.macUpdateStatus` moving while a run is in progress, on a
    /// plain interval — no-op if a poll is already running or nothing is.
    /// The updater's restart drops the event stream along with whatever
    /// frame would have said the run finished (the reconnect handler above
    /// asks once on its own for exactly that reason), and a phone that never
    /// backgrounds during the restart may see no reconnect at all to hang
    /// that ask off of.  Five seconds is short enough that a Settings screen
    /// left open does not read as stuck, and cheap enough that polling a
    /// GET for the couple of minutes an install takes costs nothing worth
    /// avoiding.
    ///
    /// Failures back that cadence off (`macUpdatePollBackoff`) and, after
    /// `macUpdateGiveUpAfterSilence` of unbroken silence, end the loop with
    /// `macUpdateContactLost` set — the only other exit is a status whose
    /// `running` is nil, and only the unreachable harness can send one of
    /// those, so a Mac that never comes back would otherwise be polled for
    /// the rest of the foreground session.  Each attempt is quiet by
    /// construction: `loadMacUpdateStatus()` raises no alert, which matters
    /// most here, where failing is the expected case.
    private func pollMacUpdateWhileRunning() {
        // Reaching here at all means a status was just folded in, from a
        // fetch or from an `update.status` frame — whatever the poll may
        // have given up on before, contact is current again.
        macUpdateContactLost = false
        guard macUpdatePollTask == nil, state.macUpdateStatus?.running != nil else { return }
        macUpdatePollTask = Task { [weak self] in
            var consecutiveFailures = 0
            var silentSince: Date?
            var gaveUp = false
            while let self, !Task.isCancelled, self.state.macUpdateStatus?.running != nil {
                let backoff = Session.macUpdatePollBackoff[
                    min(consecutiveFailures, Session.macUpdatePollBackoff.count - 1)
                ]
                try? await Task.sleep(for: .seconds(backoff))
                guard !Task.isCancelled else { break }
                if await self.loadMacUpdateStatus() == nil {
                    let since = silentSince ?? Date()
                    silentSince = since
                    consecutiveFailures += 1
                    if Date().timeIntervalSince(since) >= Session.macUpdateGiveUpAfterSilence {
                        gaveUp = true
                        break
                    }
                } else {
                    silentSince = nil
                    consecutiveFailures = 0
                }
            }
            guard let self else { return }
            // A cancelled poll is not a Mac that stopped answering, and
            // `signOut()` / `disconnect()` have already cleared both the
            // handle and the flag by the time this resumes from its last
            // `await` — so leave their work alone rather than racing it back
            // to "lost contact" (or clearing a handle that now belongs to a
            // poll armed after the reconnect).
            guard !Task.isCancelled else { return }
            // Only a give-up with a run still outstanding is worth saying
            // anything about: the other exit — the run finished — has
            // nothing left to report.
            if gaveUp, self.state.macUpdateStatus?.running != nil {
                self.macUpdateContactLost = true
            }
            self.macUpdatePollTask = nil
        }
    }

    func enableNotifications() async {
        if notificationAuthorization == .denied {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                await UIApplication.shared.open(url)
            }
            return
        }
        _ = await NotificationCoordinator.shared.requestAuthorization()
        await refreshNotificationAuthorization()
        NotificationCoordinator.shared.setBadge(state.unreadCount)
    }

    /// APNs registration is what lets a killed app wake.  Local alerts still
    /// work without it; the token is posted to the sidecar, not sent from here.
    func registerForRemoteNotificationsIfAllowed() {
        switch notificationAuthorization {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            break
        }
    }

    var notificationStatusText: String {
        switch notificationAuthorization {
        case .authorized: return "On"
        case .provisional: return "Quietly on"
        case .ephemeral: return "Temporarily on"
        case .denied: return "Off in Settings"
        case .notDetermined: return "Not enabled"
        @unknown default: return "Unknown"
        }
    }

    /// Returns whether the body got all the way through.  Almost every
    /// caller ignores that — the error banner is the answer they want — but
    /// a notification action has no banner to show and has to know, and
    /// reading `actionError` to find out would mean clearing a message the
    /// user may be looking at.
    @discardableResult
    private func perform(quietly: Bool = false, _ body: (CompanionClient) async throws -> Void) async -> Bool {
        guard let client else { return false }
        do {
            try await body(client)
            return true
        } catch let error as APIError where error.isUnauthorized {
            status = .unauthorized
            return false
        } catch {
            if !quietly { recordActionError(error) }
            return false
        }
    }
}

/// A chat is a bot or a room. They share a thread, which is what every
/// message, approval and page is keyed by.
enum Chat: Identifiable, Hashable {
    case bot(Bot)
    case room(Room)

    var id: String {
        switch self {
        case let .bot(bot): return bot.id
        case let .room(room): return room.id
        }
    }

    static func == (left: Chat, right: Chat) -> Bool {
        switch (left, right) {
        case let (.bot(a), .bot(b)): return a.id == b.id
        case let (.room(a), .room(b)): return a.id == b.id
        default: return false
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case let .bot(bot):
            hasher.combine(0)
            hasher.combine(bot.id)
        case let .room(room):
            hasher.combine(1)
            hasher.combine(room.id)
        }
    }

    var threadId: String {
        switch self {
        case let .bot(bot): return bot.threadId
        case let .room(room): return room.threadId
        }
    }

    var name: String {
        switch self {
        case let .bot(bot): return bot.name
        case let .room(room): return room.name
        }
    }

    var section: String? {
        switch self {
        case let .bot(bot): return bot.section
        case let .room(room): return room.section
        }
    }

    var isBot: Bool {
        if case .bot = self { return true }
        return false
    }

    /// Bot-to-bot DMs, not a user room.  Matches Mac Bot Chats.
    var isBotToBot: Bool {
        if case let .room(room) = self { return room.isBotToBot }
        return false
    }

    var subtitle: String {
        switch self {
        case let .bot(bot): return bot.title
        case let .room(room): return "\(room.memberIds.count) bots"
        }
    }

    var unread: Bool {
        switch self {
        case let .bot(bot): return bot.unread
        case let .room(room): return room.unread
        }
    }

    var busy: Bool {
        switch self {
        case let .bot(bot): return bot.busy ?? false
        case let .room(room): return room.isWorking
        }
    }

    var color: String {
        switch self {
        case let .bot(bot): return bot.color
        case .room: return "blue"
        }
    }
}

/// A chat plus the two things a roster row shows that the record itself does
/// not carry: the preview line, and when any of its tasks last moved.
struct ChatSummary: Identifiable, Hashable {
    let chat: Chat
    let preview: String
    let lastActivity: Double
    let pinned: Bool

    var id: String { chat.id }
}

extension CompanionState {
    /// Everything worth showing in the chat list: pinned first, then most
    /// recently active. Unread is a badge, not a sort key — same as
    /// Messages.app and the Mac sidebar. Hidden bots stay hidden.
    ///
    /// The derived fields are computed once here rather than asked for as the
    /// list is sorted and filtered. Each one walks a thread's messages to
    /// reach the last of them, and a comparator is called O(n log n) times
    /// while the search predicate runs over every chat on every keystroke —
    /// so the same transcript was being traversed dozens of times per frame
    /// to produce an answer that had not changed. One pass, then sort the
    /// results.
    var chatSummaries: [ChatSummary] {
        let bots = self.bots.filter { $0.hidden != true }.map(Chat.bot)
        let rooms = self.rooms.map(Chat.room)
        return (bots + rooms)
            .map { chat in
                let last = newestLoadedMessage(for: chat)
                return ChatSummary(
                    chat: chat,
                    preview: Self.preview(of: last),
                    lastActivity: latestActivity(for: chat),
                    pinned: Self.pinned(chat)
                )
            }
            .sorted { left, right in
                ChatListOrder.orderedBefore(
                    pinnedLeft: left.pinned,
                    activityLeft: left.lastActivity,
                    pinnedRight: right.pinned,
                    activityRight: right.lastActivity
                )
            }
    }

    private static func pinned(_ chat: Chat) -> Bool {
        if case let .bot(bot) = chat { return bot.pinned ?? false }
        return false
    }

    /// Newest loaded message across this chat's threads. Other tasks may
    /// not be hydrated yet; `latestActivity` still reads their stamps.
    func newestLoadedMessage(for chat: Chat) -> Message? {
        var candidates = [Message]()
        switch chat {
        case let .bot(bot):
            if let last = visibleTranscript(forThread: bot.threadId).last { candidates.append(last) }
            for task in bot.tasks ?? [] {
                if let last = visibleTranscript(forThread: task.threadId).last ?? task.lastMessage {
                    candidates.append(last)
                }
            }
        case let .room(room):
            if let last = visibleTranscript(forThread: room.threadId).last { candidates.append(last) }
        }
        return candidates.max { $0.at < $1.at }
    }

    /// Roster timestamp: max of loaded transcripts and each task's
    /// `lastActivity`, so an unread update on a background task does not
    /// keep showing yesterday from the currently selected thread.
    func latestActivity(for chat: Chat) -> Double {
        let fromMessages = newestLoadedMessage(for: chat)?.at
        switch chat {
        case let .bot(bot):
            let taskActivities = (bot.tasks ?? []).map { $0.lastActivity ?? $0.createdAt }
            return ChatListOrder.activity(
                createdAt: bot.createdAt,
                taskActivities: taskActivities,
                loadedMessageAt: fromMessages
            )
        case let .room(room):
            let taskActivities = (room.tasks ?? []).map { $0.lastActivity ?? $0.createdAt }
            return ChatListOrder.activity(
                createdAt: room.createdAt,
                taskActivities: taskActivities,
                loadedMessageAt: fromMessages
            )
        }
    }

    private func threadIds(for chat: Chat) -> [String] {
        switch chat {
        case let .bot(bot):
            let ids = (bot.tasks ?? []).map(\.threadId) + [bot.threadId]
            return Array(Set(ids))
        case let .room(room):
            return [room.threadId]
        }
    }

    /// The one line a roster row shows under the name, from whichever kind of
    /// message landed last.
    private static func preview(of last: Message?) -> String {
        guard let last else { return "" }
        switch last.kind {
        case .text: return last.text ?? ""
        // a pending card's question is the preview; the roster row already
        // says "waiting on you" beside it
        case .options:
            guard let card = last.card else { return "" }
            return card.isPending && !card.subtitle.isEmpty ? card.subtitle : card.title
        case .activity: return last.tool?.name ?? ""
        case .screen: return "Screenshot"
        case .unknown: return last.text ?? ""
        }
    }
}
