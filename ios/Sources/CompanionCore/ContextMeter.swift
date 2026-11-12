import Foundation

/// The same context meter the web client uses.  Numbers come from what the
/// engine already reported.  A missing figure stays missing.
public enum ContextMeterMath {
    public static let notePercent = 80
    public static let compactLabel = "Compact Session"
    public static let noteText = "Compacting before your next message keeps later replies fast and lighter on your usage."
    public static let gap = "\u{00A0} "
    public static let unavailable = "Compact session is not available right now."

    public struct Reading: Equatable, Sendable {
        public var used: Int?
        public var window: Int?
        public var percent: Int?
        public var bar: Int?
        public var summary: String
        public var detail: String
        public var percentLabel: String?
    }

    public enum CompactState: Equatable, Sendable {
        case hidden
        case ready(commandId: String)
        case disabled(reason: String)
    }

    public struct Command: Equatable, Sendable {
        public var id: String
        public var name: String
        public var enabled: Bool
        public var disabledReason: String?

        public init(id: String, name: String, enabled: Bool, disabledReason: String?) {
            self.id = id
            self.name = name
            self.enabled = enabled
            self.disabledReason = disabledReason
        }
    }

    public struct NoteMemory: Equatable, Sendable {
        public var shownAtUsed: Int
    }

    public struct NoteDecision: Equatable, Sendable {
        public var show: Bool
        public var opened: Bool
        public var memory: NoteMemory?
    }

    public static func reported(_ value: Int?) -> Int? {
        guard let value, value >= 0 else { return nil }
        return value
    }

    public static func formatCount(_ tokens: Int) -> String {
        guard tokens >= 0 else { return "" }
        if tokens < 1000 { return String(tokens) }
        let scale = tokens < 1_000_000 ? 1000 : 1_000_000
        let suffix = scale == 1000 ? "k" : "M"
        let tenths = tokens / (scale / 10)
        let ones = tenths / 10
        let frac = tenths % 10
        if frac == 0 { return "\(ones)\(suffix)" }
        return "\(ones).\(frac)\(suffix)"
    }

    public static func meter(used rawUsed: Int?, reportedWindow: Int?, catalogWindow: Int?) -> Reading {
        let used = reported(rawUsed)
        let reportedSize = reported(reportedWindow)
        let catalogSize = reported(catalogWindow)
        let window: Int? = {
            if let reportedSize, reportedSize > 0 { return reportedSize }
            if let catalogSize, catalogSize > 0 { return catalogSize }
            return nil
        }()
        let percent = used != nil && window != nil && window! > 0 ? (used! * 100) / window! : nil
        let usedLabel = used.map(formatCount)
        let windowLabel = window.map(formatCount)
        var summary = "Usage not reported"
        var detail = "This engine has not reported context usage."
        if let used, let window, let usedLabel, let windowLabel {
            summary = "\(usedLabel) / \(windowLabel)"
            detail = "\(grouped(used)) of \(grouped(window)) tokens."
        } else if let used, let usedLabel {
            summary = "\(usedLabel) tokens used"
            detail = "\(grouped(used)) tokens used.\(gap)This engine has not reported the window."
        } else if let window, let windowLabel {
            summary = "\(windowLabel) window"
            detail = "The window is \(grouped(window)) tokens.\(gap)Usage has not been reported yet."
        }
        return Reading(
            used: used,
            window: window,
            percent: percent,
            bar: percent.map { min(100, max(0, $0)) },
            summary: summary,
            detail: detail,
            percentLabel: percent.map { "\($0)% used" }
        )
    }

    public static func badge(used: Int?, reportedWindow: Int?, catalogWindow: Int?) -> String? {
        guard let percent = meter(used: used, reportedWindow: reportedWindow, catalogWindow: catalogWindow).percent else { return nil }
        return "\(percent)%"
    }

    public static func compact(_ commands: [Command]?) -> CompactState {
        guard let commands else { return .hidden }
        guard let command = commands.first(where: { $0.id == "engine:compact" && $0.name == "compact" }) else { return .hidden }
        if command.enabled { return .ready(commandId: command.id) }
        let reason = command.disabledReason?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .disabled(reason: reason.isEmpty ? unavailable : reason)
    }

    public static func nextNote(used: Int?, window: Int?, compactReady: Bool, memory: NoteMemory?) -> NoteDecision {
        let reading = meter(used: used, reportedWindow: window, catalogWindow: nil)
        let near = reading.percent != nil && reading.percent! >= notePercent
        if !near || !compactReady || used == nil {
            let dropped = reading.percent != nil && reading.percent! < notePercent
            return NoteDecision(show: false, opened: false, memory: dropped ? nil : memory)
        }
        if memory != nil {
            return NoteDecision(show: true, opened: false, memory: memory)
        }
        return NoteDecision(show: true, opened: true, memory: NoteMemory(shownAtUsed: used!))
    }

    public static func compactCopy(settled: Bool) -> String {
        settled ? "Compacted this session." : "Compacting this session."
    }

    private static func grouped(_ value: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
}
