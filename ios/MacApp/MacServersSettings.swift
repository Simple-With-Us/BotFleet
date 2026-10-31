import SwiftUI
import CompanionCore

private enum ServerEditor: Identifiable {
    case add, local(HostRecord), rename(HostRecord), test(HostRecord)
    var id: String {
        switch self {
        case .add: return "add"
        case .local: return "local"
        case .rename(let host): return "rename-\(host.id)"
        case .test(let host): return "test-\(host.id)"
        }
    }
}

struct MacServersSettings: View {
    @ObservedObject var coordinator: ServersCoordinator
    let onLocalSaved: (HostRecord) -> Void
    @State private var editor: ServerEditor?
    @State private var removing: HostRecord?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("This Mac runs your bots.\u{00A0} Testing a saved server checks its connection.")
                .font(.callout).foregroundStyle(.secondary)
            if coordinator.hosts.allSatisfy(\.isLocal) {
                Text("No server added.\u{00A0} BotFleet runs on this Mac.\u{00A0} Add a server if you have one.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(coordinator.hosts) { host in
                        VStack(alignment: .leading, spacing: 6) {
                            Label(host.name, systemImage: host.isLocal ? "desktopcomputer" : "server.rack")
                                .font(.headline)
                            Text(host.origin.url.absoluteString).font(.caption).foregroundStyle(.secondary)
                            Text(coordinator.statuses[host.id] ?? (host.isLocal ? "Used by this app" : "Not tested in this session"))
                                .font(.callout).textSelection(.enabled)
                            HStack {
                                if host.isLocal {
                                    Button("Edit Address…") { editor = .local(host) }
                                } else {
                                    Button("Rename…") { editor = .rename(host) }
                                }
                                Button("Test") {
                                    if host.isLocal { coordinator.test(host) } else { editor = .test(host) }
                                }.disabled(coordinator.testing.contains(host.id))
                                if coordinator.testing.contains(host.id) {
                                    Button("Cancel Test") { coordinator.cancelTest(host.id) }
                                }
                                if !host.isLocal {
                                    Button("Remove…", role: .destructive) { removing = host }
                                        .disabled(coordinator.removalReason(host) != nil)
                                        .help(coordinator.removalReason(host) ?? "Forget the address and token")
                                }
                            }
                            if !host.isLocal, let reason = coordinator.removalReason(host) {
                                Text(reason).font(.caption).foregroundStyle(.secondary)
                            }
                            Divider()
                        }
                    }
                }
            }.disabled(!coordinator.isLoaded)
            Button("Add A Server…") { editor = .add }.disabled(!coordinator.isLoaded)
            if !coordinator.isLoaded {
                Button("Reload Servers") { Task { await coordinator.load() } }
            }
            if let error = coordinator.errorMessage {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .disabled(coordinator.isBusy)
        .task { await coordinator.load() }
        .sheet(item: $editor) { selection in
            ServerEditorSheet(editor: selection, coordinator: coordinator, onLocalSaved: onLocalSaved)
        }
        .confirmationDialog("Remove Server?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            if let host = removing {
                Button("Remove Server", role: .destructive) { Task { await coordinator.remove(host); removing = nil } }
            }
        } message: {
            Text("Removing this server keeps its finished job history on this Mac and forgets its address and token.")
        }
    }
}

private struct ServerEditorSheet: View {
    let editor: ServerEditor
    @ObservedObject var coordinator: ServersCoordinator
    let onLocalSaved: (HostRecord) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address = ""
    @State private var port = 8799
    @State private var token = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch editor {
            case .add:
                Text("Add A Server").font(.headline)
                TextField("Name", text: $name)
                TextField("Server URL", text: $address)
                Text("Use an HTTPS address.\u{00A0} You can enter a token when you test the server.").font(.caption)
            case .local:
                Text("This Mac Address").font(.headline)
                TextField("Host", text: $address)
                TextField("Port", value: $port, format: .number.grouping(.never))
                Text("Use a loopback address for the server running on this Mac.").font(.caption)
            case .rename:
                Text("Rename Server").font(.headline)
                TextField("Name", text: $name)
            case .test(let host):
                Text("Test \(host.name)").font(.headline)
                SecureField("Server Token", text: $token)
                Text(host.hostId == nil ? "Enter a fresh token to verify this server's identity and save it securely." : "Leave empty to use this server's saved token.").font(.caption)
            }
            if let error = coordinator.errorMessage { Text(error).foregroundStyle(.red).font(.caption) }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { token = ""; dismiss() }.keyboardShortcut(.cancelAction)
                Button(actionTitle) { submit() }.keyboardShortcut(.defaultAction).disabled(coordinator.isBusy)
            }
        }
        .padding(24).frame(width: 430)
        .onAppear {
            switch editor {
            case .local(let host): address = host.origin.url.host ?? "127.0.0.1"; port = host.origin.url.port ?? 80
            case .rename(let host): name = host.name
            default: break
            }
        }
        .onDisappear { token = "" }
    }

    private var actionTitle: String { if case .test = editor { return "Test" }; return "Save" }
    private func submit() {
        if case .test(let host) = editor {
            let secret = token.isEmpty ? nil : RedactedSecret(token)
            token = ""
            coordinator.test(host, token: secret); dismiss(); return
        }
        Task {
            let saved: Bool
            switch editor {
            case .add: saved = await coordinator.add(name: name, origin: address)
            case .rename(let host): saved = await coordinator.rename(host, name: name)
            case .local:
                let origin = "http://\(Connection.urlHost(address)):\(port)"
                if let host = await coordinator.updateThisMac(origin: origin) { onLocalSaved(host); saved = true }
                else { saved = false }
            case .test: saved = false
            }
            token = ""
            if saved { dismiss() }
        }
    }
}
