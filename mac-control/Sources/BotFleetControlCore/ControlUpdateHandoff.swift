import Foundation

public enum ControlUpdateSelection: Equatable {
    case cancel
    case updateControl
}

public enum ControlUpdateError: LocalizedError {
    case unavailable

    public var errorDescription: String? {
        "The installed BotFleet app does not include a supported Control update package.\u{00A0} Update Control requires a BotFleet build that bundles Control and its update handler."
    }
}

/// Hands an explicit selection to the installed app's bundled installer.
/// No server response supplies a path, command or download source.
public struct ControlUpdateHandoff {
    public static let argument = "--update-control"
    private let commands: CommandRunning

    public init(commands: CommandRunning = ProcessCommandRunner()) {
        self.commands = commands
    }

    /// Returns false for cancellation without reading a package or running a
    /// command; the owning app confirms replacement before quitting Control.
    @discardableResult
    public func perform(selection: ControlUpdateSelection, application: URL?) throws -> Bool {
        guard selection == .updateControl else { return false }
        guard let application,
              !isSymlink(application),
              plist(at: application)?["CFBundleIdentifier"] as? String == "app.botfleet.macos"
        else { throw ControlUpdateError.unavailable }
        let resources = application.appendingPathComponent("Contents/Resources", isDirectory: true)
        let control = resources.appendingPathComponent("BotFleet Control.app", isDirectory: true)
        guard !isSymlink(control),
              plist(at: control)?["CFBundleIdentifier"] as? String == "app.botfleet.control.macos",
              let data = try? Data(contentsOf: control.appendingPathComponent("Contents/Resources/control-update-protocol.json")),
              let marker = try? JSONDecoder().decode(UpdateProtocol.self, from: data), marker.protocolVersion == 1
        else { throw ControlUpdateError.unavailable }
        // A second process delivers the argument to an already running
        // Electron instance through its single-instance handler, too.
        _ = try commands.run("/usr/bin/open", ["-n", "-a", application.path, "--args", Self.argument], timeout: 15)
        return true
    }

    private func isSymlink(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != false
    }

    private func plist(at bundle: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: bundle.appendingPathComponent("Contents/Info.plist")) else { return nil }
        return (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any]
    }
}

private struct UpdateProtocol: Decodable {
    let protocolVersion: Int
}
