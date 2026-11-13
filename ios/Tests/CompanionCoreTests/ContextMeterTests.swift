import XCTest
@testable import CompanionCore

final class ContextMeterTests: XCTestCase {
    func testFloorsTheWindowLabel() {
        XCTAssertEqual(ContextMeterMath.formatCount(910_800), "910.8k")
        XCTAssertEqual(ContextMeterMath.formatCount(1_000_000), "1M")
        XCTAssertEqual(ContextMeterMath.formatCount(1_048_576), "1M")
        XCTAssertEqual(ContextMeterMath.formatCount(204_800), "204.8k")
        XCTAssertEqual(ContextMeterMath.formatCount(999), "999")
        XCTAssertEqual(ContextMeterMath.formatCount(1500), "1.5k")
    }

    func testMatchesTheEngineReading() {
        let reading = ContextMeterMath.meter(used: 910_800, reportedWindow: 1_000_000, catalogWindow: nil)
        XCTAssertEqual(reading.percent, 91)
        XCTAssertEqual(reading.percentLabel, "91% used")
        XCTAssertEqual(reading.summary, "910.8k / 1M")
        XCTAssertEqual(reading.bar, 91)
        XCTAssertEqual(reading.detail, "910,800 of 1,000,000 tokens.")
    }

    func testUsesTheReportedWindow() {
        let catalog = ContextMeterMath.meter(used: 100_000, reportedWindow: nil, catalogWindow: 200_000)
        XCTAssertEqual(catalog.window, 200_000)
        XCTAssertEqual(catalog.percent, 50)
        let live = ContextMeterMath.meter(used: 100_000, reportedWindow: 128_000, catalogWindow: 200_000)
        XCTAssertEqual(live.window, 128_000)
        XCTAssertEqual(live.percent, 78)
    }

    func testKeepsAPartialFillBelowTheNextPercent() {
        XCTAssertEqual(ContextMeterMath.meter(used: 999_999, reportedWindow: 1_000_000, catalogWindow: nil).percent, 99)
        XCTAssertEqual(ContextMeterMath.meter(used: 1_000_000, reportedWindow: 1_000_000, catalogWindow: nil).percent, 100)
    }

    func testShowsOnlyWhatWasReported() {
        let usedOnly = ContextMeterMath.meter(used: 12_400, reportedWindow: nil, catalogWindow: nil)
        XCTAssertNil(usedOnly.percent)
        XCTAssertNil(usedOnly.bar)
        XCTAssertEqual(usedOnly.summary, "12.4k tokens used")
        XCTAssertTrue(usedOnly.detail.contains("has not reported the window"))

        let windowOnly = ContextMeterMath.meter(used: nil, reportedWindow: nil, catalogWindow: 1_000_000)
        XCTAssertNil(windowOnly.percent)
        XCTAssertEqual(windowOnly.summary, "1M window")
        XCTAssertNil(windowOnly.used)

        XCTAssertEqual(ContextMeterMath.meter(used: nil, reportedWindow: nil, catalogWindow: nil).summary, "Usage not reported")
        XCTAssertNil(ContextMeterMath.meter(used: nil, reportedWindow: -1, catalogWindow: nil).percent)
    }

    func testCapsTheBarAndKeepsAReportedZero() {
        let over = ContextMeterMath.meter(used: 250_000, reportedWindow: 200_000, catalogWindow: nil)
        XCTAssertEqual(over.percent, 125)
        XCTAssertEqual(over.bar, 100)
        XCTAssertEqual(ContextMeterMath.meter(used: 0, reportedWindow: 200_000, catalogWindow: nil).percent, 0)
    }

    func testHidesCompactWhenTheEngineDoesNotOfferIt() {
        XCTAssertEqual(ContextMeterMath.compact(nil), .hidden)
        XCTAssertEqual(ContextMeterMath.compact([]), .hidden)
        XCTAssertEqual(ContextMeterMath.compact([
            .init(id: "engine:compress", name: "compress", enabled: true, disabledReason: nil),
        ]), .hidden)
        XCTAssertEqual(ContextMeterMath.compact([
            .init(id: "engine:compact", name: "compact", enabled: true, disabledReason: nil),
        ]), .ready(commandId: "engine:compact"))
        XCTAssertEqual(ContextMeterMath.compact([
            .init(id: "engine:compact", name: "compact", enabled: false, disabledReason: "Available after the first reply."),
        ]), .disabled(reason: "Available after the first reply."))
        XCTAssertEqual(ContextMeterMath.compact([
            .init(id: "engine:compact", name: "compact", enabled: false, disabledReason: "  "),
        ]), .disabled(reason: ContextMeterMath.unavailable))
    }

    func testOpensTheNoteOncePerClimb() {
        var memory: ContextMeterMath.NoteMemory?
        var openings = 0
        var visible: [Bool] = []
        for used in [100, 500, 800, 900, 910] {
            let next = ContextMeterMath.nextNote(used: used, window: 1000, compactReady: true, memory: memory)
            memory = next.memory
            if next.opened { openings += 1 }
            visible.append(next.show)
        }
        XCTAssertEqual(openings, 1)
        XCTAssertEqual(visible, [false, false, true, true, true])

        let dropped = ContextMeterMath.nextNote(used: 200, window: 1000, compactReady: true, memory: memory)
        XCTAssertFalse(dropped.show)
        XCTAssertNil(dropped.memory)
        let again = ContextMeterMath.nextNote(used: 850, window: 1000, compactReady: true, memory: dropped.memory)
        XCTAssertTrue(again.opened)
        let held = ContextMeterMath.nextNote(used: 860, window: 1000, compactReady: true, memory: again.memory)
        XCTAssertFalse(held.opened)
        XCTAssertTrue(held.show)
    }

    func testAMissingReadingDoesNotOpenANewNote() {
        let first = ContextMeterMath.nextNote(used: 900, window: 1000, compactReady: true, memory: nil)
        XCTAssertTrue(first.opened)
        let gap = ContextMeterMath.nextNote(used: nil, window: 1000, compactReady: true, memory: first.memory)
        XCTAssertFalse(gap.show)
        XCTAssertFalse(gap.opened)
        XCTAssertEqual(gap.memory, first.memory)
        let again = ContextMeterMath.nextNote(used: 910, window: 1000, compactReady: true, memory: gap.memory)
        XCTAssertFalse(again.opened)
        XCTAssertTrue(again.show)
    }

    func testTheNoteStaysHiddenWithoutCompactOrAWindow() {
        let blocked = ContextMeterMath.nextNote(used: 900, window: 1000, compactReady: false, memory: nil)
        XCTAssertFalse(blocked.show)
        XCTAssertFalse(blocked.opened)
        let unknown = ContextMeterMath.nextNote(used: 900, window: nil, compactReady: true, memory: nil)
        XCTAssertFalse(unknown.show)
        XCTAssertFalse(ContextMeterMath.nextNote(used: 799, window: 1000, compactReady: true, memory: nil).show)
    }
}
