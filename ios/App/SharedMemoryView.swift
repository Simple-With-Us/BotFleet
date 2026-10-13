// Shared memory (the recall corpus bots search), read-only.
//
// One row in Settings that says whether the corpus is reachable, and the
// screen behind it.  Mirrors the status half of the desktop's
// `QdrantRagConnection.tsx`.  Nothing here edits a setting: the service
// address, the collection and the access credentials are set on the computer,
// and the status the phone reads has its address stripped before it reaches a
// view (`SharedMemoryStatus` has no field for it).
import CompanionCore
import SwiftUI

/// The trailing state text on the Settings row.  Loads the status once when
/// the row appears.
struct SharedMemoryStateText: View {
    @EnvironmentObject private var session: Session
    @State private var attempted = false

    private var label: String {
        if let status = session.sharedMemoryStatus { return status.stateLabel }
        if session.sharedMemoryNotReported { return "Not reported" }
        return attempted ? "Unavailable" : "Checking\u{2026}"
    }

    private var color: Color {
        guard let status = session.sharedMemoryStatus else { return .secondary }
        return status.stateLabel == "Needs attention" ? .orange : .secondary
    }

    var body: some View {
        Text(label)
            .foregroundStyle(color)
            .task {
                await session.refreshSharedMemoryStatus()
                attempted = true
            }
    }
}

struct SharedMemoryView: View {
    @EnvironmentObject private var session: Session
    @State private var attempted = false
    @State private var refreshing = false

    private static let gap = "\u{00A0} "

    var body: some View {
        List {
            Section {
                if let status = session.sharedMemoryStatus {
                    LabeledContent("State", value: status.stateLabel)
                    LabeledContent("Route", value: status.routeLabel)
                    if let collection = status.collection, !collection.isEmpty {
                        LabeledContent("Collection", value: collection)
                    }
                    if let points = status.pointsLabel {
                        LabeledContent("Size", value: points)
                    }
                    LabeledContent("Last Successful Check", value: status.lastSuccessLabel)
                    if let warning = status.accessWarning {
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    if !status.ready, let error = status.error, !error.isEmpty {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } else if session.sharedMemoryNotReported {
                    Text("The companion on your computer is older than this screen and does not report shared memory.\(Self.gap)Update BotFleet on your computer.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if attempted {
                    Text("Shared memory status is unavailable right now.")
                        .foregroundStyle(.secondary)
                    Button("Retry") { Task { await refresh() } }
                } else {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Checking\u{2026}").foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("Bot RAG")
            } footer: {
                Text("Shared memory is the recall corpus bots search for what they have learned.\(Self.gap)It is set up on your computer, and the service address and credentials are never shown here.")
            }
        }
        .navigationTitle("Shared Memory")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await refresh() }
                }
                .disabled(refreshing)
            }
        }
        .task { await refresh() }
        .refreshable { await refresh() }
    }

    private func refresh() async {
        refreshing = true
        await session.refreshSharedMemoryStatus()
        attempted = true
        refreshing = false
    }
}
