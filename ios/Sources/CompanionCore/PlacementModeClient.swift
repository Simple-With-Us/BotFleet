import Foundation

/// A refusal from `PUT /api/placement/mode` that the caller can tell apart.
/// A stale fence carries the controller pair the server returned, so one retry
/// can use that pair and no other.  A fail-closed refusal (400 or 503) carries
/// nothing to retry with.
public enum PlacementModeTransportError: Error, Equatable, LocalizedError, Sendable {
    case staleFence(controllerId: String, epoch: Int)
    case failClosed

    public var errorDescription: String? {
        switch self {
        case .staleFence:
            return "The controller epoch changed.\u{00A0} The applied selection was left unchanged."
        case .failClosed:
            return "The placement mode was refused.\u{00A0} The applied selection was left unchanged."
        }
    }
}

/// The strict body of `PUT /api/placement/mode`.  An unknown key is a 400 on
/// the server, so this encodes only the keys the route accepts.
public struct PlacementModeSubmission: Encodable, Equatable, Sendable {
    public var mode: NativePlacementMode
    public var controllerId: String
    public var epoch: Int
    public var serverId: String?
    public var allowOverflowToThisMac: Bool

    public init(mode: NativePlacementMode, controllerId: String, epoch: Int, serverId: String?, allowOverflowToThisMac: Bool) {
        self.mode = mode
        self.controllerId = controllerId
        self.epoch = epoch
        self.serverId = serverId
        self.allowOverflowToThisMac = allowOverflowToThisMac
    }

    private enum CodingKeys: String, CodingKey {
        case mode, controllerId, epoch, serverId, allowOverflowToThisMac
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(mode, forKey: .mode)
        try values.encode(controllerId, forKey: .controllerId)
        try values.encode(epoch, forKey: .epoch)
        if let serverId {
            try values.encode(serverId, forKey: .serverId)
        } else {
            try values.encodeNil(forKey: .serverId)
        }
        try values.encode(allowOverflowToThisMac, forKey: .allowOverflowToThisMac)
    }
}

/// The body of `GET` and a successful `PUT` on `/api/placement/mode`.
/// `acknowledged` is required: a missing flag is a bad frame, not a quiet false.
public struct PlacementModeAcknowledgement: Decodable, Equatable, Sendable {
    public let controllerId: String
    public let epoch: Int
    public let mode: NativePlacementMode
    public let serverId: String?
    public let allowOverflowToThisMac: Bool
    public let acknowledged: Bool
    public let appliedAt: Double?
    public let reason: String?

    public static let wireKeys: Set<String> = [
        "controllerId", "epoch", "mode", "serverId", "allowOverflowToThisMac", "acknowledged", "appliedAt", "reason",
    ]

    private enum CodingKeys: String, CodingKey {
        case controllerId, epoch, mode, serverId, allowOverflowToThisMac, acknowledged, appliedAt, reason
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        controllerId = try values.decode(String.self, forKey: .controllerId)
        epoch = try values.decode(Int.self, forKey: .epoch)
        mode = try values.decode(NativePlacementMode.self, forKey: .mode)
        // Null is present.  A missing key is not, and must not become a quiet nil.
        guard values.contains(.serverId), values.contains(.appliedAt), values.contains(.reason) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "placement mode body omitted a required key"))
        }
        serverId = try values.decodeIfPresent(String.self, forKey: .serverId)
        allowOverflowToThisMac = try values.decode(Bool.self, forKey: .allowOverflowToThisMac)
        acknowledged = try values.decode(Bool.self, forKey: .acknowledged)
        appliedAt = try values.decodeIfPresent(Double.self, forKey: .appliedAt)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// Reads and writes the controller's placement-mode record.  This does not
/// record applied state and does not open a runtime connection.  The companion
/// header is never set: that header makes the route refuse the caller.
public struct PlacementModeClient: Sendable {
    private let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func read(host: HostRecord, credential: HostGateCredential?) async throws -> PlacementModeAcknowledgement {
        let request = try makeRequest(method: "GET", body: nil, host: host, credential: credential)
        return try Self.acknowledgement(from: try await exchange(request, host: host))
    }

    public func write(_ submission: PlacementModeSubmission, host: HostRecord, credential: HostGateCredential?) async throws -> PlacementModeAcknowledgement {
        let payload = try JSONEncoder().encode(submission)
        let request = try makeRequest(method: "PUT", body: payload, host: host, credential: credential)
        return try Self.acknowledgement(from: try await exchange(request, host: host))
    }

    private func makeRequest(method: String, body: Data?, host: HostRecord, credential: HostGateCredential?) throws -> URLRequest {
        try host.validate()
        guard host.isLocal || credential != nil else { throw SavedHostError.credentialUnavailable }
        guard let url = URL(string: "/api/placement/mode", relativeTo: host.origin.url)?.absoluteURL else { throw SavedHostError.invalidOrigin }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        if let credential { try credential.authorize(&request) }
        return request
    }

    private func exchange(_ request: URLRequest, host: HostRecord) async throws -> Data {
        let (data, response) = try await session.data(for: request, delegate: HostOriginRedirectPolicy(origin: host.origin))
        guard let http = response as? HTTPURLResponse, http.url.map(host.origin.contains) == true else { throw SavedHostError.invalidResponse }
        switch http.statusCode {
        case 200:
            return data
        case 401, 403:
            throw SavedHostError.authentication
        case 409:
            throw try Self.staleFence(from: data)
        case 400, 503:
            throw PlacementModeTransportError.failClosed
        case 404, 405, 501:
            throw SavedHostError.missingPlacementRoutes
        default:
            throw SavedHostError.invalidResponse
        }
    }

    private static func acknowledgement(from data: Data) throws -> PlacementModeAcknowledgement {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == PlacementModeAcknowledgement.wireKeys else { throw SavedHostError.invalidResponse }
        do {
            let decoded = try JSONDecoder().decode(PlacementModeAcknowledgement.self, from: data)
            guard HostRecord.validHostId(decoded.controllerId), decoded.epoch >= 0 else { throw SavedHostError.invalidResponse }
            if let serverId = decoded.serverId { guard HostRecord.validHostId(serverId) else { throw SavedHostError.invalidResponse } }
            return decoded
        } catch let error as SavedHostError {
            throw error
        } catch {
            throw SavedHostError.invalidResponse
        }
    }

    private struct StaleFenceWire: Decodable {
        let error: String
        let controllerId: String
        let epoch: Int
    }

    private static func staleFence(from data: Data) throws -> PlacementModeTransportError {
        let decoded: StaleFenceWire
        do { decoded = try JSONDecoder().decode(StaleFenceWire.self, from: data) }
        catch { throw SavedHostError.invalidResponse }
        guard HostRecord.validHostId(decoded.controllerId), decoded.epoch >= 0 else { throw SavedHostError.invalidResponse }
        return .staleFence(controllerId: decoded.controllerId, epoch: decoded.epoch)
    }
}
