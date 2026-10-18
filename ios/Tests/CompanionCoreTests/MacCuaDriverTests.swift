#if os(macOS)
import CoreGraphics
import Testing
@testable import CompanionCore

@Suite("Native macOS CUA Driver")
struct MacCuaDriverTests {
    let driver = MacCuaDriver()

    @Test("CuaPoint properly stores and converts to CGPoint")
    func testPointConversion() {
        let point = CuaPoint(x: 150.5, y: 300.25)
        #expect(point.x == 150.5)
        #expect(point.y == 300.25)
        #expect(point.cgPoint.x == 150.5)
        #expect(point.cgPoint.y == 300.25)
    }

    @Test("CuaKeyModifier translates accurately to CGEventFlags")
    func testKeyModifiers() {
        let empty: CuaKeyModifier = []
        #expect(empty.cgEventFlags.isEmpty)

        let cmdShift: CuaKeyModifier = [.command, .shift]
        let flags = cmdShift.cgEventFlags
        #expect(flags.contains(.maskCommand))
        #expect(flags.contains(.maskShift))
        #expect(!flags.contains(.maskAlternate))
        #expect(!flags.contains(.maskControl))

        let all: CuaKeyModifier = [.command, .shift, .option, .control, .function]
        let allFlags = all.cgEventFlags
        #expect(allFlags.contains(.maskCommand))
        #expect(allFlags.contains(.maskShift))
        #expect(allFlags.contains(.maskAlternate))
        #expect(allFlags.contains(.maskControl))
        #expect(allFlags.contains(.maskSecondaryFn))
    }

    @Test("CuaPermissions reports authorization accurately")
    func testPermissions() {
        let neither = CuaPermissions(hasScreenRecording: false, hasAccessibility: false)
        #expect(!neither.isFullyAuthorized)

        let partial1 = CuaPermissions(hasScreenRecording: true, hasAccessibility: false)
        #expect(!partial1.isFullyAuthorized)

        let partial2 = CuaPermissions(hasScreenRecording: false, hasAccessibility: true)
        #expect(!partial2.isFullyAuthorized)

        let full = CuaPermissions(hasScreenRecording: true, hasAccessibility: true)
        #expect(full.isFullyAuthorized)
    }

    @Test("Screen coordinate translation clamps normalized values between 0.0 and 1.0")
    func testCoordinateClamping() {
        let displays = driver.activeDisplays()
        guard let primary = displays.first(where: { $0.isPrimary }) ?? displays.first else {
            return
        }

        let origin = driver.screenCoordinates(for: CuaPoint(x: 0.0, y: 0.0), displayID: primary.id)
        #expect(abs(Double(origin.x) - primary.x) < 0.001)
        #expect(abs(Double(origin.y) - primary.y) < 0.001)

        let bottomCorner = driver.screenCoordinates(for: CuaPoint(x: 1.0, y: 1.0), displayID: primary.id)
        #expect(abs(Double(bottomCorner.x) - (primary.x + primary.width)) < 0.001)
        #expect(abs(Double(bottomCorner.y) - (primary.y + primary.height)) < 0.001)

        let outOfBounds = driver.screenCoordinates(for: CuaPoint(x: -5.0, y: 15.0), displayID: primary.id)
        #expect(abs(Double(outOfBounds.x) - primary.x) < 0.001)
        #expect(abs(Double(outOfBounds.y) - (primary.y + primary.height)) < 0.001)
    }

    @Test("Active displays enumeration returns at least one valid display with positive geometry")
    func testDisplayEnumeration() {
        let displays = driver.activeDisplays()
        #expect(!displays.isEmpty)
        for display in displays {
            #expect(display.width > 0)
            #expect(display.height > 0)
            #expect(display.scaleFactor >= 1.0)
        }
    }

    @Test("Mouse, scroll, and keyboard event builders execute without crashing")
    func testEventGeneration() {
        // In headless or sandboxed CI environments, CGEvent.post may be a no-op or silently dropped,
        // but event generation itself must execute reliably and return gracefully.
        _ = driver.moveMouse(to: CGPoint(x: 100, y: 100))
        _ = driver.click(at: CGPoint(x: 100, y: 100), button: .left, clickCount: 1)
        _ = driver.scroll(deltaX: 0, deltaY: -50)
        _ = driver.keyPress(keyCode: 0, modifiers: [.command])
        _ = driver.typeText("BotFleet Option A")
    }
}
#endif
