import Foundation

/// Startup must finish reading saved hosts before selecting the local route.
@MainActor
public enum MacLocalConnectionBootstrap {
    public static func run(
        loadHosts: () async -> [HostRecord]?,
        isCurrent: () -> Bool,
        connect: (HostRecord) -> Void
    ) async {
        guard isCurrent(), !Task.isCancelled else { return }
        let hosts = await loadHosts()
        guard isCurrent(), !Task.isCancelled,
              let local = hosts?.first(where: \.isLocal),
              (try? local.companionConnection()) != nil else { return }
        // No suspension between eligibility and connecting: a disconnect wins.
        connect(local)
    }
}
