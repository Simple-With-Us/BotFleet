// Usage and cost, on the phone.
//
// Mirrors the desktop's Usage panel (`src/components/UsageSection.tsx`):
// tokens and cost per bot, what each engine has spent over the last five hours
// and week, the quotas the usage app publishes, the engines being held back,
// and the speech provider's character counts.  Read-only: nothing here changes
// a setting or a plan.
//
// The per-bot summary is added up on the phone from the bots it already holds,
// the way the desktop does it.  The rest comes from `GET /api/quotas` and
// `GET /api/tts/usage`, polled while the screen is open.
//
// Not here: the desktop's pricing plans and its API-versus-subscription
// projection, which need the engine pricing table that lives in the desktop
// build.  A spend pace stands in for the projection, and says what it is.
import CompanionCore
import SwiftUI

struct UsageView: View {
    @EnvironmentObject private var session: Session
    @State private var quotas: QuotasSnapshot?
    @State private var speech: SpeechUsage?
    /// The first read has finished, whether or not it worked.
    @State private var settled = false

    /// Sentence gap: a no-break space, then a space.
    private static let gap = "\u{00A0} "

    private var rows: [BotUsageRow] { UsageMath.summaryRows(session.state.bots) }

    private var spendRows: [EngineSpendRow] {
        guard let quotas else { return [] }
        return QuotaDisplay.spendRows(quotas.engineSpend, instances: session.cachedInstances)
    }

    var body: some View {
        List {
            summarySection
            engineSpendSection
            quotasSection
            paceSection
            speechSection
        }
        .navigationTitle("Usage & Cost")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // The engine roster names the engines; it must not hold up the
            // quotas if the computer is slow to describe them.
            Task { await session.warmInstanceDriverKinds() }
            await refresh()
            // The desktop polls every thirty seconds; so does the phone, for
            // as long as this screen is open.
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 30_000_000_000)
                } catch {
                    return
                }
                await refresh()
            }
        }
        .refreshable { await refresh() }
    }

    private func refresh() async {
        async let fetchedQuotas = session.loadQuotas()
        async let fetchedSpeech = session.loadSpeechUsage()
        let newQuotas = await fetchedQuotas
        let newSpeech = await fetchedSpeech
        // A failed refresh keeps what was on screen: a computer that sleeps for
        // a minute should not blank the quotas.
        if let newQuotas { quotas = newQuotas }
        if let newSpeech { speech = newSpeech }
        settled = true
    }

    // MARK: - Usage

    @ViewBuilder
    private var summarySection: some View {
        let rows = self.rows
        Section {
            if rows.isEmpty {
                Text("Nothing spent yet.\(Self.gap)Figures appear after a bot's first turn.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { row in
                    NavigationLink {
                        BotUsageDetailView(botId: row.botId)
                    } label: {
                        UsageFigureRow(title: row.name, usage: row.usage, emphasized: false)
                    }
                }
                UsageFigureRow(title: "All Bots", usage: UsageMath.total(rows), emphasized: true)
            }
        } header: {
            Text("Usage")
        } footer: {
            Text(summaryFooter(rows))
        }
    }

    private func summaryFooter(_ rows: [BotUsageRow]) -> String {
        var text = "Tokens and cost per bot, added up from every settled turn.\(Self.gap)A turn that ran on a fallback is billed as that fallback reported it, not as the bot's current model.\(Self.gap)Only engines that report a price show one."
        guard !rows.isEmpty else { return text }
        let total = UsageMath.total(rows)
        let cached = UsageMath.cachedInput(total)
        if cached > 0 {
            text += "\(Self.gap)Tokens count everything the model read and wrote.\(Self.gap)Each turn resends the whole conversation, so \(UsageMath.formatTokens(cached)) of the input was context re-read from the provider's cache rather than new text."
        }
        if UsageMath.hasFiniteCost(total.costUsd) {
            var billings = Set<String?>()
            for row in rows {
                billings.insert(session.cachedInstances.first { $0.instanceId == row.instanceId }?.snapshot.billing)
            }
            text += "\(Self.gap)Cost is \(UsageMath.summaryCostCaption(billings: billings))."
        }
        return text
    }

    // MARK: - Spend by engine

    @ViewBuilder
    private var engineSpendSection: some View {
        let spend = spendRows
        if !spend.isEmpty {
            Section {
                ForEach(spend) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.name)
                        HStack {
                            Text("Past 5 Hours")
                            Spacer()
                            Text(UsageMath.formatSpendUsd(row.spend.spend5hUsd)).monospacedDigit()
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        HStack {
                            Text("Past Week")
                            Spacer()
                            Text(UsageMath.formatSpendUsd(row.spend.spend7dUsd)).monospacedDigit()
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        if let note = QuotaDisplay.unpricedNote(row.spend) {
                            Text("Unpriced turns: \(note)")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                        }
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("Spend By Engine")
            } footer: {
                Text("What each engine has reported spending, over a rolling five hours and week.\(Self.gap)On a subscription a figure is an equivalent, not a charge.")
            }
        }
    }

    // MARK: - Quotas

    @ViewBuilder
    private var quotasSection: some View {
        Section {
            if let quotas {
                quotasBody(quotas)
            } else if settled {
                Text("Quota information is unavailable right now.")
                    .foregroundStyle(.secondary)
                Button("Retry") { Task { await refresh() } }
            } else {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Loading quotas…").foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Engine Quotas")
        } footer: {
            Text("Remaining usage for each engine, as the usage app on your computer reads it.\(Self.gap)Snapshots are fresh for 15 minutes.\(Self.gap)Exhausted models fail over to the saved chain before the next turn.")
        }
    }

    private func botName(_ botId: String) -> String {
        session.state.bot(botId)?.name ?? "A bot"
    }

    private func engineName(_ instanceId: String) -> String {
        session.cachedInstances.first { $0.instanceId == instanceId }?.settingsDisplayName ?? instanceId
    }

    @ViewBuilder
    private func quotasBody(_ snapshot: QuotasSnapshot) -> some View {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let held = snapshot.doomed.filter(\.isHolding)
        let groups = QuotaDisplay.groupedWindows(snapshot.windows)
        let windowCount = groups.reduce(0) { $0 + $1.windows.count }
        let notice = QuotaDisplay.localQuotaNotice(snapshot.localQuota, botFleetWindowCount: windowCount)

        if !held.isEmpty {
            heldNotice(held)
        }
        if !snapshot.fallbackChains.isEmpty {
            chainsNotice(snapshot.fallbackChains)
        }
        ForEach(snapshot.cooldowns) { cooldown in
            VStack(alignment: .leading, spacing: 2) {
                Text(cooldownTitle(cooldown))
                Text(cooldownDetail(cooldown, nowMs: nowMs))
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        ForEach(groups) { group in
            VStack(alignment: .leading, spacing: 6) {
                Text(group.title)
                    .font(.subheadline.weight(.semibold))
                ForEach(group.windows) { window in
                    HStack(alignment: .firstTextBaseline) {
                        Text(window.label)
                            .lineLimit(2)
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text(QuotaDisplay.percentText(window))
                                .monospacedDigit()
                                .foregroundStyle(window.isExhausted == true ? Color.orange : Color.primary)
                            Text(QuotaDisplay.resetText(window, nowMs: nowMs))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .font(.footnote)
                }
            }
            .padding(.vertical, 2)
        }
        if let balance = snapshot.deepseek, balance.balanceUsd != nil {
            LabeledContent("DeepSeek Balance", value: balance.line)
        }
        if let notice {
            Text(notice)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        if groups.isEmpty && snapshot.cooldowns.isEmpty && held.isEmpty && notice == nil {
            Text("No quota windows reported yet.")
                .foregroundStyle(.secondary)
        }
    }

    private func cooldownTitle(_ cooldown: QuotaCooldown) -> String {
        "\(botName(cooldown.botId)) \u{00B7} \(engineName(cooldown.instanceId))"
    }

    private func cooldownDetail(_ cooldown: QuotaCooldown, nowMs: Double) -> String {
        let message = cooldown.error.isEmpty ? "Session limit or usage quota reached" : cooldown.error
        let countdown = QuotaDisplay.cooldownCountdown(resetsAtMs: cooldown.resetsAt, nowMs: nowMs)
        return "\(message) \u{00B7} \(countdown)"
    }

    private func heldNotice(_ held: [DoomedPair]) -> some View {
        // Count bots, not pairs: one bot whose primary and fallback both opened
        // breakers is one bot being held.
        let botCount = Set(held.map(\.botId)).count
        return VStack(alignment: .leading, spacing: 6) {
            Text(QuotaDisplay.heldHeading(botCount: botCount))
                .font(.subheadline.weight(.semibold))
            Text("These bots cannot start their engine, so their scheduled work is queued rather than failed \u{2014} it runs on its own once the engine comes back.\(Self.gap)Each attempt is being counted, so this is not a stuck scheduler.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ForEach(held) { pair in
                Text(heldLine(pair))
                    .font(.footnote)
            }
        }
        .padding(.vertical, 2)
    }

    private func heldLine(_ pair: DoomedPair) -> String {
        let times = pair.consecutiveFailures == 1 ? "time" : "times"
        var line = "\(engineName(pair.instanceId)) for \(botName(pair.botId)) \u{2014} failed to start \(pair.consecutiveFailures) \(times)"
        if let reason = pair.lastError, !reason.isEmpty { line += ": \(reason)" }
        return line
    }

    private func chainsNotice(_ chains: [RedundantChain]) -> some View {
        let botCount = Set(chains.map(\.botId)).count
        return VStack(alignment: .leading, spacing: 6) {
            Text(QuotaDisplay.redundantHeading(botCount: botCount))
                .font(.subheadline.weight(.semibold))
            ForEach(chains) { chain in
                Text(chainLine(chain))
                    .font(.footnote)
            }
        }
        .padding(.vertical, 2)
    }

    private func chainLine(_ chain: RedundantChain) -> String {
        var line = chain.name.isEmpty ? botName(chain.botId) : chain.name
        if chain.scope == "task" {
            line += "\u{00A0}\u{00A0}task \(chain.threadId.map { String($0.prefix(8)) } ?? "?")"
        }
        line += " \u{2014} \(chain.total) configured, \(chain.effective) usable"
        for entry in chain.redundant {
            line += " (\(entry.model) \(entry.reason == "same-as-primary" ? "is the primary again" : "repeats an earlier entry"))"
        }
        return line
    }

    // MARK: - Pace

    @ViewBuilder
    private var paceSection: some View {
        let spend = spendRows.filter { $0.spend.spend7dUsd > 0 }
        let total = QuotaDisplay.monthlyPace(spend)
        if total > 0 {
            Section {
                ForEach(spend) { row in
                    LabeledContent(row.name, value: "\(UsageMath.formatSpendUsd(QuotaDisplay.monthlyPace(row.spend))) per 30 days")
                }
                LabeledContent("All Engines", value: "\(UsageMath.formatSpendUsd(total)) per 30 days")
                    .fontWeight(.semibold)
            } header: {
                Text("Spend Pace")
            } footer: {
                Text("The past week's spend scaled to 30 days.\(Self.gap)A pace, not a forecast, and a floor when an engine has turns it could not price.\(Self.gap)On a subscription a figure is an equivalent, not a charge.\(Self.gap)The comparison with pay-as-you-go API rates is on your computer.")
            }
        }
    }

    // MARK: - Speech

    @ViewBuilder
    private var speechSection: some View {
        Section {
            if let speech {
                Text(speech.line)
            } else {
                Text("Speech usage unavailable")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Speech Synthesis")
        } footer: {
            Text("Speech is measured in characters, not model tokens.\(Self.gap)Counts include successful requests on your computer only.")
        }
    }
}

/// One line of the summary: a name, how much it did, and what it cost.
private struct UsageFigureRow: View {
    let title: String
    let usage: UsageTotals
    let emphasized: Bool

    private var turnsText: String {
        let turns = Int(usage.turns)
        return "\(turns) \(turns == 1 ? "turn" : "turns")"
    }

    private var costText: String {
        UsageMath.hasFiniteCost(usage.costUsd) ? UsageMath.formatUsd(usage.costUsd ?? 0) : "\u{2014}"
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .fontWeight(emphasized ? .semibold : .regular)
                Text("\(turnsText) \u{00B7} \(UsageMath.formatTokens(usage.tokens)) tokens")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(UsageMath.usageDetail(usage))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Text(costText)
                .fontWeight(emphasized ? .semibold : .regular)
                .monospacedDigit()
                .foregroundStyle(UsageMath.hasFiniteCost(usage.costUsd) ? Color.primary : Color.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One bot's usage by model and by session, the detail the desktop opens when
/// a bot's row is expanded.
struct BotUsageDetailView: View {
    let botId: String

    @EnvironmentObject private var session: Session

    private static let gap = "\u{00A0} "

    private var bot: Bot? { session.state.bot(botId) }

    /// A model's own label from the engine roster when there is one, else its id.
    private func modelLabel(_ id: String) -> String {
        for instance in session.cachedInstances {
            if let option = instance.models.options.first(where: { $0.id == id }) { return option.label }
        }
        return id
    }

    var body: some View {
        if let bot {
            List {
                modelsSection(bot)
                sessionsSection(bot)
            }
            .navigationTitle(bot.name)
            .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("Bot Not Found", systemImage: "questionmark.circle")
        }
    }

    @ViewBuilder
    private func modelsSection(_ bot: Bot) -> some View {
        let models = UsageMath.botUsageByModel(bot)
        if !models.isEmpty {
            Section {
                ForEach(models) { summary in
                    figureBlock(
                        title: modelLabel(summary.model),
                        usage: summary.usage,
                        perTurn: summary.perTurnCost,
                        trailing: nil
                    )
                }
                if models.count > 1 {
                    let total = UsageMath.sum(models.map(\.usage))
                    let perTurn: Double? = UsageMath.hasFiniteCost(total.costUsd) && total.turns > 0
                        ? (total.costUsd ?? 0) / total.turns
                        : nil
                    figureBlock(title: "Total Across Models", usage: total, perTurn: perTurn, trailing: nil)
                        .fontWeight(.semibold)
                }
            } header: {
                Text("Usage By Model")
            } footer: {
                Text("Each turn is counted under the model that ran it, so a fallback shows as itself.")
            }
        }
    }

    @ViewBuilder
    private func sessionsSection(_ bot: Bot) -> some View {
        let sessions = UsageMath.sessionRows(bot)
        if !sessions.isEmpty {
            Section {
                ForEach(sessions) { row in
                    figureBlock(
                        title: row.title,
                        usage: row.usage,
                        perTurn: row.perTurnCost,
                        trailing: sessionCaption(row)
                    )
                }
            } header: {
                Text("Sessions")
            } footer: {
                Text("Newest first.\(Self.gap)The running totals count from the oldest session, so they only grow.")
            }
        }
    }

    private func sessionCaption(_ row: UsageSessionRow) -> String {
        var parts: [String] = []
        if row.at > 0 { parts.append(OwnerClock.stamp(ms: row.at)) }
        parts.append(modelLabel(row.model))
        let costPart = UsageMath.hasFiniteCost(row.usage.costUsd)
            ? " \u{00B7} \(UsageMath.formatUsd(row.cumulativeCost)) cumulative"
            : ""
        return parts.joined(separator: " \u{00B7} ") + "\n\(UsageMath.formatTokens(row.cumulativeTokens)) tokens cumulative\(costPart)"
    }

    /// "3 turns · 600 in · 300 cached · 120 out · $0.01 per turn"
    private func figureLine(usage: UsageTotals, perTurn: Double?) -> String {
        let turns = Int(usage.turns)
        let cached = UsageMath.cachedInput(usage)
        var parts: [String] = ["\(turns) \(turns == 1 ? "turn" : "turns")", "\(UsageMath.formatTokens(usage.input)) in"]
        if cached > 0 { parts.append("\(UsageMath.formatTokens(cached)) cached") }
        parts.append("\(UsageMath.formatTokens(usage.output)) out")
        parts.append("\(perTurn.map { UsageMath.formatUsd($0) } ?? "\u{2014}") per turn")
        return parts.joined(separator: " \u{00B7} ")
    }

    private func figureBlock(title: String, usage: UsageTotals, perTurn: Double?, trailing: String?) -> some View {
        let cost = UsageMath.hasFiniteCost(usage.costUsd) ? UsageMath.formatUsd(usage.costUsd ?? 0) : "\u{2014}"
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .lineLimit(2)
                Spacer()
                Text(cost)
                    .monospacedDigit()
            }
            Text(figureLine(usage: usage, perTurn: perTurn))
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let trailing {
                Text(trailing)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
