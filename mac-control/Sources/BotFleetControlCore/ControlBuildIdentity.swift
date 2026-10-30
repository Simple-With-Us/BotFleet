import Foundation

/// The release identity used by Control's version handshake.
/// Missing metadata remains unknown; it is never derived from a commit count.
public struct ControlBuildIdentity: Decodable, Equatable, Sendable {
    public let version: String?
    public let build: String?
    public let sourceCommit: String?

    public init(version: String?, build: String?, sourceCommit: String? = nil) {
        self.version = Self.components(version, count: 3...3) == nil ? nil : version
        self.build = Self.components(build, count: 1...3) == nil ? nil : build
        if let sourceCommit, sourceCommit.count == 40,
           sourceCommit.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
           sourceCommit != String(repeating: "0", count: 40) {
            self.sourceCommit = sourceCommit
        } else {
            self.sourceCommit = nil
        }
    }

    private enum CodingKeys: String, CodingKey { case version, build, sourceCommit }

    public init(from decoder: Decoder) throws {
        let values = try? decoder.container(keyedBy: CodingKeys.self)
        self.init(version: try? values?.decode(String.self, forKey: .version),
                  build: try? values?.decode(String.self, forKey: .build),
                  sourceCommit: try? values?.decode(String.self, forKey: .sourceCommit))
    }

    public static func installed(in bundle: Bundle = .main) -> ControlBuildIdentity {
        let metadata = bundle.resourceURL.flatMap {
            try? Data(contentsOf: $0.appendingPathComponent("build-identity.json"))
        }.flatMap { try? JSONDecoder().decode(ControlBuildIdentity.self, from: $0) }
        return ControlBuildIdentity(version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                                    build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                                    sourceCommit: metadata?.sourceCommit)
    }

    public var label: String {
        "\(version ?? "unknown version") (build \(build ?? "unknown"))"
    }

    fileprivate static func components(_ value: String?, count: ClosedRange<Int>) -> [UInt64]? {
        guard let value, value.utf8.count <= 64 else { return nil }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard count.contains(parts.count), parts.allSatisfy({
            !$0.isEmpty && $0.utf8.allSatisfy({ (48...57).contains($0) }) && UInt64($0) != nil
        }) else { return nil }
        return parts.compactMap { UInt64($0) }
    }
}

public enum ControlVersionRelation: Equatable, Sendable {
    case matching
    case controlOlder
    case controlNewer
    case different
    case unknown
}

public struct ControlVersionHandshake: Equatable, Sendable {
    public let control: ControlBuildIdentity
    public let server: ControlBuildIdentity?

    public init(control: ControlBuildIdentity, server: ControlBuildIdentity?) {
        self.control = control
        self.server = server
    }

    public var relation: ControlVersionRelation {
        guard let server, control.version != nil, server.version != nil else { return .unknown }
        let commitsDiffer = control.sourceCommit != nil && server.sourceCommit != nil
            && control.sourceCommit != server.sourceCommit
        guard let own = ControlBuildIdentity.components(control.build, count: 1...3),
              let remote = ControlBuildIdentity.components(server.build, count: 1...3) else {
            return control.version != server.version || commitsDiffer ? .different : .unknown
        }
        // The shared release planner makes build numbers monotonic across
        // marketing versions, including the transition to version 0.1.0.
        for index in 0..<max(own.count, remote.count) {
            let left = index < own.count ? own[index] : 0
            let right = index < remote.count ? remote[index] : 0
            if left < right { return .controlOlder }
            if left > right { return .controlNewer }
        }
        if control.version != server.version { return .different }
        if commitsDiffer { return .different }
        return .matching
    }

    public var summary: String {
        let detail = "Control \(control.label); server \(server?.label ?? "unknown version and build")"
        switch relation {
        case .matching: return "Control and server versions match (\(control.label))"
        case .controlOlder: return "Control is older than the server (\(detail))"
        case .controlNewer: return "Control is newer than the server (\(detail))"
        case .different: return "Control and server have different release identities; order is unknown (\(detail))"
        case .unknown: return "Control/server version order is unknown (\(detail))"
        }
    }
}
