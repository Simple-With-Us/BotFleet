import Foundation

/// A configured BotFleet Server host that BotFleet Control can inspect and command.
public struct ServerHost: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public var baseURL: URL
    public var authToken: String?
    public let isLocal: Bool

    public init(
        id: String = UUID().uuidString,
        name: String,
        baseURL: URL,
        authToken: String? = nil,
        isLocal: Bool = false
    ) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.authToken = authToken
        self.isLocal = isLocal
    }

    /// The default primary Mac local server on loopback port 8799.
    public static let defaultLocal = ServerHost(
        id: "local",
        name: "Local Mac",
        baseURL: URL(string: "http://127.0.0.1:8799")!,
        authToken: nil,
        isLocal: true
    )
}

/// Atomic storage for known server hosts in `~/.botfleet/control-hosts.json`.
public final class ServerHostStore: @unchecked Sendable {
    private let fileURL: URL
    private let lock = NSLock()

    public init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let home = FileManager.default.homeDirectoryForCurrentUser
            self.fileURL = home.appendingPathComponent(".botfleet/control-hosts.json")
        }
    }

    /// Loads saved server hosts, seeding only the Local Mac anchor when no store exists.
    public func loadHosts() -> [ServerHost] {
        lock.lock()
        defer { lock.unlock() }

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            let defaults = [ServerHost.defaultLocal]
            saveInternal(defaults)
            return defaults
        }

        guard let hosts = loadHostsInternal() else {
            // Preserve the unreadable file by backing it up rather than silently erasing it.
            let backupURL = fileURL.deletingPathExtension().appendingPathExtension("corrupt.\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.copyItem(at: fileURL, to: backupURL)
            return [ServerHost.defaultLocal]
        }
        return hosts
    }

    /// Saves the host list atomically with 0600 file permissions.
    public func saveHosts(_ hosts: [ServerHost]) throws {
        lock.lock()
        defer { lock.unlock() }
        saveInternal(hosts)
    }

    /// Appends or updates a host. Refuses to overwrite if an existing file failed decoding.
    public func upsertHost(_ host: ServerHost) {
        lock.lock()
        defer { lock.unlock() }
        guard var current = loadHostsInternal() else {
            return
        }
        if let idx = current.firstIndex(where: { $0.id == host.id }) {
            current[idx] = host
        } else {
            current.append(host)
        }
        saveInternal(current)
    }

    /// Removes a host by id (refusing to remove the local host anchor).
    @discardableResult
    public func removeHost(id: String) -> Bool {
        guard id != ServerHost.defaultLocal.id else { return false }
        lock.lock()
        defer { lock.unlock() }
        guard var current = loadHostsInternal() else {
            return false
        }
        let countBefore = current.count
        current.removeAll { $0.id == id && !$0.isLocal }
        if current.count != countBefore {
            saveInternal(current)
            return true
        }
        return false
    }

    private func loadHostsInternal() -> [ServerHost]? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return [ServerHost.defaultLocal]
        }
        guard let data = try? Data(contentsOf: fileURL),
              let decodedHosts = try? JSONDecoder().decode([ServerHost].self, from: data) else {
            return nil
        }
        var hosts = decodedHosts
        let originalHosts = hosts
        // Remove only the exact unauthenticated remote row shipped by the old synthetic preset.
        hosts.removeAll { host in
            host.id == "hetzner"
                && host.name == "Hetzner Server"
                && host.baseURL.absoluteString == "https://hetzner.botfleet.app"
                && host.authToken == nil
                && !host.isLocal
        }
        if !hosts.contains(where: { $0.id == ServerHost.defaultLocal.id || $0.isLocal }) {
            hosts.insert(ServerHost.defaultLocal, at: 0)
        }
        if hosts != originalHosts {
            saveInternal(hosts)
        }
        return hosts
    }

    private func saveInternal(_ hosts: [ServerHost]) {
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(hosts) else { return }

        let tempURL = dir.appendingPathComponent("control-hosts.\(UUID().uuidString).tmp")
        do {
            try data.write(to: tempURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tempURL.path)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL)
            } else {
                try FileManager.default.moveItem(at: tempURL, to: fileURL)
            }
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
        }
    }
}
