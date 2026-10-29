#if os(macOS)
import CoreGraphics
import Foundation
import Testing
@testable import CompanionCore

@Suite("Native macOS CUA Driver")
struct MacCuaDriverTests {
    let driver = RecordingCuaEventSink().makeDriver()

    @Test("A test runner never posts to the live desktop")
    func testRunnerNeverPostsToTheLiveDesktop() {
        // The CUA suite used to post real mouse and keyboard events to the
        // live desktop, so running it took the person's mouse over while
        // they worked.  This is the tripwire: if the policy ever stops
        // recognising a test runner, the hijack comes back and the gate has
        // to fail first.
        #expect(MacDesktopInputPolicy.isUnderTestRunner == true)
        #expect(MacDesktopInputPolicy.mayPostToDesktop == false)

        // The driver the app uses is the one with the production sink, so it
        // has to obey the policy as well.  It still synthesizes its events
        // and reports success; they simply never reach the display.
        //
        // The policy counts what it refused, so this proves the guard really
        // fired.  Without that counter the assertions below would pass even
        // with the guard deleted, because the driver reports success whether
        // or not the event ever reached the screen.
        let suppressedBefore = MacDesktopInputPolicy.suppressedDesktopPostCount
        let driver = MacCuaDriver()
        #expect(driver.moveMouse(to: CGPoint(x: 40, y: 40)) == true)
        #expect(driver.typeText("hello") == true)
        let suppressed = MacDesktopInputPolicy.suppressedDesktopPostCount - suppressedBefore
        #expect(suppressed >= 2, "the policy must count every desktop post it refused")
    }

    @Test("The shipping sources post to the live desktop from exactly one guarded site")
    func liveDesktopPostingIsConfinedToThePolicy() throws {
        // A policy is only as good as the number of places that can post.
        // This test fails if a second post site appears anywhere in the
        // shipping sources, which is exactly what a custom sink that posts
        // for itself would look like.
        let iosRoot = Self.iosPackageRoot()
        let fileManager = FileManager.default
        var postSites: [String] = []

        // Every directory that reaches the macOS build, so a post site
        // cannot appear in shared app code and slip past the scan.
        for directory in ["Sources", "MacApp", "App", "Shared", "Widgets", "Scripts"] {
            let root = iosRoot.appendingPathComponent(directory)
            guard let enumerator = fileManager.enumerator(
                at: root,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            ) else { continue }

            for case let url as URL in enumerator where url.pathExtension == "swift" {
                let contents = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
                for (index, line) in contents.components(separatedBy: "\n").enumerated()
                where line.contains("post(tap:") || line.contains("CGEvent.post") {
                    postSites.append("\(url.lastPathComponent):\(index + 1)")
                }
            }
        }

        #expect(postSites.count == 1, "expected exactly one live-desktop post site, found \(postSites)")
        #expect(postSites.first?.hasPrefix("MacCuaDriver.swift:") == true)

        // The one permitted site has to be the policy's own guarded helper,
        // not a stray post left behind somewhere else in the same file.
        let driverSource = try String(
            contentsOf: iosRoot.appendingPathComponent("Sources/CompanionCore/MacCuaDriver.swift"),
            encoding: .utf8
        )
        let lines = driverSource.components(separatedBy: "\n")
        let postIndex = lines.firstIndex { $0.contains("post(tap:") }
        #expect(postIndex != nil)
        if let postIndex {
            let nearestDeclaration = lines[0..<postIndex].enumerated().last { $0.element.contains("func ") }
            #expect(nearestDeclaration?.element.contains("postToDesktop(") == true)
        }
    }

    /// The `ios` package root, derived from this file's own path.
    ///
    /// The nearest ancestor that holds both `Sources` and `MacApp` is the
    /// package root, so the test keeps working if the test file moves.
    private static func iosPackageRoot() -> URL {
        let fileManager = FileManager.default
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let holdsPackageRoots = ["Sources", "MacApp"].allSatisfy { name in
                var isDirectory: ObjCBool = false
                let exists = fileManager.fileExists(
                    atPath: directory.appendingPathComponent(name).path,
                    isDirectory: &isDirectory
                )
                return exists && isDirectory.boolValue
            }
            if holdsPackageRoots { return directory }
            directory = directory.deletingLastPathComponent()
        }
        return directory
    }

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
