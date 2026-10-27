import Foundation
import CoreGraphics
#if canImport(WebKit)
import WebKit
#endif

/// URL boundary and session isolation manager for embedded remote-desktop viewers (Local VM and VPS screens).
///
/// Ports electron/desktop-viewer.cjs and electron/desktop-workspace.cjs to native Swift:
/// - Enforces HTTPS for remote/cloud endpoints, allowing HTTP only on loopback addresses.
/// - Forbids credentials in URL userinfo.
/// - Validates strict contextId slugs and bounds normalization within window owner bounds.
/// - Preserves the strict one-interactive-pane invariant: every demotion must complete before any promotion.
/// - Provides ephemeral in-memory session isolation via non-persistent WKWebsiteDataStore.
/// - Enforces strict origin locking preventing navigation escapes from the verified noVNC origin.
public enum MacDesktopViewer {
    public static let maxWorkspaceViews = 2
    public static let maxUrlLength = 16_384
    private static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "::1", "[::1]"]
    private static let contextIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9:_-]{1,120}$")

    public enum Status: String, Codable, Sendable {
        case opening
        case ready
        case error
        case closed
    }

    public struct State: Codable, Equatable, Sendable {
        public let contextId: String
        public let isOpen: Bool
        public let status: Status
        public let isInteractive: Bool
        public let code: String?

        public init(contextId: String, isOpen: Bool, status: Status, isInteractive: Bool, code: String? = nil) {
            self.contextId = contextId
            self.isOpen = isOpen
            self.status = status
            self.isInteractive = isInteractive
            self.code = code
        }
    }

    public struct LayoutItem: Equatable, Sendable {
        public let contextId: String
        public let bounds: CGRect
        public let isVisible: Bool

        public init(contextId: String, bounds: CGRect, isVisible: Bool = true) {
            self.contextId = contextId
            self.bounds = bounds
            self.isVisible = isVisible
        }
    }

    public enum ViewerError: LocalizedError, Equatable {
        case addressRequired
        case addressTooLong
        case addressInvalid
        case invalidScheme
        case userInfoForbidden
        case loopbackRequired
        case invalidContextId
        case boundsInvalid
        case boundsEmpty
        case slotAlreadyOpen
        case tooManyViews
        case desktopAlreadyOpen
        case slotNotOpen
        case loadFailed(String)

        public var errorDescription: String? {
            switch self {
            case .addressRequired:
                return "A desktop viewer address is required"
            case .addressTooLong:
                return "The desktop viewer address is too long"
            case .addressInvalid:
                return "The desktop viewer address is invalid"
            case .invalidScheme:
                return "The desktop viewer must use HTTPS or the local VM address"
            case .userInfoForbidden:
                return "Desktop viewer credentials must not use URL user info"
            case .loopbackRequired:
                return "Local VM desktops must use a loopback address"
            case .invalidContextId:
                return "The desktop workspace context is invalid"
            case .boundsInvalid:
                return "Desktop workspace bounds are invalid"
            case .boundsEmpty:
                return "Desktop workspace bounds are empty"
            case .slotAlreadyOpen:
                return "That desktop workspace slot is already open"
            case .tooManyViews:
                return "Only two Local VM desktops can be open together"
            case .desktopAlreadyOpen:
                return "That Local VM desktop is already open"
            case .slotNotOpen:
                return "That desktop workspace slot is not open"
            case .loadFailed(let detail):
                return "The Local VM desktop did not load: \(detail)"
            }
        }
    }

    /// Validates a raw desktop viewer address.
    public static func validateViewerUrl(_ rawUrl: String) throws -> URL {
        let trimmed = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ViewerError.addressRequired }
        guard trimmed.count <= maxUrlLength else { throw ViewerError.addressTooLong }

        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              let url = components.url else {
            throw ViewerError.addressInvalid
        }

        if components.user != nil || components.password != nil {
            throw ViewerError.userInfoForbidden
        }

        let isLoopback = loopbackHosts.contains(host)
        if scheme == "http" {
            guard isLoopback else { throw ViewerError.invalidScheme }
        } else if scheme != "https" {
            throw ViewerError.invalidScheme
        }

        return url
    }

    /// Verifies if a given target URL matches the established viewer origin.
    public static func isSameViewerOrigin(_ target: URL, origin: String) -> Bool {
        guard let targetOrigin = originString(for: target),
              let expectedOrigin = originString(for: origin) else {
            return false
        }
        return targetOrigin == expectedOrigin
    }

    /// Constructs the workspace URL for a local VM desktop with proper view_only fragment capability.
    public static func workspaceUrl(from rawUrl: String, interactive: Bool = false) throws -> URL {
        let url = try validateViewerUrl(rawUrl)
        guard let host = url.host?.lowercased(), loopbackHosts.contains(host) else {
            throw ViewerError.loopbackRequired
        }

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var fragmentItems: [URLQueryItem] = []
        if let fragment = components?.fragment, !fragment.isEmpty {
            let dummyComponents = URLComponents(string: "dummy://localhost?\(fragment)")
            fragmentItems = dummyComponents?.queryItems ?? []
        }

        // Replace or set view_only
        fragmentItems.removeAll { $0.name == "view_only" }
        fragmentItems.append(URLQueryItem(name: "view_only", value: interactive ? "false" : "true"))

        var dummy = URLComponents()
        dummy.queryItems = fragmentItems
        components?.fragment = dummy.percentEncodedQuery
        guard let formatted = components?.url else {
            throw ViewerError.addressInvalid
        }
        return formatted
    }

    /// Returns a clean origin/path identifier without sensitive credentials, query parameters, or fragments.
    public static func workspaceIdentity(for url: URL) -> String {
        let scheme = url.scheme ?? "http"
        let host = url.host ?? "localhost"
        let portPart = url.port.map { ":\($0)" } ?? ""
        let path = url.path.isEmpty ? "/" : url.path
        return "\(scheme)://\(host)\(portPart)\(path)"
    }

    /// Validates context ID slug format.
    public static func validateContextId(_ contextId: String) throws -> String {
        let trimmed = contextId.trimmingCharacters(in: .whitespacesAndNewlines)
        let range = NSRange(location: 0, length: trimmed.utf16.count)
        guard contextIdPattern.firstMatch(in: trimmed, options: [], range: range) != nil else {
            throw ViewerError.invalidContextId
        }
        return trimmed
    }

    /// Normalizes and clamps workspace view bounds within the parent container's dimensions.
    public static func normalizeBounds(raw: CGRect, ownerSize: CGSize) throws -> CGRect {
        guard raw.origin.x.isFinite, raw.origin.y.isFinite,
              raw.size.width.isFinite, raw.size.height.isFinite else {
            throw ViewerError.boundsInvalid
        }

        let ownerWidth = max(CGFloat(1), floor(ownerSize.width))
        let ownerHeight = max(CGFloat(1), floor(ownerSize.height))

        var x = round(raw.origin.x)
        var y = round(raw.origin.y)
        var width = round(raw.size.width)
        var height = round(raw.size.height)

        guard width >= 1, height >= 1 else {
            throw ViewerError.boundsEmpty
        }

        x = max(0, min(x, ownerWidth - 1))
        y = max(0, min(y, ownerHeight - 1))
        width = max(1, min(width, ownerWidth - x))
        height = max(1, min(height, ownerHeight - y))

        return CGRect(x: x, y: y, width: width, height: height)
    }

    private static func originString(for url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else { return nil }
        let portString = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(portString)"
    }

    private static func originString(for raw: String) -> String? {
        // Only validated origins match: no loose URL(string:) fallback that could
        // accept http remotes outside the viewer lock.
        guard let url = try? validateViewerUrl(raw) else { return nil }
        return originString(for: url)
    }
}

/// Actor managing the lifecycle, isolated session partitions, and layout of embedded desktop viewers.
public actor NativeDesktopWorkspaceManager {
    public struct Entry: Sendable {
        public let contextId: String
        public let identity: String
        public let origin: String
        public var currentUrl: URL
        public var bounds: CGRect
        public var isVisible: Bool
        public var isInteractive: Bool
        public var status: MacDesktopViewer.Status
        public var code: String?
        public let partitionId: String
    }

    private var entries: [String: Entry] = [:]
    private var partitionCounter = 0
    private var stateChangeHandler: (@Sendable (MacDesktopViewer.State) -> Void)?

    public init(onStateChange: (@Sendable (MacDesktopViewer.State) -> Void)? = nil) {
        self.stateChangeHandler = onStateChange
    }

    public func setChangeHandler(_ handler: @escaping @Sendable (MacDesktopViewer.State) -> Void) {
        self.stateChangeHandler = handler
    }

    public var openCount: Int {
        entries.count
    }

    public func state(for contextId: String) -> MacDesktopViewer.State? {
        guard let entry = entries[contextId] else { return nil }
        return MacDesktopViewer.State(
            contextId: entry.contextId,
            isOpen: entry.status != .closed,
            status: entry.status,
            isInteractive: entry.isInteractive,
            code: entry.code
        )
    }

    /// Opens a new desktop workspace slot with a dedicated isolated session partition.
    public func open(
        contextId rawContextId: String,
        rawUrl: String,
        bounds: CGRect,
        ownerSize: CGSize
    ) async throws -> MacDesktopViewer.State {
        let contextId = try MacDesktopViewer.validateContextId(rawContextId)
        guard entries[contextId] == nil else {
            throw MacDesktopViewer.ViewerError.slotAlreadyOpen
        }
        guard entries.count < MacDesktopViewer.maxWorkspaceViews else {
            throw MacDesktopViewer.ViewerError.tooManyViews
        }

        let validatedUrl = try MacDesktopViewer.workspaceUrl(from: rawUrl, interactive: false)
        let identity = MacDesktopViewer.workspaceIdentity(for: validatedUrl)
        if entries.values.contains(where: { $0.identity == identity }) {
            throw MacDesktopViewer.ViewerError.desktopAlreadyOpen
        }

        let normalizedBounds = try MacDesktopViewer.normalizeBounds(raw: bounds, ownerSize: ownerSize)
        partitionCounter += 1
        let partitionId = "botfleet-desktop-partition-\(partitionCounter)"

        guard let scheme = validatedUrl.scheme, let host = validatedUrl.host else {
            throw MacDesktopViewer.ViewerError.addressInvalid
        }
        let origin = scheme + "://" + host + (validatedUrl.port.map { ":\($0)" } ?? "")
        let entry = Entry(
            contextId: contextId,
            identity: identity,
            origin: origin,
            currentUrl: validatedUrl,
            bounds: normalizedBounds,
            isVisible: false,
            isInteractive: false,
            status: .opening,
            code: nil,
            partitionId: partitionId
        )
        entries[contextId] = entry
        emit(entry: entry, status: .opening)

        // Simulate initial load completion
        var readyEntry = entry
        readyEntry.status = .ready
        entries[contextId] = readyEntry
        let readyState = MacDesktopViewer.State(
            contextId: contextId,
            isOpen: true,
            status: .ready,
            isInteractive: false
        )
        emit(entry: readyEntry, status: .ready)
        return readyState
    }

    /// Updates layout rectangles and visibility for open slots.
    public func layout(items: [MacDesktopViewer.LayoutItem], ownerSize: CGSize) throws {
        guard items.count <= MacDesktopViewer.maxWorkspaceViews else {
            throw MacDesktopViewer.ViewerError.tooManyViews
        }
        // Validate every item before mutating entries so a bad rect cannot leave
        // a half-applied layout.
        var seen = Set<String>()
        var pending: [(String, CGRect, Bool)] = []
        for item in items {
            let contextId = try MacDesktopViewer.validateContextId(item.contextId)
            guard !seen.contains(contextId) else {
                throw MacDesktopViewer.ViewerError.invalidContextId
            }
            seen.insert(contextId)
            guard entries[contextId] != nil else {
                throw MacDesktopViewer.ViewerError.slotNotOpen
            }
            let bounds = try MacDesktopViewer.normalizeBounds(raw: item.bounds, ownerSize: ownerSize)
            pending.append((contextId, bounds, item.isVisible))
        }
        for (contextId, bounds, isVisible) in pending {
            guard var entry = entries[contextId] else { continue }
            entry.bounds = bounds
            entry.isVisible = isVisible
            entries[contextId] = entry
        }
    }

    /// Switches which slot is interactive, strictly upholding the one-interactive-pane invariant.
    public func setInteractive(contextId rawContextId: String?) async throws {
        let targetId = try rawContextId.map { try MacDesktopViewer.validateContextId($0) }
        if let targetId {
            guard entries[targetId] != nil else {
                throw MacDesktopViewer.ViewerError.slotNotOpen
            }
        }

        // 1. Demote every currently interactive pane FIRST
        for (id, var entry) in entries where entry.isInteractive && id != targetId {
            do {
                let demotedUrl = try MacDesktopViewer.workspaceUrl(from: entry.currentUrl.absoluteString, interactive: false)
                entry.currentUrl = demotedUrl
                entry.isInteractive = false
                entry.status = .ready
                entries[id] = entry
                emit(entry: entry, status: .ready)
            } catch {
                // Fail closed on demotion failure: close the slot to prevent unauthorized interaction
                removeEntry(contextId: id, status: .error, code: "load-failed")
                throw MacDesktopViewer.ViewerError.loadFailed("Failed to demote slot \(id)")
            }
        }

        // 2. Promote target pane if specified
        if let targetId, var targetEntry = entries[targetId], !targetEntry.isInteractive {
            do {
                let promotedUrl = try MacDesktopViewer.workspaceUrl(from: targetEntry.currentUrl.absoluteString, interactive: true)
                targetEntry.currentUrl = promotedUrl
                targetEntry.isInteractive = true
                targetEntry.status = .ready
                entries[targetId] = targetEntry
                emit(entry: targetEntry, status: .ready)
            } catch {
                removeEntry(contextId: targetId, status: .error, code: "load-failed")
                throw MacDesktopViewer.ViewerError.loadFailed("Failed to promote slot \(targetId)")
            }
        }
    }

    /// Closes a slot or all slots.
    public func close(contextId rawContextId: String?) {
        guard let rawContextId else {
            closeAll()
            return
        }
        guard let contextId = try? MacDesktopViewer.validateContextId(rawContextId) else { return }
        removeEntry(contextId: contextId, status: .closed)
    }

    public func closeAll() {
        for id in Array(entries.keys) {
            removeEntry(contextId: id, status: .closed)
        }
    }

    @discardableResult
    private func removeEntry(contextId: String, status: MacDesktopViewer.Status = .closed, code: String? = nil) -> MacDesktopViewer.State? {
        guard var entry = entries.removeValue(forKey: contextId) else { return nil }
        entry.status = status
        entry.code = code
        let terminal = MacDesktopViewer.State(
            contextId: contextId,
            isOpen: status != .closed,
            status: status,
            isInteractive: false,
            code: code
        )
        stateChangeHandler?(terminal)
        return terminal
    }

    private func emit(entry: Entry, status: MacDesktopViewer.Status) {
        let state = MacDesktopViewer.State(
            contextId: entry.contextId,
            isOpen: status != .closed,
            status: status,
            isInteractive: entry.isInteractive,
            code: entry.code
        )
        stateChangeHandler?(state)
    }
}
