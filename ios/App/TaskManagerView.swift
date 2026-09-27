import SwiftUI
import CompanionCore

/// A bot's separate contexts. Tasks remain a compact sheet because they are
/// conversation navigation, not host configuration.
struct TaskManagerView: View {
    let bot: Bot
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var showingNewTask = false
    @State private var taskToRename: BotTask?
    @State private var title = ""

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    /// A snoozed thread SINKS rather than disappearing, and the one the
    /// person has open stays where it is — snoozing the conversation you are
    /// reading must not move it out from under the tap that snoozed it.
    private var tasks: [BotTask] {
        ThreadSnooze.ordered(current.tasks ?? [], keepInPlace: [current.threadId])
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        BotAvatarView(bot: current, size: 48, state: .idle, animated: false)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(current.name).font(.headline)
                            Text(current.title.isEmpty ? "Agent tasks" : current.title)
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text("A task is one conversation and result.\u{00A0} Routines continue the previous task on a schedule.")
                }

                Section("Tasks") {
                    ForEach(tasks, id: \.threadId) { task in
                    Button {
                        Task {
                            await session.switchTask(task, for: current)
                            dismiss()
                        }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(task.title.isEmpty ? "Untitled task" : task.title)
                                    .foregroundStyle(Color.primary)
                                    .opacity(task.isSnoozed() ? 0.6 : 1)
                                // The badge replaces the stamp while a thread
                                // sleeps: when it wakes is the more useful
                                // fact than when it started.
                                if let snoozed = task.snoozeLabel() {
                                    Label(snoozed, systemImage: "moon.zzz")
                                        .font(.caption)
                                        .foregroundStyle(Color.secondary)
                                } else {
                                    Text(RelativeStamp.list(task.createdAt))
                                        .font(.caption)
                                        .foregroundStyle(Color.secondary)
                                }
                            }
                            Spacer()
                            if task.threadId == current.threadId {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .contextMenu {
                        Button("Rename", systemImage: "pencil") {
                            title = task.title
                            taskToRename = task
                        }
                        // Sentence case: these are values in a menu, not
                        // headings.  Resolved on the TAP rather than when the
                        // menu was built, so a sheet left open overnight does
                        // not snooze until a morning already gone.
                        Menu {
                            Button("For 1 hour") { snooze(task, until: ThreadSnoozePreset.hour()) }
                            Button("Until tomorrow morning") {
                                snooze(task, until: ThreadSnoozePreset.tomorrowMorning())
                            }
                            Button("Until activity") { snooze(task, until: threadSnoozeUntilActivity) }
                        } label: {
                            Label("Snooze", systemImage: "moon.zzz")
                        }
                        if task.isSnoozed() {
                            Button("Stop snoozing", systemImage: "bell") { snooze(task, until: nil) }
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await session.deleteTask(task, for: current) }
                        } label: { Label("Delete", systemImage: "trash") }
                        .disabled(tasks.count <= 1 || current.busy == true)
                    }
                    }
                }
            }
            .navigationTitle("\(current.name)’s tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("New task", systemImage: "plus") {
                        title = ""
                        showingNewTask = true
                    }
                    .disabled(current.busy == true)
                }
            }
        }
        .alert("New task", isPresented: $showingNewTask) {
            TextField("Title (optional)", text: $title)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                Task {
                    await session.createTask(for: current, title: title.trimmingCharacters(in: .whitespacesAndNewlines))
                    dismiss()
                }
            }
        }
        .alert("Rename task", isPresented: Binding(
            get: { taskToRename != nil },
            set: { if !$0 { taskToRename = nil } }
        )) {
            TextField("Title", text: $title)
            Button("Cancel", role: .cancel) { taskToRename = nil }
            Button("Save") {
                guard let task = taskToRename else { return }
                Task { await session.renameTask(task, for: current, title: title) }
                taskToRename = nil
            }
        }
    }

    /// Snooze one thread, or wake it with nil.  Only a bot thread can sleep:
    /// the bot-wide snooze is a wider thing and waking a thread never wakes
    /// the bot, because the person who stopped a bot did not ask for it back.
    private func snooze(_ task: BotTask, until snoozedUntil: Double?) {
        Task { await session.snoozeTask(task, for: current, snoozedUntil: snoozedUntil) }
    }
}
