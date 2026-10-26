import AppKit
import BotFleetControlCore
import ServiceManagement

@main
final class ControlApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let hostStore = ServerHostStore()
    private var hosts: [ServerHost] = []
    private var hostApis: [String: ControlAPI] = [:]
    private var hostStatuses: [String: ControlStatus] = [:]
    private var hostErrors: [String: String] = [:]

    private var api: ControlAPI {
        api(for: .defaultLocal)
    }

    private func api(for host: ServerHost) -> ControlAPI {
        if let existing = hostApis[host.id], existing.host == host { return existing }
        let client = ControlAPI(host: host)
        hostApis[host.id] = client
        return client
    }

    private let startup = StartupPolicy()
    private let persistence = PersistencePolicy()
    private let offlineDocker = OfflineDockerVM()
    private let offlineVMHelper = OfflineVMHelper()
    private let presenceProbe = ServerPresenceProbe()
    private let mcpServer: McpServerControl?
    private let mcpServerProblem: String?
    private var item: NSStatusItem?
    private let menu = NSMenu()
    private var status: ControlStatus?
    private var persistOnExit: Bool?
    private var installedServerState: InstalledServerState = .unknown
    private var apiUnavailable = false
    private var serverPresence: ServerPresence = .unknown
    private var offlineVMs: OfflineDockerState = .unavailable
    private var helperVMs: [LocalVM]?
    private var vmProblem: String?
    private var mcpServerState: WheelhouseState = .unknown
    private var isLoading = false
    private var isBusy = false
    private var isReconciling = false
    private var problem: String?

    override init() {
        do {
            mcpServer = try McpServerControl()
            mcpServerProblem = nil
        } catch {
            // The wheelhouse reports the problem in the menu instead of the
            // app refusing to start over it.
            mcpServer = nil
            mcpServerProblem = error.localizedDescription
        }
        super.init()
    }

    static func main() {
        let app = NSApplication.shared
        let delegate = ControlApp()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        hosts = hostStore.loadHosts()
        menu.autoenablesItems = false
        menu.delegate = self
        showIcon()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showIcon()
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if isBusy {
            showError("A server action is still in progress.  Wait for it to finish before quitting Control.")
            return .terminateCancel
        }
        return .terminateNow
    }

    private func showIcon() {
        guard item == nil else { return }
        let newItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        newItem.button?.image = NSImage(systemSymbolName: "server.rack", accessibilityDescription: "BotFleet Control")
        newItem.button?.image?.isTemplate = true
        newItem.button?.toolTip = "BotFleet Control"
        newItem.menu = menu
        item = newItem
        rebuildMenu()
    }

    func menuWillOpen(_ menu: NSMenu) {
        guard !isBusy, !isLoading else { return }
        isLoading = true
        hosts = hostStore.loadHosts()
        rebuildMenu()
        Task { @MainActor in
            // 1. Probe local server
            do {
                let localStatus = try await self.api.status()
                self.status = localStatus
                self.hostStatuses[ServerHost.defaultLocal.id] = localStatus
                self.hostErrors[ServerHost.defaultLocal.id] = nil
                self.persistOnExit = localStatus.persistOnExit
                self.installedServerState = .running
                self.apiUnavailable = false
                self.serverPresence = .present
                self.offlineVMs = .unavailable
                self.helperVMs = nil
                self.vmProblem = nil
                self.problem = nil
            } catch {
                self.status = nil
                self.hostStatuses.removeValue(forKey: ServerHost.defaultLocal.id)
                self.hostErrors[ServerHost.defaultLocal.id] = error.localizedDescription
                self.installedServerState = await Task.detached(priority: .userInitiated) { self.startup.installedServerState }.value
                self.apiUnavailable = (error as? ControlAPIError) == .unavailable
                // The API did not answer.  That is not proof that the server
                // is gone, so ask the port itself.
                self.serverPresence = await Task.detached(priority: .userInitiated) { self.presenceProbe.presence() }.value
                self.persistOnExit = self.installedServerState == .stopped && self.apiUnavailable ? self.persistence.value : nil
                if self.installedServerState == .stopped && self.apiUnavailable {
                    if self.offlineVMHelper.available {
                        do {
                            self.helperVMs = try await Task.detached(priority: .userInitiated) { try self.offlineVMHelper.status() }.value
                            self.vmProblem = nil
                        } catch {
                            self.helperVMs = nil
                            self.vmProblem = error.localizedDescription
                        }
                    } else { self.helperVMs = nil; self.vmProblem = nil }
                    self.offlineVMs = self.helperVMs == nil
                        ? await Task.detached(priority: .userInitiated) { self.offlineDocker.inspect() }.value
                        : .unavailable
                } else { self.offlineVMs = .unavailable; self.helperVMs = nil; self.vmProblem = nil }
                self.problem = self.apiUnavailable && self.installedServerState == .stopped ? nil : error.localizedDescription
            }

            // 2. Concurrently probe remote hosts
            await withTaskGroup(of: (String, Result<ControlStatus, Error>).self) { group in
                for host in self.hosts where !host.isLocal {
                    let client = self.api(for: host)
                    group.addTask {
                        do {
                            let st = try await client.status()
                            return (host.id, .success(st))
                        } catch {
                            return (host.id, .failure(error))
                        }
                    }
                }
                for await (id, result) in group {
                    switch result {
                    case .success(let st):
                        self.hostStatuses[id] = st
                        self.hostErrors[id] = nil
                    case .failure(let err):
                        self.hostStatuses.removeValue(forKey: id)
                        self.hostErrors[id] = err.localizedDescription
                    }
                }
            }

            self.isLoading = false
            self.rebuildMenu()
            // The wheelhouse is reconciled behind the menu.  pm2 can take
            // seconds to start or stop a service, and a menu that waits for
            // it looks broken long before it is.
            self.reconcileWheelhouseInBackground()
        }
    }

    /// What the Control app knows about the BotFleet Server itself.
    private func serverState() -> Wheelhouse.ServerState {
        Wheelhouse.serverState(statusAvailable: status != nil,
                                installedServerState: installedServerState,
                                serverPresence: serverPresence)
    }

    /// Brings the wheelhouse in line with what is wanted, without holding the
    /// menu open while pm2 does its work.
    private func reconcileWheelhouseInBackground() {
        guard !isReconciling else { return }
        isReconciling = true
        Task { @MainActor in
            await reconcileWheelhouse()
            isReconciling = false
            rebuildMenu()
        }
    }

    /// Brings the wheelhouse in line with what is wanted.
    ///
    /// The wanted state is derived from the BotFleet Server's own state, so
    /// there is nothing to store and nothing to toggle.  The BotFleet MCP
    /// server is wanted exactly while the server is running.
    private func reconcileWheelhouse() async {
        guard let mcpServer else {
            problem = mcpServerProblem ?? "The BotFleet MCP Server could not be prepared."
            return
        }
        mcpServerState = await mcpServer.state()
        // The decision is made on fresh evidence: if the server is not
        // answering, look at its port before concluding that it is gone.
        if status == nil {
            serverPresence = await Task.detached(priority: .userInitiated) { self.presenceProbe.presence() }.value
        } else {
            serverPresence = .present
        }
        let wheelhouse = Wheelhouse(serverState: serverState(), mcpServerState: mcpServerState)
        for entry in wheelhouse.entries {
            switch Wheelhouse.action(for: entry) {
            case .start:
                do { mcpServerState = try await mcpServer.setRunning(true) }
                catch { problem = "BotFleet MCP Server: \(error.localizedDescription)" }
            case .stop:
                do { mcpServerState = try await mcpServer.setRunning(false) }
                catch { problem = "BotFleet MCP Server: \(error.localizedDescription)" }
            case .none:
                break
            }
        }
    }

    /// Re-reads the server's own state after an action, and waits for that
    /// state to settle, so the wheelhouse is reconciled against what is true
    /// now rather than against what was true before the action.
    private func refreshInstalledServerState(until settled: [InstalledServerState],
                                             attempts: Int = 40) async {
        for _ in 0..<attempts {
            let state = await Task.detached(priority: .userInitiated) { self.startup.installedServerState }.value
            installedServerState = state
            if settled.contains(state) { return }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
    }

    private func add(_ title: String, selector: Selector? = nil, enabled: Bool = true, state: NSControl.StateValue = .off, representedObject: Any? = nil) {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        entry.target = self
        entry.isEnabled = selector != nil && enabled
        entry.state = state
        entry.representedObject = representedObject
        menu.addItem(entry)
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        let ready = !isLoading && !isBusy

        // 1. LOCAL SERVER (Mac)
        if hosts.count > 1 {
            let localHeader = NSMenuItem(title: "LOCAL MAC SERVER", action: nil, keyEquivalent: "")
            localHeader.isEnabled = false
            menu.addItem(localHeader)
        }

        if isLoading {
            add("Server: Loading…")
        } else if let status {
            add("Server: running (\(status.activeBotCount) active bots)")
            let vmState = status.isSharedVMRunning ? "Running 🟢" : "Off ⚪️ (\(status.sharedVM?.state ?? "stopped"))"
            add("Shared VM: \(vmState)")
            if status.localVms.count > 1 {
                add("Local VMs: \(status.runningVMCount) running of \(status.localVms.count)")
                for vm in status.localVms where vm.key != "shared" {
                    add("  \(vm.name): \(vm.state ?? (vm.running ? "running" : "unknown"))")
                }
            }
        } else {
            if apiUnavailable && installedServerState == .stopped { add("Server: stopped") }
            else if installedServerState == .notInstalled { add("Server: not installed") }
            else if installedServerState == .running { add("Server: unresponsive") }
            else { add("Server: unknown") }
            if apiUnavailable && installedServerState == .stopped, let helperVMs {
                let running = helperVMs.filter(\.running).count
                let shared = helperVMs.first(where: { $0.key == "shared" })
                let vmState = (shared?.running == true) ? "Running 🟢" : "Off ⚪️ (\(shared?.state ?? "unknown"))"
                add("Shared VM: \(vmState)")
                add("Local VMs: \(running) running of \(helperVMs.count)")
                for vm in helperVMs { add("  \(vm.name): \(vm.state ?? "unknown")") }
            } else if apiUnavailable && installedServerState == .stopped,
               case .local(let vms) = offlineVMs {
                add("Local VMs (Docker): \(offlineVMs.runningCount) running of \(vms.count)")
                if vms.isEmpty { add("  Managed Docker VMs: none found") }
                for vm in vms { add("  \(vm.name): \(vm.running ? "running" : "stopped")") }
            } else if apiUnavailable { add("Shared VM: Off ⚪️ (server offline)") }
            else { add("Shared VM: unknown while server is busy") }
        }
        if let problem { add("Error: \(problem)") }
        if let vmProblem { add("Local VM: \(vmProblem)") }
        if status?.sharedVM?.state == "stopped" { add("Local VM requires recreation in BotFleet") }
        if !startup.supportsPolicy { add("Update BotFleet to manage server startup") }

        let wheelhouse = Wheelhouse(serverState: serverState(),
                                    mcpServerState: mcpServerState)
        if !wheelhouse.entries.isEmpty {
            menu.addItem(.separator())
            for entry in wheelhouse.entries { add("\(entry.title): \(entry.summary)") }
        }

        menu.addItem(.separator())
        add("Start Server", selector: #selector(startServer), enabled: ready && startup.supportsPolicy && apiUnavailable && installedServerState == .stopped)
        add("Stop Server And Local VMs…", selector: #selector(stopServer), enabled: ready && status != nil)
        add("Start Shared VM", selector: #selector(startVM), enabled: ready && status?.canStartSharedVM == true)
        let canCreateOffline = apiUnavailable && installedServerState == .stopped
            && offlineVMHelper.available && helperVMs?.first(where: { $0.key == "shared" })?.state == "missing"
        add("Create Local VM (Stopped)…", selector: #selector(createStoppedVM), enabled: ready && canCreateOffline)
        let offlineRunning = helperVMs?.contains(where: \.running) == true
        add("Stop Shared VM…", selector: #selector(stopVMs), enabled: ready && (((status?.runningVMCount ?? 0) > 0) ||
            (apiUnavailable && installedServerState == .stopped && offlineVMHelper.available && offlineRunning)))
        if status == nil && apiUnavailable && installedServerState == .stopped {
            if !offlineVMHelper.available { add("Update BotFleet Control to manage Local VMs offline") }
        }

        // 2. REMOTE CONNECTED SERVERS (e.g. Hetzner Server, or custom servers)
        for host in hosts where !host.isLocal {
            menu.addItem(.separator())
            let header = NSMenuItem(title: host.name.uppercased(), action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)

            if let st = hostStatuses[host.id] {
                add("Server: running (\(st.activeBotCount) active bots)")
                let vmState = st.isSharedVMRunning ? "Running 🟢" : "Off ⚪️ (\(st.sharedVM?.state ?? "stopped"))"
                add("Shared VM: \(vmState)")
                if st.localVms.count > 1 {
                    add("VMs: \(st.runningVMCount) running of \(st.localVms.count)")
                }
                if let err = hostErrors[host.id] { add("Notice: \(err)") }

                add("Start Shared VM (\(host.name))", selector: #selector(startHostSharedVM), enabled: ready && st.canStartSharedVM, representedObject: host)
                add("Stop Shared VM (\(host.name))…", selector: #selector(stopHostSharedVM), enabled: ready && st.canStopSharedVM, representedObject: host)
                add("Stop Server (\(host.name))…", selector: #selector(stopRemoteServer), enabled: ready, representedObject: host)
            } else {
                let err = hostErrors[host.id] ?? "unreachable"
                add("Server: offline (\(err))")
                add("Shared VM: Off ⚪️ (server offline)")
                add("Retry Connection (\(host.name))", selector: #selector(retryHostConnection), enabled: ready, representedObject: host)
            }
        }

        // 3. CONNECTED SERVERS SUBMENU
        menu.addItem(.separator())
        let serversMenu = NSMenu()
        for host in hosts {
            let isOnline = host.isLocal ? (status != nil) : (hostStatuses[host.id] != nil)
            let badge = isOnline ? "🟢" : "⚪️"
            let item = NSMenuItem(title: "\(badge) \(host.name) (\(host.baseURL.absoluteString))", action: nil, keyEquivalent: "")
            item.isEnabled = false
            serversMenu.addItem(item)
        }
        serversMenu.addItem(.separator())
        let addItem = NSMenuItem(title: "Add Connected Server…", action: #selector(promptAddServer), keyEquivalent: "")
        addItem.target = self
        addItem.isEnabled = ready
        serversMenu.addItem(addItem)

        let removable = hosts.filter { !$0.isLocal }
        if !removable.isEmpty {
            let removeMenu = NSMenu()
            for host in removable {
                let rItem = NSMenuItem(title: "Remove \(host.name)", action: #selector(removeServerAction), keyEquivalent: "")
                rItem.target = self
                rItem.representedObject = host
                removeMenu.addItem(rItem)
            }
            let removeParent = NSMenuItem(title: "Remove Server", action: nil, keyEquivalent: "")
            removeParent.submenu = removeMenu
            serversMenu.addItem(removeParent)
        }
        let refreshItem = NSMenuItem(title: "Refresh All Servers", action: #selector(refreshHosts), keyEquivalent: "")
        refreshItem.target = self
        refreshItem.isEnabled = ready
        serversMenu.addItem(refreshItem)

        let parentServersItem = NSMenuItem(title: "Connected Servers (\(hosts.count))", action: nil, keyEquivalent: "")
        parentServersItem.submenu = serversMenu
        menu.addItem(parentServersItem)

        // 4. PERSISTENCE & LOGIN SETTINGS
        menu.addItem(.separator())
        add("Keep Server Running After Quitting BotFleet", selector: #selector(togglePersist),
            enabled: ready && persistOnExit != nil && (status != nil || (apiUnavailable && installedServerState == .stopped)),
            state: persistOnExit == nil ? .mixed : (persistOnExit == true ? .on : .off))
        if status == nil && apiUnavailable && installedServerState == .stopped && persistOnExit == nil {
            add("Server preference: not set locally")
            add("Set Keep Running: On", selector: #selector(setOfflinePersistOn), enabled: ready)
            add("Set Keep Running: Off", selector: #selector(setOfflinePersistOff), enabled: ready)
        }
        add("Start Server At Login", selector: #selector(toggleStartup), enabled: ready && startup.supportsPolicy,
            state: startup.loginPolicy == .legacy ? .mixed : (startup.startsAtLogin ? .on : .off))
        if startup.loginPolicy == .legacy { add("Login startup: legacy behavior") }
        add("Launch Control At Login", selector: #selector(toggleControlLogin), enabled: ready,
            state: SMAppService.mainApp.status == .enabled ? .on : .off)
        menu.addItem(.separator())
        add("Open BotFleet", selector: #selector(openBotFleet))
        add("Hide Menu Bar Icon…", selector: #selector(hideIcon), enabled: ready)
        add("Quit Control", selector: #selector(quitControl), enabled: !isBusy)
    }

    private func run(refresh: Bool = true,
                     settlesWhen settled: [InstalledServerState] = [.running, .stopped, .notInstalled],
                     _ action: @escaping () async throws -> Void) {
        guard !isBusy && !isLoading else { return }
        isBusy = true
        problem = nil
        rebuildMenu()
        Task { @MainActor in
            do {
                try await action()
                if !refresh {
                    status = nil
                    persistOnExit = nil
                    apiUnavailable = true
                    helperVMs = nil
                    offlineVMs = .unavailable
                }
                await refreshInstalledServerState(until: settled)
                await reconcileWheelhouse()
            }
            catch { problem = error.localizedDescription; showError(error.localizedDescription) }
            isBusy = false
            rebuildMenu()
            if refresh { menuWillOpen(menu) }
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "BotFleet Control Could Not Complete the Action"
        alert.informativeText = message
        alert.runModal()
    }

    private func confirm(_ title: String, _ message: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func startServer() {
        // The server is wanted running, so wait for its process to appear
        // before the wheelhouse decides what the MCP server should be doing.
        run(settlesWhen: [.running, .notInstalled]) { [self] in
            try await Task.detached(priority: .userInitiated) { try self.startup.startServer() }.value
        }
    }

    @objc private func stopServer() {
        guard let status else { return }
        // Say what will actually block the stop, not just the bot turns.  The
        // server refuses on any kind of in-flight work, so a dialog that
        // counts only bot turns could promise a clean stop and then the
        // server would refuse it for something the owner was never shown.
        let blocking = status.blockingWorkSummary
        let message = blocking.map { "This stops the server and its local VMs.  The server will refuse while work is in flight: \($0)." }
            ?? "This stops the server and its local VMs.  \(status.activeBotCount) bot turn(s) are active; the server will refuse while bots or leases are busy."
        guard confirm("Stop BotFleet Server And Local VMs?", message) else { return }
        // The server is wanted stopped, so wait for its process to go away
        // before the wheelhouse stops the services that only run with it.
        run(refresh: false, settlesWhen: [.stopped, .notInstalled]) { [self] in
            try await api.stopServer()
        }
    }

    @objc private func startVM() { run { [self] in try await api.startVM() } }

    @objc private func createStoppedVM() {
        guard apiUnavailable && installedServerState == .stopped,
              confirm("Create Local VM in Stopped State?", "This creates a managed Local VM without starting it.  The server stays stopped.") else { return }
        run { [self] in
            guard startup.installedServerState == .stopped else { throw OfflineVMHelperError.refused("BotFleet Server is no longer stopped.") }
            _ = try await Task.detached(priority: .userInitiated) { try self.offlineVMHelper.createStopped() }.value
        }
    }

    @objc private func stopVMs() {
        guard confirm("Stop Local VMs?", "Running local VMs will stop.  The server will refuse while bots or leases are busy.") else { return }
        if status != nil {
            run { [self] in try await api.stopVMs() }
        } else if apiUnavailable && installedServerState == .stopped {
            run { [self] in
                guard startup.installedServerState == .stopped else { throw OfflineVMHelperError.refused("BotFleet Server is no longer stopped.") }
                _ = try await Task.detached(priority: .userInitiated) { try self.offlineVMHelper.stop() }.value
            }
        }
    }

    @objc private func startHostSharedVM(_ sender: NSMenuItem) {
        guard let host = sender.representedObject as? ServerHost else { return }
        let client = api(for: host)
        run { try await client.startSharedVM() }
    }

    @objc private func stopHostSharedVM(_ sender: NSMenuItem) {
        guard let host = sender.representedObject as? ServerHost else { return }
        guard confirm("Stop Shared and Local VMs on \(host.name)?", "Running local and per-bot VMs on this host will stop.  The server will refuse while active bots or leases are busy.") else { return }
        let client = api(for: host)
        run { try await client.stopSharedVM() }
    }

    @objc private func stopRemoteServer(_ sender: NSMenuItem) {
        guard let host = sender.representedObject as? ServerHost else { return }
        guard confirm("Stop Server on \(host.name)?", "This stops the remote BotFleet server.") else { return }
        let client = api(for: host)
        run { try await client.stopServer() }
    }

    @objc private func retryHostConnection(_ sender: NSMenuItem) {
        menuWillOpen(menu)
    }

    @objc private func refreshHosts() {
        menuWillOpen(menu)
    }

    @objc private func promptAddServer() {
        let alert = NSAlert()
        alert.messageText = "Add Connected BotFleet Server"
        alert.informativeText = "Enter the server name, base URL (e.g. https://hetzner.botfleet.app or http://192.168.1.50:8799), and optional Bearer auth token."
        alert.addButton(withTitle: "Add Server")
        alert.addButton(withTitle: "Cancel")

        let stack = NSStackView(frame: NSRect(x: 0, y: 0, width: 300, height: 110))
        stack.orientation = .vertical
        stack.spacing = 8

        let nameField = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        nameField.placeholderString = "Server Name (e.g. Hetzner Server)"

        let urlField = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        urlField.placeholderString = "https://hetzner.botfleet.app"

        let tokenField = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        tokenField.placeholderString = "Auth Token (optional)"

        stack.addArrangedSubview(nameField)
        stack.addArrangedSubview(urlField)
        stack.addArrangedSubview(tokenField)
        alert.accessoryView = stack

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }

        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let urlStr = urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = tokenField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !name.isEmpty, let url = URL(string: urlStr), url.scheme == "http" || url.scheme == "https" else {
            showError("Invalid server URL. Please provide a valid HTTP or HTTPS URL.")
            return
        }

        let newHost = ServerHost(name: name, baseURL: url, authToken: token.isEmpty ? nil : token, isLocal: false)
        hostStore.upsertHost(newHost)
        hosts = hostStore.loadHosts()
        menuWillOpen(menu)
    }

    @objc private func removeServerAction(_ sender: NSMenuItem) {
        guard let host = sender.representedObject as? ServerHost else { return }
        guard confirm("Remove \(host.name)?", "BotFleet Control will stop monitoring \(host.baseURL.absoluteString).") else { return }
        hostStore.removeHost(id: host.id)
        hostStatuses.removeValue(forKey: host.id)
        hostErrors.removeValue(forKey: host.id)
        hostApis.removeValue(forKey: host.id)
        hosts = hostStore.loadHosts()
        rebuildMenu()
    }

    @objc private func togglePersist() {
        guard let persistOnExit else { return }
        let next = !persistOnExit
        if status != nil {
            run { [self] in try await api.setPersistOnExit(next) }
        } else if apiUnavailable && installedServerState == .stopped {
            run { [self] in try persistence.set(next) }
        }
    }

    @objc private func setOfflinePersistOn() {
        guard apiUnavailable && installedServerState == .stopped else { return }
        run { [self] in try persistence.set(true) }
    }

    @objc private func setOfflinePersistOff() {
        guard apiUnavailable && installedServerState == .stopped else { return }
        run { [self] in try persistence.set(false) }
    }

    @objc private func toggleStartup() {
        let next = !startup.startsAtLogin
        run { [self] in try await Task.detached(priority: .userInitiated) { try self.startup.setStartsAtLogin(next) }.value }
    }

    @objc private func toggleControlLogin() {
        run {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        }
    }

    @objc private func openBotFleet() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "app.botfleet.macos") else {
            showError("BotFleet is not installed in Applications.")
            return
        }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error { DispatchQueue.main.async { self.showError(error.localizedDescription) } }
        }
    }

    @objc private func hideIcon() {
        guard confirm("Hide Menu Bar Icon?", "Open BotFleet Control again to restore the icon.  Hiding it leaves the server unchanged.") else { return }
        if let item { NSStatusBar.system.removeStatusItem(item) }
        item = nil
    }

    @objc private func quitControl() { NSApplication.shared.terminate(nil) }
}
