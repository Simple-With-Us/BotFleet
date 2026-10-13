// Archived Bots: every bot that was archived, each with Restore.  Opened
// from the footer row at the bottom of the chat list.  The desktop's
// `ArchivedBotsPanel` (src/components/Sidebar.tsx) is the reference.  An
// archived bot keeps every transcript, so restoring it brings it back as it
// was.
import SwiftUI
import CompanionCore

struct ArchivedBotsView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var restoringId: String?
    @State private var restoreError: String?

    private var archived: [Bot] { BotOrganize.archivedBots(session.state.bots) }

    var body: some View {
        NavigationStack {
            List {
                if archived.isEmpty {
                    ContentUnavailableView(
                        "No Archived Bots",
                        systemImage: "archivebox",
                        description: Text("Bots you archive show up here, ready to restore.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(archived) { bot in
                            row(bot)
                        }
                    } footer: {
                        Text("An archived bot keeps every conversation.\u{00A0} Restore it to put it back in the chat list.")
                    }
                }

                if let restoreError {
                    Section {
                        Text(restoreError)
                            .font(.footnote)
                            .foregroundStyle(Color.red)
                    }
                }
            }
            .navigationTitle("Archived Bots")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func row(_ bot: Bot) -> some View {
        HStack(spacing: 12) {
            BotAvatarView(bot: bot, size: 36)
                .opacity(0.7)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name)
                    .font(.body)
                    .lineLimit(1)
                if !bot.title.isEmpty {
                    Text(bot.title)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if restoringId == bot.id {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button("Restore") {
                    Task { await restore(bot) }
                }
                .buttonStyle(.bordered)
                .disabled(restoringId != nil)
                .accessibilityLabel("Restore \(bot.name)")
            }
        }
    }

    /// Restore has no rule to check: an archived bot may always come back,
    /// a former Chief of Staff included.  The last one restored closes the
    /// sheet, since there is nothing left to show.
    private func restore(_ bot: Bot) async {
        restoringId = bot.id
        restoreError = nil
        defer { restoringId = nil }
        do {
            _ = try await session.applyOrganize(.restore, to: bot)
            if archived.isEmpty { dismiss() }
        } catch {
            if !session.isCancellation(error) {
                restoreError = error.localizedDescription
            }
        }
    }
}
