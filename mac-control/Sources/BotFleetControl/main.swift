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
    private var item: NSStatusItem?
    private let menu = NSMenu()
    private var status: ControlStatus?
    private var persistOnExit: Bool?
    private var installedServerState: InstalledServerState = .unknown
    private var apiUnavailable = false
    private var offlineVMs: OfflineDockerState = .unavailable
    private var helperVMs: [LocalVM]?
    private var vmProblem: String?
    private var isLoading = false
    private var isBusy = false
    private var problem: String?

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
                offlineVMs = .unavailable
                helperVMs = nil
                vmProblem = nil
                problem = nil
            } catch {
                status = nil
                installedServerState = await Task.detached(priority: .userInitiated) { self.startup.installedServerState }.value
                apiUnavailable = (error as? ControlAPIError) == .unavailable
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

    private func run(refresh: Bool = true, _ action: @escaping () async throws -> Void) {
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
                    installedServerState = .unknown
                    apiUnavailable = false
                    helperVMs = nil
                    offlineVMs = .unavailable
                }
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
        run { [self] in try await Task.detached(priority: .userInitiated) { try self.startup.startServer() }.value }
    }

    @objc private func stopServer() {
        guard let status else { return }
        let count = status.activeBotCount
        let message = "This stops the server and its local VMs.  \(count) bot turn(s) are active; the server will refuse while bots or leases are busy."
        guard confirm("Stop BotFleet Server And Local VMs?", message) else { return }
        run(refresh: false) { [self] in try await api.stopServer() }
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
