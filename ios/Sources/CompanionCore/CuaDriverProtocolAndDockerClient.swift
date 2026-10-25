#if os(macOS)
import ApplicationServices
import CoreGraphics
import CoreVideo
import Darwin
import Foundation

public typealias MouseButton = CuaMouseButton

/// Destination surface controlled by a `CuaDriverProtocol` instance.
public enum CuaTargetKind: Equatable, Hashable, Sendable {
    case hostMac
    case localVM(containerName: String, viewerPort: Int)
}

/// Frame captured from a CUA target surface.  Supports a CPU-mapped
/// `CVPixelBuffer` holding the real screen as well as encoded PNG/BGRA bytes
/// for VM viewers.
public struct CuaCapturedFrame: @unchecked Sendable, Equatable {
    public let width: Int
    public let height: Int
    public let scaleFactor: Double
    public let pixelBuffer: CVPixelBuffer?
    public let encodedImageBytes: Data?

    public init(
        width: Int,
        height: Int,
        scaleFactor: Double = 1.0,
        pixelBuffer: CVPixelBuffer? = nil,
        encodedImageBytes: Data? = nil
    ) {
        self.width = width
        self.height = height
        self.scaleFactor = scaleFactor
        self.pixelBuffer = pixelBuffer
        self.encodedImageBytes = encodedImageBytes
    }

    public static func == (lhs: CuaCapturedFrame, rhs: CuaCapturedFrame) -> Bool {
        lhs.width == rhs.width
            && lhs.height == rhs.height
            && lhs.scaleFactor == rhs.scaleFactor
            && lhs.encodedImageBytes == rhs.encodedImageBytes
            && (lhs.pixelBuffer != nil) == (rhs.pixelBuffer != nil)
    }
}

/// Node in a macOS Accessibility (`AXUIElement`) hierarchy.
public struct AXElementNode: Codable, Equatable, Sendable {
    public let role: String
    public let title: String?
    public let frame: CGRect?
    public let children: [AXElementNode]

    public init(
        role: String,
        title: String? = nil,
        frame: CGRect? = nil,
        children: [AXElementNode] = []
    ) {
        self.role = role
        self.title = title
        self.frame = frame
        self.children = children
    }
}

/// Formal protocol unifying host Mac CUA (`ScreenCaptureKit` / `MacCuaDriver` / `AXUIElement`)
/// and Local VM CUA (Docker/Podman container viewer port).
public protocol CuaDriverProtocol: Sendable {
    var targetKind: CuaTargetKind { get }
    func captureFrame() async throws -> CuaCapturedFrame
    func click(point: CGPoint, button: MouseButton, count: Int) async throws
    func move(to point: CGPoint) async throws
    func type(text: String) async throws
    func inspectAccessibilityTree(pid: pid_t?) async throws -> [AXElementNode]
}

// MARK: - AXUIElement Accessibility Inspector (`MacAXInspector`)

/// Abstraction over `AXUIElementCopyAttributeValue` so `MacAXInspector`'s depth and
/// node-cap traversal bounds can be unit-tested deterministically alongside live PIDs.
public protocol AXHierarchyProviderProtocol: Sendable {
    func rootWindows(forPid pid: pid_t) -> [AnyObject]
    func role(of element: AnyObject) -> String?
    func title(of element: AnyObject) -> String?
    func frame(of element: AnyObject) -> CGRect?
    func children(of element: AnyObject) -> [AnyObject]
}

/// Live macOS `ApplicationServices` accessibility attribute reader using `AXUIElement`.
public struct SystemAXHierarchyProvider: AXHierarchyProviderProtocol {
    public init() {}

    public func rootWindows(forPid pid: pid_t) -> [AnyObject] {
        let appElement = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value)
        if err == .success, let windows = value as? [AnyObject], !windows.isEmpty {
            return windows
        }
        var childVal: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXChildrenAttribute as CFString, &childVal) == .success,
           let children = childVal as? [AnyObject] {
            return children
        }
        return [appElement]
    }

    public func role(of element: AnyObject) -> String? {
        let ax = unsafeBitCast(element, to: AXUIElement.self)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXRoleAttribute as CFString, &value) == .success else {
            return nil
        }
        return value as? String
    }

    public func title(of element: AnyObject) -> String? {
        let ax = unsafeBitCast(element, to: AXUIElement.self)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXTitleAttribute as CFString, &value) == .success else {
            return nil
        }
        return value as? String
    }

    public func frame(of element: AnyObject) -> CGRect? {
        let ax = unsafeBitCast(element, to: AXUIElement.self)
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard
            AXUIElementCopyAttributeValue(ax, kAXPositionAttribute as CFString, &posRef) == .success,
            AXUIElementCopyAttributeValue(ax, kAXSizeAttribute as CFString, &sizeRef) == .success,
            let posVal = posRef,
            let sizeVal = sizeRef,
            CFGetTypeID(posVal) == AXValueGetTypeID(),
            CFGetTypeID(sizeVal) == AXValueGetTypeID()
        else {
            return nil
        }
        var point = CGPoint.zero
        var size = CGSize.zero
        let axPos = unsafeBitCast(posVal, to: AXValue.self)
        let axSize = unsafeBitCast(sizeVal, to: AXValue.self)
        guard
            AXValueGetValue(axPos, .cgPoint, &point),
            AXValueGetValue(axSize, .cgSize, &size)
        else {
            return nil
        }
        return CGRect(origin: point, size: size)
    }

    public func children(of element: AnyObject) -> [AnyObject] {
        let ax = unsafeBitCast(element, to: AXUIElement.self)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXChildrenAttribute as CFString, &value) == .success,
              let list = value as? [AnyObject]
        else {
            return []
        }
        return list
    }
}

/// Bounded macOS `AXUIElement` window-hierarchy inspector.
///
/// Enforces `maxDepth` and `maxNodes` caps so inspecting a complex app never blocks
/// or exhausts memory.
public struct MacAXInspector: Sendable {
    public let maxDepth: Int
    public let maxNodes: Int
    private let provider: AXHierarchyProviderProtocol

    public init(
        maxDepth: Int = 6,
        maxNodes: Int = 250,
        provider: AXHierarchyProviderProtocol = SystemAXHierarchyProvider()
    ) {
        self.maxDepth = max(1, maxDepth)
        self.maxNodes = max(1, maxNodes)
        self.provider = provider
    }

    /// Inspects the accessibility hierarchy for `pid` (defaults to the current process PID).
    public func inspect(pid: pid_t? = nil) -> [AXElementNode] {
        let targetPid = pid ?? getpid()
        let roots = provider.rootWindows(forPid: targetPid)
        var visitedCount = 0
        var result: [AXElementNode] = []

        for root in roots {
            if visitedCount >= maxNodes { break }
            if let node = traverse(element: root, depth: 0, visitedCount: &visitedCount) {
                result.append(node)
            }
        }
        return result
    }

    private func traverse(element: AnyObject, depth: Int, visitedCount: inout Int) -> AXElementNode? {
        guard visitedCount < maxNodes else { return nil }
        visitedCount += 1

        let role = provider.role(of: element) ?? "AXUnknown"
        let title = provider.title(of: element)
        let frame = provider.frame(of: element)

        guard depth + 1 < maxDepth, visitedCount < maxNodes else {
            return AXElementNode(role: role, title: title, frame: frame, children: [])
        }

        var childNodes: [AXElementNode] = []
        for child in provider.children(of: element) {
            if visitedCount >= maxNodes { break }
            if let node = traverse(element: child, depth: depth + 1, visitedCount: &visitedCount) {
                childNodes.append(node)
            }
        }
        return AXElementNode(role: role, title: title, frame: frame, children: childNodes)
    }
}

// MARK: - Host Mac & Local VM CUA Driver Implementations

/// Host Mac implementation of `CuaDriverProtocol` backed by `MacCuaDriver` and `MacAXInspector`.
public final class HostMacCuaDriver: CuaDriverProtocol {
    public let targetKind: CuaTargetKind = .hostMac
    private let macDriver: MacCuaDriver
    private let axInspector: MacAXInspector

    public init(
        macDriver: MacCuaDriver = .shared,
        axInspector: MacAXInspector = MacAXInspector()
    ) {
        self.macDriver = macDriver
        self.axInspector = axInspector
    }

    public func captureFrame() async throws -> CuaCapturedFrame {
        let displays = macDriver.activeDisplays()
        guard let primary = displays.first(where: \.isPrimary) ?? displays.first else {
            throw ContainerSocketError.httpStatus(code: 503, body: "No display is attached, so there is nothing to capture.")
        }
        guard macDriver.checkPermissions().hasScreenRecording else {
            throw ContainerSocketError.httpStatus(
                code: 403,
                body: "Screen Recording permission is not granted, so BotFleet cannot capture the screen."
            )
        }
        guard let capturedImage = CGDisplayCreateImage(primary.id) else {
            throw ContainerSocketError.httpStatus(
                code: 502,
                body: "The macOS screen capture API returned no image for display \(primary.id)."
            )
        }

        let width = capturedImage.width
        let height = capturedImage.height
        var pixelBuffer: CVPixelBuffer?
        let attributes: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            max(1, width),
            max(1, height),
            kCVPixelFormatType_32BGRA,
            attributes as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw ContainerSocketError.httpStatus(
                code: 500,
                body: "Screen capture buffer allocation failed (\(status))."
            )
        }

        // Draw the captured screen into the buffer through a bitmap context, so
        // the pixels are the real screen rather than uninitialized memory and
        // keep their top-down orientation.
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer),
              let context = CGContext(
                  data: baseAddress,
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                      | CGBitmapInfo.byteOrder32Little.rawValue
              )
        else {
            throw ContainerSocketError.httpStatus(
                code: 500,
                body: "Screen capture buffer could not be mapped for drawing."
            )
        }
        context.draw(capturedImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        return CuaCapturedFrame(
            width: width,
            height: height,
            scaleFactor: primary.scaleFactor,
            pixelBuffer: pixelBuffer,
            encodedImageBytes: nil
        )
    }

    public func click(point: CGPoint, button: MouseButton = .left, count: Int = 1) async throws {
        _ = macDriver.click(at: point, button: button, clickCount: count)
    }

    public func move(to point: CGPoint) async throws {
        _ = macDriver.moveMouse(to: point)
    }

    public func type(text: String) async throws {
        _ = macDriver.typeText(text)
    }

    public func inspectAccessibilityTree(pid: pid_t? = nil) async throws -> [AXElementNode] {
        axInspector.inspect(pid: pid)
    }
}

/// Local VM implementation of `CuaDriverProtocol` targeting a `botfleet-computer*` container viewer port.
public final class LocalVmCuaDriver: CuaDriverProtocol {
    public let targetKind: CuaTargetKind
    public let containerName: String
    public let viewerPort: Int
    public let socketClient: ContainerSocketClient

    public init(
        containerName: String,
        viewerPort: Int = 6080,
        socketClient: ContainerSocketClient
    ) throws {
        guard ContainerSocketClient.isVerifiedBotFleetContainerName(containerName) else {
            throw ContainerSocketError.unownedContainerRefused(name: containerName)
        }
        self.containerName = containerName
        self.viewerPort = viewerPort
        self.socketClient = socketClient
        self.targetKind = .localVM(containerName: containerName, viewerPort: viewerPort)
    }

    public func captureFrame() async throws -> CuaCapturedFrame {
        try await requireRunningContainer()
        // The guest's screen is served by `cua-driver` inside the container,
        // which the Node harness drives through `docker exec`.  The Swift
        // client speaks to the daemon socket, so it cannot read a real frame
        // yet.  Returning a placeholder would leave the agent reasoning
        // against a stale screen, so the driver fails loudly instead.
        throw ContainerSocketError.unsupportedOperation(
            operation: "captureFrame",
            reason: "reading the guest screen needs the container's cua-driver bridge, which is not wired up in the native client yet"
        )
    }

    public func click(point: CGPoint, button: MouseButton = .left, count: Int = 1) async throws {
        try await requireRunningContainer()
        throw ContainerSocketError.unsupportedOperation(
            operation: "click",
            reason: "driving the guest's pointer needs the container's cua-driver bridge, which is not wired up in the native client yet"
        )
    }

    public func move(to point: CGPoint) async throws {
        try await requireRunningContainer()
        throw ContainerSocketError.unsupportedOperation(
            operation: "move",
            reason: "driving the guest's pointer needs the container's cua-driver bridge, which is not wired up in the native client yet"
        )
    }

    public func type(text: String) async throws {
        try await requireRunningContainer()
        throw ContainerSocketError.unsupportedOperation(
            operation: "type",
            reason: "driving the guest's keyboard needs the container's cua-driver bridge, which is not wired up in the native client yet"
        )
    }

    public func inspectAccessibilityTree(pid: pid_t? = nil) async throws -> [AXElementNode] {
        try await requireRunningContainer()
        throw ContainerSocketError.unsupportedOperation(
            operation: "inspectAccessibilityTree",
            reason: "reading the guest's accessibility tree needs the container's cua-driver bridge, which is not wired up in the native client yet"
        )
    }

    /// Confirms the Local VM container is running before an operation is
    /// attempted, so a stopped VM reports its own state rather than the
    /// unsupported-operation error.
    private func requireRunningContainer() async throws {
        let detail = try await socketClient.inspectContainer(idOrName: containerName)
        guard detail.running else {
            throw ContainerSocketError.httpStatus(code: 409, body: "Local VM container '\(containerName)' is not running.")
        }
    }
}

// MARK: - Container Runtime Naming & Guard (`shared/container-runtime-name.ts`)

/// Known container runtime IDs and human-readable product names (`shared/container-runtime-name.ts`).
public enum ContainerRuntimeNaming {
    public static let supportedRuntimeIds: Set<String> = ["docker", "podman"]

    /// Product name shown for a runtime ID (`Docker`, `Podman`, `Apple Container`, or capitalized ID).
    public static func productName(for runtimeId: String) -> String {
        switch runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "docker":
            return "Docker"
        case "podman":
            return "Podman"
        case "container":
            return "Apple Container"
        default:
            let trimmed = runtimeId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let first = trimmed.first else { return trimmed }
            return String(first).uppercased() + trimmed.dropFirst()
        }
    }

    /// Exact sentence when a container daemon does not answer in time (`shared/container-runtime-name.ts`).
    public static func daemonSlowProblem(runtime: String) -> String {
        "\(productName(for: runtime)) is slow to respond right now; try again in a moment"
    }
}

// MARK: - Pure-Swift POSIX `AF_UNIX` HTTP Client for Docker & Podman (`ContainerSocketClient`)

/// Summary of a BotFleet Local VM container returned by `GET /containers/json`.
public struct BotFleetContainerSummary: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let state: String
    public let status: String
    public let labels: [String: String]

    public init(id: String, name: String, state: String, status: String, labels: [String: String] = [:]) {
        self.id = id
        self.name = name
        self.state = state
        self.status = status
        self.labels = labels
    }

    public var isRunning: Bool {
        state.lowercased() == "running"
    }
}

/// Detailed container state returned by `GET /containers/{name}/json`.
public struct BotFleetContainerDetail: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let running: Bool
    public let status: String
    public let memoryLimitBytes: Int64?
    public let labels: [String: String]

    public init(
        id: String,
        name: String,
        running: Bool,
        status: String,
        memoryLimitBytes: Int64? = nil,
        labels: [String: String] = [:]
    ) {
        self.id = id
        self.name = name
        self.running = running
        self.status = status
        self.memoryLimitBytes = memoryLimitBytes
        self.labels = labels
    }
}

/// Errors thrown by `ContainerSocketClient`.
public enum ContainerSocketError: LocalizedError, Equatable, Sendable {
    case runtimeDisabled
    case unsupportedRuntime(runtimeName: String, message: String)
    case unownedContainerRefused(name: String)
    case invalidSocketPath(String)
    case connectionFailed(socketPath: String, errnoCode: Int32)
    case malformedHTTPResponse
    case malformedHTTPRequest
    case unsupportedOperation(operation: String, reason: String)
    case httpStatus(code: Int, body: String)

    public var errorDescription: String? {
        switch self {
        case .runtimeDisabled:
            return "Container runtimes are disabled in this process (BOTFLEET_DISABLE_CONTAINER_RUNTIME is set), so BotFleet will not run docker, podman, container or orb."
        case .unsupportedRuntime(_, let message):
            return message
        case .unownedContainerRefused(let name):
            return "Refused container lifecycle operation on '\(name)': only verified 'botfleet-computer*' containers may be targeted."
        case .invalidSocketPath(let path):
            return "Invalid UNIX domain socket path: \(path)"
        case .connectionFailed(let path, let code):
            return "Could not connect to container UNIX socket at \(path) (errno \(code))."
        case .malformedHTTPResponse:
            return "Container socket returned a malformed HTTP/1.1 response."
        case .malformedHTTPRequest:
            return "Refused a malformed HTTP request to the container socket: the method or path carried characters that are not allowed in an HTTP request line."
        case .unsupportedOperation(let operation, let reason):
            return "The \(operation) operation is not available on this target: \(reason)"
        case .httpStatus(let code, let body):
            return "Container daemon returned HTTP \(code): \(body)"
        }
    }
}

/// Pure-Swift POSIX `AF_UNIX` HTTP/1.1 client for managing BotFleet Local VM containers
/// over Docker Desktop (`/var/run/docker.sock`), OrbStack (`~/.orbstack/run/docker.sock`),
/// or Podman machine UNIX domain sockets without spawning a CLI child process.
public final class ContainerSocketClient: Sendable {
    public static let defaultDockerSocketPath = "/var/run/docker.sock"
    public static var defaultOrbStackSocketPath: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".orbstack/run/docker.sock")
    }

    public let socketPath: String
    public let runtimeId: String

    public init(
        socketPath: String = ContainerSocketClient.defaultDockerSocketPath,
        runtimeId: String = "docker"
    ) throws {
        let normalizedRuntime = runtimeId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let displayName = ContainerRuntimeNaming.productName(for: runtimeId)
        guard ContainerRuntimeNaming.supportedRuntimeIds.contains(normalizedRuntime) else {
            throw ContainerSocketError.unsupportedRuntime(
                runtimeName: displayName,
                message: "\(displayName) does not expose a compatible Docker/Podman UNIX domain socket API for BotFleet Local VM."
            )
        }
        self.socketPath = socketPath
        self.runtimeId = normalizedRuntime
    }

    /// Verifies that `name` is a legitimate `botfleet-computer*` container identifier
    /// and contains no path traversal or URL delimiter characters.
    public static func isVerifiedBotFleetContainerName(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard trimmed.hasPrefix("botfleet-computer") else { return false }
        guard !trimmed.contains(".."), !trimmed.contains("/"), !trimmed.contains("\\") else { return false }
        return trimmed.allSatisfy { ch in
            ch.isASCII && (ch.isLetter || ch.isNumber || ch == "-" || ch == "_" || ch == ".")
        }
    }

    // MARK: - Container Lifecycle Operations

    /// Lists all `botfleet-computer*` containers reported by the daemon (`GET /containers/json?all=true`).
    public func listBotFleetContainers() async throws -> [BotFleetContainerSummary] {
        let (status, body) = try await performHTTPRequest(method: "GET", path: "/containers/json?all=true")
        guard (200..<300).contains(status) else {
            throw ContainerSocketError.httpStatus(code: status, body: String(data: body, encoding: .utf8) ?? "")
        }
        guard let rows = try? JSONSerialization.jsonObject(with: body) as? [[String: Any]] else {
            throw ContainerSocketError.malformedHTTPResponse
        }

        var summaries: [BotFleetContainerSummary] = []
        for row in rows {
            let id = row["Id"] as? String ?? ""
            let state = row["State"] as? String ?? "unknown"
            let statusText = row["Status"] as? String ?? ""
            let labels = row["Labels"] as? [String: String] ?? [:]
            let rawNames = row["Names"] as? [String] ?? []
            let cleanName = rawNames
                .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
                .first(where: { Self.isVerifiedBotFleetContainerName($0) })

            if let name = cleanName {
                summaries.append(
                    BotFleetContainerSummary(
                        id: id,
                        name: name,
                        state: state,
                        status: statusText,
                        labels: labels
                    )
                )
            }
        }
        return summaries
    }

    /// Inspects a verified `botfleet-computer*` container (`GET /containers/{name}/json`).
    public func inspectContainer(idOrName: String) async throws -> BotFleetContainerDetail {
        let clean = idOrName.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard Self.isVerifiedBotFleetContainerName(clean) else {
            throw ContainerSocketError.unownedContainerRefused(name: idOrName)
        }

        let (status, body) = try await performHTTPRequest(method: "GET", path: "/containers/\(clean)/json")
        guard (200..<300).contains(status) else {
            throw ContainerSocketError.httpStatus(code: status, body: String(data: body, encoding: .utf8) ?? "")
        }
        guard let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
            throw ContainerSocketError.malformedHTTPResponse
        }

        let id = json["Id"] as? String ?? clean
        let rawName = (json["Name"] as? String ?? clean).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let stateDict = json["State"] as? [String: Any] ?? [:]
        let running = (stateDict["Running"] as? Bool) ?? false
        let statusText = (stateDict["Status"] as? String) ?? (running ? "running" : "exited")
        let configDict = json["Config"] as? [String: Any] ?? [:]
        let labels = configDict["Labels"] as? [String: String] ?? [:]
        let hostConfig = json["HostConfig"] as? [String: Any] ?? [:]
        let memoryLimit = (hostConfig["Memory"] as? NSNumber)?.int64Value

        return BotFleetContainerDetail(
            id: id,
            name: rawName,
            running: running,
            status: statusText,
            memoryLimitBytes: memoryLimit,
            labels: labels
        )
    }

    /// Starts a verified `botfleet-computer*` container (`POST /containers/{name}/start`).
    public func startContainer(idOrName: String) async throws {
        let clean = idOrName.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard Self.isVerifiedBotFleetContainerName(clean) else {
            throw ContainerSocketError.unownedContainerRefused(name: idOrName)
        }
        let (status, body) = try await performHTTPRequest(method: "POST", path: "/containers/\(clean)/start")
        // HTTP 204 (started) and HTTP 304 (already started) are both success
        guard status == 204 || status == 304 || (200..<300).contains(status) else {
            throw ContainerSocketError.httpStatus(code: status, body: String(data: body, encoding: .utf8) ?? "")
        }
    }

    /// Stops a verified `botfleet-computer*` container (`POST /containers/{name}/stop?t={timeoutSeconds}`),
    /// freeing the 1–2 GB container footprint when idle.
    public func stopContainer(idOrName: String, timeoutSeconds: Int = 10) async throws {
        let clean = idOrName.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard Self.isVerifiedBotFleetContainerName(clean) else {
            throw ContainerSocketError.unownedContainerRefused(name: idOrName)
        }
        let clampedTimeout = max(1, timeoutSeconds)
        let (status, body) = try await performHTTPRequest(
            method: "POST",
            path: "/containers/\(clean)/stop?t=\(clampedTimeout)"
        )
        // HTTP 204 (stopped) and HTTP 304 (already stopped) are both success
        guard status == 204 || status == 304 || (200..<300).contains(status) else {
            throw ContainerSocketError.httpStatus(code: status, body: String(data: body, encoding: .utf8) ?? "")
        }
    }

    // MARK: - POSIX `AF_UNIX` HTTP/1.1 Wire Implementation

    public func performHTTPRequest(
        method: String,
        path: String,
        body: Data? = nil
    ) async throws -> (statusCode: Int, body: Data) {
        // The request line is written straight onto the daemon socket, so a
        // method or path carrying CR, LF, or a space would let a caller split
        // the request and smuggle extra headers or a second request past the
        // container-name guard.  Validate both here rather than trusting every
        // caller to sanitize its own identifiers.
        guard Self.isValidHTTPMethod(method), Self.isValidHTTPPath(path) else {
            throw ContainerSocketError.malformedHTTPRequest
        }
        let sockPath = self.socketPath
        return try await Task.detached(priority: .userInitiated) {
            try Self.sendSynchronousUnixSocketHTTP(
                socketPath: sockPath,
                method: method,
                path: path,
                body: body
            )
        }.value
    }

    /// An HTTP method is a token: ASCII letters, digits, `-`, and `_` only.
    private static func isValidHTTPMethod(_ method: String) -> Bool {
        guard !method.isEmpty, method.utf8.count <= 32 else { return false }
        return method.utf8.allSatisfy { byte in
            (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || (byte >= 0x30 && byte <= 0x39)
                || byte == 0x2D
                || byte == 0x5F
        }
    }

    /// An HTTP request target is an absolute path with no space and no control
    /// characters, so it cannot terminate the request line or start a header.
    private static func isValidHTTPPath(_ path: String) -> Bool {
        guard path.hasPrefix("/"), path.utf8.count <= 2_048 else { return false }
        return path.utf8.allSatisfy { byte in
            byte > 0x20 && byte != 0x7F
        }
    }

    private static func sendSynchronousUnixSocketHTTP(
        socketPath: String,
        method: String,
        path: String,
        body: Data?
    ) throws -> (statusCode: Int, body: Data) {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = Array(socketPath.utf8CString)
        let maxSunPath = MemoryLayout.size(ofValue: addr.sun_path)
        guard !socketPath.isEmpty, pathBytes.count <= maxSunPath else {
            throw ContainerSocketError.invalidSocketPath(socketPath)
        }

        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw ContainerSocketError.connectionFailed(socketPath: socketPath, errnoCode: errno)
        }
        defer { Darwin.close(fd) }

        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))

        var tv = timeval(tv_sec: 10, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        withUnsafeMutablePointer(to: &addr.sun_path) { sunPathPtr in
            let rawPtr = UnsafeMutableRawPointer(sunPathPtr).assumingMemoryBound(to: CChar.self)
            for (index, byte) in pathBytes.enumerated() {
                rawPtr[index] = byte
            }
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)

        let connectResult = withUnsafePointer(to: &addr) { addrPtr in
            addrPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { saPtr in
                Darwin.connect(fd, saPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else {
            throw ContainerSocketError.connectionFailed(socketPath: socketPath, errnoCode: errno)
        }

        let contentLength = body?.count ?? 0
        var requestHeader = "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n"
        if contentLength > 0 {
            requestHeader += "Content-Type: application/json\r\nContent-Length: \(contentLength)\r\n"
        } else if method == "POST" {
            requestHeader += "Content-Length: 0\r\n"
        }
        requestHeader += "\r\n"

        var requestData = Data(requestHeader.utf8)
        if let body {
            requestData.append(body)
        }

        try requestData.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            var totalSent = 0
            while totalSent < rawBuffer.count {
                let sent = Darwin.write(fd, baseAddress.advanced(by: totalSent), rawBuffer.count - totalSent)
                if sent <= 0 {
                    throw ContainerSocketError.connectionFailed(socketPath: socketPath, errnoCode: errno)
                }
                totalSent += sent
            }
        }

        var responseData = Data()
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let bytesRead = Darwin.read(fd, &buffer, buffer.count)
            if bytesRead > 0 {
                responseData.append(buffer, count: bytesRead)
            } else {
                break
            }
        }

        return try parseHTTPResponse(responseData)
    }

    private static func parseHTTPResponse(_ raw: Data) throws -> (statusCode: Int, body: Data) {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerRange = raw.range(of: separator) else {
            throw ContainerSocketError.malformedHTTPResponse
        }
        let headerData = raw.subdata(in: 0..<headerRange.lowerBound)
        let bodyData = raw.subdata(in: headerRange.upperBound..<raw.count)

        guard let headerString = String(data: headerData, encoding: .utf8) else {
            throw ContainerSocketError.malformedHTTPResponse
        }
        let lines = headerString.components(separatedBy: "\r\n")
        guard let statusLine = lines.first else {
            throw ContainerSocketError.malformedHTTPResponse
        }
        let statusParts = statusLine.split(separator: " ")
        guard statusParts.count >= 2, let statusCode = Int(statusParts[1]) else {
            throw ContainerSocketError.malformedHTTPResponse
        }

        let isChunked = lines.dropFirst().contains { line in
            let lower = line.lowercased()
            return lower.hasPrefix("transfer-encoding:") && lower.contains("chunked")
        }

        if isChunked {
            return (statusCode, decodeChunkedBody(bodyData))
        }
        return (statusCode, bodyData)
    }

    private static func decodeChunkedBody(_ data: Data) -> Data {
        var result = Data()
        var cursor = data.startIndex
        let crlf = Data("\r\n".utf8)

        while cursor < data.endIndex {
            guard let lineEnd = data.range(of: crlf, in: cursor..<data.endIndex) else {
                break
            }
            let sizeSlice = data.subdata(in: cursor..<lineEnd.lowerBound)
            guard
                let sizeString = String(data: sizeSlice, encoding: .utf8)?
                    .split(separator: ";").first?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                let chunkSize = Int(sizeString, radix: 16)
            else {
                break
            }
            if chunkSize == 0 {
                break
            }
            let chunkStart = lineEnd.upperBound
            let chunkEnd = min(data.endIndex, chunkStart + chunkSize)
            result.append(data.subdata(in: chunkStart..<chunkEnd))
            cursor = min(data.endIndex, chunkEnd + crlf.count)
        }
        return result
    }
}
#endif
