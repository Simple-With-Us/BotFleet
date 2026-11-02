import Foundation
import Combine

/// Fetch state for `Settings › Resources`, mirroring `HostResourcesState` in `src/lib/host-resources.ts`.
public enum HostResourcesFetchState: Equatable, Sendable {
    case idle
    case loading
    case ready(HostResourcesReport)
    case refreshing(HostResourcesReport)
    case error(String)

    /// Preserves the last report on screen while a refresh is in flight so
    /// readings never blank out during a refresh.
    public static func nextRefreshState(_ current: HostResourcesFetchState) -> HostResourcesFetchState {
        switch current {
        case .ready(let report):
            return .refreshing(report)
        case .refreshing:
            return current
        case .idle, .loading, .error:
            return .loading
        }
    }

    public var report: HostResourcesReport? {
        switch self {
        case .ready(let report), .refreshing(let report):
            return report
        case .idle, .loading, .error:
            return nil
        }
    }

    public var isRefreshing: Bool {
        if case .refreshing = self { return true }
        return false
    }

    public var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    public var errorMessage: String? {
        if case .error(let message) = self { return message }
        return nil
    }
}

/// Keychain reads run off the main actor so a system prompt or lock never blocks UI updates.
private actor ResourcesCredentials {
    let store: any HostTokenStore
    init(_ store: any HostTokenStore) { self.store = store }
    func read(_ host: HostRecord) throws -> HostGateCredential? {
        try store.read(for: host)
    }
}

/// Read-only HTTP client for `GET /api/host/resources`.
public struct HostResourcesClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetchResources(host: HostRecord, credential: HostGateCredential?) async throws -> HostResourcesReport {
        try host.validate()
        guard host.isLocal || credential != nil else {
            throw SavedHostError.credentialUnavailable
        }
        guard let url = URL(string: "/api/host/resources", relativeTo: host.origin.url)?.absoluteURL else {
            throw SavedHostError.invalidOrigin
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        if let credential {
            try credential.authorize(&request)
        }
        let (data, response) = try await session.data(
            for: request,
            delegate: HostOriginRedirectPolicy(origin: host.origin)
        )
        guard let http = response as? HTTPURLResponse,
              http.url.map(host.origin.contains) == true else {
            throw SavedHostError.invalidResponse
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw SavedHostError.authentication
        }
        if [404, 405, 501].contains(http.statusCode) {
            throw SavedHostError.missingPlacementRoutes
        }
        guard http.statusCode == 200 else {
            throw SavedHostError.invalidResponse
        }
        let report: HostResourcesReport
        do {
            report = try JSONDecoder().decode(HostResourcesReport.self, from: data)
        } catch {
            throw SavedHostError.invalidResponse
        }
        guard HostRecord.validHostId(report.hostId) else {
            throw SavedHostError.invalidResponse
        }
        if let expected = host.hostId, expected != report.hostId {
            throw SavedHostError.differentHost
        }
        return report
    }
}

/// Coordinates host selection and `GET /api/host/resources` polling for `Settings › Resources`.
@MainActor
public final class ResourcesCoordinator: ObservableObject {
    public typealias Fetcher = @Sendable (HostRecord, HostGateCredential?) async throws -> HostResourcesReport

    @Published public private(set) var hosts: [HostRecord] = [.thisMac]
    @Published public var selectedHostID: String = HostRecord.localID
    @Published public private(set) var state: HostResourcesFetchState = .idle
    @Published public private(set) var statesByHostID: [String: HostResourcesFetchState] = [:]

    private let store: any ServersHostStore
    private let credentials: ResourcesCredentials
    private let fetcher: Fetcher
    private var inflightByHostID: [String: UUID] = [:]
    private var hostsCancellable: AnyCancellable?

    public init(
        store: any ServersHostStore,
        tokens: any HostTokenStore = KeychainHostTokenStore(),
        session: URLSession = .shared,
        fetcher: Fetcher? = nil
    ) {
        self.store = store
        self.credentials = ResourcesCredentials(tokens)
        let client = HostResourcesClient(session: session)
        self.fetcher = fetcher ?? { host, credential in
            try await client.fetchResources(host: host, credential: credential)
        }
    }

    public var selectedHost: HostRecord {
        hosts.first(where: { $0.id == selectedHostID }) ?? hosts.first ?? .thisMac
    }

    public var currentReport: HostResourcesReport? {
        state.report
    }

    /// Subscribes to `ServersCoordinator.$hosts` so host additions, renames, origin edits,
    /// and removals in `Settings › Servers` propagate immediately to `Settings › Resources`.
    public func observeHosts(from servers: ServersCoordinator) {
        hostsCancellable = servers.$hosts
            .dropFirst()
            .sink { [weak self] updated in
                self?.syncHosts(updated)
            }
    }

    /// Synchronizes the host picker with an updated saved-host list, pruning removed host state
    /// and falling back to `This Mac` if the active host was removed.
    public func syncHosts(_ updated: [HostRecord]) {
        let normalized = updated.isEmpty ? [.thisMac] : updated
        let validIDs = Set(normalized.map(\.id))
        hosts = normalized
        statesByHostID = statesByHostID.filter { validIDs.contains($0.key) }
        inflightByHostID = inflightByHostID.filter { validIDs.contains($0.key) }
        if !validIDs.contains(selectedHostID) {
            selectedHostID = normalized.first?.id ?? HostRecord.localID
            state = statesByHostID[selectedHostID] ?? .idle
            Task { [weak self] in
                await self?.refresh()
            }
        }
    }

    /// Loads the saved hosts list from `HostStore` and fetches resources for the selected host.
    public func load() async {
        do {
            let loaded = try await store.hosts()
            let normalized = loaded.isEmpty ? [.thisMac] : loaded
            let validIDs = Set(normalized.map(\.id))
            hosts = normalized
            statesByHostID = statesByHostID.filter { validIDs.contains($0.key) }
            if !validIDs.contains(selectedHostID) {
                selectedHostID = normalized.first?.id ?? HostRecord.localID
            }
        } catch {
            let msg = SavedHostError.unreadableStore.localizedDescription
            state = .error(msg)
            statesByHostID[selectedHostID] = .error(msg)
            return
        }
        await refresh()
    }

    /// Switches the active host in the picker and loads or refreshes its resource report.
    public func selectHost(id: String) async {
        guard hosts.contains(where: { $0.id == id }) else { return }
        selectedHostID = id
        if let existing = statesByHostID[id] {
            state = existing
        } else {
            state = .idle
        }
        await refresh()
    }

    /// Refreshes the selected host's resource report, keeping any prior report visible while refreshing.
    public func refresh() async {
        let host = selectedHost
        // Ignore overlapping refreshes for the same host so an earlier slow request cannot overwrite a newer one.
        guard inflightByHostID[host.id] == nil else { return }
        let generation = UUID()
        inflightByHostID[host.id] = generation

        let current = statesByHostID[host.id] ?? (selectedHostID == host.id ? state : .idle)
        let next = HostResourcesFetchState.nextRefreshState(current)
        statesByHostID[host.id] = next
        if selectedHostID == host.id {
            state = next
        }

        defer {
            if inflightByHostID[host.id] == generation {
                inflightByHostID[host.id] = nil
            }
        }

        do {
            let credential: HostGateCredential?
            if host.isLocal {
                credential = nil
            } else {
                credential = try await credentials.read(host)
                guard credential != nil else {
                    throw SavedHostError.credentialUnavailable
                }
            }
            let report = try await fetcher(host, credential)
            let ready: HostResourcesFetchState = .ready(report)
            statesByHostID[host.id] = ready
            if selectedHostID == host.id {
                state = ready
            }
        } catch {
            let failure: HostResourcesFetchState = .error(Self.safeMessage(error, host: host))
            statesByHostID[host.id] = failure
            if selectedHostID == host.id {
                state = failure
            }
        }
    }

    private static func safeMessage(_ error: Error, host: HostRecord) -> String {
        if let known = error as? SavedHostError {
            if known == .missingPlacementRoutes {
                return "Update the server: host resource routes are unavailable."
            }
            if known == .credentialUnavailable && !host.isLocal {
                return "Test \(host.name) in Servers Settings first so its credential is enrolled."
            }
            return known.localizedDescription
        }
        return "Couldn't load host resources.\u{00A0} Check that \(host.name) is reachable and try again."
    }
}
