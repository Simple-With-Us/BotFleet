import Foundation

/// An owner-gate credential is usable for exactly one enrolled origin.
public struct HostGateCredential: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let origin: HostOrigin
    private let token: RedactedSecret
    public init(origin: HostOrigin, token: RedactedSecret) throws {
        let bytes = Array(token.exposeSecret().utf8)
        guard !bytes.isEmpty, bytes.count <= 4096, bytes.allSatisfy({ (0x21...0x7E).contains($0) }) else { throw SavedHostError.credentialUnavailable }
        self.origin = origin; self.token = token
    }
    public var description: String { "HostGateCredential([REDACTED])" }
    public var debugDescription: String { description }
    public func authorize(_ request: inout URLRequest) throws {
        guard let url = request.url, origin.contains(url) else { throw SavedHostError.differentOrigin }
        request.setValue(token.exposeSecret(), forHTTPHeaderField: "x-botfleet-gate-token")
    }
}

/// Custom headers must never follow a redirect to a different origin.
public final class HostOriginRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let origin: HostOrigin
    public init(origin: HostOrigin) { self.origin = origin }
    public func allows(_ url: URL?) -> Bool { url.map(origin.contains) == true }
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(allows(request.url) ? request : nil)
    }
}

public struct VerifiedServer: Equatable, Sendable {
    public let hostId: String
    public let version: String
    public let platform: String
    public let capabilities: Set<String>
    public let controllerId: String
    public let epoch: Int
}

/// A read-only enrollment check; this does not save a host, apply a mode or dispatch work.
public struct ServerHandshake: Sendable {
    private let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func test(host: HostRecord, credential: HostGateCredential?, acceptedPlacementVersion: String) async throws -> VerifiedServer {
        try host.validate()
        guard !acceptedPlacementVersion.isEmpty else { throw SavedHostError.incompatibleVersion }
        guard host.isLocal || credential != nil else { throw SavedHostError.credentialUnavailable }
        struct Health: Decodable { let app: String; let ready: Bool; let hostId: String; let version: String }
        struct Resources: Decodable { let hostId: String; let version: String; let platform: String; let capabilities: Set<String> }
        struct Identity: Decodable { let hostId: String; let version: String; let platform: String; let capabilities: Set<String>; let controllerId: String; let epoch: Int }

        let health: Health = try await get("/api/health", host: host, credential: credential)
        guard health.app == "botfleet", health.ready, HostRecord.validHostId(health.hostId), !health.version.isEmpty else { throw SavedHostError.invalidResponse }
        if let expected = host.hostId, expected != health.hostId { throw SavedHostError.differentHost }
        let resources: Resources = try await get("/api/host/resources", host: host, credential: credential, placement: true)
        guard resources.hostId == health.hostId, resources.version == health.version, ["darwin", "linux"].contains(resources.platform) else { throw SavedHostError.invalidResponse }
        let identity: Identity = try await get("/api/placement/identity", host: host, credential: credential, placement: true)
        guard identity.hostId == health.hostId, identity.platform == resources.platform, identity.capabilities == resources.capabilities,
              HostRecord.validHostId(identity.controllerId), identity.epoch >= 0 else { throw SavedHostError.invalidResponse }
        guard identity.version == acceptedPlacementVersion else { throw SavedHostError.incompatibleVersion }
        return VerifiedServer(hostId: health.hostId, version: health.version, platform: resources.platform,
                              capabilities: resources.capabilities, controllerId: identity.controllerId, epoch: identity.epoch)
    }

    private func get<T: Decodable>(_ path: String, host: HostRecord, credential: HostGateCredential?, placement: Bool = false) async throws -> T {
        guard let url = URL(string: path, relativeTo: host.origin.url)?.absoluteURL else { throw SavedHostError.invalidOrigin }
        var request = URLRequest(url: url); request.timeoutInterval = 20
        if let credential { try credential.authorize(&request) }
        let (data, response) = try await session.data(for: request, delegate: HostOriginRedirectPolicy(origin: host.origin))
        guard let response = response as? HTTPURLResponse, response.url.map(host.origin.contains) == true else { throw SavedHostError.invalidResponse }
        if response.statusCode == 401 || response.statusCode == 403 { throw SavedHostError.authentication }
        if placement && [404, 405, 501].contains(response.statusCode) { throw SavedHostError.missingPlacementRoutes }
        guard response.statusCode == 200 else { throw SavedHostError.invalidResponse }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw SavedHostError.invalidResponse }
    }
}

