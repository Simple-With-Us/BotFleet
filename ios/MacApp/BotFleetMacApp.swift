import SwiftUI
import CompanionCore

@main
struct BotFleetMacApp: App {
    @StateObject private var session = MacSession()

    init() {
        // Native macOS app startup; notifications are NEVER requested at launch.
    }

    var body: some Scene {
        WindowGroup {
            MacRootView()
                .environmentObject(session)
                .frame(minWidth: 860, minHeight: 560)
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
                    session.connect()
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
            .frame(width: 520, height: 320)
        }
        #endif
    }
}
