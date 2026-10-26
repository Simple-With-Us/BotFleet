#if os(macOS)
import CoreGraphics
import Foundation
@testable import CompanionCore

/// Records delivery without ever posting an event to the active desktop.
final class RecordingCuaEventSink: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [CGEvent] = []

    func makeDriver() -> MacCuaDriver {
        MacCuaDriver(eventSink: { [self] event in
            lock.lock()
            defer { lock.unlock() }
            recorded.append(event)
        })
    }

    var events: [CGEvent] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func unicodeText(of event: CGEvent) -> String {
        var length = 0
        event.keyboardGetUnicodeString(maxStringLength: 0, actualStringLength: &length, unicodeString: nil)
        var units = [UniChar](repeating: 0, count: length)
        event.keyboardGetUnicodeString(maxStringLength: units.count, actualStringLength: &length, unicodeString: &units)
        return String(decoding: units.prefix(length), as: UTF16.self)
    }
}
#endif
