#if os(macOS)
import ApplicationServices
import CoreGraphics
import Foundation

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
public enum CuaMouseButton: String, Sendable, Hashable, Codable {
    case left
    case right
    case center
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

/// Native macOS CUA driver providing zero-overhead mouse and keyboard event synthesis.
public final class MacCuaDriver: @unchecked Sendable {
    /// Posts one event to the live desktop.
    ///
    /// A test runner never posts.  The suite used to post real mouse and
    /// keyboard events to the live desktop, which took the person's mouse
    /// over while they worked.  The shipping app is an application bundle,
    /// never a test runner, so the product capability is unchanged.
    private static func postToDesktop(_ event: CGEvent) {
        guard !Self.isRunningUnderATestRunner else { return }
        event.post(tap: .cghidEventTap)
    }

    /// True when this process is a test runner rather than the app.
    ///
    /// The SwiftPM testing helper is the process that runs the suite, and an
    /// XCTest run is an XCTest bundle.
    private static var isRunningUnderATestRunner: Bool {
        if ProcessInfo.processInfo.processName == "swiftpm-testing-helper" { return true }
        if Bundle.main.bundleURL.pathExtension == "xctest" { return true }
        return NSClassFromString("XCTest") != nil
    }

    public static let shared = MacCuaDriver()

    public init() {}

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
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            return false
        }
        Self.postToDesktop(event)
        return true
    }

    /// Performs a mouse click at the given point.
    @discardableResult
    public func click(
        at point: CGPoint,
        button: CuaMouseButton = .left,
        clickCount: Int = 1
    ) -> Bool {
        let downType: CGEventType
        let upType: CGEventType
        let mouseButton: CGMouseButton

        switch button {
        case .left:
            downType = .leftMouseDown
            upType = .leftMouseUp
            mouseButton = .left
        case .right:
            downType = .rightMouseDown
            upType = .rightMouseUp
            mouseButton = .right
        case .center:
            downType = .otherMouseDown
            upType = .otherMouseUp
            mouseButton = .center
        }

        guard let downEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: downType,
            mouseCursorPosition: point,
            mouseButton: mouseButton
        ) else {
            return false
        }

        guard let upEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: upType,
            mouseCursorPosition: point,
            mouseButton: mouseButton
        ) else {
            return false
        }

        downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))

        Self.postToDesktop(downEvent)
        Self.postToDesktop(upEvent)
        return true
    }

    /// Performs a mouse drag from start point to end point with smooth interpolation.
    @discardableResult
    public func drag(
        from start: CGPoint,
        to end: CGPoint,
        button: CuaMouseButton = .left,
        steps: Int = 10
    ) -> Bool {
        let downType: CGEventType
        let draggedType: CGEventType
        let upType: CGEventType
        let mouseButton: CGMouseButton

        switch button {
        case .left:
            downType = .leftMouseDown
            draggedType = .leftMouseDragged
            upType = .leftMouseUp
            mouseButton = .left
        case .right:
            downType = .rightMouseDown
            draggedType = .rightMouseDragged
            upType = .rightMouseUp
            mouseButton = .right
        case .center:
            downType = .otherMouseDown
            draggedType = .otherMouseDragged
            upType = .otherMouseUp
            mouseButton = .center
        }

        guard let downEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: downType,
            mouseCursorPosition: start,
            mouseButton: mouseButton
        ) else {
            return false
        }
        Self.postToDesktop(downEvent)

        let safeSteps = max(steps, 1)
        for i in 1...safeSteps {
            let progress = Double(i) / Double(safeSteps)
            let currentX = start.x + (end.x - start.x) * progress
            let currentY = start.y + (end.y - start.y) * progress
            let currentPoint = CGPoint(x: currentX, y: currentY)

            if let dragEvent = CGEvent(
                mouseEventSource: nil,
                mouseType: draggedType,
                mouseCursorPosition: currentPoint,
                mouseButton: mouseButton
            ) {
                Self.postToDesktop(dragEvent)
            }
        }

        guard let upEvent = CGEvent(
            mouseEventSource: nil,
            mouseType: upType,
            mouseCursorPosition: end,
            mouseButton: mouseButton
        ) else {
            return false
        }
        Self.postToDesktop(upEvent)
        return true
    }

    /// Synthesizes a scroll wheel event with pixel-accurate deltas.
    @discardableResult
    public func scroll(deltaX: Int32, deltaY: Int32) -> Bool {
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
        Self.postToDesktop(event)
        return true
    }

    // MARK: - Keyboard Event Synthesis

    /// Synthesizes a key down and key up event for a specific key code.
    @discardableResult
    public func keyPress(
        keyCode: CGKeyCode,
        modifiers: CuaKeyModifier = []
    ) -> Bool {
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

        Self.postToDesktop(downEvent)
        Self.postToDesktop(upEvent)
        return true
    }

    /// Types an arbitrary UTF-8 string by emitting Unicode keyboard events.
    @discardableResult
    public func typeText(_ text: String) -> Bool {
        guard !text.isEmpty else { return true }

        // Iterate Characters, not UTF-16 code units: a non-BMP scalar (emoji,
        // extended scripts) is a surrogate pair and both halves must ride in a
        // single CGEvent or the character is corrupted.
        for character in text {
            var utf16Units = Array(character.utf16)
            guard let downEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
                return false
            }
            guard let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                return false
            }

            downEvent.keyboardSetUnicodeString(stringLength: utf16Units.count, unicodeString: &utf16Units)
            upEvent.keyboardSetUnicodeString(stringLength: utf16Units.count, unicodeString: &utf16Units)

            Self.postToDesktop(downEvent)
            Self.postToDesktop(upEvent)
        }
        return true
    }
}
#endif
