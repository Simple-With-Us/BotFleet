import SwiftUI
import CompanionCore

@MainActor
struct MacSecretsSettings: View {
    @ObservedObject var servers: ServersCoordinator
    @StateObject private var coordinator = InfisicalSettingsCoordinator()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Configure Host", selection: Binding(
                    get: { coordinator.selectedHostID },
                    set: { id in Task { await coordinator.selectHost(id: id) } }
                )) {
                    ForEach(coordinator.hosts) { host in Text(host.name).tag(host.id) }
                }
                .disabled(coordinator.isSaving)

                Text("Infisical is optional.\u{00A0} Credentials and token references are managed on the selected host.")
                    .font(.callout).foregroundStyle(.secondary)

                GroupBox("Infisical") {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle("Enable Infisical", isOn: $coordinator.draft.enabled)
                        Picker("Authentication", selection: $coordinator.draft.authMethod) {
                            ForEach(InfisicalAuthMethod.allCases, id: \.self) { method in
                                Text(method.title).tag(method)
                            }
                        }
                        Text("Service tokens use only their configured scopes.\u{00A0} Machine identity authentication uses the selected host's existing protected app credentials only when explicitly selected.")
                            .font(.caption).foregroundStyle(.secondary)
                        TextField("Infisical Site", text: $coordinator.draft.siteUrl)
                        TextField("Primary Project ID", text: $coordinator.draft.projectId)
                        HStack {
                            TextField("Environment", text: $coordinator.draft.environment)
                            TextField("Secret Path", text: $coordinator.draft.secretPath)
                        }
                    }
                    .textFieldStyle(.roundedBorder)
                    .padding(8)
                }
                .disabled(coordinator.snapshot == nil || coordinator.isSaving || coordinator.isLoading)

                if let snapshot = coordinator.snapshot {
                    GroupBox("Protected Credentials On This Host") {
                        VStack(alignment: .leading, spacing: 6) {
                            credentialRow("Primary Read Token", configured: snapshot.hasToken)
                            credentialRow("Primary Write Token", configured: snapshot.hasWriteToken)
                            credentialRow("App Machine Identity", configured: snapshot.hasClientId && snapshot.hasClientSecret)
                            Text("This form changes references and authentication choice.\u{00A0} It does not read, replace, or copy protected credential values.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(8)
                    }
                }

                GroupBox("Service Token Sources") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Add a source for each project and folder.\u{00A0} File paths and environment names refer to the selected host; write token references are optional and separate from read tokens.")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach($coordinator.draft.readSources) { $source in
                            let sourceID = source.id
                            InfisicalTokenSourceEditor(source: $source) {
                                coordinator.draft.readSources.removeAll { $0.id == sourceID }
                            }
                        }
                        Button("Add Token Source") {
                            var source = InfisicalTokenSourceSettings()
                            source.name = "source-\(coordinator.draft.readSources.count + 1)"
                            coordinator.draft.readSources.append(source)
                        }
                    }.padding(8)
                }
                .disabled(coordinator.snapshot == nil || coordinator.isSaving || coordinator.isLoading)

                HStack {
                    Button("Refresh") { Task { await coordinator.refresh() } }
                        .disabled(coordinator.isLoading || coordinator.isSaving)
                    Button(coordinator.isSaving ? "Saving…" : "Save Secrets Settings") {
                        Task { await coordinator.save() }
                    }
                    .disabled(coordinator.snapshot == nil || coordinator.isLoading || coordinator.isSaving)
                    if coordinator.isLoading || coordinator.isSaving { ProgressView().controlSize(.small) }
                }
                if let error = coordinator.errorMessage { Text(error).font(.callout).foregroundStyle(.red) }
                if let status = coordinator.statusMessage { Text(status).font(.callout).foregroundStyle(.secondary) }
            }
        }
        .task {
            await servers.load()
            coordinator.observeHosts(from: servers)
            await coordinator.refresh()
        }
    }

    private func credentialRow(_ label: String, configured: Bool) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(configured ? "Configured" : "Not configured").foregroundStyle(.secondary)
        }
    }
}

private struct InfisicalTokenSourceEditor: View {
    @Binding var source: InfisicalTokenSourceSettings
    let remove: () -> Void

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    TextField("Source Name", text: $source.name)
                    Button("Remove Source", role: .destructive, action: remove)
                }
                TextField("Project ID", text: $source.projectId)
                HStack {
                    TextField("Environment", text: $source.environment)
                    TextField("Secret Path", text: $source.secretPath)
                }
                HStack {
                    TextField("Read Token File", text: $source.tokenFile)
                    TextField("Read Token Environment Name", text: $source.tokenEnv)
                }
                HStack {
                    TextField("Write Token File (Optional)", text: $source.writeTokenFile)
                    TextField("Write Token Environment Name (Optional)", text: $source.writeTokenEnv)
                }
            }
            .textFieldStyle(.roundedBorder)
            .padding(4)
        }
    }
}
