import AppKit
import BotFleetControlCore
import ServiceManagement

@main
final class ControlApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let api = ControlAPI()
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
        rebuildMenu()
        Task { @MainActor in
            do {
                status = try await api.status()
                persistOnExit = status?.persistOnExit
                installedServerState = .running
                apiUnavailable = false
                serverPresence = .present
                offlineVMs = .unavailable
                helperVMs = nil
                vmProblem = nil
                problem = nil
            } catch {
                status = nil
                installedServerState = await Task.detached(priority: .userInitiated) { self.startup.installedServerState }.value
                apiUnavailable = (error as? ControlAPIError) == .unavailable
                // The API did not answer.  That is not proof that the server
                // is gone, so ask the port itself.
                serverPresence = await Task.detached(priority: .userInitiated) { self.presenceProbe.presence() }.value
                persistOnExit = installedServerState == .stopped && apiUnavailable ? persistence.value : nil
                if installedServerState == .stopped && apiUnavailable {
                    if offlineVMHelper.available {
                        do {
                            helperVMs = try await Task.detached(priority: .userInitiated) { try self.offlineVMHelper.status() }.value
                            vmProblem = nil
                        } catch {
                            helperVMs = nil
                            vmProblem = error.localizedDescription
                        }
                    } else { helperVMs = nil; vmProblem = nil }
                    offlineVMs = helperVMs == nil
                        ? await Task.detached(priority: .userInitiated) { self.offlineDocker.inspect() }.value
                        : .unavailable
                } else { offlineVMs = .unavailable; helperVMs = nil; vmProblem = nil }
                problem = apiUnavailable && installedServerState == .stopped ? nil : error.localizedDescription
            }
            isLoading = false
            rebuildMenu()
            // The wheelhouse is reconciled behind the menu.  pm2 can take
            // seconds to start or stop a service, and a menu that waits for
            // it looks broken long before it is.
            reconcileWheelhouseInBackground()
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

    private func add(_ title: String, selector: Selector? = nil, enabled: Bool = true, state: NSControl.StateValue = .off) {
        let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        entry.target = self
        entry.isEnabled = selector != nil && enabled
        entry.state = state
        menu.addItem(entry)
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        let ready = !isLoading && !isBusy
        if isLoading { add("Server: Loading…") }
        else if let status {
            add("Server: running (\(status.activeBotCount) active bots)")
            add("Local VMs: \(status.runningVMCount) running of \(status.localVms.count)")
            for vm in status.localVms { add("  \(vm.name): \(vm.state ?? (vm.running ? "running" : "unknown"))") }
        } else {
            if apiUnavailable && installedServerState == .stopped { add("Server: stopped") }
            else if installedServerState == .notInstalled { add("Server: not installed") }
            else if installedServerState == .running { add("Server: unresponsive") }
            else { add("Server: unknown") }
            if apiUnavailable && installedServerState == .stopped, let helperVMs {
                let running = helperVMs.filter(\.running).count
                add("Local VMs: \(running) running of \(helperVMs.count)")
                for vm in helperVMs { add("  \(vm.name): \(vm.state ?? "unknown")") }
            } else if apiUnavailable && installedServerState == .stopped,
               case .local(let vms) = offlineVMs {
                add("Local VMs (Docker): \(offlineVMs.runningCount) running of \(vms.count)")
                if vms.isEmpty { add("  Managed Docker VMs: none found") }
                for vm in vms { add("  \(vm.name): \(vm.running ? "running" : "stopped")") }
            } else if apiUnavailable { add("Local VMs: unknown while server is offline") }
            else { add("Local VMs: unknown while server is busy") }
        }
        if let problem { add("Error: \(problem)") }
        if let vmProblem { add("Local VM: \(vmProblem)") }
        if status?.sharedVM?.state == "stopped" { add("Local VM requires recreation in BotFleet") }
        if !startup.supportsPolicy { add("Update BotFleet to manage server startup") }
        let wheelhouse = Wheelhouse(serverState: serverState(),
                                    mcpServerState: mcpServerState)
        if !wheelhouse.entries.isEmpty {
            menu.addItem(.separator())
            add("Wheelhouse:")
            for entry in wheelhouse.entries { add("  \(entry.title): \(entry.summary)") }
        }
        menu.addItem(.separator())
        add("Start Server", selector: #selector(startServer), enabled: ready && startup.supportsPolicy && apiUnavailable && installedServerState == .stopped)
        add("Stop Server And Local VMs…", selector: #selector(stopServer), enabled: ready && status != nil)
        add("Start Local VM", selector: #selector(startVM), enabled: ready && status?.canStartSharedVM == true)
        let canCreateOffline = apiUnavailable && installedServerState == .stopped
            && offlineVMHelper.available && helperVMs?.first(where: { $0.key == "shared" })?.state == "missing"
        add("Create Local VM (Stopped)…", selector: #selector(createStoppedVM), enabled: ready && canCreateOffline)
        let offlineRunning = helperVMs?.contains(where: \.running) == true
        add("Stop Local VMs…", selector: #selector(stopVMs), enabled: ready && (((status?.runningVMCount ?? 0) > 0) ||
            (apiUnavailable && installedServerState == .stopped && offlineVMHelper.available && offlineRunning)))
        if status == nil && apiUnavailable && installedServerState == .stopped {
            if !offlineVMHelper.available { add("Update BotFleet Control to manage Local VMs offline") }
        }
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
        let count = status.activeBotCount
        let message = "This stops the server and its local VMs.  \(count) bot turn(s) are active; the server will refuse while bots or leases are busy."
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
