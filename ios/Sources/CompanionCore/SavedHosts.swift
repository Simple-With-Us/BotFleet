import Foundation
import Security
import Darwin

public enum SavedHostError: Error, LocalizedError, Equatable {
    case invalidOrigin, invalidRecord, unreadableStore, storeBusy, localAnchor, hostInUse, credentialUnavailable
    case differentOrigin, authentication, invalidResponse, differentHost, missingPlacementRoutes, incompatibleVersion

    public var errorDescription: String? {
        switch self {
        case .invalidOrigin: return "Use an HTTPS server origin, or HTTP on loopback, without credentials, a path, a query or a fragment."
        case .invalidRecord: return "The saved host settings are invalid."
        case .unreadableStore: return "The saved hosts could not be read.\u{00A0} The existing file has been preserved."
        case .storeBusy: return "Another process is updating saved hosts.\u{00A0} Try again."
        case .localAnchor: return "This Mac cannot be removed."
        case .hostInUse: return "This server is a controller or holds a lease.\u{00A0} Release it before removing it."
        case .credentialUnavailable: return "The server credential is unavailable."
        case .differentOrigin: return "The server credential belongs to a different origin."
        case .authentication: return "The server did not accept this credential."
        case .invalidResponse: return "The server did not return a valid BotFleet host response."
        case .differentHost: return "This is a different server than the one you added."
        case .missingPlacementRoutes: return "This server has no placement routes.\u{00A0} Update the server to use this mode."
        case .incompatibleVersion: return "This server uses an incompatible placement version."
        }
    }
}

/// A bare origin; validation errors never include the supplied URL or credentials.
public struct HostOrigin: Codable, Equatable, Sendable {
    public let url: URL

    public init(_ raw: String) throws {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("\\"),
              !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }),
              var parts = URLComponents(string: value), let scheme = parts.scheme?.lowercased(),
              ["https", "http"].contains(scheme), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/",
              parts.port == nil || (1...65535).contains(parts.port!),
              scheme == "https" || Self.isLoopback(host) else { throw SavedHostError.invalidOrigin }
        parts.scheme = scheme
        parts.host = host
        parts.path = ""
        if parts.port == (scheme == "https" ? 443 : 80) { parts.port = nil }
        guard let url = parts.url else { throw SavedHostError.invalidOrigin }
        self.url = url
    }

    private static func isLoopback(_ host: String) -> Bool {
        if ["localhost", "::1", "[::1]"].contains(host) { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        return octets.count == 4 && octets[0] == "127" && octets.allSatisfy {
            !$0.isEmpty && $0.allSatisfy(\.isNumber) && Int($0).map { (0...255).contains($0) } == true
        }
    }

    public init(from decoder: Decoder) throws { try self.init(decoder.singleValueContainer().decode(String.self)) }
    public func encode(to encoder: Encoder) throws { var value = encoder.singleValueContainer(); try value.encode(url.absoluteString) }
    public func contains(_ candidate: URL) -> Bool {
        guard var parts = URLComponents(url: candidate, resolvingAgainstBaseURL: false) else { return false }
        parts.path = ""; parts.query = nil; parts.fragment = nil
        return (try? HostOrigin(parts.string ?? "")) == self
    }
}

public struct HostRecord: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var name: String
    public var origin: HostOrigin
    /// Pinned after explicit enrollment; a subsequent different id is refused.
    public var hostId: String?
    public var isLocal: Bool { id == Self.localID }
    public static let localID = "this-mac"
    public static let thisMac = HostRecord(id: localID, name: "This Mac", origin: try! HostOrigin("http://127.0.0.1:8799"))

    public init(id: String = UUID().uuidString, name: String, origin: HostOrigin, hostId: String? = nil) {
        self.id = id; self.name = name; self.origin = origin; self.hostId = hostId
    }

    static func validHostId(_ value: String) -> Bool {
        let parts = value.split(separator: ":", maxSplits: 1)
        return parts.count == 2 && ["mac", "server"].contains(String(parts[0])) && UUID(uuidString: String(parts[1])) != nil
    }

    func validate() throws {
        guard (isLocal || UUID(uuidString: id) != nil), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              hostId == nil || Self.validHostId(hostId!), !isLocal || origin.url.scheme == "http" && HostOrigin.thisMacLoopback(origin)
        else { throw SavedHostError.invalidRecord }
    }
}

private extension HostOrigin {
    static func thisMacLoopback(_ origin: HostOrigin) -> Bool { isLoopback(origin.url.host ?? "") }
}

public enum NativePlacementMode: String, Codable, Sendable { case localOnly, serverFirst, macFirst }
public struct PlacementSelection: Codable, Equatable, Sendable {
    public var mode: NativePlacementMode
    public var serverID: String?
    public var allowOverflowToThisMac: Bool
    public init(mode: NativePlacementMode = .localOnly, serverID: String? = nil, allowOverflowToThisMac: Bool = false) {
        self.mode = mode; self.serverID = serverID; self.allowOverflowToThisMac = allowOverflowToThisMac
    }
}
public struct PlacementSettings: Codable, Equatable, Sendable {
    public var saved = PlacementSelection()
    public var applied = PlacementSelection()
    public init() {}
    public var hasUnappliedChanges: Bool { saved != applied }
}

/// Tokens are deliberately absent from the Codable store; callers use HostTokenStore.
public actor HostStore {
    private struct File: Codable { var schema = 1; var hosts = [HostRecord.thisMac]; var placement = PlacementSettings() }
    private let fileURL: URL
    public init(fileURL: URL) { self.fileURL = fileURL }

    public func hosts() throws -> [HostRecord] { try read().hosts }
    public func settings() throws -> PlacementSettings { try read().placement }
    public func upsert(_ host: HostRecord) throws {
        try host.validate()
        try mutate { file in
        if let index = file.hosts.firstIndex(where: { $0.id == host.id }) {
            // Changing an origin requires a new record and fresh credential enrollment.
            guard file.hosts[index].origin == host.origin else { throw SavedHostError.differentOrigin }
            guard file.hosts[index].hostId == nil || file.hosts[index].hostId == host.hostId else { throw SavedHostError.differentHost }
            file.hosts[index] = host
        }
        else { file.hosts.append(host) }
        }
    }
    public func remove(id: String, controllerID: String?, leasedHostIDs: Set<String>) throws {
        guard id != HostRecord.localID else { throw SavedHostError.localAnchor }
        try mutate { file in
        let pinnedID = file.hosts.first(where: { $0.id == id })?.hostId
        guard id != controllerID, pinnedID == nil || pinnedID != controllerID,
              !leasedHostIDs.contains(id), pinnedID == nil || !leasedHostIDs.contains(pinnedID!), file.placement.saved.serverID != id,
              file.placement.applied.serverID != id else { throw SavedHostError.hostInUse }
        file.hosts.removeAll { $0.id == id }
        }
    }
    /// Saving never applies a mode; only the controller's acknowledged state may be applied.
    public func save(_ selection: PlacementSelection) throws {
        try mutate { file in try validate(selection, hosts: file.hosts); file.placement.saved = selection }
    }
    public func recordApplied(_ selection: PlacementSelection) throws {
        try mutate { file in try validate(selection, hosts: file.hosts); file.placement.applied = selection }
    }
    private func validate(_ selection: PlacementSelection, hosts: [HostRecord]) throws {
        guard selection.mode == .localOnly ? selection.serverID == nil : hosts.contains(where: { !$0.isLocal && $0.id == selection.serverID })
        else { throw SavedHostError.invalidRecord }
    }
    private func read() throws -> File {
        let fd = Darwin.open(fileURL.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { return File() }
            throw SavedHostError.unreadableStore
        }
        defer { Darwin.close(fd) }
        var original: Data?
        do {
            try validateParent()
            try validateFile(fd, at: fileURL)
            let data = try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() ?? Data()
            try validateFile(fd, at: fileURL)
            original = data
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(json.keys).isSubset(of: ["schema", "hosts", "placement"]),
                  let hosts = json["hosts"] as? [[String: Any]], hosts.allSatisfy({ Set($0.keys).isSubset(of: ["id", "name", "origin", "hostId"]) })
            else { throw SavedHostError.unreadableStore }
            let file = try JSONDecoder().decode(File.self, from: data)
            guard file.schema == 1, file.hosts.filter(\.isLocal).count == 1, Set(file.hosts.map(\.id)).count == file.hosts.count else { throw SavedHostError.unreadableStore }
            try file.hosts.forEach { try $0.validate() }
            try validate(file.placement.saved, hosts: file.hosts); try validate(file.placement.applied, hosts: file.hosts)
            return file
        } catch {
            if let original {
                // Preserve the first corrupt snapshot once; the unread source stays untouched.
                let backup = fileURL.appendingPathExtension("corrupt.json")
                try? writePrivate(original, to: backup)
            }
            throw SavedHostError.unreadableStore
        }
    }
    private func mutate(_ change: (inout File) throws -> Void) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try validateParent()
        let lockURL = fileURL.appendingPathExtension("lock")
        let fd = Darwin.open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw SavedHostError.unreadableStore }
        defer { Darwin.close(fd) }
        try validateFile(fd, at: lockURL)
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw SavedHostError.storeBusy }
        defer { flock(fd, LOCK_UN) }
        try validateFile(fd, at: lockURL)
        var file = try read(); try change(&file); try write(file)
    }
    private func validateFile(_ fd: Int32, at url: URL) throws {
        var opened = stat(), listed = stat()
        guard fstat(fd, &opened) == 0, lstat(url.path, &listed) == 0,
              opened.st_mode & S_IFMT == S_IFREG, opened.st_nlink == 1,
              opened.st_uid == getuid(), opened.st_mode & 0o077 == 0,
              opened.st_dev == listed.st_dev, opened.st_ino == listed.st_ino else { throw SavedHostError.unreadableStore }
    }
    private func validateParent() throws {
        let fd = Darwin.open(fileURL.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw SavedHostError.unreadableStore }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o022 == 0 else { throw SavedHostError.unreadableStore }
    }
    private func writePrivate(_ data: Data, to url: URL) throws {
        let fd = Darwin.open(url.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw SavedHostError.unreadableStore }
        defer { Darwin.close(fd) }
        try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: data)
        guard fsync(fd) == 0 else { throw SavedHostError.unreadableStore }
    }
    private func write(_ file: File) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temp = directory.appendingPathComponent("hosts.\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temp) }
        let data = try JSONEncoder().encode(file)
        try writePrivate(data, to: temp)
        guard Darwin.rename(temp.path, fileURL.path) == 0 else { throw SavedHostError.unreadableStore }
    }
}

public protocol HostTokenStore: Sendable {
    func read(for host: HostRecord) throws -> HostGateCredential?
    func write(_ token: RedactedSecret, for host: HostRecord) throws
    func remove(recordID: String) throws
}

/// A separate per-user Keychain namespace; it never opens Control's JSON or service credentials.
public struct KeychainHostTokenStore: HostTokenStore {
    public init() {}
    private struct StoredCredential: Codable {
        let schema: Int
        let recordID: String
        let origin: HostOrigin
        let hostId: String?
        let token: String
        enum CodingKeys: String, CodingKey { case schema, recordID, origin, hostId, token }
        func encode(to encoder: Encoder) throws {
            var value = encoder.container(keyedBy: CodingKeys.self)
            try value.encode(schema, forKey: .schema)
            try value.encode(recordID, forKey: .recordID)
            try value.encode(origin, forKey: .origin)
            try value.encode(hostId, forKey: .hostId)
            try value.encode(token, forKey: .token)
        }
    }
    static func query(recordID: String) throws -> [String: Any] {
        // The account is the saved-record UUID, not the remote's mac:/server: identity pin.
        guard UUID(uuidString: recordID) != nil else { throw SavedHostError.invalidRecord }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.botfleet.macos.saved-host", kSecAttrAccount as String: recordID]
    }
    static func encode(_ token: RedactedSecret, for host: HostRecord) throws -> Data {
        try host.validate()
        _ = try query(recordID: host.id)
        _ = try HostGateCredential(origin: host.origin, token: token)
        return try JSONEncoder().encode(StoredCredential(schema: 1, recordID: host.id, origin: host.origin, hostId: host.hostId, token: token.exposeSecret()))
    }
    static func decode(_ data: Data, for host: HostRecord) throws -> HostGateCredential {
        try host.validate()
        _ = try query(recordID: host.id)
        let stored: StoredCredential
        do {
            guard data.count <= 16_384,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(json.keys) == Set(["schema", "recordID", "origin", "hostId", "token"]) else { throw SavedHostError.credentialUnavailable }
            stored = try JSONDecoder().decode(StoredCredential.self, from: data)
        } catch { throw SavedHostError.credentialUnavailable }
        guard stored.schema == 1, stored.recordID == host.id else { throw SavedHostError.credentialUnavailable }
        guard stored.origin == host.origin else { throw SavedHostError.differentOrigin }
        guard stored.hostId == host.hostId else { throw SavedHostError.differentHost }
        return try HostGateCredential(origin: stored.origin, token: RedactedSecret(stored.token))
    }
    public func read(for host: HostRecord) throws -> HostGateCredential? {
        try host.validate()
        var query = try Self.query(recordID: host.id); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw SavedHostError.credentialUnavailable }
        return try Self.decode(data, for: host)
    }
    public func write(_ token: RedactedSecret, for host: HostRecord) throws {
        let data = try Self.encode(token, for: host)
        let query = try Self.query(recordID: host.id)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query; add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SavedHostError.credentialUnavailable }
    }
    public func remove(recordID: String) throws {
        let status = SecItemDelete(try Self.query(recordID: recordID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SavedHostError.credentialUnavailable }
    }
}
