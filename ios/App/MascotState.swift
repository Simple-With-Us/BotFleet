// Which face a bot wears — the desktop's `stateForBot`, ported.
//
// A pinned expression wins; then what the bot is doing right now; then a
// guess from its role. Same rules, same order, so a bot looks the same on
// the phone as on the laptop.
import Foundation
import CompanionCore

extension BotState {
    /// The desktop's legacy names, kept so an older bot record still resolves.
    private static let legacy: [String: BotState] = [
        "deadpan": .idle, "friendly": .happy, "focused": .working, "thinking": .thinking,
        "excited": .excited, "sleepy": .drowsy, "surprised": .surprised, "skeptical": .suspicious,
        "worried": .scared, "mischievous": .playful,
    ]

    /// Resolves any stored value — current, legacy or junk — to a real state.
    static func normalize(_ value: String?) -> BotState? {
        guard let value, !value.isEmpty else { return nil }
        return BotState(rawValue: value) ?? legacy[value]
    }

    static func forBot(_ bot: Bot, last: Message?) -> BotState {
        if let pinned = normalize(bot.mascotExpression) { return pinned }

        if last?.kind == .activity, last?.tool?.ok == false { return .alerting }
        if bot.busy == true { return .working }
        if bot.unread { return .notifying }
        if last?.kind == .options { return .curious }

        let profile = "\(bot.name) \(bot.title) \(bot.description)".lowercased()
        func matches(_ words: [String]) -> Bool {
            words.contains { word in
                profile.range(of: "\\b\(NSRegularExpression.escapedPattern(for: word))\\b", options: .regularExpression) != nil
            }
        }
        // Prefer super-specific TV-Face sheet faces when the role is clear.
        if matches(["git", "github", "pull request", "pr", "commit", "merge", "deploy", "compiler", "build", "ci", "testflight"]) { return .git }
        if matches(["webhook", "hooks", "callback", "event stream"]) { return .webhook }
        if matches(["fleet", "director", "coordinator", "orchestrat"]) { return .fleet }
        if matches(["memory", "rag", "vector", "embedding", "recall"]) { return .memory }
        if matches(["tool", "tools", "adapter", "plumber", "connector", "skill"]) { return .tools }
        if matches(["computer", "desktop", "shell", "terminal", "ssh"]) { return .computer }
        if matches(["routine", "schedule", "cron", "recurring", "housekeeper"]) { return .routine }
        if matches(["screen", "ui", "ux", "designer", "frontend"]) { return .screen }
        if matches(["crash", "sentry", "pagerduty", "fixer", "incident response"]) { return .crash }
        if matches(["code", "coding", "developer", "development", "engineer", "engineering", "debug", "program", "software"]) { return .working }
        if matches(["research", "researcher", "search", "investigate", "strategy", "strategist", "study", "learn", "knowledge"]) { return .searching }
        if matches(["marketing", "growth", "launch", "campaign", "social", "sales", "outreach", "brand"]) { return .excited }
        if matches(["overnight", "night", "background", "async", "queue", "batch", "long-running"]) { return .drowsy }
        if matches(["monitor", "monitoring", "incident", "alert", "watch", "status", "uptime"]) { return .radar }
        if matches(["review", "reviewer", "audit", "critic", "critique", "quality", "qa", "test", "legal", "publisher"]) { return .suspicious }
        if matches(["security", "secure", "compliance", "risk", "privacy", "finance", "financial"]) { return .scared }
        if matches(["design", "creative", "brainstorm", "art", "illustration", "music", "story"]) { return .playful }
        if matches(["support", "help", "success", "onboarding", "coach", "teacher", "guide", "welcome"]) { return .happy }
        if matches(["sneak", "stealth", "quiet", "background agent"]) { return .sneaking }
        return .idle
    }

    /// The face for a chat as a whole: a bot's own, a room's is "happy" —
    /// which is what the desktop draws for room avatars.
    static func forChat(_ chat: Chat, in state: CompanionState) -> BotState {
        switch chat {
        case let .bot(bot): return forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last)
        case .room: return .happy
        }
    }
}
