import Foundation
import Combine

public protocol ServersHostStore: Sendable {
    func hosts() async throws -> [HostRecord]
    func settings() async throws -> PlacementSettings
    func upsert(_ host: HostRecord) async throws
    func updateThisMacOrigin(_ origin: HostOrigin) async throws
    func remove(id: String, controllerID: String?, leasedHostIDs: Set<String>) async throws
}
extension HostStore: ServersHostStore {}

/// Keychain may wait for the system; keep its synchronous calls off the UI actor.
private actor ServersCredentials {
    let store: any HostTokenStore
    init(_ store: any HostTokenStore) { self.store = store }
    func read(_ host: HostRecord) throws -> HostGateCredential? { try store.read(for: host) }
    func enroll(_ token: RedactedSecret, host: HostRecord) throws { try store.enrollIfAbsent(token, for: host) }
    func remove(_ id: String) throws { try store.remove(recordID: id) }
}

/// Test is enrollment only; this object never activates a mode or a runtime connection.
@MainActor
public final class ServersCoordinator: ObservableObject {
    public typealias Handshake = @Sendable (HostRecord, HostGateCredential?) async throws -> VerifiedServer
    @Published public private(set) var hosts: [HostRecord] = [.thisMac]
    @Published public private(set) var statuses: [String: String] = [:]
    @Published public private(set) var testing: Set<String> = []
    @Published public private(set) var isBusy = false
    @Published public private(set) var isLoaded = false
    @Published public private(set) var errorMessage: String?
    public var connectedRecordID: String? = HostRecord.localID
    public var controllerID: String?
    public var leasedHostIDs: Set<String> = []

    private let store: any ServersHostStore
    private let credentials: ServersCredentials
    private let handshake: Handshake
    private var generations: [String: UUID] = [:]
    private var tasks: [String: Task<Void, Never>] = [:]
    private var loading: Task<[HostRecord], Error>?

    public init(store: any ServersHostStore, tokens: any HostTokenStore = KeychainHostTokenStore(),
                handshake: @escaping Handshake = { try await ServerHandshake().test(host: $0, credential: $1) }) {
        self.store = store; self.credentials = ServersCredentials(tokens); self.handshake = handshake
    }

    public func load() async {
        guard !isLoaded else { return }
        isBusy = true
        if loading == nil { loading = Task { try await store.hosts() } }
        guard let loading else { return }
        do {
            let loaded = try await loading.value
            guard !isLoaded else { return }
            hosts = loaded; isLoaded = true; errorMessage = nil
        } catch { errorMessage = SavedHostError.unreadableStore.localizedDescription }
        self.loading = nil; isBusy = false
    }

    @discardableResult
    public func add(name: String, origin: String) async -> Bool {
        guard canMutate else { return false }
        isBusy = true; defer { isBusy = false }
        do {
            let host = HostRecord(name: name.trimmingCharacters(in: .whitespacesAndNewlines), origin: try HostOrigin(origin))
            try await store.upsert(host)
            hosts.append(host); errorMessage = nil
            return true
        } catch { errorMessage = safeMessage(error); return false }
    }

    @discardableResult
    public func rename(_ host: HostRecord, name: String) async -> Bool {
        guard canMutate, !host.isLocal, hosts.contains(host) else { return false }
        invalidate(host.id)
        isBusy = true; defer { isBusy = false }
        do {
            var updated = host; updated.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            try await store.upsert(updated)
            replace(updated); errorMessage = nil; return true
        } catch { errorMessage = safeMessage(error); return false }
    }

    @discardableResult
    public func updateThisMac(origin: String) async -> HostRecord? {
        guard canMutate else { return nil }
        invalidate(HostRecord.localID)
        isBusy = true; defer { isBusy = false }
        do {
            let origin = try HostOrigin(origin)
            try await store.updateThisMacOrigin(origin)
            let records = try await store.hosts()
            hosts = records; errorMessage = nil
            return records.first(where: \.isLocal)
        } catch { errorMessage = safeMessage(error); return nil }
    }

    public func removalReason(_ host: HostRecord) -> String? {
        if host.isLocal { return SavedHostError.localAnchor.localizedDescription }
        if connectedRecordID == host.id { return "Disconnect from this server before removing it." }
        if controllerID == host.id || (host.hostId != nil && controllerID == host.hostId) { return "\(host.name) is the controller." }
        if leasedHostIDs.contains(host.id) || host.hostId.map(leasedHostIDs.contains) == true { return "Jobs on \(host.name) are still leased.\u{00A0} Finish them, stop them, or mark them lost first." }
        return nil
    }

    @discardableResult
    public func remove(_ host: HostRecord) async -> Bool {
        guard canMutate, hosts.contains(host) else { return false }
        if let reason = removalReason(host) { errorMessage = reason; return false }
        invalidate(host.id)
        isBusy = true; defer { isBusy = false }
        do {
            // Read first: an unreadable store or active selection must not delete a token.
            let settings = try await store.settings()
            guard settings.saved.serverID != host.id, settings.applied.serverID != host.id else { throw SavedHostError.hostInUse }
            _ = try await store.hosts()
            try await credentials.remove(host.id)
            do { try await store.remove(id: host.id, controllerID: controllerID, leasedHostIDs: leasedHostIDs) }
            catch {
                errorMessage = "The token was deleted, but the saved server remains.\u{00A0} Try Remove again."
                return false
            }
            hosts.removeAll { $0.id == host.id }; statuses[host.id] = nil; errorMessage = nil
            return true
        } catch { errorMessage = safeMessage(error); return false }
    }

    public func cancelTest(_ id: String) { guard !isBusy else { return }; invalidate(id) }

    public func test(_ host: HostRecord, token: RedactedSecret? = nil) {
        guard canMutate, hosts.contains(host) else { return }
        invalidate(host.id)
        let generation = UUID(); generations[host.id] = generation
        testing.insert(host.id); statuses[host.id] = "Testing…"
        tasks[host.id] = Task { [weak self] in
            guard let self else { return }
            await self.performTest(host, token: token, generation: generation)
        }
    }

    private var canMutate: Bool { isLoaded && !isBusy }
    private func invalidate(_ id: String) {
        generations[id] = UUID(); tasks.removeValue(forKey: id)?.cancel(); testing.remove(id); statuses[id] = nil
    }
    private func current(_ host: HostRecord, _ generation: UUID) -> Bool {
        !Task.isCancelled && generations[host.id] == generation && hosts.contains(host)
    }
    private func replace(_ host: HostRecord) { if let index = hosts.firstIndex(where: { $0.id == host.id }) { hosts[index] = host } }

    private func performTest(_ host: HostRecord, token: RedactedSecret?, generation: UUID) async {
        defer {
            if generations[host.id] == generation { testing.remove(host.id); tasks[host.id] = nil }
        }
        do {
            let credential: HostGateCredential?
            if host.isLocal { credential = nil }
            else if let token { credential = try HostGateCredential(origin: host.origin, token: token) }
            else if host.hostId == nil {
                statuses[host.id] = "Enter a fresh server token to verify and enroll this server."
                return
            } else { credential = try await credentials.read(host) }
            guard current(host, generation) else { return }
            guard host.isLocal || credential != nil else {
                statuses[host.id] = "Enter a server token to test this server."; return
            }
            let verified = try await handshake(host, credential)
            guard current(host, generation) else { return }
            guard !isBusy else {
                statuses[host.id] = "Settings changed during this test.\u{00A0} Test the server again."
                return
            }
            isBusy = true
            defer { isBusy = false }
            var pinned = host; pinned.hostId = verified.hostId
            guard host.hostId == nil || host.hostId == verified.hostId else { throw SavedHostError.differentHost }
            var enrolled = false
            if !host.isLocal, let token {
                // Atomic insert: never overwrite a credential that cannot be restored.
                try await credentials.enroll(token, host: pinned); enrolled = true
            }
            do {
                if host.hostId == nil { try await store.upsert(pinned) }
            } catch {
                if enrolled {
                    do { try await credentials.remove(host.id) }
                    catch {
                        statuses[host.id] = "Verification was not saved and its token could not be cleared.\u{00A0} Remove this server before enrolling it again."
                        return
                    }
                }
                throw error
            }
            replace(pinned)
            statuses[host.id] = ServerTestPresentation.reached(verified, name: host.name)
            errorMessage = nil
        } catch {
            guard current(host, generation) else { return }
            statuses[host.id] = safeMessage(error)
        }
    }

    private func safeMessage(_ error: Error) -> String {
        if let known = error as? SavedHostError {
            if known == .missingPlacementRoutes { return "Update the server: required placement routes are unavailable." }
            return known.localizedDescription
        }
        return "Could not reach this server.\u{00A0} Check its address and try again."
    }
}

public extension HostRecord {
    /// One exact route, with no advertised hosts or endpoint fallback.
    func companionConnection() throws -> Connection {
        try validate()
        let kind: CompanionEndpointKind = origin.url.scheme == "https" ? .hosted : .lan
        guard let endpoint = CompanionEndpoint(url: origin.url.absoluteString, kind: kind, priority: 0) else { throw SavedHostError.invalidOrigin }
        return Connection(id: id, name: name, host: endpoint.host, port: endpoint.port,
                          activeEndpoint: endpoint, endpoints: [endpoint], allowedRouteKinds: [kind],
                          allowedLocalRouteURLs: kind == .lan ? [endpoint.url] : [])
    }
}
