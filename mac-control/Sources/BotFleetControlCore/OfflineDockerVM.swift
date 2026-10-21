import Foundation

public struct OfflineVM: Equatable {
    public let name: String
    public let running: Bool
}

public enum OfflineDockerState: Equatable {
    case unavailable
    case local([OfflineVM])

    public var runningCount: Int {
        if case .local(let vms) = self { return vms.filter(\.running).count }
        return 0
    }
}

/// Read-only inspection of BotFleet-named, BotFleet-labeled containers in a local Docker context.
public final class OfflineDockerVM {
    private let commands: CommandRunning
    private let files: FileManager
    private let environment: [String: String]
    private let executable: String
    private let sharedName: String

    public init(commands: CommandRunning = ProcessCommandRunner(),
                files: FileManager = .default,
                environment: [String: String] = ProcessInfo.processInfo.environment,
                executable: String? = nil,
                username: String = NSUserName()) {
        self.commands = commands
        self.files = files
        self.environment = environment
        self.executable = executable ?? (files.isExecutableFile(atPath: "/usr/local/bin/docker")
            ? "/usr/local/bin/docker" : "/opt/homebrew/bin/docker")
        let sanitized = username.lowercased().map { character -> Character in
            character.isASCII && (character.isLetter || character.isNumber || character == "_" || character == "." || character == "-")
                ? character : "-"
        }
        let suffix = String(sanitized).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        sharedName = "botfleet-computer-\(suffix.isEmpty ? "user" : suffix)"
    }

    public func inspect() -> OfflineDockerState {
        guard files.isExecutableFile(atPath: executable) else { return .unavailable }
        if let override = environment["DOCKER_HOST"], !override.isEmpty, !isLocalSocket(override) { return .unavailable }
        do {
            let host = try commands.run(executable, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
            guard isLocalSocket(host) else { return .unavailable }
            let listing = try commands.run(executable, ["ps", "--all", "--filter", "label=com.botfleet.local-vm=1", "--format", "{{.Names}}"])
            var vms: [OfflineVM] = []
            for name in listing.split(separator: "\n").map(String.init) where ownsName(name) {
                let template = "{{index .Config.Labels \"com.botfleet.local-vm\"}}\t" +
                    "{{index .Config.Labels \"com.botfleet.workspace\"}}\t" +
                    "{{index .Config.Labels \"com.botfleet.local-vm-target\"}}\t{{.State.Running}}"
                let result = try commands.run(executable, ["inspect", "--format", template, name])
                let fields = result.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
                guard fields.count == 4, fields[0] == "1", fields[1] == "1",
                      validTarget(fields[2], for: name), ["true", "false"].contains(fields[3]) else { continue }
                vms.append(OfflineVM(name: name, running: fields[3] == "true"))
            }
            return .local(vms)
        } catch {
            return .unavailable
        }
    }

    private func isLocalSocket(_ host: String) -> Bool {
        guard host.hasPrefix("unix:///"), !host.contains("\n"), !host.contains("\r") else { return false }
        let path = String(host.dropFirst("unix://".count))
        return path.hasPrefix("/") && !path.split(separator: "/").contains("..")
    }

    private func ownsName(_ name: String) -> Bool {
        if name == sharedName { return true }
        guard name.hasPrefix(sharedName + "-") else { return false }
        let suffix = name.dropFirst(sharedName.count + 1)
        return suffix.count == 16 && suffix.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    private func validTarget(_ target: String, for name: String) -> Bool {
        if name == sharedName { return target == "shared" || target == "<no value>" }
        return target.count == 64 && target.allSatisfy { $0.isHexDigit && !$0.isUppercase }
            && target.hasPrefix(String(name.suffix(16)))
    }
}
