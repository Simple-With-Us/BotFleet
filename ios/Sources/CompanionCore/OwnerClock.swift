// The owner's clock, for times shown to a person.
//
// Twelve-hour, lowercase am or pm, Central, and no zone abbreviation: the
// fleet's copy rule.  The desktop's own `Intl` formats ask for
// `timeZoneName: "short"`, which prints "CDT" or "CST"; the phone does not copy
// that.  Pure and clock-free (the caller passes the instant), so every string
// is testable.
import Foundation

public enum OwnerClock {
    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "America/Chicago")
        formatter.amSymbol = "am"
        formatter.pmSymbol = "pm"
        formatter.dateFormat = format
        return formatter
    }

    /// "Oct 9, 2026, 3:15pm"
    public static func stamp(ms: Double) -> String {
        formatter("MMM d, yyyy, h:mma").string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// "3:15pm"
    public static func time(ms: Double) -> String {
        formatter("h:mma").string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// Epoch milliseconds for an ISO-8601 string the harness wrote with
    /// `toISOString()`, or nil when it does not read as a date.
    public static func milliseconds(iso: String) -> Double? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date.timeIntervalSince1970 * 1000 }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: iso) { return date.timeIntervalSince1970 * 1000 }
        return nil
    }

    /// "Oct 9, 2026, 3:15pm" for an ISO string, or nil when it is not a date.
    public static func stamp(iso: String) -> String? {
        milliseconds(iso: iso).map { stamp(ms: $0) }
    }

    /// "2h 5m", "3d 4h", "45m": the time left until `resetMs`, or "resetting
    /// now" once it has passed.  Port of `formatResetCountdown`.
    public static func countdown(untilMs resetMs: Double, nowMs: Double) -> String {
        let diff = resetMs - nowMs
        if diff <= 0 { return "resetting now" }
        let seconds = Int((diff / 1000).rounded(.down))
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3600
        let minutes = (seconds % 3600) / 60
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(max(minutes, 1))m"
    }
}
