import Foundation

/// Presentation and availability rules for the Settings › Servers
/// "Where Bots Run" mode picker (`docs/plans/2026-10-29-native-server-mode.md`).
/// Pure value types with no UI, network, or placement-activation side effects.
public struct PlacementModeOptionPresentation: Equatable, Identifiable, Sendable {
    public let mode: NativePlacementMode
    public let title: String
    public let caption: String
    public let isSelectable: Bool
    public let disabledReason: String?
    public let showsOverflowToggle: Bool
    public let overflowTitle: String?

    public var id: String { mode.rawValue }
}

public struct PlacementModeAvailability: Equatable, Sendable {
    public static let sectionTitle = "Where Bots Run"
    public static let emptyServerBanner = "No server added.\u{00A0} BotFleet runs on this Mac.\u{00A0} Add a server if you have one."
    public static let addServerReason = "Add a server to use this mode."
    public static let selectServerReason = "Select a saved server to use this mode."
    public static let testServerReason = "Test this server before using this mode."
    public static let overflowToggleTitle = "Allow Overflow To This Mac"
    public static let takeOverActionTitle = "Take Over On This Mac…"
    public static let takeOverAvailableCaption = "Server is unreachable.\u{00A0} Use Take Over On This Mac… to switch to This Mac Only."
    public static let unappliedSelectionCaption = "Saved selection has not been confirmed by the controller yet."

    public static func testServerReason(serverName: String) -> String {
        let trimmed = serverName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return testServerReason }
        return "Test \(trimmed) below to use this mode."
    }

    public static func missingPlacementRoutesReason(serverName: String, version: String) -> String {
        let trimmedName = serverName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedVersion = version.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = trimmedName.isEmpty ? "The server" : trimmedName
        let versionDescription = trimmedVersion.isEmpty ? "an unknown version" : "version \(trimmedVersion)"
        return "\(displayName) is running \(versionDescription), which has no placement routes.\u{00A0} Update the server to use this mode."
    }

    public let hasRemoteServer: Bool
    public let hasVerifiedServer: Bool
    public let options: [PlacementModeOptionPresentation]
    public let canTakeOverOnThisMac: Bool
    public let takeOverCaption: String?
    public let savedVsAppliedCaption: String?

    public static func evaluate(
        hosts: [HostRecord],
        selectedServerID: String?,
        placement: PlacementSettings,
        runningLocalJobsCount: Int = 0,
        runningServerJobsCount: Int = 0,
        serverReachable: Bool = true,
        unverifiedServerReason: String? = nil
    ) -> PlacementModeAvailability {
        let remoteHosts = hosts.filter { !$0.isLocal }
        let verifiedHosts = remoteHosts.filter { host in
            guard let hostId = host.hostId else { return false }
            return HostRecord.validHostId(hostId)
        }
        let hasRemote = !remoteHosts.isEmpty
        let hasVerified = !verifiedHosts.isEmpty
        let targetServer: HostRecord?
        let hasUnmatchedSelection: Bool
        if let selectedServerID {
            let matched = remoteHosts.first(where: { $0.id == selectedServerID })
            targetServer = matched
            hasUnmatchedSelection = hasRemote && matched == nil
        } else {
            targetServer = verifiedHosts.first ?? remoteHosts.first
            hasUnmatchedSelection = false
        }
        let targetVerified = targetServer.flatMap { host -> Bool in
            guard let hostId = host.hostId else { return false }
            return HostRecord.validHostId(hostId)
        } ?? false

        let appliedMode = placement.applied.mode
        let orderedModes: [NativePlacementMode] = [.localOnly, .serverFirst, .macFirst]

        let options = orderedModes.map { mode in
            let disabledReason = transitionDisabledReason(
                for: mode,
                appliedMode: appliedMode,
                hasRemote: hasRemote,
                hasUnmatchedSelection: hasUnmatchedSelection,
                targetVerified: targetVerified,
                targetServerName: targetServer?.name,
                unverifiedServerReason: unverifiedServerReason,
                runningLocalJobsCount: runningLocalJobsCount,
                runningServerJobsCount: runningServerJobsCount,
                serverReachable: serverReachable
            )
            return PlacementModeOptionPresentation(
                mode: mode,
                title: title(for: mode),
                caption: caption(for: mode),
                isSelectable: disabledReason == nil,
                disabledReason: disabledReason,
                showsOverflowToggle: mode == .serverFirst,
                overflowTitle: mode == .serverFirst ? overflowToggleTitle : nil
            )
        }

        let unappliedCaption = placement.hasUnappliedChanges ? unappliedSelectionCaption : nil
        let allowTakeOver = appliedMode == .serverFirst && !serverReachable
        return PlacementModeAvailability(
            hasRemoteServer: hasRemote,
            hasVerifiedServer: hasVerified,
            options: options,
            canTakeOverOnThisMac: allowTakeOver,
            takeOverCaption: allowTakeOver ? takeOverAvailableCaption : nil,
            savedVsAppliedCaption: unappliedCaption
        )
    }

    public static func title(for mode: NativePlacementMode) -> String {
        switch mode {
        case .localOnly:
            return "This Mac Only"
        case .serverFirst:
            return "Server First"
        case .macFirst:
            return "This Mac First"
        }
    }

    public static func caption(for mode: NativePlacementMode) -> String {
        switch mode {
        case .localOnly:
            return "Run every bot and tool on this Mac.\u{00A0} Nothing is sent to a server."
        case .serverFirst:
            return "Run bots on the selected server first.\u{00A0} Mac-only tools and optional overflow run on this Mac."
        case .macFirst:
            return "Run bots on this Mac first, and send overflow or pinned work to the selected server."
        }
    }

    public static func unreachableBanner(serverName: String, originHost: String) -> String {
        "Can't reach \(serverName) at \(originHost).\u{00A0} If that is a Tailscale name, this Mac may be off the tailnet.\u{00A0} Work already running on this Mac finishes.\u{00A0} New work is refused until \(serverName) returns or you take over.\u{00A0} Retrying automatically."
    }

    private static func transitionDisabledReason(
        for targetMode: NativePlacementMode,
        appliedMode: NativePlacementMode,
        hasRemote: Bool,
        hasUnmatchedSelection: Bool,
        targetVerified: Bool,
        targetServerName: String?,
        unverifiedServerReason: String?,
        runningLocalJobsCount: Int,
        runningServerJobsCount: Int,
        serverReachable: Bool
    ) -> String? {
        if targetMode == appliedMode {
            return nil
        }
        if targetMode != .localOnly {
            if !hasRemote {
                return addServerReason
            }
            if hasUnmatchedSelection {
                return selectServerReason
            }
            if !targetVerified {
                if let reason = unverifiedServerReason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
                    return reason
                }
                if let targetServerName {
                    return testServerReason(serverName: targetServerName)
                }
                return testServerReason
            }
        }
        if !serverReachable {
            if appliedMode == .serverFirst {
                return targetMode == .localOnly
                    ? takeOverAvailableCaption
                    : "Server is unreachable.\u{00A0} Wait for the server to return before switching to This Mac First."
            }
            if targetMode == .serverFirst {
                return "Server is unreachable.\u{00A0} Wait for the server to return before switching to Server First."
            }
        }
        if appliedMode == .serverFirst {
            let activeTotal = runningServerJobsCount + runningLocalJobsCount
            if activeTotal > 0 {
                if runningServerJobsCount > 0 && runningLocalJobsCount > 0 {
                    return "Finish or stop \(activeTotal) jobs running across the server and this Mac first"
                }
                if runningServerJobsCount > 0 {
                    let noun = runningServerJobsCount == 1 ? "job" : "jobs"
                    return "Finish or stop \(runningServerJobsCount) \(noun) running on the server first"
                }
                let noun = runningLocalJobsCount == 1 ? "job" : "jobs"
                return "Finish or stop \(runningLocalJobsCount) \(noun) running on this Mac first"
            }
        }
        if runningLocalJobsCount > 0 && targetMode == .serverFirst {
            let noun = runningLocalJobsCount == 1 ? "job" : "jobs"
            return "Finish or stop \(runningLocalJobsCount) \(noun) running on this Mac first"
        }
        if runningServerJobsCount > 0 && appliedMode != .localOnly {
            let noun = runningServerJobsCount == 1 ? "job" : "jobs"
            return "Finish or stop \(runningServerJobsCount) \(noun) running on the server first"
        }
        return nil
    }
}
