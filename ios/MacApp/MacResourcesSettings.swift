import SwiftUI
import CompanionCore

struct MacResourcesSettings: View {
    @ObservedObject var coordinator: ResourcesCoordinator
    @State private var showThresholdEnvNames = false
    @State private var showHeadroomEnvNames = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Picker(
                    "Host",
                    selection: Binding(
                        get: { coordinator.selectedHostID },
                        set: { newID in
                            Task { await coordinator.selectHost(id: newID) }
                        }
                    )
                ) {
                    ForEach(coordinator.hosts) { host in
                        Text(host.name).tag(host.id)
                    }
                }
                .frame(maxWidth: 260)

                Spacer()

                Button {
                    Task { await coordinator.refresh() }
                } label: {
                    Label(
                        coordinator.state.isRefreshing ? "Refreshing…" : "Refresh",
                        systemImage: "arrow.clockwise"
                    )
                }
                .disabled(coordinator.state.isLoading || coordinator.state.isRefreshing)
            }

            Text(HostResourcesPresentation.hostSubtitle(for: coordinator.selectedHost, activeReport: coordinator.currentReport))
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            if coordinator.state.isLoading {
                GroupBox("Host Resource Readings") {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading host resources…")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let errorMessage = coordinator.state.errorMessage {
                GroupBox("Host Resource Readings") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(errorMessage)
                            .font(.callout)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                        Button("Refresh") {
                            Task { await coordinator.refresh() }
                        }
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let report = coordinator.currentReport {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ReadingsCard(report: report)
                        ThresholdsCard(
                            report: report,
                            showEnvNames: $showThresholdEnvNames
                        )
                        HeadroomCard(
                            coordinator: coordinator,
                            report: report,
                            showEnvNames: $showHeadroomEnvNames
                        )
                        if !report.limitations.isEmpty {
                            KnownGapsCard(limitations: report.limitations)
                        }
                    }
                }
            }
        }
        .task {
            await coordinator.load()
        }
    }
}

private struct ReadingsCard: View {
    let report: HostResourcesReport

    var body: some View {
        let rows = HostResourcesPresentation.resourceRows(for: report)
        GroupBox("Host Resource Readings") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Detected capacity, current use and enforcement mechanism for each host resource.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(row.label)
                                .font(.callout.weight(.semibold))
                                .frame(width: 130, alignment: .leading)
                            Text(row.detected)
                                .font(.callout)
                                .frame(width: 110, alignment: .leading)
                            Text(row.use)
                                .font(.callout)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Text(row.enforcement)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 142)
                        if let alert = row.alert {
                            Text(alert)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.red)
                                .padding(.leading, 142)
                        }
                        Divider()
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ThresholdsCard: View {
    let report: HostResourcesReport
    @Binding var showEnvNames: Bool

    var body: some View {
        let thresholds = HostResourcesPresentation.admissionRows(for: report)
        let mismatches = thresholds.filter { $0.mismatch != nil }

        GroupBox("Admission Thresholds (Saved vs Applied)") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Saved values from the owner's config against what the runtime actually applies.\u{00A0} Jobs settings apply live, so the two agree unless a row below says otherwise.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ForEach(thresholds) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(row.label)
                                .font(.callout.weight(.semibold))
                                .frame(width: 170, alignment: .leading)
                            Text("Saved: \(row.saved)")
                                .font(.callout)
                                .frame(width: 120, alignment: .leading)
                            Text("Applied: \(row.applied)")
                                .font(.callout)
                                .foregroundStyle(row.mismatch != nil ? .orange : .primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let note = row.note {
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let mismatch = row.mismatch {
                            Text("Saved \(row.saved) · \(mismatch)")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.orange)
                        }
                        Divider()
                    }
                }

                if mismatches.isEmpty {
                    Text("Saved and applied agree on every threshold.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text("A saved number the runtime has not applied keeps the previous applied value in force — a saved value is never shown as applied.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                DisclosureGroup("Show environment variable names", isExpanded: $showEnvNames) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(thresholds) { row in
                            HStack(spacing: 6) {
                                Text("\(row.label):")
                                    .font(.caption.weight(.medium))
                                Text("\(row.knob) · \(row.envOverride)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .padding(.top, 4)
                }
                .font(.caption)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct HeadroomCard: View {
    @ObservedObject var coordinator: ResourcesCoordinator
    let report: HostResourcesReport
    @Binding var showEnvNames: Bool
    @State private var values: HeadroomEditValues
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var touched = false
    @State private var submitAttempted = false

    init(coordinator: ResourcesCoordinator, report: HostResourcesReport, showEnvNames: Binding<Bool>) {
        _coordinator = ObservedObject(wrappedValue: coordinator)
        self.report = report
        _showEnvNames = showEnvNames
        _values = State(initialValue: HostResourcesPresentation.headroomEditInitial(report))
    }

    private var outcome: HeadroomEditOutcome {
        HostResourcesPresentation.parseHeadroomEdit(values)
    }

    private var isValid: Bool {
        if case .valid = outcome { return true }
        return false
    }

    private var firstMessage: String? {
        if case .invalid(let errors) = outcome { return errors.first?.message }
        return nil
    }

    private var showValidation: Bool {
        !isValid && (touched || submitAttempted)
    }

    var body: some View {
        GroupBox("Owner-Set Headroom") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Reserved capacity for everything else on this host.\u{00A0} Absent means unset: no gate, exactly as before.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Reserved CPU cores")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        TextField("Not set", text: $values.reservedCpuCores)
                            .disabled(saving)
                            .onChange(of: values.reservedCpuCores) { touched = true }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Reserved RAM (MB)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        TextField("Not set", text: $values.reservedRamMb)
                            .disabled(saving)
                            .onChange(of: values.reservedRamMb) { touched = true }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Minimum available memory (%)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        TextField("Not set", text: $values.minMemoryAvailablePercent)
                            .disabled(saving)
                            .onChange(of: values.minMemoryAvailablePercent) { touched = true }
                    }
                }

                if showValidation, let message = firstMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }

                Button {
                    save()
                } label: {
                    HStack(spacing: 6) {
                        if saving {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(saving ? "Saving…" : "Save headroom")
                    }
                }
                .disabled(!isValid || saving)

                Text("Saves via PUT /api/config, then reloads the report.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Text(headroomFooter)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                DisclosureGroup("Show environment variable names", isExpanded: $showEnvNames) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("BOTFLEET_JOBS_RESERVED_CPU_CORES")
                        Text("BOTFLEET_JOBS_RESERVED_RAM_MB")
                        Text("BOTFLEET_JOBS_MIN_MEMORY_AVAILABLE_PERCENT")
                    }
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.top, 4)
                }
                .font(.caption)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onChange(of: report) { newReport in
            values = HostResourcesPresentation.headroomEditInitial(newReport)
            touched = false
            submitAttempted = false
            errorMessage = nil
        }
    }

    private func save() {
        submitAttempted = true
        guard isValid else {
            errorMessage = firstMessage
            return
        }
        guard !saving else { return }
        saving = true
        errorMessage = nil
        Task {
            do {
                try await coordinator.saveHeadroom(values: values)
            } catch {
                errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            saving = false
        }
    }

    private var headroomFooter: String {
        var parts = ["Empty clears a set knob back to unset.\u{00A0} A vault-managed knob is refused; remove it in Infisical to unset it."]
        if let reservedRam = report.admission.reservedRamBytes {
            parts.append("Reserved RAM in force: \(HostResourcesPresentation.formatBytes(reservedRam)).")
        }
        if report.platform == "darwin" {
            parts.append("On this Mac reserved CPU never refuses a job; it sizes the per-job CPU-time budget instead.")
        }
        return parts.joined(separator: "\u{00A0} ")
    }
}

private struct KnownGapsCard: View {
    let limitations: [String]

    var body: some View {
        GroupBox("Known Gaps") {
            VStack(alignment: .leading, spacing: 6) {
                Text("What this report cannot see, in its own words.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(Array(limitations.enumerated()), id: \.offset) { _, limitation in
                    Text("• \(limitation)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
