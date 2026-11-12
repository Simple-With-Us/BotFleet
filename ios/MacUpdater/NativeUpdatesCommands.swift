import SwiftUI
import CompanionCore

/// The app composition retains NativeMacUpdater and installs these commands once.
struct NativeUpdatesCommands: Commands {
    @ObservedObject var service: NativeUpdateService

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check For Updates…") { service.checkForUpdates() }
                .disabled(!service.canCheckForUpdates)
                .help(service.statusMessage)
        }
    }
}
