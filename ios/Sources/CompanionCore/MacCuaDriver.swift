#if os(macOS)
import ApplicationServices
import CoreGraphics
import Foundation
import Security

/// Normalized or absolute coordinates for Computer Use Agent (CUA) interactions.
public struct CuaPoint: Sendable, Hashable, Codable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public var cgPoint: CGPoint {
        CGPoint(x: x, y: y)
    }
}

/// Mouse buttons supported by macOS CUA event synthesis.
public enum CuaMouseButton: String, Sendable, Hashable, Codable, CaseIterable {
    case left
    case right
    case center
}

public typealias MouseButton = CuaMouseButton

/// Coordinate space of incoming CUA pointer coordinates before conversion to Quartz global points.
public enum CoordinateInputSpace: String, Sendable, Hashable, Codable {
    case points
    case backingPixels
    case normalized0To1
}

/// Geometry and Retina backing-pixel scale metadata for a macOS display.
public struct DisplayGeometry: Equatable, Sendable, Hashable, Codable {
    public let displayID: CGDirectDisplayID
    public let framePoints: CGRect
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let scaleFactor: Double
    public let isMain: Bool

    public init(
        displayID: CGDirectDisplayID,
        framePoints: CGRect,
        pixelWidth: Int,
        pixelHeight: Int,
        scaleFactor: Double,
        isMain: Bool
    ) {
        self.displayID = displayID
        self.framePoints = framePoints
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.scaleFactor = scaleFactor
        self.isMain = isMain
    }
}

/// Converts a point in `.points`, `.backingPixels`, or `.normalized0To1` space on `display` into
/// Quartz global display points, accounting for Retina backing scale factors and non-zero secondary
/// display origins.
public func mapNormalizedOrPixelPointToGlobalPoints(
    x: Double,
    y: Double,
    in display: DisplayGeometry,
    inputSpace: CoordinateInputSpace
) -> CGPoint {
    let widthPoints = max(Double(display.framePoints.width), 0.0)
    let heightPoints = max(Double(display.framePoints.height), 0.0)

    let localPointsX: Double
    let localPointsY: Double

    switch inputSpace {
    case .points:
        localPointsX = min(max(x, 0.0), widthPoints)
        localPointsY = min(max(y, 0.0), heightPoints)

    case .backingPixels:
        let fallbackScale = max(display.scaleFactor, 1.0)
        let scaleX = (display.pixelWidth > 0 && widthPoints > 0)
            ? (Double(display.pixelWidth) / widthPoints)
            : fallbackScale
        let scaleY = (display.pixelHeight > 0 && heightPoints > 0)
            ? (Double(display.pixelHeight) / heightPoints)
            : fallbackScale
        localPointsX = min(max(x / scaleX, 0.0), widthPoints)
        localPointsY = min(max(y / scaleY, 0.0), heightPoints)

    case .normalized0To1:
        let clampedX = min(max(x, 0.0), 1.0)
        let clampedY = min(max(y, 0.0), 1.0)
        localPointsX = clampedX * widthPoints
        localPointsY = clampedY * heightPoints
    }

    return CGPoint(
        x: Double(display.framePoints.origin.x) + localPointsX,
        y: Double(display.framePoints.origin.y) + localPointsY
    )
}

/// Keyboard modifier flags for CUA key actions.
public struct CuaKeyModifier: OptionSet, Sendable, Hashable, Codable {
    public let rawValue: UInt64

    public init(rawValue: UInt64) {
        self.rawValue = rawValue
    }

    public static let command = CuaKeyModifier(rawValue: 1 << 0)
    public static let shift   = CuaKeyModifier(rawValue: 1 << 1)
    public static let option  = CuaKeyModifier(rawValue: 1 << 2)
    public static let control = CuaKeyModifier(rawValue: 1 << 3)
    public static let function = CuaKeyModifier(rawValue: 1 << 4)

    public var cgEventFlags: CGEventFlags {
        var flags: CGEventFlags = []
        if contains(.command) { flags.insert(.maskCommand) }
        if contains(.shift) { flags.insert(.maskShift) }
        if contains(.option) { flags.insert(.maskAlternate) }
        if contains(.control) { flags.insert(.maskControl) }
        if contains(.function) { flags.insert(.maskSecondaryFn) }
        return flags
    }
}

/// Information about a connected display.
public struct CuaDisplayInfo: Sendable, Hashable, Codable {
    public let id: UInt32
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public let scaleFactor: Double
    public let isPrimary: Bool

    public init(
        id: UInt32,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        scaleFactor: Double,
        isPrimary: Bool
    ) {
        self.id = id
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.scaleFactor = scaleFactor
        self.isPrimary = isPrimary
    }

    public var bounds: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }

    public var displayGeometry: DisplayGeometry {
        DisplayGeometry(
            displayID: id,
            framePoints: bounds,
            pixelWidth: Int((width * scaleFactor).rounded()),
            pixelHeight: Int((height * scaleFactor).rounded()),
            scaleFactor: scaleFactor,
            isMain: isPrimary
        )
    }
}

/// macOS system permissions required for local computer use.
public struct CuaPermissions: Sendable, Hashable, Codable {
    public let hasScreenRecording: Bool
    public let hasAccessibility: Bool

    public init(hasScreenRecording: Bool, hasAccessibility: Bool) {
        self.hasScreenRecording = hasScreenRecording
        self.hasAccessibility = hasAccessibility
    }

    public var isFullyAuthorized: Bool {
        hasScreenRecording && hasAccessibility
    }
}

/// Runtime TCC permission state observed by `CuaPermissionMonitor`.
public enum CuaPermissionState: Equatable, Sendable {
    case authorized
    case missingPermissions(missingScreenRecording: Bool, missingAccessibility: Bool)
    case revoked(missingScreenRecording: Bool, missingAccessibility: Bool, detectedAt: Date)

    public var isRevoked: Bool {
        if case .revoked = self { return true }
        return false
    }

    /// Product-copy banner text suitable for display when TCC permissions are missing or revoked.
    public var bannerMessage: String? {
        switch self {
        case .authorized:
            return nil
        case .missingPermissions(let missingScreen, let missingAX):
            if missingScreen && missingAX {
                return "Screen Recording and Accessibility permissions are required for desktop control."
            } else if missingScreen {
                return "Screen Recording permission is required for live capture."
            } else if missingAX {
                return "Accessibility permission is required for desktop control."
            }
            return nil
        case .revoked(let missingScreen, let missingAX, _):
            if missingScreen && missingAX {
                return "Screen Recording and Accessibility permissions were revoked.\u{00A0} Desktop control has been stopped."
            } else if missingScreen {
                return "Screen Recording permission was revoked.\u{00A0} Live capture and desktop control have been stopped."
            } else if missingAX {
                return "Accessibility permission was revoked.\u{00A0} Desktop control has been stopped."
            }
            return nil
        }
    }
}

/// The status copy the CUA inspector shows while desktop control is running.
public enum MacCuaStatus: Equatable, Sendable {
    case starting
    case liveDesktopShared
    case streamStopped
    case emergencyStopActivated
    case screenRecordingPermissionNeeded
    case liveCaptureUnavailable
    case noDisplayAvailable

    /// The product copy shown in the CUA inspector status bar.
    public var message: String {
        switch self {
        case .starting:
            return "Starting live capture…"
        case .liveDesktopShared:
            return "Live desktop shared"
        case .streamStopped:
            return "Stream stopped"
        case .emergencyStopActivated:
            return "Emergency stop activated — desktop control halted"
        case .screenRecordingPermissionNeeded:
            return "Screen recording permission needed"
        case .liveCaptureUnavailable:
            return "Live capture could not start"
        case .noDisplayAvailable:
            return "No display available to capture"
        }
    }
}

/// Holds the CUA inspector status copy.
///
/// The emergency-stop confirmation is sticky: the asynchronous "stream stopped"
/// update that lands right after an emergency stop must not overwrite the safety
/// message the operator just triggered, or the inspector would report a plain
/// stop instead of the latched safety stop.
public final class CuaStatusState: @unchecked Sendable {
    private let lock = NSLock()
    private var _current: MacCuaStatus?
    private var _emergencyLatched = false

    public init() {}

    /// The copy currently shown.
    public var current: MacCuaStatus? {
        lock.lock()
        defer { lock.unlock() }
        return _current
    }

    /// Records a status update and returns the copy that is now shown.
    @discardableResult
    public func record(_ status: MacCuaStatus) -> MacCuaStatus? {
        lock.lock()
        defer { lock.unlock() }
        if _emergencyLatched && status != .emergencyStopActivated {
            return _current
        }
        if status == .emergencyStopActivated {
            _emergencyLatched = true
        }
        _current = status
        return status
    }

    /// Clears the latched emergency stop, so a freshly started capture session
    /// can report its own status again.
    public func reset() {
        lock.lock()
        _emergencyLatched = false
        _current = nil
        lock.unlock()
    }
}

/// Native macOS CUA driver providing zero-overhead mouse and keyboard event synthesis
/// with an immediate emergency safety stop.
public final class MacCuaDriver: @unchecked Sendable {
    public static let shared = MacCuaDriver()

    private let stateLock = NSLock()
    private var _isEmergencyStopped: Bool = false
    private var _emergencyStopGeneration: UInt64 = 0
    private var _heldMouseButtons: Set<CuaMouseButton> = []
    private var _lastCursorPosition: CGPoint = .zero
    private var _lastEmergencyStopLatencyMs: Double = 0
    private var _lastEmergencyStopReleasedButtons: [CuaMouseButton] = []

    /// Optional observer invoked whenever a mouse event is synthesized (useful for deterministic test assertions).
    public var mouseEventObserver: (@Sendable (CGEventType, CGPoint, CuaMouseButton) -> Void)?

    /// Test seam invoked while the driver state lock is held, immediately before
    /// a mouse-down event is posted.
    ///
    /// It lets a test hold the lock while a concurrent emergency stop contends
    /// for it, which is the window in which a stopped button used to be left
    /// physically held.
    var mouseDownPrePostHook: (() -> Void)?

    /// Test seam invoked right after a synthesized mouse event reaches the window
    /// server, so a test can assert the real post order of the events.
    var mouseEventPostedHook: ((CGEventType, CuaMouseButton) -> Void)?

    /// Whether the process currently holds the Accessibility grant.
    ///
    /// Desktop control needs the Accessibility permission: without it the driver
    /// must not synthesize input, because the event would reach the operator's
    /// screen without the permission that authorizes it.  The live capture needs
    /// the independent Screen Recording grant, so a missing Accessibility grant
    /// no longer stops the capture.
    ///
    /// Injectable so a test can model a granted machine.
    public var accessibilityProvider: @Sendable () -> Bool = { AXIsProcessTrusted() }

    public init() {}

    // MARK: - Emergency Stop State

    /// Whether the emergency safety stop is currently latched.
    public var isEmergencyStopped: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _isEmergencyStopped
    }

    /// Monotonically increasing generation counter incremented on every `emergencyStop()`.
    public var emergencyStopGeneration: UInt64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _emergencyStopGeneration
    }

    /// Mouse buttons currently held down by synthesized CUA actions.
    public var heldMouseButtons: Set<CuaMouseButton> {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _heldMouseButtons
    }

    /// Duration in milliseconds required to execute the most recent `emergencyStop()`.
    public var lastEmergencyStopLatencyMs: Double {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _lastEmergencyStopLatencyMs
    }

    /// Mouse buttons that were forcibly released during the most recent `emergencyStop()`.
    public var lastEmergencyStopReleasedButtons: [CuaMouseButton] {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _lastEmergencyStopReleasedButtons
    }

    /// Immediately aborts any in-flight `drag` or `typeText` loop (`< 100 ms`) and posts `mouseUp`
    /// events for every currently held mouse button so a mid-drag stop never leaves a button stuck down.
    @discardableResult
    public func emergencyStop() -> [CuaMouseButton] {
        let startNs = DispatchTime.now().uptimeNanoseconds

        let buttonsToRelease: [CuaMouseButton]
        let releasePoint: CGPoint
        let observer: (@Sendable (CGEventType, CGPoint, CuaMouseButton) -> Void)?

        stateLock.lock()
        _isEmergencyStopped = true
        _emergencyStopGeneration &+= 1
        let heldSnapshot = _heldMouseButtons
        _heldMouseButtons.removeAll()
        releasePoint = _lastCursorPosition
        observer = mouseEventObserver
        buttonsToRelease = CuaMouseButton.allCases.filter { heldSnapshot.contains($0) }
        stateLock.unlock()

        for button in buttonsToRelease {
            let (upType, cgButton) = Self.mouseUpEventSpec(for: button)
            if let upEvent = CGEvent(
                mouseEventSource: nil,
                mouseType: upType,
                mouseCursorPosition: releasePoint,
                mouseButton: cgButton
            ) {
                upEvent.post(tap: .cghidEventTap)
                mouseEventPostedHook?(upType, button)
            }
            observer?(upType, releasePoint, button)
        }

        let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - startNs) / 1_000_000.0
        stateLock.lock()
        _lastEmergencyStopLatencyMs = elapsedMs
        _lastEmergencyStopReleasedButtons = buttonsToRelease
        stateLock.unlock()

        return buttonsToRelease
    }

    /// Re-arms the CUA driver before the next explicit user-authorized action.
    public func resetEmergencyStop() {
        stateLock.lock()
        _isEmergencyStopped = false
        stateLock.unlock()
    }

    // MARK: - Permissions

    /// Checks the current Screen Recording and Accessibility permission state.
    public func checkPermissions() -> CuaPermissions {
        let screenRecording = CGPreflightScreenCaptureAccess()
        let accessibility = AXIsProcessTrusted()
        return CuaPermissions(hasScreenRecording: screenRecording, hasAccessibility: accessibility)
    }

    /// Requests Screen Recording permission from the system prompt if not granted.
    public func requestScreenRecordingPermission() -> Bool {
        if CGPreflightScreenCaptureAccess() {
            return true
        }
        return CGRequestScreenCaptureAccess()
    }

    /// Requests Accessibility permission, optionally presenting the macOS system dialog.
    public func requestAccessibilityPermission(promptIfNeeded: Bool = true) -> Bool {
        if AXIsProcessTrusted() {
            return true
        }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: promptIfNeeded] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    // MARK: - Displays & Geometry

    /// Enumerates all active displays connected to the Mac.
    public func activeDisplays() -> [CuaDisplayInfo] {
        var displayCount: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
            return []
        }

        var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        guard CGGetActiveDisplayList(displayCount, &displays, &displayCount) == .success else {
            return []
        }

        let primaryID = CGMainDisplayID()
        return displays.prefix(Int(displayCount)).map { displayID in
            let bounds = CGDisplayBounds(displayID)
            let mode = CGDisplayCopyDisplayMode(displayID)
            let pixelWidth = mode?.pixelWidth ?? Int(bounds.width)
            let scaleFactor = bounds.width > 0 ? Double(pixelWidth) / bounds.width : 1.0

            return CuaDisplayInfo(
                id: displayID,
                x: bounds.origin.x,
                y: bounds.origin.y,
                width: bounds.width,
                height: bounds.height,
                scaleFactor: scaleFactor,
                isPrimary: displayID == primaryID
            )
        }
    }

    /// Enumerates active displays with full `DisplayGeometry` metadata for coordinate scaling.
    public func activeDisplayGeometries() -> [DisplayGeometry] {
        var displayCount: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
            return []
        }

        var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        guard CGGetActiveDisplayList(displayCount, &displays, &displayCount) == .success else {
            return []
        }

        let primaryID = CGMainDisplayID()
        return displays.prefix(Int(displayCount)).map { displayID in
            let bounds = CGDisplayBounds(displayID)
            let mode = CGDisplayCopyDisplayMode(displayID)
            let pixelWidth = mode?.pixelWidth ?? Int(bounds.width)
            let pixelHeight = mode?.pixelHeight ?? Int(bounds.height)
            let scaleFactor = bounds.width > 0 ? Double(pixelWidth) / bounds.width : 1.0

            return DisplayGeometry(
                displayID: displayID,
                framePoints: bounds,
                pixelWidth: pixelWidth,
                pixelHeight: pixelHeight,
                scaleFactor: scaleFactor,
                isMain: displayID == primaryID
            )
        }
    }

    /// Converts normalized, backing-pixel, or point coordinates on `display` into Quartz global points.
    public func mapNormalizedOrPixelPointToGlobalPoints(
        x: Double,
        y: Double,
        in display: DisplayGeometry,
        inputSpace: CoordinateInputSpace
    ) -> CGPoint {
        CompanionCore.mapNormalizedOrPixelPointToGlobalPoints(
            x: x,
            y: y,
            in: display,
            inputSpace: inputSpace
        )
    }

    public static func mapNormalizedOrPixelPointToGlobalPoints(
        x: Double,
        y: Double,
        in display: DisplayGeometry,
        inputSpace: CoordinateInputSpace
    ) -> CGPoint {
        CompanionCore.mapNormalizedOrPixelPointToGlobalPoints(
            x: x,
            y: y,
            in: display,
            inputSpace: inputSpace
        )
    }

    /// Translates a normalized point (0.0...1.0) on a given display to global screen coordinates.
    public func screenCoordinates(for normalizedPoint: CuaPoint, displayID: UInt32? = nil) -> CGPoint {
        let targetDisplay = displayID ?? CGMainDisplayID()
        let bounds = CGDisplayBounds(targetDisplay)

        let clampedX = min(max(normalizedPoint.x, 0.0), 1.0)
        let clampedY = min(max(normalizedPoint.y, 0.0), 1.0)

        let targetX = bounds.origin.x + (clampedX * bounds.width)
        let targetY = bounds.origin.y + (clampedY * bounds.height)

        return CGPoint(x: targetX, y: targetY)
    }

    // MARK: - Mouse Event Synthesis

    /// Moves the cursor to the target point in global screen coordinates.
    @discardableResult
    public func moveMouse(to point: CGPoint) -> Bool {
        guard canProceedWithAction(updatingCursorTo: point) else { return false }
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            return false
        }
        event.post(tap: .cghidEventTap)
        mouseEventObserver?(.mouseMoved, point, .left)
        return true
    }

    /// Presses and holds a mouse button at `point`, recording the held button so `emergencyStop()`
    /// can release it if interrupted before `mouseUp(at:button:)`.
    @discardableResult
    public func mouseDown(at point: CGPoint, button: CuaMouseButton = .left, clickCount: Int = 1) -> Bool {
        let (downType, _, mouseButton) = Self.mouseEventTypes(for: button)
        guard let downEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: downType,
            mouseCursorPosition: point,
            mouseButton: mouseButton
        ) else {
            return false
        }
        downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))

        guard desktopControlIsAuthorized() else { return false }
        stateLock.lock()
        if _isEmergencyStopped {
            stateLock.unlock()
            return false
        }
        _lastCursorPosition = point
        _heldMouseButtons.insert(button)
        let observer = mouseEventObserver
        let prePostHook = mouseDownPrePostHook
        prePostHook?()
        // The down event is posted while the state lock is still held, so an
        // emergency stop cannot slip in between the bookkeeping above and the
        // post.  Otherwise the stop would release the button first and the
        // later down event would leave it physically held, with no record left
        // to release it.
        downEvent.post(tap: .cghidEventTap)
        mouseEventPostedHook?(downType, button)
        stateLock.unlock()

        observer?(downType, point, button)
        return true
    }

    /// Releases a previously held mouse button at `point`.
    @discardableResult
    public func mouseUp(at point: CGPoint, button: CuaMouseButton = .left, clickCount: Int = 1) -> Bool {
        let (_, upType, mouseButton) = Self.mouseEventTypes(for: button)
        guard let upEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: upType,
            mouseCursorPosition: point,
            mouseButton: mouseButton
        ) else {
            return false
        }
        upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))

        stateLock.lock()
        _lastCursorPosition = point
        _heldMouseButtons.remove(button)
        let observer = mouseEventObserver
        stateLock.unlock()

        upEvent.post(tap: .cghidEventTap)
        mouseEventPostedHook?(upType, button)
        observer?(upType, point, button)
        return true
    }

    /// Performs a mouse click at the given point.
    @discardableResult
    public func click(
        at point: CGPoint,
        button: CuaMouseButton = .left,
        clickCount: Int = 1
    ) -> Bool {
        guard mouseDown(at: point, button: button, clickCount: clickCount) else {
            return false
        }
        guard !isEmergencyStopped else {
            return false
        }
        return mouseUp(at: point, button: button, clickCount: clickCount)
    }

    /// Performs a mouse drag from start point to end point with smooth interpolation.
    /// If `emergencyStop()` is triggered mid-drag, the loop aborts immediately and `emergencyStop()`
    /// emits the corresponding `mouseUp` event so the button is never left held down.
    @discardableResult
    public func drag(
        from start: CGPoint,
        to end: CGPoint,
        button: CuaMouseButton = .left,
        steps: Int = 10,
        stepDelayMs: Double = 0,
        onStep: ((Int, CGPoint) -> Void)? = nil
    ) -> Bool {
        let (_, draggedType, _) = Self.mouseEventTypes(for: button)
        let (_, mouseButton) = Self.mouseUpEventSpec(for: button)

        stateLock.lock()
        if _isEmergencyStopped {
            stateLock.unlock()
            return false
        }
        let startGeneration = _emergencyStopGeneration
        stateLock.unlock()

        guard mouseDown(at: start, button: button, clickCount: 1) else {
            return false
        }

        let safeSteps = max(steps, 1)
        for i in 1...safeSteps {
            if !isGenerationActive(startGeneration) {
                return false
            }
            // The grant can be taken away mid-drag, so every step re-checks it
            // instead of relying on the check that opened the drag.
            guard desktopControlIsAuthorized() else { return false }

            if stepDelayMs > 0 {
                if !sleepInterruptibly(milliseconds: stepDelayMs, generation: startGeneration) {
                    return false
                }
            }

            if !isGenerationActive(startGeneration) {
                return false
            }

            let progress = Double(i) / Double(safeSteps)
            let currentX = start.x + (end.x - start.x) * progress
            let currentY = start.y + (end.y - start.y) * progress
            let currentPoint = CGPoint(x: currentX, y: currentY)

            stateLock.lock()
            if _isEmergencyStopped || _emergencyStopGeneration != startGeneration {
                stateLock.unlock()
                return false
            }
            _lastCursorPosition = currentPoint
            let observer = mouseEventObserver
            stateLock.unlock()

            if let dragEvent = CGEvent(
                mouseEventSource: nil,
                mouseType: draggedType,
                mouseCursorPosition: currentPoint,
                mouseButton: mouseButton
            ) {
                dragEvent.post(tap: .cghidEventTap)
                observer?(draggedType, currentPoint, button)
            }
            onStep?(i, currentPoint)
        }

        guard isGenerationActive(startGeneration) else {
            return false
        }

        return mouseUp(at: end, button: button, clickCount: 1)
    }

    /// Synthesizes a scroll wheel event with pixel-accurate deltas.
    @discardableResult
    public func scroll(deltaX: Int32, deltaY: Int32) -> Bool {
        guard desktopControlIsAuthorized() else { return false }
        guard !isEmergencyStopped else { return false }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: deltaY,
            wheel2: deltaX,
            wheel3: 0
        ) else {
            return false
        }
        event.post(tap: .cghidEventTap)
        return true
    }

    // MARK: - Keyboard Event Synthesis

    /// Synthesizes a key down and key up event for a specific key code.
    @discardableResult
    public func keyPress(
        keyCode: CGKeyCode,
        modifiers: CuaKeyModifier = []
    ) -> Bool {
        guard desktopControlIsAuthorized() else { return false }
        guard !isEmergencyStopped else { return false }
        guard let downEvent = CGEvent(
            keyboardEventSource: nil,
            virtualKey: keyCode,
            keyDown: true
        ) else {
            return false
        }

        guard let upEvent = CGEvent(
            keyboardEventSource: nil,
            virtualKey: keyCode,
            keyDown: false
        ) else {
            return false
        }

        if !modifiers.isEmpty {
            downEvent.flags = modifiers.cgEventFlags
            upEvent.flags = modifiers.cgEventFlags
        }

        downEvent.post(tap: .cghidEventTap)
        upEvent.post(tap: .cghidEventTap)
        return true
    }

    /// Types an arbitrary UTF-8 string by emitting Unicode keyboard events, aborting immediately
    /// if `emergencyStop()` is triggered mid-sequence.
    @discardableResult
    public func typeText(_ text: String, characterDelayMs: Double = 0) -> Bool {
        guard desktopControlIsAuthorized() else { return false }
        stateLock.lock()
        if _isEmergencyStopped {
            stateLock.unlock()
            return false
        }
        let startGeneration = _emergencyStopGeneration
        stateLock.unlock()

        guard !text.isEmpty else { return true }

        // Iterate Characters, not UTF-16 code units: a non-BMP scalar (emoji,
        // extended scripts) is a surrogate pair and both halves must ride in a
        // single CGEvent or the character is corrupted.
        for character in text {
            guard isGenerationActive(startGeneration) else {
                return false
            }
            if characterDelayMs > 0 {
                guard sleepInterruptibly(milliseconds: characterDelayMs, generation: startGeneration) else {
                    return false
                }
            }

            var utf16Units = Array(character.utf16)
            guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
                return false
            }
            guard let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                return false
            }

            downEvent.keyboardSetUnicodeString(stringLength: utf16Units.count, unicodeString: &utf16Units)
            upEvent.keyboardSetUnicodeString(stringLength: utf16Units.count, unicodeString: &utf16Units)

            downEvent.post(tap: .cghidEventTap)
            upEvent.post(tap: .cghidEventTap)
        }
        return true
    }

    // MARK: - Internal Helpers

    private func canProceedWithAction(updatingCursorTo point: CGPoint) -> Bool {
        guard desktopControlIsAuthorized() else { return false }
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !_isEmergencyStopped else { return false }
        _lastCursorPosition = point
        return true
    }

    /// Whether a desktop-control action is allowed to run.
    ///
    /// A mouse release is never gated: a button that was pressed has to be
    /// releasable even when the grant was taken away in the meantime.
    private func desktopControlIsAuthorized() -> Bool {
        accessibilityProvider()
    }

    private func isGenerationActive(_ expectedGeneration: UInt64) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return !_isEmergencyStopped && _emergencyStopGeneration == expectedGeneration
    }

    private func sleepInterruptibly(milliseconds: Double, generation: UInt64) -> Bool {
        let deadlineNs = DispatchTime.now().uptimeNanoseconds + UInt64(max(milliseconds, 0) * 1_000_000.0)
        while DispatchTime.now().uptimeNanoseconds < deadlineNs {
            if !isGenerationActive(generation) {
                return false
            }
            let remainingNs = deadlineNs - DispatchTime.now().uptimeNanoseconds
            let sliceUs = useconds_t(min(max(remainingNs / 1_000, 200), 1_000))
            usleep(sliceUs)
        }
        return isGenerationActive(generation)
    }

    private static func mouseEventTypes(for button: CuaMouseButton) -> (CGEventType, CGEventType, CGMouseButton) {
        switch button {
        case .left:
            return (.leftMouseDown, .leftMouseUp, .left)
        case .right:
            return (.rightMouseDown, .rightMouseUp, .right)
        case .center:
            return (.otherMouseDown, .otherMouseUp, .center)
        }
    }

    private static func mouseUpEventSpec(for button: CuaMouseButton) -> (CGEventType, CGMouseButton) {
        switch button {
        case .left:
            return (.leftMouseUp, .left)
        case .right:
            return (.rightMouseUp, .right)
        case .center:
            return (.otherMouseUp, .center)
        }
    }
}

// MARK: - TCC Permission Monitor

/// Monitors Screen Recording and Accessibility TCC grants during an active CUA session or stream.
///
/// Polls every `0.5s` by default (detecting revocation well inside the `< 2 seconds` budget) and
/// accepts immediate stream error callbacks from `ScreenStreamActor` (`SCStreamDelegate.stream(_:didStopWithError:)`).
/// When revocation occurs, `CuaPermissionMonitor` triggers `driver.emergencyStop()` and invokes `onRevocation`
/// so the UI transitions cleanly instead of rendering black frames or freezing silently.
public final class CuaPermissionMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private let driver: MacCuaDriver
    private let permissionChecker: @Sendable () -> CuaPermissions
    private let pollInterval: TimeInterval
    private var timerSource: DispatchSourceTimer?
    private let monitorQueue = DispatchQueue(label: "app.botfleet.cua-permission-monitor", qos: .userInitiated)

    private var _state: CuaPermissionState = .authorized
    private var _isMonitoring: Bool = false
    /// Whether a Screen Recording grant was ever observed during this session.
    ///
    /// A grant that was never given is "missing", not "revoked": only a grant
    /// that was observed can later be revoked.
    private var _screenRecordingWasAuthorized: Bool = false
    /// Whether an Accessibility grant was ever observed during this session.
    private var _accessibilityWasAuthorized: Bool = false
    public var onRevocation: (@Sendable (CuaPermissionState) -> Void)?

    public init(
        driver: MacCuaDriver = .shared,
        pollInterval: TimeInterval = 0.5,
        permissionChecker: (@Sendable () -> CuaPermissions)? = nil,
        onRevocation: (@Sendable (CuaPermissionState) -> Void)? = nil
    ) {
        self.driver = driver
        self.pollInterval = max(pollInterval, 0.02)
        self.permissionChecker = permissionChecker ?? { driver.checkPermissions() }
        self.onRevocation = onRevocation
    }

    deinit {
        stopMonitoring()
    }

    public var state: CuaPermissionState {
        lock.lock()
        defer { lock.unlock() }
        return _state
    }

    public var isMonitoring: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isMonitoring
    }

    /// Evaluates current permissions before starting a CUA stream or session.
    ///
    /// This establishes the baseline for the session: a permission that is not
    /// granted yet is recorded as missing, and only a grant that was observed
    /// can later be reported as revoked.
    @discardableResult
    public func evaluateInitialPermissions() -> CuaPermissionState {
        let perms = permissionChecker()
        let nextState: CuaPermissionState
        if perms.isFullyAuthorized {
            nextState = .authorized
        } else {
            nextState = .missingPermissions(
                missingScreenRecording: !perms.hasScreenRecording,
                missingAccessibility: !perms.hasAccessibility
            )
        }
        lock.lock()
        _state = nextState
        _screenRecordingWasAuthorized = perms.hasScreenRecording
        _accessibilityWasAuthorized = perms.hasAccessibility
        lock.unlock()
        return nextState
    }

    /// Starts periodic `0.5s` TCC polling while a CUA stream or session is active.
    public func startMonitoring(onRevocation: (@Sendable (CuaPermissionState) -> Void)? = nil) {
        stopMonitoring()

        lock.lock()
        if let onRevocation {
            self.onRevocation = onRevocation
        }
        _isMonitoring = true
        lock.unlock()

        // The baseline has to be established before the first poll, otherwise a
        // permission that was never granted looks exactly like a revoked one.
        _ = evaluateInitialPermissions()

        let timer = DispatchSource.makeTimerSource(queue: monitorQueue)
        timer.schedule(
            deadline: .now() + pollInterval,
            repeating: pollInterval,
            leeway: .milliseconds(25)
        )
        timer.setEventHandler { [weak self] in
            self?.pollOnce()
        }
        lock.lock()
        self.timerSource = timer
        lock.unlock()
        timer.resume()
    }

    /// Stops periodic TCC polling.
    public func stopMonitoring() {
        lock.lock()
        let timer = timerSource
        timerSource = nil
        _isMonitoring = false
        lock.unlock()
        timer?.cancel()
    }

    /// Performs an immediate permission check and transitions to `.revoked` if a
    /// TCC grant that was observed during this session was lost.
    ///
    /// A permission that was never granted stays `.missingPermissions`: the live
    /// capture keeps running and the driver is not latched into an emergency
    /// stop, because nothing was taken away from the operator.
    @discardableResult
    public func pollOnce() -> CuaPermissionState {
        let perms = permissionChecker()
        lock.lock()
        // A permission observed as granted joins the baseline, so a later
        // revocation is detected even when the grant happened mid-session.
        _screenRecordingWasAuthorized = _screenRecordingWasAuthorized || perms.hasScreenRecording
        _accessibilityWasAuthorized = _accessibilityWasAuthorized || perms.hasAccessibility
        let screenRevoked = _screenRecordingWasAuthorized && !perms.hasScreenRecording
        let accessibilityRevoked = _accessibilityWasAuthorized && !perms.hasAccessibility
        lock.unlock()

        if perms.isFullyAuthorized {
            lock.lock()
            if case .missingPermissions = _state {
                _state = .authorized
            }
            let current = _state
            lock.unlock()
            return current
        }

        if screenRevoked || accessibilityRevoked {
            return transitionToRevoked(
                missingScreenRecording: screenRevoked,
                missingAccessibility: accessibilityRevoked
            )
        }

        // A grant that was never given is "missing", not "revoked": keep the
        // capture running and only refresh which permissions are outstanding.
        lock.lock()
        if case .missingPermissions = _state {
            _state = .missingPermissions(
                missingScreenRecording: !perms.hasScreenRecording,
                missingAccessibility: !perms.hasAccessibility
            )
        }
        let current = _state
        lock.unlock()
        return current
    }

    /// Handles an immediate stream failure reported by `ScreenStreamActor.stream(_:didStopWithError:)`.
    ///
    /// Only an explicitly recognized Screen Recording denial counts as a
    /// revocation.  A benign capture failure (a display reconfigure, a
    /// transient `SCStream` error) stops the stream and latches the driver, but
    /// it is never reported to the operator as a lost permission.
    @discardableResult
    public func notifyStreamStoppedWithError(_ error: Error) -> CuaPermissionState {
        let perms = permissionChecker()
        let screenCaptureRevoked = isLikelyScreenCaptureRevocation(error)
        lock.lock()
        _screenRecordingWasAuthorized = _screenRecordingWasAuthorized || perms.hasScreenRecording
        _accessibilityWasAuthorized = _accessibilityWasAuthorized || perms.hasAccessibility
        let screenRevoked = screenCaptureRevoked
            || (_screenRecordingWasAuthorized && !perms.hasScreenRecording)
        let accessibilityRevoked = _accessibilityWasAuthorized && !perms.hasAccessibility
        lock.unlock()

        if screenRevoked || accessibilityRevoked {
            return transitionToRevoked(
                missingScreenRecording: screenRevoked,
                missingAccessibility: accessibilityRevoked
            )
        }

        // A benign capture failure is not a TCC revocation.  The driver is still
        // latched and the stream still stops, but the permission state stays
        // what it was, so no revocation banner is shown.
        stopMonitoring()
        driver.emergencyStop()
        if #available(macOS 14.0, *) {
            Task {
                await ScreenStreamActor.shared.stopStreaming()
            }
        }
        return state
    }

    private func transitionToRevoked(
        missingScreenRecording: Bool,
        missingAccessibility: Bool
    ) -> CuaPermissionState {
        let revokedState = CuaPermissionState.revoked(
            missingScreenRecording: missingScreenRecording,
            missingAccessibility: missingAccessibility,
            detectedAt: Date()
        )

        let callback: (@Sendable (CuaPermissionState) -> Void)?
        lock.lock()
        if case .revoked = _state {
            stateUnlockAndReturn()
            return _state
        }
        _state = revokedState
        callback = onRevocation
        let timer = timerSource
        timerSource = nil
        _isMonitoring = false
        lock.unlock()

        timer?.cancel()
        driver.emergencyStop()
        if #available(macOS 14.0, *) {
            Task {
                await ScreenStreamActor.shared.stopStreaming()
            }
        }
        callback?(revokedState)
        return revokedState
    }

    private func stateUnlockAndReturn() {
        lock.unlock()
    }

    private func isLikelyScreenCaptureRevocation(_ error: Error) -> Bool {
        if #available(macOS 14.0, *), let streamErr = error as? ScreenStreamError {
            if case .notAuthorized = streamErr { return true }
        }
        let nsError = error as NSError
        let lower = (nsError.domain + " " + nsError.localizedDescription).lowercased()
        if lower.contains("tcc") || lower.contains("declined") || lower.contains("permission") || lower.contains("not authorized") {
            return true
        }
        // SCStreamErrorDomain -3801 (user declined TCC) or -3817 / -3818 (stream stopped by system).
        if nsError.domain.contains("SCStream") || [-3801, -3817, -3818].contains(nsError.code) {
            return true
        }
        // Anything else is a benign capture failure: a display reconfigure or a
        // transient stream error must not be reported as a lost permission.
        return false
    }
}

// MARK: - Stable Developer ID Signing Verifier

/// Report describing whether the running or target macOS bundle has a stable Developer ID / Team ID
/// code signature so macOS TCC grants (Screen Recording + Accessibility) survive rebuilds.
public struct SigningIdentityReport: Equatable, Sendable {
    public let bundleIdentifier: String?
    public let teamIdentifier: String?
    public let isAdHocSigned: Bool
    public let hasStableTCCIdentity: Bool
    public let diagnosticMessage: String

    public init(
        bundleIdentifier: String?,
        teamIdentifier: String?,
        isAdHocSigned: Bool,
        hasStableTCCIdentity: Bool,
        diagnosticMessage: String
    ) {
        self.bundleIdentifier = bundleIdentifier
        self.teamIdentifier = teamIdentifier
        self.isAdHocSigned = isAdHocSigned
        self.hasStableTCCIdentity = hasStableTCCIdentity
        self.diagnosticMessage = diagnosticMessage
    }
}

/// Inspects code-signing metadata to verify that `BotFleetMac` is signed with the expected
/// `DEVELOPMENT_TEAM` (`CC8UTF7ATG`) and bundle identifier (`app.botfleet.macos`) rather than an
/// ad-hoc signature whose CDHash changes on every build (which causes TCC to forget permissions).
public struct SigningIdentityVerifier: Sendable {
    public static let expectedTeamID = "CC8UTF7ATG"
    public static let expectedBundleID = "app.botfleet.macos"

    public init() {}

    /// Evaluates raw code-signing attributes extracted from `SecCodeCopySigningInformation` or a bundle fixture.
    public static func evaluate(
        bundleIdentifier: String?,
        teamIdentifier: String?,
        signingFlags: UInt32 = 0
    ) -> SigningIdentityReport {
        // kSecCodeSignatureAdhoc == 0x0002
        let isAdHoc = (signingFlags & 0x0002) != 0 || (teamIdentifier ?? "").isEmpty
        let matchesBundle = bundleIdentifier == expectedBundleID
        let matchesTeam = teamIdentifier == expectedTeamID
        let stable = matchesBundle && matchesTeam && !isAdHoc

        let message: String
        if stable {
            message = "Signed with stable team \(expectedTeamID) (\(expectedBundleID)); TCC grants will persist across rebuilds."
        } else if isAdHoc {
            message = "Ad-hoc signature detected (missing team \(expectedTeamID)); macOS TCC grants will reset after rebuilds."
        } else if !matchesBundle {
            message = "Bundle identifier '\(bundleIdentifier ?? "nil")' does not match '\(expectedBundleID)'."
        } else {
            message = "Team identifier '\(teamIdentifier ?? "nil")' does not match expected team '\(expectedTeamID)'."
        }

        return SigningIdentityReport(
            bundleIdentifier: bundleIdentifier,
            teamIdentifier: teamIdentifier,
            isAdHocSigned: isAdHoc,
            hasStableTCCIdentity: stable,
            diagnosticMessage: message
        )
    }

    /// Inspects the code signature of the bundle at `bundleURL` (or the current process when `nil`).
    public static func verify(bundleURL: URL? = nil) -> SigningIdentityReport {
        var staticCode: SecStaticCode?
        let status: OSStatus

        if let bundleURL {
            status = SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &staticCode)
        } else {
            var selfCode: SecCode?
            let selfStatus = SecCodeCopySelf(SecCSFlags(), &selfCode)
            if selfStatus == errSecSuccess, let selfCode {
                status = SecCodeCopyStaticCode(selfCode, SecCSFlags(), &staticCode)
            } else {
                status = selfStatus
            }
        }

        guard status == errSecSuccess, let code = staticCode else {
            return evaluate(bundleIdentifier: Bundle.main.bundleIdentifier, teamIdentifier: nil, signingFlags: 0x0002)
        }

        var infoCF: CFDictionary?
        let copyFlags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(code, copyFlags, &infoCF) == errSecSuccess,
              let info = infoCF as? [String: Any] else {
            return evaluate(bundleIdentifier: Bundle.main.bundleIdentifier, teamIdentifier: nil, signingFlags: 0x0002)
        }

        let identifier = info[kSecCodeInfoIdentifier as String] as? String
        let teamID = info[kSecCodeInfoTeamIdentifier as String] as? String
        let flags = (info[kSecCodeInfoFlags as String] as? UInt32) ?? 0

        return evaluate(bundleIdentifier: identifier, teamIdentifier: teamID, signingFlags: flags)
    }
}
#endif
