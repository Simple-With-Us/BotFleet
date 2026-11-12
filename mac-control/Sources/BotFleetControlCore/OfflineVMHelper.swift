import Foundation

public enum OfflineVMHelperError: LocalizedError {
    case updateRequired
    case invalidResponse
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .updateRequired: return "Update BotFleet Control to manage Local VMs while the server is stopped."
        case .invalidResponse: return "The Local VM helper returned an invalid result."
        case .refused(let message): return message
        }
    }
}

public final class OfflineVMHelper {
    private let script: URL
    private let node: String?
    private let files: FileManager
    private let commands: CommandRunning
    private let decoder = JSONDecoder()

    public init(script: URL? = Bundle.main.resourceURL?.appendingPathComponent("botfleet-vm-control.mjs"),
                node: String? = nil,
                files: FileManager = .default,
                commands: CommandRunning = ProcessCommandRunner()) {
        self.script = script ?? URL(fileURLWithPath: "/nonexistent/botfleet-vm-control.mjs")
        self.files = files
        self.commands = commands
        self.node = node ?? ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first(where: { files.isExecutableFile(atPath: $0) })
    }

    public var available: Bool {
        files.fileExists(atPath: script.path) && node.map { files.isExecutableFile(atPath: $0) } == true
    }

    public func status() throws -> [LocalVM] { try call("status", timeout: 20) }
    public func createStopped() throws -> [LocalVM] {
        let vms = try call("create-stopped", timeout: 300)
        guard vms.first(where: { $0.key == "shared" })?.state == "created" else {
            throw OfflineVMHelperError.invalidResponse
        }
        return vms
    }
    public func stop() throws -> [LocalVM] {
        let vms = try call("stop", timeout: 300)
        guard vms.allSatisfy({ !$0.running }) else { throw OfflineVMHelperError.invalidResponse }
        return vms
    }

    private func call(_ action: String, timeout: TimeInterval) throws -> [LocalVM] {
        guard available, let node else { throw OfflineVMHelperError.updateRequired }
        let output: String
        do { output = try commands.run(node, [script.path, action], timeout: timeout) }
        catch let error as CommandExitError {
            if let result = try? decoder.decode(Result.self, from: Data(error.output.utf8)),
               let message = result.error, !message.isEmpty {
                throw OfflineVMHelperError.refused(String(message.prefix(300)))
            }
            throw OfflineVMHelperError.refused("The Local VM helper could not complete the action.")
        }
        let result = try? decoder.decode(Result.self, from: Data(output.utf8))
        guard let result else { throw OfflineVMHelperError.invalidResponse }
        if result.ok == false { throw OfflineVMHelperError.refused(String((result.error ?? "The Local VM helper refused the action.").prefix(300))) }
        guard result.ok == true, let vms = result.localVms,
              vms.allSatisfy({ ["missing", "created", "running", "stopped"].contains($0.state ?? "") }) else {
            throw OfflineVMHelperError.invalidResponse
        }
        return vms
    }
}

private struct Result: Decodable {
    let ok: Bool
    let localVms: [LocalVM]?
    let error: String?
}
