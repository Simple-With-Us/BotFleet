#if os(macOS)
import CoreGraphics
import Testing
@testable import CompanionCore

@Suite("Native macOS CUA Driver")
struct MacCuaDriverTests {
    let driver = RecordingCuaEventSink().makeDriver()

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

    @Test("Mouse, scroll, and keyboard events are delivered only to the injected sink")
    func testEventGeneration() throws {
        let sink = RecordingCuaEventSink()
        let driver = sink.makeDriver()
        let point = CGPoint(x: 100, y: 100)
        #expect(driver.moveMouse(to: point))
        #expect(driver.click(at: point, button: .left, clickCount: 2))
        #expect(driver.scroll(deltaX: 3, deltaY: -50))
        #expect(driver.keyPress(keyCode: 0, modifiers: [.command]))
        #expect(driver.typeText("A😀"))

        let events = sink.events
        #expect(events.map(\.type) == [
            .mouseMoved, .leftMouseDown, .leftMouseUp, .scrollWheel,
            .keyDown, .keyUp, .keyDown, .keyUp, .keyDown, .keyUp,
        ])
        #expect(events[0].location == point)
        #expect(events[1].getIntegerValueField(.mouseEventClickState) == 2)
        #expect(events[3].getIntegerValueField(.scrollWheelEventPointDeltaAxis1) == -50)
        #expect(events[3].getIntegerValueField(.scrollWheelEventPointDeltaAxis2) == 3)
        #expect(events[4].getIntegerValueField(.keyboardEventKeycode) == 0)
        #expect(events[4].flags.contains(.maskCommand))
        #expect(events[5].flags.contains(.maskCommand))
        #expect(sink.unicodeText(of: events[6]) == "A")
        #expect(sink.unicodeText(of: events[8]) == "😀")
    }

    @Test("The event sink records each button, drag, and emergency release")
    func testMouseDeliveryAndEmergencyStop() {
        let sink = RecordingCuaEventSink()
        let driver = sink.makeDriver()
        let endpointTypes: [(CGEventType, CGEventType)] = [
            (.leftMouseDown, .leftMouseUp),
            (.rightMouseDown, .rightMouseUp),
            (.otherMouseDown, .otherMouseUp),
        ]
        for (index, button) in CuaMouseButton.allCases.enumerated() {
            #expect(driver.drag(from: .zero, to: CGPoint(x: 20, y: 30), button: button, steps: 2))
            let events = Array(sink.events.dropFirst(index * 4))
            #expect(events.count == 4)
            #expect(events.first?.type == endpointTypes[index].0)
            #expect(events.last?.type == endpointTypes[index].1)
            #expect(events[1].location == CGPoint(x: 10, y: 15))
            #expect(events[2].location == CGPoint(x: 20, y: 30))
        }
        for button in CuaMouseButton.allCases {
            #expect(driver.mouseDown(at: .zero, button: button))
        }
        #expect(Set(driver.emergencyStop()) == Set(CuaMouseButton.allCases))
        #expect(sink.events.suffix(3).map(\.type) == [.leftMouseUp, .rightMouseUp, .otherMouseUp])
        #expect(driver.heldMouseButtons.isEmpty)
        let count = sink.events.count
        #expect(!driver.moveMouse(to: .zero))
        #expect(!driver.click(at: .zero))
        #expect(!driver.drag(from: .zero, to: .zero))
        #expect(!driver.scroll(deltaX: 0, deltaY: 1))
        #expect(!driver.keyPress(keyCode: 0))
        #expect(!driver.typeText("blocked"))
        #expect(sink.events.count == count)
        driver.resetEmergencyStop()
        #expect(driver.keyPress(keyCode: 0))
        #expect(sink.events.count == count + 2)
    }

    @available(macOS 14.0, *)
    @Test("Stream errors map to product copy with no framework text")
    func testStreamErrorStatusCopy() {
        let declined = ScreenStreamError.captureFailed(
            "The user declined TCCs for application, window, display capture (SCStreamErrorDomain -3801)"
        )
        #expect(declined.statusMessage(hasScreenRecording: false) == "Screen recording permission needed")
        #expect(ScreenStreamError.notAuthorized.statusMessage(hasScreenRecording: true) == "Screen recording permission needed")
        #expect(ScreenStreamError.noDisplayFound.statusMessage(hasScreenRecording: true) == "No display available to capture")

        let failures: [ScreenStreamError] = [
            .streamInitializationFailed("SCStreamErrorDomain -3802"),
            .captureFailed("SCStreamErrorDomain -3815"),
        ]
        for failure in failures {
            for permitted in [true, false] {
                let message = failure.statusMessage(hasScreenRecording: permitted)
                #expect(!message.contains("SCStream"))
                #expect(!message.contains("-38"))
            }
            #expect(failure.statusMessage(hasScreenRecording: true) == "Live capture could not start")
        }
    }
}
#endif
