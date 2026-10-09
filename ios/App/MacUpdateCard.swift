// The Mac Update card: whether the paired computer's own BotFleet is up to
// date, and a button to install a newer build without touching the laptop.
//
// The install itself is entirely the harness's `/api/update/*` transaction —
// the same one `scripts/update-botfleet-mac.mjs` runs locally (see
// `docs/rollouts/2026-09-12-safe-mac-updater.md`).  This card only starts it
// and narrates `state.macUpdateStatus`, whether that came from the fetch on
// appear or a live `update.status` stream event landing in the background.
import CompanionCore
import SwiftUI

struct MacUpdateSection: View {
    @EnvironmentObject private var session: Session
    @State private var checking = false
    @State private var installing = false
    @State private var confirmingInstall = false
    /// Set when the initial (or a retried) status fetch comes back with
    /// nothing to show — offline, an older harness without these routes, or
    /// a malformed reply.  Kept apart from `status == nil`, which is also
    /// true for the brief moment before the very first fetch finishes: that
    /// case reads as "checking", this one as "not available", and the two
    /// must not look identical or the card spins forever on a Mac it will
    /// never hear from.
    @State private var loadFailed = false
    /// The harness's own reason the last `runUpdate()` refused (a 409) —
    /// shown right here rather than only in the app-wide error alert, since
    /// it is a normal, expected answer ("an update is already running"),
    /// not a failure worth interrupting the screen for.
    @State private var installError: String?
    /// The status `installError` was reported against.  A live
    /// `update.status` event only ever touches `session.state`, never this
    /// view's own `installError` — without this snapshot there is no way to
    /// tell "the status that just changed is the very one the refusal
    /// carried" (leave the message alone) apart from "something moved past
    /// it since" (clear it), and a refusal like "An update is already
    /// running" would otherwise sit there, stale, long after that run
    /// finished.
    @State private var installErrorStatus: MacUpdateStatus?
    /// The value the automatic-checks switch shows while its save is in
    /// flight.  Without it the switch would snap back to the stored value
    /// until the reply lands; nil means "show what the Mac has".
    @State private var autoUpdatePending: Bool?
    @State private var autoUpdateSaving = false
    /// Why the last save of the automatic-checks switch did not stick.
    @State private var autoUpdateError: String?
    /// The paired Mac answered that it has no route for the switch.
    @State private var autoUpdateNeedsMacUpdate = false

    private var status: MacUpdateStatus? { session.state.macUpdateStatus }

    /// The stored preference.  Nil until the config has loaded, and on a Mac
    /// that predates automatic checks, where it is unknown rather than off.
    private var storedAutoUpdate: Bool? { session.config?.autoUpdate?.enabled }

    /// The config loaded and has no `autoUpdate`, so this Mac cannot be asked.
    private var autoUpdateUnsupported: Bool {
        autoUpdateNeedsMacUpdate || (session.config != nil && storedAutoUpdate == nil)
    }

    var body: some View {
        Section {
            if let status {
                installedRow(status)
                availabilityRow(status)
                if let lastRun = status.lastRun, status.running == nil {
                    lastRunRow(lastRun)
                }
                actionsRow(status)
                if let installError {
                    Text(installError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            } else if loadFailed {
                unavailableRow
            } else {
                HStack {
                    Text("Checking for updates…")
                        .foregroundStyle(.secondary)
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            }
            // The preference lives in the Mac's config, not in the update
            // status, so it stays here even when that status could not load.
            autoUpdateRow
        } header: {
            Text("Mac Update")
        } footer: {
            if let status {
                VStack(alignment: .leading, spacing: 4) {
                    if let checkedAt = status.checkedAt {
                        Text(Self.checkedAtText(checkedAt))
                    }
                    if let checkError = status.checkError, !Self.rowShowsCheckError(status) {
                        // The row above is showing a real update or a run in
                        // progress, so it has something true to say and keeps
                        // saying it.  The failure still belongs on screen,
                        // right beside the timestamp it explains — that
                        // "Checked …" line is the stale one.
                        Text(checkError)
                    }
                    if let reason = Self.footerReason(status, installError: installError) {
                        Text(reason)
                    }
                }
            }
        }
        .task { await loadStatus() }
        .onChange(of: status) { _, newStatus in
            // A stale refusal is only ever cleared by something that is not
            // the exact status it arrived with — see `installErrorStatus`.
            guard installError != nil, newStatus != installErrorStatus else { return }
            installError = nil
            installErrorStatus = nil
        }
        .confirmationDialog(
            "Install Mac Update?",
            isPresented: $confirmingInstall,
            titleVisibility: .visible
        ) {
            Button("Install Update") {
                Task { await startInstall() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The Mac app and its server restart during the update.  Continue?")
        }
    }

    // MARK: - Rows

    private var unavailableRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Mac Update not available", systemImage: "exclamationmark.triangle")
                .foregroundStyle(.secondary)
            Text("Could not reach this computer's update status.  It may be offline or running an older BotFleet.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Retry") {
                Task { await loadStatus() }
            }
        }
    }

    /// Enable Automatic Update Checks, as on the desktop's Updates card.  It
    /// shows the stored value, never a guess: disabled until the config has
    /// loaded, and on a Mac that cannot be asked.
    private var autoUpdateRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(
                get: { autoUpdatePending ?? storedAutoUpdate ?? false },
                set: { enabled in
                    Task { await saveAutoUpdate(enabled) }
                }
            )) {
                Text("Enable Automatic Update Checks")
            }
            .disabled(autoUpdateSaving || storedAutoUpdate == nil || autoUpdateNeedsMacUpdate)

            if autoUpdateUnsupported {
                Text("Update BotFleet on your Mac to change this from your phone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Auto-checks at most once per 6 hours.\u{00A0} You can still check any time.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let autoUpdateError {
                    Text("Automatic update preference was not saved.\u{00A0} \(autoUpdateError)")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
    }

    private func installedRow(_ status: MacUpdateStatus) -> some View {
        HStack(spacing: 12) {
            MacUpdateIcon(symbol: "laptopcomputer", color: .blue)
            Text("Installed")
                .foregroundStyle(.primary)
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(status.installed.version ?? "Unknown version")
                Text(Self.shortCommit(status.installed.sourceCommit))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func availabilityRow(_ status: MacUpdateStatus) -> some View {
        if let running = status.running {
            if session.macUpdateContactLost {
                // The install is still the last thing this Mac said it was
                // doing, but it has stopped answering long enough that the
                // poll gave up.  A spinner here would claim progress nobody
                // can see any more.
                contactLostRow(running)
            } else {
                runningRow(running)
            }
        } else if let available = status.available {
            availableRow(available)
        } else if let checkError = status.checkError {
            // The harness could not reach the update source, so `available`
            // and `checkedAt` are both still whatever the last check that
            // *did* work left behind.  Neither "Up to date" nor "Not checked
            // yet" is true here, and the first of those is the dangerous one:
            // it is exactly the sentence someone reads as confirmation right
            // after pressing Check.
            checkFailedRow(checkError)
        } else if status.checkedAt == nil {
            // `available == nil` is also what a Mac that has never checked
            // looks like — "Up to date" is a claim about a check that has
            // not happened, so this reads as "not checked" instead of
            // reusing the same row copy the footer already shows for it.
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "questionmark.circle", color: .secondary)
                Text("Not checked yet")
                    .foregroundStyle(.primary)
                Spacer()
            }
        } else {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "checkmark.circle.fill", color: .green)
                Text("Up to date")
                    .foregroundStyle(.primary)
                Spacer()
            }
        }
    }

    private func checkFailedRow(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "exclamationmark.triangle.fill", color: .orange)
                Text("Could not check")
                    .foregroundStyle(.primary)
                Spacer()
            }
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
        }
    }

    private func runningRow(_ running: MacUpdateRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "arrow.triangle.2.circlepath", color: .orange)
                Text("Installing…")
                    .foregroundStyle(.primary)
                Spacer()
                ProgressView().controlSize(.small)
            }
            Text(running.step)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
            if let progress = running.progress {
                ProgressView(value: min(max(progress, 0), 1))
                    .padding(.leading, 40)
            }
            if let lastLine = running.logTail.last {
                Text(lastLine)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .padding(.leading, 40)
            }
        }
    }

    private func contactLostRow(_ running: MacUpdateRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "exclamationmark.triangle.fill", color: .orange)
                Text("Lost contact during the update")
                    .foregroundStyle(.primary)
                Spacer()
            }
            // The last thing the Mac said it was doing, in the same place
            // and the same voice `runningRow` says it — the harness maps its
            // own step keys to human labels (`stepLabel` in
            // `server/update-control.ts`) before sending them, so there is
            // nothing to prefix or translate here.
            Text(running.step)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
            Text("This computer stopped answering while the updater ran.\u{00A0} It may still be restarting, or it may need a look.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
            Button("Retry") {
                Task { await loadStatus() }
            }
            .padding(.leading, 40)
        }
    }

    private func availableRow(_ available: MacAvailableUpdate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "arrow.down.circle.fill", color: .green)
                Text("Update available: \(available.version ?? Self.shortCommit(available.sourceCommit)), \(Self.commitCount(available.aheadBy)) ahead")
                    .foregroundStyle(.primary)
                Spacer()
            }
            if !available.commits.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(available.commits.prefix(5), id: \.sha) { commit in
                        Text("•\u{00A0}\(commit.subject)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.leading, 40)
            }
        }
    }

    private func lastRunRow(_ lastRun: MacUpdateLastRun) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Last update: \(Self.outcomeText(lastRun.outcome))")
                .font(.footnote)
                .foregroundStyle(Self.outcomeColor(lastRun.outcome))
            if lastRun.outcome != .verified {
                Text(lastRun.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func actionsRow(_ status: MacUpdateStatus) -> some View {
        HStack {
            Button {
                checking = true
                Task {
                    await session.checkForMacUpdate()
                    checking = false
                }
            } label: {
                if checking {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Check")
                }
            }
            .disabled(checking || installing || status.running != nil || !status.capabilities.canCheck)

            Spacer()

            Button("Install Update") {
                confirmingInstall = true
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                installing || status.running != nil || status.available == nil
                    || !status.capabilities.canRun
            )
        }
    }

    /// The initial (or retried) fetch.  Distinguishes "nothing to show yet"
    /// from "asked, and there is still nothing" — `session.loadMacUpdateStatus()`
    /// deliberately raises no alert of its own, so this row *is* how the
    /// failure reaches the user, and all it needs is to notice
    /// `state.macUpdateStatus` is still nil once the fetch is done.
    private func loadStatus() async {
        loadFailed = false
        if await session.loadMacUpdateStatus() == nil, session.state.macUpdateStatus == nil {
            loadFailed = true
        }
    }

    private func startInstall() async {
        installing = true
        let message = await session.runMacUpdate()
        installError = message
        // Snapshot the status the refusal arrived with, not "no status" —
        // `onChange(of:)` above needs something to compare the next live
        // update against.  A success (`message == nil`) needs no snapshot;
        // there is nothing left to keep stale.
        installErrorStatus = message != nil ? status : nil
        installing = false
    }

    /// One save at a time.  The switch shows the new value while it saves
    /// and falls back to whatever the Mac has once the reply lands, so a
    /// refusal reverts it on its own.
    private func saveAutoUpdate(_ enabled: Bool) async {
        guard !autoUpdateSaving else { return }
        autoUpdateSaving = true
        autoUpdatePending = enabled
        autoUpdateError = nil
        let outcome = await session.setAutoUpdateEnabled(enabled)
        switch outcome {
        case .saved:
            break
        case .needsMacUpdate:
            autoUpdateNeedsMacUpdate = true
        case let .failed(message):
            autoUpdateError = message
        }
        autoUpdatePending = nil
        autoUpdateSaving = false
    }

    // MARK: - Formatting

    /// Whether `availabilityRow` is itself rendering `checkError`, which is
    /// the case exactly when it has no truthful alternative to show.  The
    /// footer consults this so the same sentence never appears twice.
    private static func rowShowsCheckError(_ status: MacUpdateStatus) -> Bool {
        status.checkError != nil && status.running == nil && status.available == nil
    }

    /// The standing reason the Mac will not run an update right now, when it
    /// is worth repeating in the footer.
    ///
    /// It is not worth repeating when it is the very sentence a refusal just
    /// put on screen in red: a 409 answers with `BUSY_REFUSAL` as both the
    /// error and `capabilities.reasons.first`, so without this the card
    /// printed "BotFleet is working right now…" twice at once, once above
    /// and once below.  Same de-duplication `rowShowsCheckError(_:)` does
    /// for `checkError`.
    private static func footerReason(_ status: MacUpdateStatus, installError: String?) -> String? {
        guard status.running == nil, status.capabilities.canRun == false,
              let reason = status.capabilities.reasons.first,
              reason != installError
        else { return nil }
        return reason
    }

    /// `MacUpdateTimestamp` rather than a formatter built here: the harness
    /// stamps `checkedAt` with milliseconds and a default
    /// `ISO8601DateFormatter` rejects those outright, which left this
    /// showing the raw ISO string on every Mac.  The fallback below is now
    /// only for a timestamp in neither spelling.
    private static func checkedAtText(_ checkedAt: String) -> String {
        guard let date = MacUpdateTimestamp.date(from: checkedAt) else {
            return "Checked \(checkedAt)"
        }
        return "Checked \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    private static func shortCommit(_ sha: String) -> String {
        String(sha.prefix(7))
    }

    private static func commitCount(_ aheadBy: Int) -> String {
        "\(aheadBy) \(aheadBy == 1 ? "commit" : "commits")"
    }

    private static func outcomeText(_ outcome: MacUpdateOutcome) -> String {
        switch outcome {
        case .verified: return "Verified"
        case .rolledBack: return "Rolled back"
        case .failed: return "Failed"
        case .refused: return "Refused"
        case .unknown: return "Unknown"
        }
    }

    private static func outcomeColor(_ outcome: MacUpdateOutcome) -> Color {
        switch outcome {
        case .verified: return .green
        case .rolledBack, .failed: return .red
        case .refused, .unknown: return .secondary
        }
    }
}

private struct MacUpdateIcon: View {
    let symbol: String
    let color: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}
