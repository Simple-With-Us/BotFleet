import SwiftUI
import CompanionCore

/// In-chat thread switcher. Tasks used to live only in the composer + sheet;
/// they now sit under the chat header the way Safari keeps windows in tabs.
struct ThreadTabBar: View {
    let bot: Bot
    @EnvironmentObject private var session: Session

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    /// Sleeping tabs sink to the end rather than vanishing, and the open one
    /// never moves — a tab bar that reshuffles under the tab being read is
    /// worse than one that is slightly out of order.
    private var tasks: [BotTask] {
        ThreadSnooze.ordered(current.tasks ?? [], keepInPlace: [current.threadId])
    }

    /// The thread open for reading when it is not the active one. Both the
    /// execution target and the browsed thread read as selected tabs, but
    /// only the active one carries the strong tint.
    private var viewedThreadId: String? {
        session.state.viewingThreadId(forBotId: current.id)
    }

    private func intent(for task: BotTask) -> ThreadViewIntent {
        threadPickIntent(
            busy: current.busy == true,
            active: task.threadId == current.threadId,
            viewing: viewedThreadId != nil,
            canView: true
        )
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                    ForEach(tasks, id: \.threadId) { task in
                        let viewed = task.threadId == viewedThreadId
                        Button {
                            switch intent(for: task) {
                            case .switchTo:
                                Task { await session.switchTask(task, for: current) }
                            case .view, .viewActive:
                                Task { await session.viewThread(task, for: current) }
                            case .none:
                                break
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                HStack(spacing: 3) {
                                    if task.isSnoozed() {
                                        Image(systemName: "moon.zzz.fill")
                                            .font(.system(size: 9))
                                            .foregroundStyle(Color.secondary)
                                    }
                                    if viewed {
                                        Image(systemName: "eye")
                                            .font(.system(size: 9))
                                            .foregroundStyle(Color.secondary)
                                    }
                                    Text(task.title.isEmpty ? "Untitled" : task.title)
                                        .font(.system(size: 13, weight: task.threadId == current.threadId ? .semibold : .medium))
                                        .lineLimit(1)
                                }
                                .opacity(task.isSnoozed() ? 0.6 : 1)
                                // While it sleeps, when it wakes is the more
                                // useful fact than when it last spoke.
                                Text((task.snoozeLabel() ?? RelativeStamp.list(task.lastActivity ?? task.createdAt)) + (viewed ? " · Viewing" : ""))
                                    .font(.system(size: 10))
                                    .foregroundStyle(Color.secondary)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                Capsule().fill(
                                    task.threadId == current.threadId
                                        ? Color.primary.opacity(0.12)
                                        : viewed
                                            ? Color.primary.opacity(0.08)
                                            : Color.primary.opacity(0.05)
                                )
                            )
                        }
                        .buttonStyle(.plain)
                        // The active tab stays tappable (a no-op, as before);
                        // only a busy non-active tab with nowhere to view is off.
                        .disabled(intent(for: task) == .none && task.threadId != current.threadId)
                        .accessibilityAddTraits(task.threadId == current.threadId || viewed ? .isSelected : [])
                        .accessibilityLabel(Self.tabLabel(task) + (viewed ? ", viewing" : ""))
                    }
                    if session.config?.allowsMultipleBotThreads == true {
                        Button {
                            Task { await session.createTask(for: current, title: nil) }
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 13, weight: .semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 8)
                                .background(Capsule().fill(Color.primary.opacity(0.05)))
                        }
                        .buttonStyle(.plain)
                        .disabled(current.busy == true)
                        .accessibilityLabel("New thread")
                    }
                }
                .padding(.horizontal, 16)
            }
        }

    /// A sleeping tab is dimmed and carries a moon, neither of which VoiceOver
    /// can read, so the state and its deadline go into the label itself.
    static func tabLabel(_ task: BotTask, now: Date = Date()) -> String {
        let title = task.title.isEmpty ? "Untitled thread" : task.title
        guard let snoozed = task.snoozeLabel(now: now) else { return title }
        return "\(title), snoozed \(snoozed.lowercased())"
    }
}
