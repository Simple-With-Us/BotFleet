// Background jobs: a shell command a bot started with `job_start` that keeps
// running after the tool call returns.
//
// Mirrors `shared/jobs.ts` and the pill in `src/components/JobsMenu.tsx`
// (docs/plans/2026-10-01-background-jobs-and-subagents-decision.md).  The
// harness owns the process, its log and the registry; the phone shows the
// jobs of a conversation, reads a job's output on demand and Stops it, which
// the owner approved from the phone (ruling d).  Nothing here starts a job.
//
// Every field the phone does not need to draw a row is optional or defaulted,
// and the two enums fall back to `.unknown`, so a harness that adds a status
// tomorrow does not turn a `jobs` frame into a decoding failure on a phone
// from last month.
import Foundation

/// Where a job is in its life.  `stopping` is a kill in flight (SIGTERM sent,
/// SIGKILL after five seconds).  `lost` is a job the harness stopped tracking
/// because it was running when the harness shut down.
public enum JobStatus: String, Codable, Hashable, Sendable {
    case running, stopping, completed, failed, killed, lost
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

/// Who ended a job early.
public enum JobKilledBy: String, Codable, Hashable, Sendable {
    case model, owner, timeout, limit, system
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

/// One job, as the harness's `jobs` frame and `GET /api/jobs` describe it.
/// Never carries output: that is read on demand over REST.
public struct JobSnapshot: Codable, Hashable, Identifiable, Sendable {
    /// `job_<ulid>`
    public var id: String
    public var botId: String
    public var threadId: String
    /// The command, redacted by the harness, on one line, clipped.
    public var label: String
    public var cwd: String?
    public var status: JobStatus
    /// The command's own exit code, when it exited on its own.
    public var exitCode: Int?
    /// The signal that ended it, when one did (`SIGTERM`, `SIGXCPU`).
    public var signal: String?
    /// Wall-clock epoch milliseconds.
    public var startedAt: Double
    public var endedAt: Double?
    public var killedBy: JobKilledBy?
    /// A short reason the status alone does not say ("CPU limit reached").
    public var reason: String?

    private enum CodingKeys: String, CodingKey {
        case id, botId, threadId, label, cwd, status, exitCode, signal, startedAt, endedAt, killedBy, reason
    }

    public init(
        id: String,
        botId: String = "",
        threadId: String,
        label: String = "",
        cwd: String? = nil,
        status: JobStatus,
        exitCode: Int? = nil,
        signal: String? = nil,
        startedAt: Double = 0,
        endedAt: Double? = nil,
        killedBy: JobKilledBy? = nil,
        reason: String? = nil
    ) {
        self.id = id
        self.botId = botId
        self.threadId = threadId
        self.label = label
        self.cwd = cwd
        self.status = status
        self.exitCode = exitCode
        self.signal = signal
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.killedBy = killedBy
        self.reason = reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        threadId = try container.decode(String.self, forKey: .threadId)
        botId = try container.decodeIfPresent(String.self, forKey: .botId) ?? ""
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
        status = try container.decodeIfPresent(JobStatus.self, forKey: .status) ?? .unknown
        exitCode = try container.decodeIfPresent(Int.self, forKey: .exitCode)
        signal = try container.decodeIfPresent(String.self, forKey: .signal)
        startedAt = try container.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0
        endedAt = try container.decodeIfPresent(Double.self, forKey: .endedAt)
        killedBy = try container.decodeIfPresent(JobKilledBy.self, forKey: .killedBy)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
    }

    /// Running or being stopped: the states a Stop still means something in.
    public var isActive: Bool { status == .running || status == .stopping }

    /// How long it has run: to `now` while it runs, to its end once it ended.
    public func elapsedMs(now: Double) -> Double {
        (endedAt ?? now) - startedAt
    }

    /// The chip beside a job.  Sentence case: it is a value, not a heading.
    public var exitChip: String {
        switch status {
        case .running:
            return "Running"
        case .stopping:
            return "Stopping"
        case .completed:
            return "Exited 0"
        case .failed:
            // `ulimit -t` ends a job with SIGXCPU, which a shell reports as
            // 152: the limit is the news, not the number.
            if signal == "SIGXCPU" { return "CPU limit reached" }
            if let exitCode { return "Exited \(exitCode)" }
            if let signal { return "Ended by \(signal)" }
            return "Failed"
        case .killed:
            switch killedBy {
            case .owner?: return "Killed by you"
            case .model?: return "Stopped by the bot"
            case .timeout?: return "Timed out"
            case .limit?: return "Output limit"
            default: return "Stopped"
            }
        case .lost:
            return "Lost after restart"
        case .unknown:
            return "Unknown"
        }
    }

    /// Whether the end counts as a failure: a crash, a lost job, or a limit
    /// the job ran into.  A Stop, by anyone, is not one.
    public var endedBadly: Bool {
        if status == .failed || status == .lost { return true }
        return status == .killed && (killedBy == .timeout || killedBy == .limit)
    }

    /// True when it ended badly within `windowMs` of `now`; the pill's dot
    /// stays red for a while after a failure.
    public func failedRecently(now: Double, windowMs: Double = JobsDisplay.failedRedMs) -> Bool {
        guard let endedAt, now - endedAt <= windowMs else { return false }
        return endedBadly
    }

    /// Why a finished job's chip is worth a second line, or nil when the chip
    /// already says it.  A Stop by you or the bot needs no explanation.
    public var shownReason: String? {
        guard let reason, !reason.isEmpty, !isActive, status != .completed else { return nil }
        if status == .killed && (killedBy == .owner || killedBy == .model) { return nil }
        return reason.prefix(1).uppercased() + reason.dropFirst()
    }
}

/// What `GET /api/jobs/:id/output` returns for the owner: the newest bytes of
/// the log, and where in the log they sit.
public struct JobOutput: Codable, Hashable, Sendable {
    public var text: String
    /// Byte offset the text starts at.
    public var from: Double
    /// Bytes cut off the front of the log to keep it small.
    public var dropped: Double

    private enum CodingKeys: String, CodingKey { case text, from, dropped }

    public init(text: String, from: Double = 0, dropped: Double = 0) {
        self.text = text
        self.from = from
        self.dropped = dropped
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        from = try container.decodeIfPresent(Double.self, forKey: .from) ?? 0
        dropped = try container.decodeIfPresent(Double.self, forKey: .dropped) ?? 0
    }

    /// Earlier output exists that this is not showing.
    public var isTruncated: Bool { from > 0 || dropped > 0 }
}

/// `{ job, output }`.  `output` is null when the harness no longer has the log.
public struct JobOutputResponse: Decodable, Sendable {
    public var job: JobSnapshot?
    public var output: JobOutput?

    private enum CodingKeys: String, CodingKey { case job, output }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        job = try? container.decodeIfPresent(JobSnapshot.self, forKey: .job)
        output = try? container.decodeIfPresent(JobOutput.self, forKey: .output)
    }
}

/// `{ jobs: [...] }` from `GET /api/jobs`.  A job the phone cannot read is
/// left out rather than failing the list.
public struct JobListResponse: Decodable, Sendable {
    public var jobs: [JobSnapshot]

    private struct Lossy: Decodable {
        let value: JobSnapshot?
        init(from decoder: Decoder) throws { value = try? JobSnapshot(from: decoder) }
    }

    private enum CodingKeys: String, CodingKey { case jobs }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        jobs = try container.decodeIfPresent([Lossy].self, forKey: .jobs)?.compactMap(\.value) ?? []
    }
}

public enum JobsPillTone: Hashable, Sendable {
    case running, failed, idle
}

/// What the pill and its list say.  Pure, with the clock passed in, so every
/// string can be tested against the ones `JobsMenu.tsx` produces.
public enum JobsDisplay {
    /// A finished job stays in the header this long; the transcript keeps it.
    public static let recentMs: Double = 30 * 60_000
    /// The pill's dot stays red this long after a failure.
    public static let failedRedMs: Double = 5 * 60_000

    /// Sentence gap: a no-break space, then a space.
    private static let gap = "\u{00A0} "

    /// The list's footer.  True wherever the phone is connected from: a job
    /// ends when the harness that started it stops or restarts.
    public static let footer =
        "Jobs run on your computer.\(gap)They end when BotFleet's server stops: quitting the Mac app does that when the app started it, and so does an update."

    /// "4m 12s", "12s", "1h 3m".  Whole seconds; never negative.
    public static func duration(ms: Double) -> String {
        guard ms.isFinite else { return "0s" }
        let total = max(0, Int((ms / 1000).rounded(.down)))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m \(seconds)s" }
        return "\(seconds)s"
    }

    /// Running first (newest start first), then finished (newest end first).
    public static func sortedForDisplay(_ jobs: [JobSnapshot]) -> [JobSnapshot] {
        jobs.sorted { a, b in
            if a.isActive != b.isActive { return a.isActive }
            if a.isActive {
                if a.startedAt != b.startedAt { return a.startedAt > b.startedAt }
            } else {
                let aEnd = a.endedAt ?? a.startedAt
                let bEnd = b.endedAt ?? b.startedAt
                if aEnd != bEnd { return aEnd > bEnd }
            }
            return a.id < b.id
        }
    }

    /// The jobs the pill counts and the list shows: every running one, and
    /// those that ended within the last half hour.
    public static func visible(_ jobs: [JobSnapshot], now: Double) -> [JobSnapshot] {
        sortedForDisplay(jobs.filter { job in
            job.isActive || (job.endedAt.map { now - $0 <= recentMs } ?? false)
        })
    }

    /// What the pill counts: running jobs when any run, else the recent
    /// finished ones.
    public static func pillCount(_ jobs: [JobSnapshot]) -> Int {
        let running = jobs.filter(\.isActive).count
        return running > 0 ? running : jobs.count
    }

    /// "2 Jobs".
    public static func pillLabel(_ jobs: [JobSnapshot]) -> String {
        let count = pillCount(jobs)
        return "\(count) \(count == 1 ? "Job" : "Jobs")"
    }

    /// What the pill's dot says, in words: "2 running, 1 failed".
    public static func pillDescription(_ jobs: [JobSnapshot], now: Double) -> String {
        let running = jobs.filter(\.isActive).count
        let failed = jobs.filter { $0.failedRecently(now: now) }.count
        let finished = jobs.count - running - failed
        var parts: [String] = []
        if running > 0 { parts.append("\(running) running") }
        if failed > 0 { parts.append("\(failed) failed") }
        if finished > 0 { parts.append("\(finished) finished") }
        return parts.joined(separator: ", ")
    }

    public static func pillTone(_ jobs: [JobSnapshot], now: Double) -> JobsPillTone {
        if jobs.contains(where: { $0.failedRecently(now: now) }) { return .failed }
        if jobs.contains(where: \.isActive) { return .running }
        return .idle
    }
}
