// The SSE parser, which is where a hand-rolled event client goes wrong.
import XCTest
@testable import CompanionCore

final class SSETests: XCTestCase {
    /// Feed lines the way `AsyncLineSequence` would — newlines stripped.
    func events(_ lines: [String]) -> [SSEEvent] {
        var parser = SSEParser()
        return lines.compactMap { parser.line($0) }
    }

    func testReadsOneFrameTheHarnessActuallySends() {
        // exactly the shape server/index.ts writes
        let parsed = events(["id: 778d5d30:4", #"data: {"kind":"bot","seq":4}"#, ""])
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed[0].id, "778d5d30:4")
        XCTAssertEqual(parsed[0].data, #"{"kind":"bot","seq":4}"#)
    }

    func testSwallowsKeepaliveComments() {
        // a 25-second `: keepalive` is the only reason this stream survives
        // a NAT, and it must never surface as an event
        XCTAssertTrue(events([": keepalive", ""]).isEmpty)
        let parsed = events([": keepalive", "", "data: {}", ""])
        XCTAssertEqual(parsed.count, 1)
    }

    func testEmitsNothingUntilTheBlankLineArrives() {
        var parser = SSEParser()
        XCTAssertNil(parser.line("id: s:1"))
        XCTAssertNil(parser.line("data: {}"))
        // a frame split across two network chunks must not be emitted early
        XCTAssertNotNil(parser.line(""))
    }

    func testJoinsMultipleDataLines() {
        let parsed = events(["data: {", #"data: "kind": "hello""#, "data: }", ""])
        XCTAssertEqual(parsed.first?.data, "{\n\"kind\": \"hello\"\n}")
    }

    func testHandlesTheOptionalSpaceAndCarriageReturns() {
        XCTAssertEqual(events(["data:tight", ""]).first?.data, "tight")
        XCTAssertEqual(events(["data:  padded", ""]).first?.data, " padded", "only one space is the separator")
        XCTAssertEqual(events(["data: crlf\r", "\r"]).first?.data, "crlf")
    }

    func testIgnoresFieldsItDoesNotUseAndBlocksWithoutData() {
        XCTAssertTrue(events(["event: ping", "retry: 3000", ""]).isEmpty)
        XCTAssertTrue(events(["", "", ""]).isEmpty)
        XCTAssertTrue(events(["garbage-with-no-colon", ""]).isEmpty)
    }

    func testDoesNotLeakFieldsFromOneEventIntoTheNext() {
        var parser = SSEParser()
        _ = parser.line("id: s:1")
        _ = parser.line("data: first")
        let first = parser.line("")
        _ = parser.line("data: second")
        let second = parser.line("")

        XCTAssertEqual(first?.id, "s:1")
        XCTAssertEqual(second?.data, "second")
        XCTAssertNil(second?.id, "the second event never carried an id")
    }

    func testAFullStreamDecodesIntoFrames() throws {
        let lines = [
            #"data: {"kind":"hello","cursor":"abc12345:0","resumed":false}"#, "",
            ": keepalive", "",
            "id: abc12345:1",
            #"data: {"kind":"message","threadId":"t1","seq":1,"message":{"id":"m1","role":"user","kind":"text","at":1}}"#,
            "",
        ]
        let decoder = JSONDecoder()
        let frames = events(lines).compactMap { event in
            try? decoder.decode(StreamFrame.self, from: Data(event.data.utf8))
        }
        XCTAssertEqual(frames.count, 2)
        guard case let .hello(cursor, resumed) = frames[0].frame else { return XCTFail("expected hello") }
        XCTAssertEqual(cursor, "abc12345:0")
        XCTAssertFalse(resumed)
        guard case .message = frames[1].frame else { return XCTFail("expected message") }
        XCTAssertEqual(frames[1].seq, 1)
    }

    // MARK: - Bounds (BF-2695): a line or an event past the limit is dropped, not kept

    func testAnEventJustUnderTheLimitStillDelivers() {
        var parser = SSEParser(byteLimit: 64)
        let payload = String(repeating: "a", count: 48)
        XCTAssertNil(parser.line("data: \(payload)"))
        // "data" plus the value: the limit is read against the bytes the event holds
        XCTAssertEqual(parser.bufferedByteCount, 52)
        XCTAssertFalse(parser.isDroppingEvent)
        XCTAssertEqual(parser.line("")?.data, payload)
        XCTAssertEqual(parser.droppedEventCount, 0)
        XCTAssertEqual(parser.bufferedByteCount, 0, "a delivered event holds nothing afterwards")
    }

    func testAnEventWhoseFieldsGrowPastTheLimitIsDroppedInsteadOfKept() {
        var parser = SSEParser(byteLimit: 64)
        XCTAssertNil(parser.line("id: s:1"))
        let line = "data: \(String(repeating: "b", count: 20))"
        XCTAssertNil(parser.line(line))
        XCTAssertNil(parser.line(line))
        XCTAssertEqual(parser.bufferedByteCount, 53)
        // the third line crosses the limit: the event is dropped whole
        XCTAssertNil(parser.line(line))
        XCTAssertTrue(parser.isDroppingEvent)
        XCTAssertEqual(parser.bufferedByteCount, 0, "nothing is held for a dropped event")
        XCTAssertNil(parser.line("data: \(String(repeating: "c", count: 400))"))
        XCTAssertEqual(parser.bufferedByteCount, 0, "the rest of the dropped event is not kept either")
        // the blank line ends it without emitting anything, and the count says so
        XCTAssertNil(parser.line(""))
        XCTAssertEqual(parser.droppedEventCount, 1)
        XCTAssertFalse(parser.isDroppingEvent)

        // the stream is in step again at the very next event
        XCTAssertNil(parser.line(#"data: {"kind":"hello"}"#))
        XCTAssertEqual(parser.line("")?.data, #"{"kind":"hello"}"#)
        XCTAssertEqual(parser.droppedEventCount, 1)
    }

    func testALineOverTheLimitDropsItsEventWhole() {
        var parser = SSEParser(byteLimit: 1_000)
        XCTAssertNil(parser.line("id: s:2"))
        // the stream loop says this when `SSELineBuffer` reports a dropped line
        parser.lineOverLimit()
        XCTAssertTrue(parser.isDroppingEvent)
        XCTAssertNil(parser.line("data: the rest of the event"))
        XCTAssertNil(parser.line(""))
        XCTAssertEqual(parser.droppedEventCount, 1)
        XCTAssertNil(parser.line("data: after"))
        XCTAssertEqual(parser.line("")?.data, "after")
    }

    func testTheLineBufferStopsHoldingALineAtTheLimit() {
        var lines = SSELineBuffer(byteLimit: 8)
        for byte in "data: ok".utf8 { XCTAssertNil(lines.feed(byte)) }
        XCTAssertEqual(lines.bufferedByteCount, 8)
        XCTAssertEqual(lines.feed(0x0A), .line("data: ok"))
        XCTAssertEqual(lines.bufferedByteCount, 0)
        XCTAssertEqual(lines.droppedLineCount, 0)

        // a line that never ends is not kept past the limit
        for _ in 0..<100_000 { XCTAssertNil(lines.feed(0x62)) }
        XCTAssertEqual(lines.bufferedByteCount, 0, "the bytes of a dropped line are not held")
        XCTAssertEqual(lines.droppedLineCount, 0, "nothing is counted until the line ends")
        XCTAssertEqual(lines.feed(0x0A), .droppedLine)
        XCTAssertEqual(lines.droppedLineCount, 1)

        // and the next line reads normally, CRLF included
        for byte in "x: y".utf8 { XCTAssertNil(lines.feed(byte)) }
        XCTAssertEqual(lines.feed(0x0A), .line("x: y"))
        for byte in "a\r".utf8 { XCTAssertNil(lines.feed(byte)) }
        XCTAssertEqual(lines.feed(0x0A), .line("a"))
    }

    func testTheStreamLoopDropsOversizedFramesAndStillDeliversTheNextOnes() {
        var lines = SSELineBuffer(byteLimit: 24)
        var parser = SSEParser(byteLimit: 24)
        var delivered: [SSEEvent] = []
        // the same calls `eventStream` makes, byte for byte
        func pump(_ text: String) {
            for byte in text.utf8 {
                switch lines.feed(byte) {
                case .line(let line):
                    if let event = parser.line(line) { delivered.append(event) }
                case .droppedLine:
                    parser.lineOverLimit()
                case nil:
                    break
                }
            }
        }

        pump("id: s:1\ndata: small\n\n")
        pump("data: \(String(repeating: "x", count: 200))\n\n")
        pump("data: \(String(repeating: "y", count: 12))\ndata: \(String(repeating: "z", count: 12))\n\n")
        pump("id: s:2\ndata: last\n\n")

        XCTAssertEqual(delivered.map(\.data), ["small", "last"])
        XCTAssertEqual(delivered.map(\.id), ["s:1", "s:2"])
        XCTAssertEqual(lines.droppedLineCount, 1, "one line went over the limit")
        XCTAssertEqual(parser.droppedEventCount, 2, "that line's event, and the one whose fields added up past the limit")
    }
}
