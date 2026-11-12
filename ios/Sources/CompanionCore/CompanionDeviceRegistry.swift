import CryptoKit
import Foundation

/// One paired phone, as it is written to disk — the native mirror of
/// `DeviceRecord` in `companion/src/devices.ts`.
///
/// The token itself is never stored: `tokenHash` is its SHA-256 hex digest,
/// handed out once at pairing.  A stolen devices file is not a stolen fleet.
/// Timestamps are milliseconds since the epoch, matching both the Node file
/// and the wire `PairedDevice`.
public struct CompanionDeviceRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// SHA-256 hex of the Bearer token — never the token itself.
    public var tokenHash: String
    public var createdAt: Double
    public var lastSeenAt: Double
    /// Full interactive access to a bot's cloud desktop.  Off on every new
    /// and migrated device until the computer owner enables it.
    public var cloudDesktopAccess: Bool

    public init(
        id: String,
        name: String,
        tokenHash: String,
        createdAt: Double,
        lastSeenAt: Double,
        cloudDesktopAccess: Bool = false
    ) {
        self.id = id
        self.name = name
        self.tokenHash = tokenHash
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.cloudDesktopAccess = cloudDesktopAccess
    }

    /// The device as the phone and the settings UI may see it: no secret.
    public var publicDevice: PairedDevice {
        PairedDevice(id: id, name: name, createdAt: createdAt, lastSeenAt: lastSeenAt)
    }
}

/// The paired fleet: who may reach this computer through the native
/// companion listener, backed optionally by a `devices.json` file in the
/// same shape the Node sidecar writes (`{"devices": [...]}`).
///
/// This is the durable half of the BF-2511 pairing contract.  Before it,
/// the native server kept raw tokens in an in-memory set — a restart
/// silently unpaired every phone, and there was no device to revoke.
/// Here only digests persist, malformed records never authenticate, and
/// a file that cannot be read loads as an empty fleet (fail closed: no
/// credential matches).
public struct CompanionDeviceRegistry: Sendable, Equatable {
    /// Bounds the fleet, as `MAX_DEVICES` bounds the Node file.
    public static let maxDevices = 20
    /// `lastSeenAt` is a UI nicety, not an audit log — the Node registry
    /// writes it at most once a minute per device (`LAST_SEEN_WRITE_MS`).
    public static let lastSeenWriteIntervalMs: Double = 60_000

    public private(set) var devices: [CompanionDeviceRecord]
    private var lastSeenWrites: [String: Double]

    public init(devices: [CompanionDeviceRecord] = []) {
        // The cap bounds every insertion path, including a hand-edited
        // or seeded fleet larger than `maxDevices`: records past the
        // cap never authenticate.
        self.devices = Array(devices.filter { Self.isWellFormed($0) }.prefix(Self.maxDevices))
        self.lastSeenWrites = [:]
    }

    public var count: Int { devices.count }

    // MARK: - Digests and the Authorization header

    /// Hex SHA-256 of a bearer token, the only form ever kept.
    public static func tokenHash(for token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Pulls the Bearer token out of an `Authorization` header, mirroring
    /// `bearerToken` in `companion/src/devices.ts`: the scheme is matched
    /// case-insensitively (RFC 7235 §2.1), and a header with nothing after
    /// the scheme is `nil`, so no caller decides whether "" is a credential.
    public static func bearerToken(fromAuthorizationHeader header: String?) -> String? {
        guard let header else { return nil }
        let trimmed = header.trimmingCharacters(in: .whitespacesAndNewlines)
        let scheme = "Bearer"
        guard trimmed.count > scheme.count,
              trimmed.lowercased().hasPrefix(scheme.lowercased()) else { return nil }
        let rest = trimmed.dropFirst(scheme.count)
        guard let first = rest.first, first == " " || first == "\t" else { return nil }
        let token = rest.trimmingCharacters(in: .whitespaces)
        return token.isEmpty ? nil : token
    }

    /// A record can only ever authenticate when its digest is a real
    /// 64-hex-character SHA-256.  Anything else in the file is dropped on
    /// load rather than compared against, so a hand-edited or torn file
    /// fails closed instead of inventing a credential.
    static func isWellFormed(_ record: CompanionDeviceRecord) -> Bool {
        !record.id.isEmpty && isTokenHash(record.tokenHash)
    }

    static func isTokenHash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
        }
    }

    // MARK: - Authentication and mutation

    /// Resolves a bearer token to its device, or `nil`.  Every stored
    /// digest is compared in constant time and the scan never exits
    /// early, so response timing does not rank guesses.
    public func authenticate(token: String?) -> CompanionDeviceRecord? {
        guard let token, !token.isEmpty else { return nil }
        let presentedHash = Self.tokenHash(for: token)
        var matched: CompanionDeviceRecord?
        for device in devices
        where NativeCompanionServer.constantTimeEquals(device.tokenHash, presentedHash) {
            matched = device
        }
        return matched
    }

    /// True when a device with this token's digest is still paired.
    public func contains(token: String) -> Bool {
        authenticate(token: token) != nil
    }

    /// Registers a freshly minted token under a new device id.  The caller
    /// owns persistence: register, persist, and roll back with `revoke`
    /// when the write fails, as `redeem` does in `devices.ts`.
    @discardableResult
    public mutating func register(name: String, token: String, nowMs: Double) -> CompanionDeviceRecord {
        let record = CompanionDeviceRecord(
            id: UUID().uuidString.lowercased(),
            name: name,
            tokenHash: Self.tokenHash(for: token),
            createdAt: nowMs,
            lastSeenAt: nowMs
        )
        devices.append(record)
        return record
    }

    /// Takes a phone's access away.  False when there was no such device —
    /// a revoke that quietly matched nothing would read as success.
    @discardableResult
    public mutating func revoke(id: String) -> Bool {
        let before = devices.count
        devices.removeAll { $0.id == id }
        lastSeenWrites[id] = nil
        return devices.count != before
    }

    /// Records that a device was just seen, at most once per
    /// `lastSeenWriteIntervalMs` per device.  Returns true when the caller
    /// should persist (best effort — a stale timestamp must never stop a
    /// valid token from authenticating).
    @discardableResult
    public mutating func recordSeen(id: String, nowMs: Double) -> Bool {
        guard nowMs - (lastSeenWrites[id] ?? 0) > Self.lastSeenWriteIntervalMs,
              let index = devices.firstIndex(where: { $0.id == id }) else { return false }
        devices[index].lastSeenAt = nowMs
        lastSeenWrites[id] = nowMs
        return true
    }

    // MARK: - Persistence

    private struct DevicesFile: Codable {
        var devices: [CompanionDeviceRecord]
    }

    /// Loads the paired fleet from `devices.json`, normalising as it goes.
    /// Only `id` and a well-formed `tokenHash` decide whether a record is
    /// a device at all; a file that is missing or unreadable loads empty,
    /// which authenticates nothing.
    public static func load(from fileURL: URL) -> CompanionDeviceRegistry {
        guard let data = try? Data(contentsOf: fileURL),
              let file = try? JSONDecoder().decode(DevicesFile.self, from: data) else {
            return CompanionDeviceRegistry()
        }
        return CompanionDeviceRegistry(devices: file.devices.map(normalize))
    }

    /// Completes a stored record, whatever shape the file had.
    /// `lastSeenAt` falls back to `createdAt`: a device never heard from
    /// since pairing was last seen when it paired.
    static func normalize(_ record: CompanionDeviceRecord) -> CompanionDeviceRecord {
        var record = record
        record.name = NativeCompanionServer.cleanDeviceName(record.name)
        if !(record.createdAt > 0) || !record.createdAt.isFinite {
            record.createdAt = Date().timeIntervalSince1970 * 1000
        }
        if !(record.lastSeenAt > 0) || !record.lastSeenAt.isFinite {
            record.lastSeenAt = record.createdAt
        }
        return record
    }

    /// Writes the fleet atomically, because a torn file reads as empty and
    /// would sign every phone out.  The file is owner-only from the moment
    /// it exists: the bytes land in a `0600` temp file in the same
    /// directory and are renamed over the destination, so there is no
    /// window where `devices.json` sits world-readable, and a failure to
    /// create, harden, or rename the file is thrown — never swallowed
    /// after a successful-looking write.
    public func persist(to fileURL: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(DevicesFile(devices: devices))
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let directory = fileURL.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(
            ".devices.\(UUID().uuidString.lowercased()).tmp"
        )
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer {
            _ = Darwin.close(descriptor)
            try? FileManager.default.removeItem(at: temporary)
        }
        guard Darwin.fchmod(descriptor, 0o600) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                guard let baseAddress = buffer.baseAddress else {
                    throw POSIXError(.EIO)
                }
                let written = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    buffer.count - offset
                )
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
                offset += written
            }
        }
        guard Darwin.fsync(descriptor) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard Darwin.rename(temporary.path, fileURL.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}

/// Whether the native listener's device port binds loopback or the LAN —
/// the Swift mirror of `companion/src/lan-policy.ts`.
///
/// The opt-in is the same environment variable, because that is the one
/// channel a person starting a process deliberately holds.  Only the
/// literal affirmative words count as consent; anything else is treated
/// as not given, so a typo cannot open the port while looking like it
/// tried to close it.  Advertisement follows the same answer: a Bonjour
/// record for a loopback-bound port advertises a route that refuses
/// every connection that follows it.
public struct CompanionLANPolicy: Sendable, Equatable {
    /// The environment variable that reopens the device port to the LAN.
    public static let cleartextLANEnvironmentVariable = "OMB_COMPANION_ALLOW_CLEARTEXT_LAN"

    public enum Source: Sendable, Equatable {
        case `default`
        case environment
        case invalid
    }

    /// Does the device port bind a routable address?
    public var allowCleartextLAN: Bool
    /// The address the device port binds.  `0.0.0.0` is the whole question.
    public var deviceBindHost: String
    /// How the answer was reached, so a refusal can name the reason.
    public var source: Source

    /// The policy for an install that configured nothing.
    public static let loopbackDefault = CompanionLANPolicy(
        allowCleartextLAN: false,
        deviceBindHost: "127.0.0.1",
        source: .default
    )

    /// Reads the opt-in.  Deliberately narrow: `on`, `yes`, `enabled` and
    /// a stray typo are all "not given".
    public static func read(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> CompanionLANPolicy {
        read(value: environment[cleartextLANEnvironmentVariable])
    }

    public static func read(value: String?) -> CompanionLANPolicy {
        let given = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let given, !given.isEmpty else { return .loopbackDefault }
        if given == "1" || given == "true" {
            return CompanionLANPolicy(allowCleartextLAN: true, deviceBindHost: "0.0.0.0", source: .environment)
        }
        return CompanionLANPolicy(allowCleartextLAN: false, deviceBindHost: "127.0.0.1", source: .invalid)
    }

    /// Does a Bonjour record make sense for this policy?  Multicast DNS is
    /// a LAN protocol, so only a LAN-bound listener may advertise.
    public var advertisesOnLAN: Bool { allowCleartextLAN }
}
