import Foundation

public struct NativeEngineRoute: Hashable, Codable, Sendable {
    public let botId: String
    public let engineId: String
    public let modelId: String?

    public init(botId: String, engineId: String, modelId: String?) {
        self.botId = botId; self.engineId = engineId; self.modelId = modelId
    }
}

public enum NativeEngineLimitKind: String, Codable, Sendable { case quota, capacity }

public struct NativeEngineLimit: Equatable, Codable, Sendable {
    public let kind: NativeEngineLimitKind
    public let retryAfterSeconds: TimeInterval
}

/// A provider's failure evidence, never arbitrary successful assistant prose.
public enum NativeEngineLimitClassifier {
    public static func classify(code: String, message: String) -> NativeEngineLimit? {
        let code = code.lowercased()
        let text = message.lowercased()
        let hard = ["quota", "quota_exceeded", "insufficient_quota", "insufficient_balance", "insufficient_funds", "usage_limit_exceeded", "enforced_spend_limit", "enforced_spend_limit_reached", "account_inactive"].contains(code) ||
            matches(#"\b(?:quota_exceeded|insufficient_quota|insufficient_balance|insufficient_funds|usage_limit_exceeded|enforced_spend_limit(?:_reached)?|account_inactive)\b|\b(?:usage|plan|weekly|monthly|spend|credit|billing|quota)\b.{0,60}\b(?:limit|exhaust|exceed|deplet|fail)|insufficient[_ ](?:quota|balance|funds)|out of credits"#, text)
        if hard {
            let delay = duration(in: text, pattern: #"\breset(?:s)?\s+in\s*(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b"#)
            return NativeEngineLimit(kind: .quota, retryAfterSeconds: min(7 * 86_400, max(1, delay ?? 3_600)))
        }
        let transient = ["rate_limited", "overloaded", "resource_exhausted"].contains(code) ||
            matches(#"\b429\b|rate[_ -]?limit|too many requests|concurren(?:t|cy)|in[- ]flight|session (?:limit|cap)|resource[_ -]?exhausted"#, text)
        guard transient else { return nil }
        let delay = duration(in: text, pattern: #"\b(?:retry[- ]after:?|try again in)\s*(\d+)(?:\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b|(?=\s*(?:$|[,;.!)])))"#)
        return NativeEngineLimit(kind: .capacity, retryAfterSeconds: min(300, max(1, delay ?? 5)))
    }

    public static func isHealthyPrefix(_ text: String) -> Bool {
        let value = String(text.prefix(512)).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty else { return false }
        let prefixes = ["error", "http", "429", "402", "rate limit", "too many", "concurren", "usage limit", "billing", "insufficient", "you've hit", "{", "["]
        return !prefixes.contains { $0.hasPrefix(value) || value.hasPrefix($0) }
    }

    public static func isWorkTool(_ name: String) -> Bool {
        let value = name.lowercased()
        guard !value.isEmpty, value != "spawn_agent" else { return false }
        return value.range(of: #"^(?:hookrun|reminderchild|workflow|subagent)(?:$|[^a-z0-9])"#,
                           options: .regularExpression) == nil
    }

    public static func completionFailureCode(_ reason: String) -> String? {
        let value = reason.lowercased().replacingOccurrences(of: "-", with: "_").replacingOccurrences(of: " ", with: "_")
        if ["cancel", "interrupt", "abort", "user_stop"].contains(where: { value.hasPrefix($0) }) { return "cancelled" }
        if ["error", "failed", "failure", "timeout", "prompt_timeout", "stall_timeout"].contains(value) { return "engine_error" }
        return nil
    }

    private static func matches(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    private static func duration(in text: String, pattern: String) -> TimeInterval? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let amountRange = Range(match.range(at: 1), in: text),
              let amount = Double(text[amountRange]) else { return nil }
        let unit = Range(match.range(at: 2), in: text).map { String(text[$0]) } ?? "s"
        let multiplier: Double = unit.hasPrefix("d") ? 86_400 : unit.hasPrefix("h") ? 3_600 : unit.hasPrefix("m") ? 60 : 1
        return amount * multiplier
    }
}

public struct NativeEngineRecoveryHold: Codable, Equatable, Sendable {
    public let route: NativeEngineRoute
    public let kind: NativeEngineLimitKind
    public let recordedAt: Date
    public let retryAt: Date
}

/// Quota snapshots contain routing metadata only; transient pressure is never persisted.
public actor NativeEngineRecoveryActor {
    private struct ModelRoute: Hashable { let engineId: String; let modelId: String? }
    private var holds: [NativeEngineRoute: NativeEngineRecoveryHold] = [:]
    private var healthy: [ModelRoute: [String: Date]] = [:]
    private let storageURL: URL?
    public private(set) var persistenceFailed = false

    public init(storageURL: URL? = nil) {
        self.storageURL = storageURL
        if let storageURL, let data = try? Data(contentsOf: storageURL),
           let saved = try? JSONDecoder().decode([NativeEngineRecoveryHold].self, from: data) {
            for hold in saved.prefix(512) where hold.kind == .quota && hold.retryAt > Date() {
                holds[hold.route] = hold
            }
        }
    }

    public func hold(for route: NativeEngineRoute, now: Date = Date()) -> NativeEngineRecoveryHold? {
        prune(now: now)
        if let own = holds[route] { return own }
        return holds.values.first {
            $0.kind == .capacity && $0.route.engineId == route.engineId && $0.route.modelId == route.modelId
        }
    }

    @discardableResult
    public func recordFailure(route: NativeEngineRoute, limit: NativeEngineLimit,
                              activeSiblingBots: Set<String> = [], now: Date = Date()) -> NativeEngineRecoveryHold? {
        prune(now: now)
        let key = ModelRoute(engineId: route.engineId, modelId: route.modelId)
        healthy[key]?[route.botId] = nil
        if limit.kind == .capacity, let hard = holds[route], hard.kind == .quota { return hard }
        if limit.kind == .capacity, healthy[key]?.contains(where: {
            $0.key != route.botId && activeSiblingBots.contains($0.key) && $0.value <= now && now.timeIntervalSince($0.value) < 30
        }) == true { return nil }
        let delay = max(1, min(limit.kind == .capacity ? 300 : 7 * 86_400,
                               limit.retryAfterSeconds.isFinite ? limit.retryAfterSeconds : 5))
        let proposedRetryAt = now.addingTimeInterval(delay)
        let retryAt: Date
        if limit.kind == .quota, let previous = holds[route], previous.kind == .quota {
            retryAt = max(previous.retryAt, proposedRetryAt)
        } else { retryAt = proposedRetryAt }
        let hold = NativeEngineRecoveryHold(route: route, kind: limit.kind, recordedAt: now,
                                            retryAt: retryAt)
        holds[route] = hold
        trim()
        persist()
        return hold
    }

    public func markHealthy(route: NativeEngineRoute, now: Date = Date()) {
        prune(now: now)
        let key = ModelRoute(engineId: route.engineId, modelId: route.modelId)
        var bots = healthy[key] ?? [:]
        bots[route.botId] = now
        if bots.count > 16, let oldest = bots.min(by: { $0.value < $1.value }) { bots[oldest.key] = nil }
        healthy[key] = bots
        for (heldRoute, hold) in holds where hold.kind == .capacity && hold.recordedAt <= now &&
            heldRoute.engineId == route.engineId && heldRoute.modelId == route.modelId {
            holds[heldRoute] = nil
        }
        trim()
    }

    public func markUnhealthy(route: NativeEngineRoute) {
        healthy[ModelRoute(engineId: route.engineId, modelId: route.modelId)]?[route.botId] = nil
    }

    public func clearSuccessfulQuota(route: NativeEngineRoute) {
        if holds[route]?.kind == .quota { holds[route] = nil; persist() }
    }

    public func snapshot(now: Date = Date()) -> [NativeEngineRecoveryHold] {
        prune(now: now)
        return holds.values.sorted { $0.recordedAt < $1.recordedAt }
    }

    private func prune(now: Date) {
        let previous = holds.count
        holds = holds.filter { $0.value.retryAt > now }
        healthy = healthy.compactMapValues { bots in
            let recent = bots.filter { now.timeIntervalSince($0.value) < 30 }
            return recent.isEmpty ? nil : recent
        }
        if previous != holds.count { persist() }
    }

    private func trim() {
        while holds.count > 512, let oldest = holds.min(by: { $0.value.recordedAt < $1.value.recordedAt }) { holds[oldest.key] = nil }
        if healthy.count > 512 { healthy.removeAll(keepingCapacity: true) }
    }

    private func persist() {
        guard let storageURL else { return }
        do {
            let data = try JSONEncoder().encode(holds.values.filter { $0.kind == .quota })
            try data.write(to: storageURL, options: .atomic)
            persistenceFailed = false
        } catch { persistenceFailed = true }
    }
}

extension TurnInput {
    /// A backup engine selects its own default model and starts a fresh native session.
    func forBackupEngine() -> TurnInput {
        TurnInput(threadId: threadId, botId: botId, prompt: prompt, modelId: nil,
                  resumeSessionId: nil, workingDirectory: workingDirectory,
                  environment: environment, configOptions: [:], toolPreparation: toolPreparation)
    }
}
