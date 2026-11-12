import Foundation
import Combine

/// References to credentials managed on the selected server, never credential values.
public struct InfisicalTokenSourceSettings: Codable, Equatable, Identifiable, Sendable {
    public let id = UUID()
    public var name = ""
    public var projectId = ""
    public var environment = "prod"
    public var secretPath = "/"
    public var tokenFile = ""
    public var tokenEnv = ""
    public var writeTokenFile = ""
    public var writeTokenEnv = ""

    public init() {}

    private enum CodingKeys: String, CodingKey {
        case name, projectId, environment, secretPath, tokenFile, tokenEnv, writeTokenFile, writeTokenEnv
    }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        projectId = try values.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        environment = try values.decodeIfPresent(String.self, forKey: .environment) ?? "prod"
        secretPath = try values.decodeIfPresent(String.self, forKey: .secretPath) ?? "/"
        tokenFile = try values.decodeIfPresent(String.self, forKey: .tokenFile) ?? ""
        tokenEnv = try values.decodeIfPresent(String.self, forKey: .tokenEnv) ?? ""
        writeTokenFile = try values.decodeIfPresent(String.self, forKey: .writeTokenFile) ?? ""
        writeTokenEnv = try values.decodeIfPresent(String.self, forKey: .writeTokenEnv) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(name, forKey: .name)
        try values.encode(projectId, forKey: .projectId)
        try values.encode(environment, forKey: .environment)
        try values.encode(secretPath, forKey: .secretPath)
        for (key, value) in [(CodingKeys.tokenFile, tokenFile), (.tokenEnv, tokenEnv),
                             (.writeTokenFile, writeTokenFile), (.writeTokenEnv, writeTokenEnv)] {
            let reference = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !reference.isEmpty { try values.encode(reference, forKey: key) }
        }
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.name == rhs.name && lhs.projectId == rhs.projectId && lhs.environment == rhs.environment &&
            lhs.secretPath == rhs.secretPath && lhs.tokenFile == rhs.tokenFile && lhs.tokenEnv == rhs.tokenEnv &&
            lhs.writeTokenFile == rhs.writeTokenFile && lhs.writeTokenEnv == rhs.writeTokenEnv
    }
}

/// The administrative status route exposes configuration and presence flags only.
public struct InfisicalSettingsSnapshot: Decodable, Equatable, Sendable {
    public var enabled: Bool
    public var authMethod: InfisicalAuthMethod
    public var siteUrl: String
    public var projectId: String
    public var environment: String
    public var secretPath: String
    public var hasClientId: Bool
    public var hasClientSecret: Bool
    public var hasToken: Bool
    public var hasWriteToken: Bool
    public var readSources: [InfisicalTokenSourceSettings]

    private enum CodingKeys: String, CodingKey {
        case enabled, enabledSetting, authMethod, siteUrl, projectId, environment, secretPath
        case hasClientId, hasClientSecret, hasToken, hasWriteToken, readSources
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabledSetting)
            ?? values.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        authMethod = try values.decodeIfPresent(InfisicalAuthMethod.self, forKey: .authMethod) ?? .serviceToken
        siteUrl = try values.decodeIfPresent(String.self, forKey: .siteUrl) ?? "https://app.infisical.com"
        projectId = try values.decodeIfPresent(String.self, forKey: .projectId) ?? ""
        environment = try values.decodeIfPresent(String.self, forKey: .environment) ?? "prod"
        secretPath = try values.decodeIfPresent(String.self, forKey: .secretPath) ?? "/"
        hasClientId = try values.decodeIfPresent(Bool.self, forKey: .hasClientId) ?? false
        hasClientSecret = try values.decodeIfPresent(Bool.self, forKey: .hasClientSecret) ?? false
        hasToken = try values.decodeIfPresent(Bool.self, forKey: .hasToken) ?? false
        hasWriteToken = try values.decodeIfPresent(Bool.self, forKey: .hasWriteToken) ?? false
        readSources = try values.decodeIfPresent([InfisicalTokenSourceSettings].self, forKey: .readSources) ?? []
    }
}

/// This metadata-only patch cannot assert external secret storage or carry raw credentials.
public struct InfisicalSettingsDraft: Encodable, Equatable, Sendable {
    public var enabled = false
    public var authMethod: InfisicalAuthMethod = .serviceToken
    public var siteUrl = "https://app.infisical.com"
    public var projectId = ""
    public var environment = "prod"
    public var secretPath = "/"
    public var readSources: [InfisicalTokenSourceSettings] = []

    public init() {}

    public init(snapshot: InfisicalSettingsSnapshot) {
        enabled = snapshot.enabled; authMethod = snapshot.authMethod
        siteUrl = snapshot.siteUrl; projectId = snapshot.projectId
        environment = snapshot.environment; secretPath = snapshot.secretPath
        readSources = snapshot.readSources
    }

    public func validate() throws {
        guard let site = URLComponents(string: siteUrl), site.scheme == "https",
              site.host != nil, site.user == nil, site.password == nil,
              site.query == nil, site.fragment == nil else {
            throw InfisicalSettingsError.invalid("Use an HTTPS Infisical site without credentials or a query.")
        }
        if enabled, projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw InfisicalSettingsError.invalid("Enter the selected host's Infisical project ID.")
        }
        guard !environment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              secretPath.hasPrefix("/") else {
            throw InfisicalSettingsError.invalid("Enter an environment and an absolute secret path.")
        }
        guard readSources.count <= 32 else {
            throw InfisicalSettingsError.invalid("Use at most 32 service token sources.")
        }
        var names: Set<String> = []
        for source in readSources {
            let name = source.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, names.insert(name).inserted,
                  !source.projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !source.environment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  source.secretPath.hasPrefix("/"),
                  !source.tokenFile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    !source.tokenEnv.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    !source.writeTokenFile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    !source.writeTokenEnv.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw InfisicalSettingsError.invalid("Each token source needs a unique name, project, environment, secret path, and a read or write token reference.")
            }
        }
    }
}

public enum InfisicalSettingsError: Error, LocalizedError, Equatable, Sendable {
    case invalid(String)
    case notLoaded
    case refused(Int)
    case invalidResponse
    case transport

    public var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .notLoaded: return "Load this host's secret settings before saving."
        case .refused(let status): return "This server refused Infisical administration (HTTP \(status))."
        case .invalidResponse: return "The server returned an unreadable Infisical settings response."
        case .transport: return "The selected server could not be reached for Infisical settings."
        }
    }
}

public struct InfisicalSettingsClient: Sendable {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session { self.session = session }
        else {
            let config = URLSessionConfiguration.ephemeral
            config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
            config.httpShouldSetCookies = false
            self.session = URLSession(configuration: config)
        }
    }

    public static func request(host: HostRecord, credential: HostGateCredential?, draft: InfisicalSettingsDraft? = nil) throws -> URLRequest {
        try host.validate()
        guard host.isLocal || credential != nil else { throw SavedHostError.credentialUnavailable }
        let path = draft == nil ? "/api/infisical/status" : "/api/config"
        guard let url = URL(string: path, relativeTo: host.origin.url)?.absoluteURL else { throw SavedHostError.invalidOrigin }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let draft {
            try draft.validate()
            struct Patch: Encodable { let infisical: InfisicalSettingsDraft }
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(Patch(infisical: draft))
        } else { request.httpMethod = "GET" }
        if let credential { try credential.authorize(&request) }
        return request
    }

    public func fetch(host: HostRecord, credential: HostGateCredential?) async throws -> InfisicalSettingsSnapshot {
        let data = try await execute(Self.request(host: host, credential: credential), host: host)
        struct Envelope: Decodable { let infisical: InfisicalSettingsSnapshot }
        guard let decoded = try? JSONDecoder().decode(Envelope.self, from: data) else { throw InfisicalSettingsError.invalidResponse }
        return decoded.infisical
    }

    public func save(host: HostRecord, credential: HostGateCredential?, draft: InfisicalSettingsDraft) async throws {
        _ = try await execute(Self.request(host: host, credential: credential, draft: draft), host: host)
    }

    private func execute(_ request: URLRequest, host: HostRecord) async throws -> Data {
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request, delegate: HostOriginRedirectPolicy(origin: host.origin)) }
        catch { throw InfisicalSettingsError.transport }
        guard let http = response as? HTTPURLResponse, http.url.map(host.origin.contains) == true else {
            throw InfisicalSettingsError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else { throw InfisicalSettingsError.refused(http.statusCode) }
        return data
    }
}

private actor InfisicalSettingsCredentials {
    let store: any HostTokenStore
    init(_ store: any HostTokenStore) { self.store = store }
    func read(_ host: HostRecord) throws -> HostGateCredential? { try store.read(for: host) }
}

@MainActor
public final class InfisicalSettingsCoordinator: ObservableObject {
    public typealias Fetcher = @Sendable (HostRecord, HostGateCredential?) async throws -> InfisicalSettingsSnapshot
    public typealias Saver = @Sendable (HostRecord, HostGateCredential?, InfisicalSettingsDraft) async throws -> Void
    @Published public private(set) var hosts: [HostRecord] = [.thisMac]
    @Published public private(set) var selectedHostID = HostRecord.localID
    @Published public private(set) var snapshot: InfisicalSettingsSnapshot?
    @Published public var draft = InfisicalSettingsDraft()
    @Published public private(set) var isLoading = false
    @Published public private(set) var isSaving = false
    @Published public private(set) var errorMessage: String?
    @Published public private(set) var statusMessage: String?
    private let credentials: InfisicalSettingsCredentials
    private let fetcher: Fetcher
    private let saver: Saver
    private var generation = UUID()
    private var hostsCancellable: AnyCancellable?

    public init(tokens: any HostTokenStore = KeychainHostTokenStore(), fetcher: Fetcher? = nil, saver: Saver? = nil) {
        credentials = InfisicalSettingsCredentials(tokens)
        let client = InfisicalSettingsClient()
        self.fetcher = fetcher ?? { try await client.fetch(host: $0, credential: $1) }
        self.saver = saver ?? { try await client.save(host: $0, credential: $1, draft: $2) }
    }

    public var selectedHost: HostRecord { hosts.first(where: { $0.id == selectedHostID }) ?? .thisMac }

    public func observeHosts(from servers: ServersCoordinator) {
        syncHosts(servers.hosts)
        hostsCancellable = servers.$hosts.dropFirst().sink { [weak self] in self?.syncHosts($0) }
    }

    public func syncHosts(_ updated: [HostRecord]) {
        let previous = selectedHost
        hosts = updated.isEmpty ? [.thisMac] : updated
        if !hosts.contains(where: { $0.id == selectedHostID }) { selectedHostID = hosts[0].id }
        if selectedHost != previous { reset() }
    }

    public func selectHost(id: String) async {
        guard hosts.contains(where: { $0.id == id }) else { return }
        selectedHostID = id
        reset()
        await refresh()
    }

    public func refresh() async {
        guard !isSaving else { return }
        let host = selectedHost
        let current = UUID(); generation = current
        isLoading = true; errorMessage = nil; statusMessage = nil
        defer { if generation == current { isLoading = false } }
        do {
            let credential = try await credentials.read(host)
            guard isCurrent(host, current) else { return }
            let loaded = try await fetcher(host, credential)
            guard isCurrent(host, current) else { return }
            snapshot = loaded; draft = InfisicalSettingsDraft(snapshot: loaded)
        } catch {
            guard isCurrent(host, current) else { return }
            snapshot = nil; errorMessage = safeMessage(error)
        }
    }

    public func save() async {
        guard snapshot != nil, !isLoading, !isSaving else { errorMessage = InfisicalSettingsError.notLoaded.localizedDescription; return }
        let host = selectedHost
        let saving = draft
        let current = UUID(); generation = current
        isSaving = true; errorMessage = nil; statusMessage = nil
        defer { if generation == current { isSaving = false } }
        do {
            try saving.validate()
            let credential = try await credentials.read(host)
            guard isCurrent(host, current) else { return }
            try await saver(host, credential, saving)
            guard isCurrent(host, current) else { return }
            let loaded = try await fetcher(host, credential)
            guard isCurrent(host, current) else { return }
            snapshot = loaded; draft = InfisicalSettingsDraft(snapshot: loaded)
            statusMessage = "Secrets settings saved."
        } catch {
            guard isCurrent(host, current) else { return }
            errorMessage = safeMessage(error)
        }
    }

    private func reset() {
        generation = UUID(); snapshot = nil; draft = InfisicalSettingsDraft()
        isLoading = false; isSaving = false; errorMessage = nil; statusMessage = nil
    }
    private func isCurrent(_ host: HostRecord, _ value: UUID) -> Bool { generation == value && selectedHost == host }
    private func safeMessage(_ error: Error) -> String {
        if let error = error as? InfisicalSettingsError { return error.localizedDescription }
        if let error = error as? SavedHostError { return error.localizedDescription }
        return InfisicalSettingsError.transport.localizedDescription
    }
}
