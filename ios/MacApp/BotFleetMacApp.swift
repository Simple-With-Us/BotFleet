import SwiftUI
import CompanionCore

@main
struct BotFleetMacApp: App {
    @StateObject private var session = MacSession()

    init() {
        // Any early native Mac initialization
    }

    var body: some Scene {
        WindowGroup {
            MacRootView()
                .environmentObject(session)
                .frame(minWidth: 860, minHeight: 560)
                .onAppear {
                    session.connect()
                }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    Task {
                        await session.handleAppTermination()
                    }
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
                            NSApplication.AboutPanelOptionKey.applicationName: "BotFleet (Native macOS)",
                            NSApplication.AboutPanelOptionKey.version: "Option A Native Alpha",
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
            }
        }

        #if os(macOS)
        Settings {
            VStack(alignment: .leading, spacing: 20) {
                Text("BotFleet Desktop Settings")
                    .font(.headline)

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
                                get: { session.lifecycleSettings.allowRemoteDesktopLaunch },
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
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                Spacer()
            }
            .padding(24)
            .frame(width: 480, height: 380)
        }
        #endif
    }
}
