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
            }
        }

        #if os(macOS)
        Settings {
            VStack(alignment: .leading, spacing: 16) {
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

                Spacer()
            }
            .padding(24)
            .frame(width: 440, height: 260)
        }
        #endif
    }
}
