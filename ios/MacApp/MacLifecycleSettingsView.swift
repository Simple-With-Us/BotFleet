import CompanionCore
import SwiftUI

/// The Lifecycle settings section:  what the harness is doing right now, the
/// Local VM controls, and whether the server starts at login.
///
/// This is the product half of the Decision 1 Option C split (BF-2688):  the
/// surface BotFleet Control's menu bar carried, moved into the one app a
/// BotFleet user downloads.  Nothing fleet-administrative appears here — the
/// twelve-row services list, pm2 rows and the process monitor belong to
/// Muster, not to this product.
struct MacLifecycleSettingsView: View {
    @ObservedObject var session: MacSession

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            statusGroup
            vmGroup
            startupGroup
            if let errorMessage = session.controlStatusError {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
            }
            if let startupError = session.startupPolicyErrorMessage {
                Text(startupError)
                    .font(.caption)
                    .foregroundColor(.red)
            }
        }
    }

    // MARK: - Server Status

    private var statusGroup: some View {
        GroupBox("Server Status") {
            VStack(alignment: .leading, spacing: 8) {
                if let status = session.controlStatus {
                    row("Active bots", "\(status.activeBotCount ?? 0)")
                    row("Local VMs running", "\(status.runningVMCount)")
                    if let blocking = status.blockingWorkSummary {
                        row("Work in flight", blocking)
                    }
                    if let build = status.serverBuild {
                        row("Server build", build.build ?? build.version ?? "unknown")
                    }
                } else if session.controlStatusError != nil {
                    Text("The server has not answered yet.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text("Reading the server status…")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                HStack {
                    Button("Refresh") {
                        Task { await session.refreshControlStatus() }
                    }
                    .disabled(session.isRefreshingControlStatus)
                    Spacer()
                }
                .padding(.top, 4)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Local VM

    private var vmGroup: some View {
        GroupBox("Local VM") {
            VStack(alignment: .leading, spacing: 8) {
                let status = session.controlStatus
                let canStart = status?.canStartSharedVM == true
                //  The stop route stops every VM the harness manages, so the
                //  button follows that:  any running VM makes it available,
                //  shared or not.
                let canStop = (status?.runningVMCount ?? 0) > 0
                HStack {
                    Button("Start Shared VM") {
                        Task { await session.startSharedVM() }
                    }
                    .disabled(!canStart || session.isControllingVM)
                    Button("Stop Local VMs…", role: .destructive) {
                        Task { await session.stopLocalVMs() }
                    }
                    .disabled(!canStop || session.isControllingVM)
                    if session.isControllingVM {
                        ProgressView().controlSize(.small)
                    }
                    Spacer()
                }
                Text(
                    (status?.runningVMCount ?? 0) > 0
                        ? "A stop reaches every VM this harness manages, not only the shared one."
                        : "No local VM is running."
                )
                .font(.caption)
                .foregroundColor(.secondary)

                if let message = session.vmActionMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Startup Policy

    private var startupGroup: some View {
        GroupBox("Startup") {
            VStack(alignment: .leading, spacing: 8) {
                if session.supportsStartupPolicy {
                    Toggle(
                        "Start Server At Login",
                        isOn: Binding(
                            get: { session.startupPolicy.startsAtLogin },
                            set: { session.setStartsAtLogin($0) }
                        )
                    )
                    Text(
                        session.startupPolicy.isExplicit
                            ? "The wrapper starts the server at login because this setting says so."
                            : "The install's default stands:  the server starts at login until this setting is changed."
                    )
                    .font(.caption)
                    .foregroundColor(.secondary)
                } else {
                    Text(MacStartupPolicyError.updateRequired.localizedDescription)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundColor(.secondary)
            Spacer()
            Text(value).monospacedDigit()
        }
    }
}
