import SwiftUI
import AppKit
import CompanionCore

/// Application delegate for the native macOS desktop app.
///
/// The quit-time shutdown has to finish before the process exits, so the
/// delegate answers `applicationShouldTerminate(_:)` with `.terminateLater` and
/// only replies once the async shutdown is done.  AppKit terminates the process
/// as soon as `willTerminateNotification` is delivered, so a detached `Task`
/// in a notification handler is abandoned before the shutdown request ever
/// reaches the harness.
final class BotFleetMacAppDelegate: NSObject, NSApplicationDelegate {
    /// The session that owns the lifecycle policy.  Weak, because the session
    /// outlives neither the delegate nor the app, and the delegate must not
    /// keep it alive across a termination.
    weak var session: MacSession?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let session else { return .terminateNow }
        Task { @MainActor in
            await session.handleAppTermination()
            NSApplication.shared.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

/// Captures the `NSWindow` that hosts a SwiftUI scene.
///
/// The window-close policy has to be evaluated for the app's main window only,
/// so the observer is bound to that window instance instead of to every
/// `NSWindow` (closing the Settings panel must not stop the harness).
private final class WindowCaptureView: NSView {
    var onWindow: ((NSWindow) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        onWindow?(window)
    }
}

private struct WindowAccessor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = WindowCaptureView()
        view.onWindow = onWindow
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

@main
struct BotFleetMacApp: App {
    @StateObject private var session = MacSession()
    @NSApplicationDelegateAdaptor(BotFleetMacAppDelegate.self) private var appDelegate

    init() {
        // Native macOS app startup; notifications are NEVER requested at launch.
    }

    var body: some Scene {
        WindowGroup {
            MacRootView()
                .environmentObject(session)
                .frame(minWidth: 860, minHeight: 560)
                .background(WindowAccessor { window in
                    session.registerMainWindow(window)
                })
                .onAppear {
                    #if os(macOS)
                    // Every menubar row needs a handler, or the surface this
                    // PR ships is a menu of dead buttons.
                    session.menubarController.onOpenBotFleet = {
                        session.activateMainWindow()
                    }
                    session.menubarController.onComposeNewMessage = {
                        session.focusComposer()
                    }
                    session.menubarController.onDictateMessage = {
                        session.beginMenubarDictation()
                    }
                    session.menubarController.onSelectWaitingBot = { item in
                        session.selectWaitingBot(item)
                    }
                    session.menubarController.onTogglePauseResumeAll = {
                        session.togglePauseResumeAll()
                    }
                    session.menubarController.onOpenSettings = {
                        session.openSettings()
                    }
                    session.menubarController.installIfNeeded()
                    #endif
                    appDelegate.session = session
                    session.launch()
                }
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1120, height: 760)
        .commands {
            SidebarCommands()

            CommandGroup(replacing: .appInfo) {
                Button("About BotFleet") {
                    NSApplication.shared.orderFrontStandardAboutPanel(
                        options: [
                            NSApplication.AboutPanelOptionKey.applicationName: "BotFleet",
                            NSApplication.AboutPanelOptionKey.version: session.capabilities.versionStamp,
                        ]
                    )
                }
            }

            CommandMenu("Fleet") {
                Button("Reconnect to Local Harness") {
                    session.connect()
                }
                .keyboardShortcut("r", modifiers: [.command])

                Button("Stop Active Turn") {
                    Task { await session.stopActiveTurn() }
                }
                .keyboardShortcut(".", modifiers: [.command])
                .disabled(session.activeStreamingText == nil)

                Divider()

                Button("Stop Desktop Control (Emergency Stop)") {
                    session.triggerCuaEmergencyStop()
                }
                .keyboardShortcut(.escape, modifiers: [.command, .shift])

                Button("Shut Down Server & Local VM") {
                    Task { await session.shutDownServerAndLocalVM() }
                }
                .disabled(session.isShuttingDownServer)

                Divider()

                Menu("Settings Section") {
                    ForEach(MacSettingsSection.allCases) { section in
                        Button(section.displayTitle) {
                            session.activeSettingsSection = section
                        }
                    }
                }
            }
        }

        #if os(macOS)
        Settings {
            TabView(selection: $session.activeSettingsSection) {
                ForEach(MacSettingsSection.allCases) { section in
                    VStack(alignment: .leading, spacing: 16) {
                        Text(section.displayTitle)
                            .font(.headline)

                        if section == .general {
                            HStack {
                                Text("Local Harness Address:")
                                TextField("Host", text: $session.host)
                                    .frame(width: 120)
                                Text(":")
                                TextField("Port", value: $session.port, format: .number.grouping(.never))
                                    .frame(width: 70)
                            }

                            Button("Save and Reconnect") {
                                session.connect(host: session.host, port: session.port)
                            }

                            Divider()

                            GroupBox("Remote Wake & Lifecycle") {
                                VStack(alignment: .leading, spacing: 12) {
                                    Toggle(
                                        "Allow iOS Remote Desktop Launch",
                                        isOn: Binding(
                                            get: { session.lifecycleSettings.allowRemoteDesktopLaunch ?? false },
                                            set: { newValue in
                                                var updated = session.lifecycleSettings
                                                updated.allowRemoteDesktopLaunch = newValue
                                                Task { await session.saveLifecycleSettings(updated) }
                                            }
                                        )
                                    )

                                    Toggle(
                                        "Keep Server Running When Window Closes",
                                        isOn: Binding(
                                            get: { session.lifecycleSettings.persistOnExit },
                                            set: { newValue in
                                                var updated = session.lifecycleSettings
                                                updated.persistOnExit = newValue
                                                Task { await session.saveLifecycleSettings(updated) }
                                            }
                                        )
                                    )

                                    HStack {
                                        Button(role: .destructive) {
                                            Task { await session.shutDownServerAndLocalVM() }
                                        } label: {
                                            Text(session.isShuttingDownServer ? "Shutting Down…" : "Shut Down Server & Local VM")
                                        }
                                        .disabled(session.isShuttingDownServer)

                                        Spacer()
                                    }
                                    .padding(.top, 4)

                                    if let errorMessage = session.lifecycleErrorMessage {
                                        Text(errorMessage)
                                            .font(.caption)
                                            .foregroundColor(.red)
                                    }
                                }
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else if section == .permissions,
                                  let banner = session.notificationCoordinator.settingsStatusBanner {
                            Text(banner)
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        } else {
                            Text(session.capabilities.versionStamp)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }

                        Spacer()
                    }
                    .padding(24)
                    .tabItem {
                        Label(section.displayTitle, systemImage: section.symbolName)
                    }
                    .tag(section)
                }
            }
            .frame(width: 520, height: 420)
        }
        #endif
    }
}
