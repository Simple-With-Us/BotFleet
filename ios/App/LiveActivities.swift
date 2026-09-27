// Keeping the Dynamic Island in step with the bots.
//
// One Live Activity per bot that is doing something — needs you, working,
// or has an unread message — started, updated and ended from the same
// `updates` the pill reads. Tapping the lock-screen card opens that bot's
// thread. The stream is foreground-only and there is no push path yet, so
// the background lifecycle transition requests immediate teardown.  Activities
// are rebuilt from current state when the app becomes active again.
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
        // Answer from the island: the intent runs in this process.
        AnswerApprovalIntent.handler = { [weak session] threadId, requestId, choice, isPermission in
            await session?.answer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }
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
            // on its own and the lock screen lights up. Working and unread
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
            // Closed-app push is not in this version; keep the activity local.
            try? Activity.request(
                attributes: attributes,
                content: .init(state: content, staleDate: nil),
                pushType: nil
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
