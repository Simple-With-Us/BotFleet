// What `GET /api/quotas` knows that the phone cannot work out for itself:
// the quota windows the native usage app publishes, rolling per-engine spend,
// the engines that are out of quota or cannot start, and fallback chains
// that are shorter than they look.
//
// Mirrors the read side of `src/components/UsageSection.tsx`.  The route
// carries no key or token.  Every list is decoded one element at a time, so a
// row this build cannot read is left out and the rest still show; and every
// scalar is `try?`, so a harness that changes one field's type costs that
// field and not the screen.
import Foundation

private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

/// One engine's rolling spend as the tracker reports it.
public struct EngineSpend: Codable, Hashable, Sendable {
    public var spend5hUsd: Double
    public var spend7dUsd: Double
    /// Settled turns the engine could not price.  A non-zero count means the
    /// dollar figures beside it are a floor, not a total.
    public var unpricedTurns5h: Double?
    public var unpricedTurns7d: Double?

    private enum CodingKeys: String, CodingKey { case spend5hUsd, spend7dUsd, unpricedTurns5h, unpricedTurns7d }

    public init(spend5hUsd: Double = 0, spend7dUsd: Double = 0, unpricedTurns5h: Double? = nil, unpricedTurns7d: Double? = nil) {
        self.spend5hUsd = spend5hUsd
        self.spend7dUsd = spend7dUsd
        self.unpricedTurns5h = unpricedTurns5h
        self.unpricedTurns7d = unpricedTurns7d
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        spend5hUsd = (try? container.decodeIfPresent(Double.self, forKey: .spend5hUsd)) ?? 0
        spend7dUsd = (try? container.decodeIfPresent(Double.self, forKey: .spend7dUsd)) ?? 0
        unpricedTurns5h = try? container.decodeIfPresent(Double.self, forKey: .unpricedTurns5h)
        unpricedTurns7d = try? container.decodeIfPresent(Double.self, forKey: .unpricedTurns7d)
    }

    /// Dollars or unpriced turns.  An engine that settled work but reported no
    /// cost has spent money the screen cannot price, and a blank row is not
    /// the same as no activity.
    public var hasActivity: Bool {
        spend5hUsd > 0 || spend7dUsd > 0 || (unpricedTurns5h ?? 0) > 0 || (unpricedTurns7d ?? 0) > 0
    }

    public var unpricedTurns: Double { (unpricedTurns5h ?? 0) + (unpricedTurns7d ?? 0) }
}

/// One quota window from the native usage app's handoff: a percentage of an
/// allowance left, and when it refills.
public struct QuotaWindow: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var provider: String
    public var providerKey: String?
    public var providerLabel: String?
    public var sourceApp: String?
    public var via: String?
    public var label: String
    public var remainingPercent: Double?
    /// ISO-8601.
    public var resetAt: String?
    public var skip: Bool
    public var planName: String?
    public var isExhausted: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, provider, providerKey, providerLabel, sourceApp, via, label, remainingPercent, resetAt, skip, planName, isExhausted
    }

    public init(
        id: String,
        provider: String,
        providerKey: String? = nil,
        providerLabel: String? = nil,
        sourceApp: String? = nil,
        via: String? = nil,
        label: String,
        remainingPercent: Double? = nil,
        resetAt: String? = nil,
        skip: Bool = false,
        planName: String? = nil,
        isExhausted: Bool? = nil
    ) {
        self.id = id
        self.provider = provider
        self.providerKey = providerKey
        self.providerLabel = providerLabel
        self.sourceApp = sourceApp
        self.via = via
        self.label = label
        self.remainingPercent = remainingPercent
        self.resetAt = resetAt
        self.skip = skip
        self.planName = planName
        self.isExhausted = isExhausted
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let provider = (try? container.decodeIfPresent(String.self, forKey: .provider)) ?? ""
        let label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? ""
        self.provider = provider
        self.label = label
        id = (try? container.decodeIfPresent(String.self, forKey: .id)) ?? "\(provider):\(label)"
        providerKey = try? container.decodeIfPresent(String.self, forKey: .providerKey)
        providerLabel = try? container.decodeIfPresent(String.self, forKey: .providerLabel)
        sourceApp = try? container.decodeIfPresent(String.self, forKey: .sourceApp)
        via = try? container.decodeIfPresent(String.self, forKey: .via)
        remainingPercent = try? container.decodeIfPresent(Double.self, forKey: .remainingPercent)
        resetAt = try? container.decodeIfPresent(String.self, forKey: .resetAt)
        skip = (try? container.decodeIfPresent(Bool.self, forKey: .skip)) ?? false
        planName = try? container.decodeIfPresent(String.self, forKey: .planName)
        isExhausted = try? container.decodeIfPresent(Bool.self, forKey: .isExhausted)
    }
}

/// A bot and engine pair that is out of quota until `resetsAt`.
public struct QuotaCooldown: Codable, Hashable, Identifiable, Sendable {
    public var botId: String
    public var instanceId: String
    public var model: String
    /// Epoch milliseconds, when the engine said when it refills.
    public var resetsAt: Double?
    public var error: String

    public var id: String { "\(botId)|\(instanceId)|\(model)" }

    private enum CodingKeys: String, CodingKey { case botId, instanceId, model, resetsAt, error }

    public init(botId: String, instanceId: String, model: String = "", resetsAt: Double? = nil, error: String = "") {
        self.botId = botId
        self.instanceId = instanceId
        self.model = model
        self.resetsAt = resetsAt
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        botId = try container.decode(String.self, forKey: .botId)
        instanceId = try container.decode(String.self, forKey: .instanceId)
        model = (try? container.decodeIfPresent(String.self, forKey: .model)) ?? ""
        resetsAt = try? container.decodeIfPresent(Double.self, forKey: .resetsAt)
        error = (try? container.decodeIfPresent(String.self, forKey: .error)) ?? ""
    }
}

/// A bot and engine pair the dispatcher is refusing to start.
public struct DoomedPair: Codable, Hashable, Identifiable, Sendable {
    public var botId: String
    public var instanceId: String
    public var consecutiveFailures: Int
    public var lastError: String?
    /// Whether the breaker is refusing dispatches right now.  Absent on a
    /// harness that predates the flag, and absent means open.
    public var open: Bool?
    /// Whether an open breaker here is actually holding this bot (the engine
    /// it names is one the bot's work could be on).  Absent means "same as
    /// `open`": showing the entry is the safe direction, since an over-warning
    /// costs a glance and a hidden hold loses the one stop worth seeing.
    public var holds: Bool?

    public var id: String { "\(botId)|\(instanceId)" }

    /// `holds ?? open ?? true`, the desktop's own rule.
    public var isHolding: Bool { holds ?? open ?? true }

    private enum CodingKeys: String, CodingKey { case botId, instanceId, consecutiveFailures, lastError, open, holds }

    public init(botId: String, instanceId: String, consecutiveFailures: Int = 0, lastError: String? = nil, open: Bool? = nil, holds: Bool? = nil) {
        self.botId = botId
        self.instanceId = instanceId
        self.consecutiveFailures = consecutiveFailures
        self.lastError = lastError
        self.open = open
        self.holds = holds
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        botId = try container.decode(String.self, forKey: .botId)
        instanceId = try container.decode(String.self, forKey: .instanceId)
        consecutiveFailures = (try? container.decodeIfPresent(Int.self, forKey: .consecutiveFailures)) ?? 0
        lastError = try? container.decodeIfPresent(String.self, forKey: .lastError)
        open = try? container.decodeIfPresent(Bool.self, forKey: .open)
        holds = try? container.decodeIfPresent(Bool.self, forKey: .holds)
    }
}

/// A bot whose configured fallback chain is longer than the runtime will walk.
public struct RedundantChain: Codable, Hashable, Identifiable, Sendable {
    public struct Entry: Codable, Hashable, Sendable {
        public var instanceId: String
        public var model: String
        /// `same-as-primary` or `duplicate`.
        public var reason: String

        public init(instanceId: String = "", model: String = "", reason: String = "") {
            self.instanceId = instanceId
            self.model = model
            self.reason = reason
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            instanceId = (try? container.decodeIfPresent(String.self, forKey: .instanceId)) ?? ""
            model = (try? container.decodeIfPresent(String.self, forKey: .model)) ?? ""
            reason = (try? container.decodeIfPresent(String.self, forKey: .reason)) ?? ""
        }

        private enum CodingKeys: String, CodingKey { case instanceId, model, reason }
    }

    public var botId: String
    public var name: String
    /// `bot` or `task`.
    public var scope: String?
    public var threadId: String?
    public var total: Int
    public var effective: Int
    public var redundant: [Entry]

    public var id: String { "\(botId)|\(scope ?? "bot")|\(threadId ?? "-")" }

    private enum CodingKeys: String, CodingKey { case botId, name, scope, threadId, total, effective, redundant }

    public init(botId: String, name: String = "", scope: String? = nil, threadId: String? = nil, total: Int = 0, effective: Int = 0, redundant: [Entry] = []) {
        self.botId = botId
        self.name = name
        self.scope = scope
        self.threadId = threadId
        self.total = total
        self.effective = effective
        self.redundant = redundant
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        botId = try container.decode(String.self, forKey: .botId)
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? ""
        scope = try? container.decodeIfPresent(String.self, forKey: .scope)
        threadId = try? container.decodeIfPresent(String.self, forKey: .threadId)
        total = (try? container.decodeIfPresent(Int.self, forKey: .total)) ?? 0
        effective = (try? container.decodeIfPresent(Int.self, forKey: .effective)) ?? 0
        redundant = (try? container.decodeIfPresent([Lossy<Entry>].self, forKey: .redundant))?.compactMap(\.value) ?? []
    }
}

/// DeepSeek's prepaid balance, fetched best-effort by the harness.
public struct DeepSeekBalance: Codable, Hashable, Sendable {
    public var balanceUsd: Double?
    public var grantedUsd: Double?
    public var toppedUpUsd: Double?
    /// `available`, `exhausted` or `unknown`.
    public var availability: String
    public var error: String?

    private enum CodingKeys: String, CodingKey { case balanceUsd, grantedUsd, toppedUpUsd, availability, error }

    public init(balanceUsd: Double? = nil, grantedUsd: Double? = nil, toppedUpUsd: Double? = nil, availability: String = "unknown", error: String? = nil) {
        self.balanceUsd = balanceUsd
        self.grantedUsd = grantedUsd
        self.toppedUpUsd = toppedUpUsd
        self.availability = availability
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        balanceUsd = try? container.decodeIfPresent(Double.self, forKey: .balanceUsd)
        grantedUsd = try? container.decodeIfPresent(Double.self, forKey: .grantedUsd)
        toppedUpUsd = try? container.decodeIfPresent(Double.self, forKey: .toppedUpUsd)
        availability = (try? container.decodeIfPresent(String.self, forKey: .availability)) ?? "unknown"
        error = try? container.decodeIfPresent(String.self, forKey: .error)
    }

    /// "$4.20 remaining", "$0.00 remaining" or "Balance unavailable".
    public var line: String {
        guard let balanceUsd, balanceUsd.isFinite else { return "Balance unavailable" }
        if balanceUsd == 0 { return "$0.00 remaining" }
        return String(format: "$%.2f remaining", balanceUsd)
    }
}

/// Why the local quota handoff is missing or stale.
public struct LocalQuotaFreshness: Codable, Hashable, Sendable {
    public var state: String?
    /// ISO-8601.
    public var generatedAt: String?
    public var producer: String?

    private enum CodingKeys: String, CodingKey { case state, generatedAt, producer }

    public init(state: String? = nil, generatedAt: String? = nil, producer: String? = nil) {
        self.state = state
        self.generatedAt = generatedAt
        self.producer = producer
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try? container.decodeIfPresent(String.self, forKey: .state)
        generatedAt = try? container.decodeIfPresent(String.self, forKey: .generatedAt)
        producer = try? container.decodeIfPresent(String.self, forKey: .producer)
    }
}

/// `GET /api/quotas`.
public struct QuotasSnapshot: Decodable, Hashable, Sendable {
    public var cooldowns: [QuotaCooldown]
    public var doomed: [DoomedPair]
    public var fallbackChains: [RedundantChain]
    public var windows: [QuotaWindow]
    public var localQuota: LocalQuotaFreshness?
    public var deepseek: DeepSeekBalance?
    /// Keyed by driver kind or instance id.
    public var engineSpend: [String: EngineSpend]

    private enum CodingKeys: String, CodingKey {
        case cooldowns, doomed, fallbackChains, windows, localQuota, deepseek, engineSpend
    }

    public init(
        cooldowns: [QuotaCooldown] = [],
        doomed: [DoomedPair] = [],
        fallbackChains: [RedundantChain] = [],
        windows: [QuotaWindow] = [],
        localQuota: LocalQuotaFreshness? = nil,
        deepseek: DeepSeekBalance? = nil,
        engineSpend: [String: EngineSpend] = [:]
    ) {
        self.cooldowns = cooldowns
        self.doomed = doomed
        self.fallbackChains = fallbackChains
        self.windows = windows
        self.localQuota = localQuota
        self.deepseek = deepseek
        self.engineSpend = engineSpend
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cooldowns = (try? container.decodeIfPresent([Lossy<QuotaCooldown>].self, forKey: .cooldowns))?.compactMap(\.value) ?? []
        doomed = (try? container.decodeIfPresent([Lossy<DoomedPair>].self, forKey: .doomed))?.compactMap(\.value) ?? []
        fallbackChains = (try? container.decodeIfPresent([Lossy<RedundantChain>].self, forKey: .fallbackChains))?.compactMap(\.value) ?? []
        windows = (try? container.decodeIfPresent([Lossy<QuotaWindow>].self, forKey: .windows))?.compactMap(\.value) ?? []
        localQuota = try? container.decodeIfPresent(LocalQuotaFreshness.self, forKey: .localQuota)
        deepseek = try? container.decodeIfPresent(DeepSeekBalance.self, forKey: .deepseek)
        let rawSpend = try? container.decodeIfPresent([String: Lossy<EngineSpend>].self, forKey: .engineSpend)
        engineSpend = rawSpend?.compactMapValues(\.value) ?? [:]
    }
}

/// `GET /api/tts/usage`: the speech provider's character counts.  Speech is
/// billed by characters, not model tokens.
public struct SpeechUsage: Decodable, Hashable, Sendable {
    public var minimaxCharacters: Double
    public var minimaxRequests: Double

    private enum CodingKeys: String, CodingKey { case totals }
    private enum TotalsKeys: String, CodingKey { case minimax }
    private enum MiniMaxKeys: String, CodingKey { case characters, requests }

    public init(minimaxCharacters: Double = 0, minimaxRequests: Double = 0) {
        self.minimaxCharacters = minimaxCharacters
        self.minimaxRequests = minimaxRequests
    }

    public init(from decoder: Decoder) throws {
        // Every step is `try?`: a provider table that reshapes costs the
        // counts, not the screen they sit on.
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let totals = try? container.nestedContainer(keyedBy: TotalsKeys.self, forKey: .totals)
        let minimax = try? totals?.nestedContainer(keyedBy: MiniMaxKeys.self, forKey: .minimax)
        minimaxCharacters = (try? minimax?.decodeIfPresent(Double.self, forKey: .characters)) ?? 0
        minimaxRequests = (try? minimax?.decodeIfPresent(Double.self, forKey: .requests)) ?? 0
    }

    /// "MiniMax: 12,400 characters (31 requests)"
    public var line: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        let characters = formatter.string(from: NSNumber(value: minimaxCharacters)) ?? "0"
        let requests = Int(minimaxRequests)
        return "MiniMax: \(characters) characters (\(requests) \(requests == 1 ? "request" : "requests"))"
    }
}

/// The windows of one provider, under the provider's own name.
public struct QuotaWindowGroup: Hashable, Identifiable, Sendable {
    public var title: String
    public var windows: [QuotaWindow]
    public var id: String { title }
}

/// What the Quotas section says.  Pure, with the clock passed in.
public enum QuotaDisplay {
    private static let supportedProviders: Set<String> = [
        "anthropic", "openai", "google-antigravity", "cursor", "xai", "minimax", "deepseek", "dsh",
    ]
    private static let aliases: [String: String] = [
        "claude": "anthropic",
        "claude-code": "anthropic",
        "chatgpt": "openai",
        "codex": "openai",
        "openai-codex": "openai",
        "antigravity": "google-antigravity",
        "antigravity-cli": "google-antigravity",
        "cursor-cli": "cursor",
        "grok": "xai",
        "grok-build": "xai",
        "minimax-code": "minimax",
    ]

    /// `trim`, lowercase, and runs of underscores or whitespace folded to "-".
    static func normalizedKey(_ value: String?) -> String {
        let lowered = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lowered.replacingOccurrences(of: "[_\\s]+", with: "-", options: .regularExpression)
    }

    private static func canonicalProvider(_ window: QuotaWindow) -> String {
        if normalizedKey(window.via) == "antigravity" { return "google-antigravity" }
        let raw = (window.providerKey?.isEmpty == false ? window.providerKey : nil) ?? window.provider
        let key = normalizedKey(raw)
        return aliases[key] ?? key
    }

    /// Only providers with a BotFleet engine appear, as on the desktop
    /// (`isBotFleetQuotaWindow`).  A bare OpenAI provider is ambiguous for
    /// custom OpenAI-compatible engines, so it needs Codex's own source
    /// identity; Grok Bot is a different product from Grok CLI.
    public static func isBotFleetWindow(_ window: QuotaWindow) -> Bool {
        let identity = [window.providerKey, window.provider, window.sourceApp, window.label]
            .compactMap { $0 }
            .joined(separator: " ")
        if identity.range(of: "grok[-_ ]?bot", options: [.regularExpression, .caseInsensitive]) != nil { return false }
        guard supportedProviders.contains(canonicalProvider(window)) else { return false }
        let rawKey = normalizedKey((window.providerKey?.isEmpty == false ? window.providerKey : nil) ?? window.provider)
        if rawKey != "openai" { return true }
        let source = [window.sourceApp ?? "", window.label].joined(separator: " ")
        return source.range(of: "codex|chatgpt", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The windows worth a row, grouped under the provider's own name, in the
    /// order providers first appear and by label within one.
    public static func groupedWindows(_ windows: [QuotaWindow]) -> [QuotaWindowGroup] {
        var order: [String] = []
        var groups: [String: [QuotaWindow]] = [:]
        for window in windows where isBotFleetWindow(window) && !window.skip {
            let title = [window.providerLabel, window.provider]
                .compactMap { $0 }
                .first(where: { !$0.isEmpty }) ?? "Other"
            if groups[title] == nil { order.append(title) }
            groups[title, default: []].append(window)
        }
        return order.map { title in
            QuotaWindowGroup(title: title, windows: (groups[title] ?? []).sorted { $0.label < $1.label })
        }
    }

    /// "62% remaining", or "not reported" when the percentage is missing or
    /// outside 0...100.
    public static func percentText(_ window: QuotaWindow) -> String {
        guard let percent = window.remainingPercent, percent.isFinite, percent >= 0, percent <= 100 else {
            return "not reported"
        }
        return "\(Int(percent.rounded()))% remaining"
    }

    /// "resets in 2h 5m", or "reset unknown".
    public static func resetText(_ window: QuotaWindow, nowMs: Double) -> String {
        guard let iso = window.resetAt, let resetMs = OwnerClock.milliseconds(iso: iso) else { return "reset unknown" }
        let countdown = OwnerClock.countdown(untilMs: resetMs, nowMs: nowMs)
        return countdown == "resetting now" ? countdown : "resets in \(countdown)"
    }

    /// The cooldown line: "Resets in 2h 5m", "Refreshing now", or "Rolling
    /// refresh window" when the engine named no time.  Port of
    /// `formatCountdown` in `UsageSection.tsx`.
    public static func cooldownCountdown(resetsAtMs: Double?, nowMs: Double) -> String {
        guard let resetsAtMs, resetsAtMs != 0 else { return "Rolling refresh window" }
        let diff = resetsAtMs - nowMs
        if diff <= 0 { return "Refreshing now" }
        let seconds = Int((diff / 1000).rounded(.down))
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 { return "Resets in \(hours)h \(minutes)m" }
        return "Resets in \(minutes)m"
    }

    /// The heading above the held bots: "1 Bot Is Being Held".
    public static func heldHeading(botCount: Int) -> String {
        botCount == 1 ? "1 Bot Is Being Held" : "\(botCount) Bots Are Being Held"
    }

    /// The heading above the redundant fallback chains.
    public static func redundantHeading(botCount: Int) -> String {
        botCount == 1
            ? "1 Bot's Fallback Chain Is Shorter Than It Looks"
            : "\(botCount) Bots' Fallback Chains Are Shorter Than They Look"
    }

    /// Why the quota grid is empty or old, in the native app's own name:
    /// shown when no BotFleet window arrived at all, or the handoff stopped
    /// being refreshed while the phone kept showing the last of it.  An empty
    /// grid with no explanation is what let that app quit unnoticed.  Port of
    /// `localQuotaStatusLine`.
    public static func localQuotaNotice(_ freshness: LocalQuotaFreshness?, botFleetWindowCount: Int) -> String? {
        let state = freshness?.state ?? ""
        guard botFleetWindowCount == 0 || state == "stale" || state == "unreadable" else { return nil }
        if state.isEmpty || state == "fresh" { return nil }
        let producer = producerLabel(freshness?.producer)
        if state == "missing" { return "\(producer) is not running, so no local subscription quota is available" }
        if state == "stale" {
            if let iso = freshness?.generatedAt, let ms = OwnerClock.milliseconds(iso: iso) {
                return "\(producer) has not written quota since \(OwnerClock.time(ms: ms))"
            }
            return "\(producer) has not written quota recently"
        }
        return "\(producer)'s quota file could not be read"
    }

    /// The app that writes the local handoff.  CodeCaps renamed itself on the
    /// wire from `agent-bar`; both spellings read as CodeCaps.
    static func producerLabel(_ producer: String?) -> String {
        let value = (producer ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value == "usage-monitor" { return "Usage Monitor" }
        return "CodeCaps"
    }

    /// The past week's priced spend scaled to thirty days.  A pace, not a
    /// forecast: it assumes next month looks like this week, and it is a floor
    /// when an engine has turns it could not price.
    public static func monthlyPace(_ spend: EngineSpend) -> Double {
        spend.spend7dUsd * 30 / 7
    }

    /// The pace across every row.  Rows are one per engine, so the sum counts
    /// each turn once.
    public static func monthlyPace(_ rows: [EngineSpendRow]) -> Double {
        rows.reduce(0) { $0 + monthlyPace($1.spend) }
    }

    /// Engines the desktop hides from its quota section: unused ones stay
    /// hidden even when old spend exists.
    static func isHiddenQuotaEngine(_ driverKind: String) -> Bool {
        let key = driverKind.lowercased().filter { $0.isLetter || $0.isNumber }
        let trimmed = key.hasSuffix("agent") ? String(key.dropLast(5)) : key
        return ["kimi", "moonshot", "geminicli", "githubcopilot", "copilot", "windsurf", "grokbot"].contains(trimmed)
    }

    /// One row per engine that has spent anything.
    ///
    /// The tracker books every turn under BOTH its provider and its instance
    /// id (and DeepSeek under two aliases) so that either lookup finds it, so
    /// the table cannot be read key by key: that counts each turn twice.  The
    /// desktop looks up each engine in turn, `driverKind` first; this does the
    /// same, and drops a second engine that resolved to a key already shown
    /// rather than print one figure twice.
    public static func spendRows(_ table: [String: EngineSpend], instances: [Instance]) -> [EngineSpendRow] {
        var rows: [EngineSpendRow] = []
        var usedKeys = Set<String>()
        for instance in instances where instance.isEnabled && !instance.snapshot.isHidden && !isHiddenQuotaEngine(instance.driverKind) {
            let isDeepSeek = ["deepseekAgent", "dshAgent", "deepseek"].contains(instance.driverKind)
            var key: String?
            if table[instance.driverKind] != nil {
                key = instance.driverKind
            } else if table[instance.instanceId] != nil {
                key = instance.instanceId
            } else if isDeepSeek {
                key = table["deepseek"] != nil ? "deepseek" : (table["deepseekAgent"] != nil ? "deepseekAgent" : nil)
            }
            guard let key, let spend = table[key], spend.hasActivity, usedKeys.insert(key).inserted else { continue }
            rows.append(EngineSpendRow(id: instance.instanceId, name: instance.settingsDisplayName, driverKind: instance.driverKind, spend: spend))
        }
        return rows.sorted { a, b in
            if a.spend.spend7dUsd != b.spend.spend7dUsd { return a.spend.spend7dUsd > b.spend.spend7dUsd }
            return a.name < b.name
        }
    }

    /// "5 could not be costed" copy for an engine with unpriced turns: said in
    /// words, because a confident dollar total that quietly excludes them is
    /// worse than none.  The count is a floor on what is unaccounted for.
    public static func unpricedNote(_ spend: EngineSpend) -> String? {
        let count = Int(spend.unpricedTurns)
        guard count > 0 else { return nil }
        return "\(count) could not be costed \u{2014} the totals above exclude them"
    }
}

/// One engine's spend, ready to show.
public struct EngineSpendRow: Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var driverKind: String
    public var spend: EngineSpend

    public init(id: String, name: String, driverKind: String, spend: EngineSpend) {
        self.id = id
        self.name = name
        self.driverKind = driverKind
        self.spend = spend
    }
}
