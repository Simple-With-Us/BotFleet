// Background jobs, on the phone.
//
// Mirrors the chat header's pill and dropdown in `src/components/JobsMenu.tsx`:
// a pill that counts what is running (or what ended in the last half hour), a
// list with each job's command, how it ended, how long it ran, View Output and
// Stop.  The owner approved Stop and reading output from the phone.  The phone
// never starts a job: a job only starts from a bot's own tool call, on the
// computer.
//
// Stop here is the owner's: the job gets SIGTERM, then SIGKILL after five
// seconds, and the bot is told on its next turn without being woken.  The
// chat's own Stop button ends the turn, never a job.
import CompanionCore
import SwiftUI

/// The pill under the chat header.  Draws nothing when the conversation has no
/// job worth showing, so most chats never see it.
struct JobsPill: View {
    let threadId: String
    /// In a room each row names the member whose job it is.
    let showsBotNames: Bool

    @EnvironmentObject private var session: Session
    @State private var showingSheet = false

    var body: some View {
        content
            .sheet(isPresented: $showingSheet) {
                JobsSheet(threadId: threadId, showsBotNames: showsBotNames)
            }
    }

    @ViewBuilder
    private var content: some View {
        let jobs = session.state.jobsByThread[threadId] ?? []
        if jobs.isEmpty {
            EmptyView()
        } else {
            // Ticks once a second while something runs, and slowly otherwise,
            // so a finished job's red dot fades and the job leaves the header
            // without a frame arriving to say so.
            TimelineView(.periodic(from: .now, by: jobs.contains(where: \.isActive) ? 1 : 15)) { context in
                pill(jobs: jobs, now: context.date.timeIntervalSince1970 * 1000)
            }
        }
    }

    @ViewBuilder
    private func pill(jobs: [JobSnapshot], now: Double) -> some View {
        let shown = JobsDisplay.visible(jobs, now: now)
        if shown.isEmpty {
            EmptyView()
        } else {
            let description = JobsDisplay.pillDescription(shown, now: now)
            HStack {
                Button {
                    showingSheet = true
                } label: {
                    HStack(spacing: 6) {
                        JobStatusDot(tone: JobsDisplay.pillTone(shown, now: now))
                        Text(JobsDisplay.pillLabel(shown))
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.primary)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Color.secondary)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 32)
                    .background(Capsule().fill(Color.secondary.opacity(0.14)))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Background Jobs: \(description)")
                .accessibilityHint("Shows what is running and lets you stop it")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
        }
    }
}

/// The pill's dot.  A running job's is blue in every skin, since "running" is
/// not a mood; a recent failure is red; otherwise it is quiet.  It pulses
/// while something runs, unless Reduce Motion is on.
private struct JobStatusDot: View {
    let tone: JobsPillTone

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    private var color: Color {
        switch tone {
        case .running: return .blue
        case .failed: return .red
        case .idle: return Color.secondary.opacity(0.6)
        }
    }

    private var pulses: Bool { tone == .running && !reduceMotion }

    private var pulse: Animation {
        pulses ? Animation.easeInOut(duration: 0.9).repeatForever(autoreverses: true) : Animation.default
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .opacity(pulses && dim ? 0.35 : 1)
            .animation(pulse, value: dim)
            .onAppear { dim = true }
            .accessibilityHidden(true)
    }
}

/// A job's dot in the list: blue while it runs, green when it exited 0, red
/// when it ended badly, quiet when it was stopped.
private struct JobRowDot: View {
    let job: JobSnapshot

    private var color: Color {
        if job.isActive { return .blue }
        if job.status == .completed { return .green }
        return job.endedBadly ? .red : Color.secondary.opacity(0.6)
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

/// The list a conversation's jobs open into.
struct JobsSheet: View {
    let threadId: String
    let showsBotNames: Bool

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    /// Stops asked for that no frame has confirmed yet.
    @State private var stopping: Set<String> = []
    @State private var viewingJobId: String?
    @State private var confirmingStopAll = false

    private var allJobs: [JobSnapshot] { session.state.jobsByThread[threadId] ?? [] }

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                list(now: context.date.timeIntervalSince1970 * 1000)
            }
            .navigationTitle("Background Jobs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(item: $viewingJobId) { jobId in
                JobOutputView(jobId: jobId)
            }
        }
        .presentationDetents([.medium, .large])
        .task { await session.loadJobs() }
        .onChange(of: allJobs) { _, jobs in
            // A stop the frames have answered needs no local "Stopping".
            stopping = stopping.filter { id in
                jobs.contains { $0.id == id && $0.status == .running }
            }
        }
        .confirmationDialog("Stop every running job in this conversation?", isPresented: $confirmingStopAll, titleVisibility: .visible) {
            Button("Stop All", role: .destructive) { stopAll() }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private func list(now: Double) -> some View {
        let jobs = JobsDisplay.visible(allJobs, now: now)
        if jobs.isEmpty {
            ContentUnavailableView(
                "No Background Jobs",
                systemImage: "terminal",
                description: Text("Jobs your bots start appear here while they run, and for half an hour after they end.")
            )
        } else {
            List {
                Section {
                    ForEach(jobs) { job in
                        row(job, now: now)
                    }
                } header: {
                    if jobs.filter({ $0.status == .running }).count > 1 {
                        HStack {
                            Spacer()
                            Button("Stop All", role: .destructive) { confirmingStopAll = true }
                                .font(.footnote.weight(.semibold))
                                .textCase(nil)
                        }
                    }
                } footer: {
                    Text(JobsDisplay.footer)
                }
            }
        }
    }

    private func isStopping(_ job: JobSnapshot) -> Bool {
        job.status == .stopping || (job.status == .running && stopping.contains(job.id))
    }

    @ViewBuilder
    private func row(_ job: JobSnapshot, now: Double) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                JobRowDot(job: job)
                Text(job.label)
                    .font(.system(.subheadline, design: .monospaced))
                    .lineLimit(3)
            }
            HStack(spacing: 8) {
                Text(isStopping(job) ? "Stopping" : job.exitChip)
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.secondary.opacity(0.14)))
                Text(JobsDisplay.duration(ms: job.elapsedMs(now: now)))
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
                if showsBotNames, let name = session.state.bot(job.botId)?.name {
                    Text(name)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if let reason = job.shownReason {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button("View Output") { viewingJobId = job.id }
                    .buttonStyle(.borderless)
                Spacer()
                if job.status == .running {
                    Button("Stop", role: .destructive) { stop(job) }
                        .buttonStyle(.borderless)
                        .disabled(isStopping(job))
                }
            }
            .font(.subheadline)
        }
        .padding(.vertical, 4)
    }

    private func stop(_ job: JobSnapshot) {
        stopping.insert(job.id)
        let jobId = job.id
        Task {
            let accepted = await session.stopJob(jobId)
            // Nothing was stopped and no frame will say otherwise: let the
            // person try again.
            if !accepted { stopping.remove(jobId) }
        }
    }

    private func stopAll() {
        let ids = allJobs.filter { $0.status == .running }.map(\.id)
        stopping.formUnion(ids)
        Task {
            let accepted = await session.stopAllJobs(threadId: threadId)
            if !accepted { stopping.subtract(ids) }
        }
    }
}

/// One job's newest output (the newest 64 KB the harness keeps), fetched on
/// demand: output is never on a frame.
struct JobOutputView: View {
    let jobId: String

    @EnvironmentObject private var session: Session
    @State private var text = ""
    @State private var loading = true
    @State private var truncated = false
    @State private var errorMessage: String?
    /// Only the newest request may fill the screen.
    @State private var requestNumber = 0

    private var job: JobSnapshot? {
        for jobs in session.state.jobsByThread.values {
            if let match = jobs.first(where: { $0.id == jobId }) { return match }
        }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let job {
                    Text(job.label)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if truncated {
                    Text("Showing the newest 64 KB.\u{00A0} Earlier output exists on your computer.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if loading && text.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                } else {
                    Text(text.isEmpty ? "No output yet." : text)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(text.isEmpty ? .secondary : .primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
        }
        .navigationTitle("Output")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await load() }
                }
                .disabled(loading)
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        requestNumber += 1
        let mine = requestNumber
        loading = true
        errorMessage = nil
        do {
            let response = try await session.readJobOutput(jobId)
            guard mine == requestNumber else { return }
            if let output = response.output {
                text = output.text
                truncated = output.isTruncated
            } else {
                text = ""
                truncated = false
                errorMessage = "The computer no longer has this job's output."
            }
        } catch {
            guard mine == requestNumber else { return }
            // A cancelled read (the sheet went away, or a refresh gesture
            // gave up) is not a failure to report.
            if !(error is CancellationError) {
                errorMessage = error.localizedDescription
            }
        }
        loading = false
    }
}
