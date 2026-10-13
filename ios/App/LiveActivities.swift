// Keeping the Dynamic Island in step with the bots.
//
// One Live Activity per bot that is doing something — needs you, working,
// or has an unread message — started, updated and ended from the same
// `updates` the pill reads.  Tapping the lock-screen card opens that bot's
// thread.  The stream is foreground-only and there is no push path yet, so the
// background lifecycle transition ends the ambient activities.  An activity
// still waiting on an answer is the exception and stays, because it is the one
// card that has to be readable and tappable with the phone locked; it is
// reconciled against current state on the next foreground activation.
import ActivityKit
import Combine
import Foundation
import CompanionCore

@MainActor
final class LiveActivityCoordinator {
    private var cancellable: AnyCancellable?
    private var lastSent: [String: BotActivityAttributes.ContentState] = [:]
    /// When each bot's current kind began, so an update does not reset the clock.
    private var since: [String: (kind: String, at: Date)] = [:]
    private var lifecycle = LiveActivityLifecycle()
    /// ActivityKit mutations run in order.  Background teardown therefore
    /// finishes before a rapid foreground return can recreate an activity.
    private var activityWork: Task<Void, Never>?
    private var resumeRefresh: Task<Void, Never>?
    private var connectionCancellable: AnyCancellable?
    private weak var session: Session?

    func attach(to session: Session) {
        self.session = session
        observePushToStartToken(on: session)
        cancellable = session.$state
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] state in self?.scheduleSync(state) }
        connectionCancellable = session.$connection
            .map { $0?.id }
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] connectionId in
                self?.handlePairingChange(isPaired: connectionId != nil)
            }
    }

    func transition(to phase: LiveActivityLifecyclePhase) {
        handle(lifecycle.transition(to: phase))
    }

    private func handlePairingChange(isPaired: Bool) {
        handle(lifecycle.pairingChanged(isPaired: isPaired))
    }

    private func handle(_ action: LiveActivityLifecycleAction?) {
        switch action {
        case .awaitFreshState:
            awaitFreshState()
        case .endAll:
            endAll()
        case .endAmbient:
            endAmbientActivities()
        case .resetAndAwaitFreshState:
            endAll()
            awaitFreshState()
        case nil:
            break
        }
    }

    private func awaitFreshState() {
        let generation = lifecycle.generation
        resumeRefresh?.cancel()
        guard let session else { return }
        resumeRefresh = Task { [weak self, weak session] in
            guard let freshState = await session?.refreshLiveActivityState() else { return }
            guard !Task.isCancelled, let self,
                  self.lifecycle.acceptFreshState(for: generation)
            else { return }
            self.scheduleSync(freshState)
        }
    }

    /// Watch the per-device push-to-start token and hand it to the sidecar.
    ///
    /// This is the credential that makes an ask reachable when the app is *not*
    /// running: the sidecar uses it to start an ActivityKit activity from an
    /// APNs push, which is the only way a Lock Screen card appears for a phone
    /// whose app has been killed.  ActivityKit mints it whether or not an
    /// activity is running, so this is observed once at attach rather than per
    /// activity.
    ///
    /// The sequence re-emits on rotation, so every value is posted and the last
    /// one wins on the sidecar.
    private func observePushToStartToken(on session: Session) {
        Task { [weak session] in
            for await tokenData in Activity<BotActivityAttributes>.pushToStartTokenUpdates {
                guard let session else { return }
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                await session.registerLiveActivityToken(hex, kind: .pushToStart)
            }
        }
    }

    private func endAll() {
        resumeRefresh?.cancel()
        resumeRefresh = nil
        lastSent.removeAll()
        since.removeAll()
        enqueueActivityWork {
            for activity in Activity<BotActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    /// Backgrounding ends decoration, not a decision.  An activity still
    /// waiting on an answer stays on the Lock Screen, because that is the one
    /// card worth reading with the phone in a pocket; a working bot or an
    /// unread thread goes, since a local-only stream cannot keep either honest.
    /// The retained card is reconciled by the first foreground `sync`.
    private func endAmbientActivities() {
        resumeRefresh?.cancel()
        resumeRefresh = nil
        enqueueActivityWork {
            for activity in Activity<BotActivityAttributes>.activities {
                let state = activity.content.state
                guard !LiveActivityRetention.shouldRetain(
                    kind: state.kind, requestId: state.requestId, options: state.options
                ) else { continue }
                self.lastSent.removeValue(forKey: activity.attributes.botId)
                self.since.removeValue(forKey: activity.attributes.botId)
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    private func scheduleSync(_ state: CompanionState) {
        let generation = lifecycle.generation
        guard lifecycle.permitsUpdates(from: generation) else { return }
        enqueueActivityWork { [weak self] in
            guard let self, self.lifecycle.permitsUpdates(from: generation) else { return }
            await self.sync(state, generation: generation)
        }
    }

    private func enqueueActivityWork(_ work: @escaping @MainActor () async -> Void) {
        let previous = activityWork
        activityWork = Task {
            await previous?.value
            await work()
        }
    }

    private func sync(_ state: CompanionState, generation: Int) async {
        guard lifecycle.permitsUpdates(from: generation) else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let wanted = state.updates.filter { if case .bot = $0.chat { return true } else { return false } }
        var wantedIds = Set<String>()

        for update in wanted {
            guard lifecycle.permitsUpdates(from: generation) else { return }
            guard case let .bot(bot) = update.chat else { continue }
            wantedIds.insert(bot.id)
            let face = BotState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last)
            let kind = liveActivityKind(update.kind)
            if since[bot.id]?.kind != kind { since[bot.id] = (kind, Date()) }
            let content = BotActivityAttributes.ContentState(
                face: face.rawValue,
                kind: kind,
                headline: liveActivityHeadline(bot.name, kind: update.kind),
                line: update.line.isEmpty ? (update.card?.title ?? "") : update.line,
                requestId: update.card?.isPending == true ? update.card?.requestId : nil,
                options: update.card?.isPending == true
                    ? (update.card?.options.map { update.card?.displayChoice(for: $0) ?? $0 } ?? [])
                    : [],
                isPermission: update.card?.isPermission ?? false,
                since: since[bot.id]?.at ?? Date()
            )
            let previousContent = lastSent[bot.id]
            let existingActivity = Activity<BotActivityAttributes>.activities.first {
                $0.attributes.botId == bot.id
            }
            if previousContent == content, existingActivity?.attributes.threadId == bot.threadId {
                continue
            }

            // A bot stopping for you is worth an alert: the island pops open
            // on its own and the lock screen lights up.  Working and unread
            // are not — unread dismisses itself once the thread is read.
            let alert: AlertConfiguration? = update.kind == .needsYou
                ? AlertConfiguration(
                    title: LocalizedStringResource(stringLiteral: content.headline),
                    body: LocalizedStringResource(stringLiteral: content.line),
                    sound: .default
                )
                : nil
            if let activity = existingActivity {
                if activity.attributes.threadId != bot.threadId {
                    await activity.end(nil, dismissalPolicy: .immediate)
                    guard lifecycle.permitsUpdates(from: generation) else { return }
                    await requestActivity(
                        bot: bot,
                        content: content,
                        alert: nil,
                        shouldAlert: false,
                        generation: generation
                    )
                    guard lifecycle.permitsUpdates(from: generation) else { return }
                    lastSent[bot.id] = content
                    continue
                }
                let newAsk = update.kind == .needsYou
                    && previousContent != nil
                    && previousContent?.requestId != content.requestId
                await activity.update(.init(state: content, staleDate: nil), alertConfiguration: newAsk ? alert : nil)
            } else {
                let newAsk = update.kind == .needsYou
                    && previousContent != nil
                    && previousContent?.requestId != content.requestId
                await requestActivity(
                    bot: bot,
                    content: content,
                    alert: alert,
                    shouldAlert: newAsk,
                    generation: generation
                )
            }
            guard lifecycle.permitsUpdates(from: generation) else { return }
            lastSent[bot.id] = content
        }

        // bots that went quiet or whose unread was opened: let the island go
        for activity in Activity<BotActivityAttributes>.activities where !wantedIds.contains(activity.attributes.botId) {
            #if DEBUG
            // The `-live-activity-preview` fixture has no bot behind it, so
            // reconciliation would end the very card it exists to show.
            if Self.isPreviewFixture(activity) { continue }
            #endif
            guard lifecycle.permitsUpdates(from: generation) else { return }
            lastSent.removeValue(forKey: activity.attributes.botId)
            since.removeValue(forKey: activity.attributes.botId)
            await activity.end(nil, dismissalPolicy: .immediate)
            guard lifecycle.permitsUpdates(from: generation) else { return }
        }
    }

    // IMPORTANT: Activity.request() performs a synchronous XPC call to
    // SpringBoard under the hood.  Calling it while on @MainActor blocks the
    // main thread for 2+ seconds and trips the app-hang watchdog (BOTFLEET-E).
    // Hand off to a nonisolated context, await the result, then hop back to
    // check the lifecycle guard and fire the alerting update.
    private nonisolated func requestActivity(
        bot: Bot,
        content: BotActivityAttributes.ContentState,
        alert: AlertConfiguration?,
        shouldAlert: Bool,
        generation: Int
    ) async {
        // Check the lifecycle gate before touching ActivityKit (main-actor).
        guard await lifecycle.permitsUpdates(from: generation) else { return }

        let attributes = BotActivityAttributes(botId: bot.id, threadId: bot.threadId, name: bot.name, color: bot.color)

        // Activity.request() does a synchronous XPC round-trip; run it on a
        // background executor so it never touches the main thread directly.
        let activity: Activity<BotActivityAttributes>? = await Task.detached(priority: .userInitiated) {
            // `.token` so the sidecar can later update or end this activity
            // remotely; the per-activity token it mints is deliberately NOT
            // posted, because the sidecar keeps one slot per device and that
            // slot belongs to the push-to-start token.
            try? Activity.request(
                attributes: attributes,
                content: .init(state: content, staleDate: nil),
                pushType: .token
            )
        }.value

        guard let activity else { return }

        // Back on a background thread — do the lifecycle check and any
        // alerting update (both are async, not main-actor bound).
        guard await lifecycle.permitsUpdates(from: generation) else {
            await activity.end(nil, dismissalPolicy: .immediate)
            return
        }
        // A fresh activity cannot alert on request; one immediate alerting
        // update does it.  Only trigger for a genuinely new ask.
        if shouldAlert, let alert {
            await activity.update(.init(state: content, staleDate: nil), alertConfiguration: alert)
        }
    }
}

func liveActivityKind(_ kind: ChatUpdate.Kind) -> String {
    switch kind {
    case .needsYou: return "needsYou"
    case .working: return "working"
    case .toReview: return "toReview"
    }
}

func liveActivityHeadline(_ name: String, kind: ChatUpdate.Kind) -> String {
    switch kind {
    case .needsYou: return "\(name) needs you"
    case .working: return "\(name) is working"
    case .toReview: return "\(name) has an update"
    }
}

/// Answering from the island or the Lock Screen, in a process that may have
/// no UI at all.
///
/// A `LiveActivityIntent` runs in the **app's** process: the system launches
/// it in the background and performs the intent there.  The SwiftUI scene never
/// comes on screen for that launch, so anything wired from `onAppear` — which
/// is where this used to be installed — is `nil` at exactly the moment the
/// Lock Screen button is tapped, and the tap silently did nothing.
///
/// So the route is installed from `CompanionApp.init`, the first code this
/// process runs, and the session is rebuilt on demand inside the intent
/// rather than assumed.  The card is dismissed here too: with the app
/// backgrounded there is no `sync` to redraw it, so the buttons would sit on
/// the Lock Screen claiming an approval that already landed.
@MainActor
enum LiveActivityApprovalRoute {
    static func install(session: Session) {
        AnswerApprovalIntent.handler = { [weak session] threadId, requestId, choice, isPermission in
            guard let session else { return }
            let sent = await session.answerFromLiveActivity(
                threadId: threadId,
                requestId: requestId,
                choice: choice,
                isPermission: isPermission
            )
            guard sent else { return }
            await dismissCard(threadId: threadId, requestId: requestId)
        }
    }

    /// End only the card that was just answered, never every activity: the
    /// Lock Screen can be showing several bots at once and the others are
    /// still true.
    static func dismissCard(threadId: String, requestId: String) async {
        let answered = Activity<BotActivityAttributes>.activities.first {
            $0.attributes.threadId == threadId && $0.content.state.requestId == requestId
        }
        await answered?.end(nil, dismissalPolicy: .immediate)
    }
}

#if DEBUG
extension LiveActivityCoordinator {
    /// A real ActivityKit request with fixture content, so the Lock Screen card
    /// and its buttons can be seen on a simulator that has no paired harness.
    /// DEBUG only, and only from the `-live-activity-preview` launch argument.
    static let previewBotId = "preview-bot"

    static func isPreviewFixture(_ activity: Activity<BotActivityAttributes>) -> Bool {
        activity.attributes.botId == previewBotId
    }

    static func startPreviewActivity() {
        let content = BotActivityAttributes.ContentState(
            face: BotState.thinking.rawValue,
            kind: "needsYou",
            headline: "Forge needs you",
            line: "Run `rm -rf build/cache` in the BotFleet repo?",
            requestId: "preview-request",
            options: ["Allow", "Deny"],
            isPermission: true,
            since: Date()
        )
        Task.detached(priority: .userInitiated) {
            try? Activity.request(
                attributes: BotActivityAttributes(
                    botId: previewBotId,
                    threadId: "preview-thread",
                    name: "Forge",
                    color: "coral"
                ),
                content: .init(state: content, staleDate: nil),
                pushType: nil
            )
        }
    }
}
#endif
