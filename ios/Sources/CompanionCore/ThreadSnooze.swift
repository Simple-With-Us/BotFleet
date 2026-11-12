// Per-thread snooze on the phone.
//
// One conversation goes quiet while the bot keeps working its others.  The
// harness owns the state (`shared/thread-snooze.ts`, `server/store.ts`) and
// this is the phone's half of the same contract, kept in the core rather
// than in a view so `swift test` can hold it to the desktop's answers.
//
// The wire is three values and nothing else: absent means awake, `0` is the
// until-activity sentinel and sleeps until the thread does anything again,
// and a timestamp in epoch milliseconds sleeps until that moment.  JSON
// `null` is the only way to wake a thread, because an omitted field has
// always meant "leave it alone" on the task route.
import Foundation

/// The sentinel: sleep until the thread does something again rather than
/// until a moment.  Zero is a real value on the wire, never "no snooze".
public let threadSnoozeUntilActivity: Double = 0

/// The snooze choices the phone offers, resolved in the person's local time
/// on purpose — it is their hour and their morning, and the harness stores
/// the absolute moment either way.
///
/// These mirror the desktop menu (`shared/thread-snooze.ts`) so a thread
/// snoozed on the phone reads the same on the Mac.
public enum ThreadSnoozePreset {
    /// Tomorrow morning is 8 local, matching the desktop.
    public static let morningHour = 8

    /// One hour from the tap.  Resolved when it is tapped, never when the
    /// menu was built: a menu left open must not snooze until a moment that
    /// has already been and gone.
    public static func hour(now: Date = Date()) -> Double {
        now.addingTimeInterval(3_600).timeIntervalSince1970 * 1_000
    }

    /// The next day at 8 local — a clean overnight break.
    public static func tomorrowMorning(now: Date = Date(), calendar: Calendar = .current) -> Double {
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        let when = calendar.date(bySettingHour: morningHour, minute: 0, second: 0, of: tomorrow) ?? tomorrow
        return when.timeIntervalSince1970 * 1_000
    }
}

public enum ThreadSnooze {
    /// Asleep right now.  The sentinel sleeps until something wakes it; a
    /// timestamp sleeps only until it passes.
    ///
    /// The harness drops expired snoozes from what it hands out, so a fresh
    /// snapshot is authoritative — but a live SSE frame is never refreshed
    /// afterwards, and an app left open across a deadline has to check the
    /// clock too.
    public static func isSnoozed(_ snoozedUntil: Double?, now: Date = Date()) -> Bool {
        guard let snoozedUntil else { return false }
        return snoozedUntil == threadSnoozeUntilActivity || snoozedUntil > now.timeIntervalSince1970 * 1_000
    }

    /// The one line a sleeping row says about itself: "Until activity", or
    /// the resolved deadline as "Until 8:00 AM".  Nil while the thread is
    /// awake, so a caller can decide to draw the badge on this alone.
    ///
    /// A deadline past today carries its weekday, because "Until 8:00 AM" on
    /// a Friday row that wakes on Monday would be a lie.
    public static func label(
        _ snoozedUntil: Double?,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String? {
        guard isSnoozed(snoozedUntil, now: now), let snoozedUntil else { return nil }
        if snoozedUntil == threadSnoozeUntilActivity { return "Until activity" }
        let when = Date(timeIntervalSince1970: snoozedUntil / 1_000)
        let time = DateFormatter()
        time.locale = locale
        time.calendar = calendar
        time.timeStyle = .short
        time.dateStyle = .none
        if calendar.isDate(when, inSameDayAs: now) { return "Until \(time.string(from: when))" }
        let weekday = DateFormatter()
        weekday.locale = locale
        weekday.calendar = calendar
        weekday.setLocalizedDateFormatFromTemplate("EEE")
        return "Until \(weekday.string(from: when)) \(time.string(from: when))"
    }

    /// Newest activity, falling back to when the thread was created, so a
    /// row that never spoke sorts by its own age rather than by nothing.
    public static func recency(_ task: BotTask) -> Double {
        if let lastActivity = task.lastActivity, lastActivity.isFinite { return lastActivity }
        return task.createdAt.isFinite ? task.createdAt : 0
    }

    /// Thread order: awake threads newest-first, then the sleeping ones.
    ///
    /// A snoozed thread SINKS rather than disappearing, and the moment its
    /// deadline passes it is awake again and back in plain update order —
    /// nothing has to remember where it used to sit, because the position
    /// was never stored, only derived.
    ///
    /// `keepInPlace` is upstream #1248's pinned-thread retention: an
    /// anchored thread is never demoted to the sleeping tier, so it holds
    /// the slot it already had.  BotFleet pins bots rather than threads, so
    /// the anchor here is the thread the person currently has open —
    /// snoozing the conversation on screen must not move it out from under
    /// the tap that snoozed it.
    ///
    /// Stable within each tier: equal stamps keep the caller's order.
    public static func ordered(
        _ tasks: [BotTask],
        now: Date = Date(),
        keepInPlace: Set<String> = []
    ) -> [BotTask] {
        let asleep = { (task: BotTask) -> Bool in
            !keepInPlace.contains(task.threadId) && isSnoozed(task.snoozedUntil, now: now)
        }
        return tasks.enumerated()
            .sorted { left, right in
                let leftAsleep = asleep(left.element)
                let rightAsleep = asleep(right.element)
                if leftAsleep != rightAsleep { return !leftAsleep }
                let leftAt = recency(left.element)
                let rightAt = recency(right.element)
                if leftAt != rightAt { return leftAt > rightAt }
                return left.offset < right.offset
            }
            .map(\.element)
    }
}
