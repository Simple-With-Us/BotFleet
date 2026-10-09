// Settings > Models: every bot's primary model and its fallbacks on one
// screen, the phone's copy of the desktop's Models page
// (`src/components/FleetModelsSection.tsx`).
//
// Above the per-bot list sits Apply to All Bots: a Primary and three
// Fallback places, each a Set Default button until chosen, and a Set All
// Bots To Default button that makes ONE call.  Nothing is stored as a default
// afterward; each bot keeps its own list.  The rules (fixed places, the
// request body, which place offers Add Fallback, the filter and the engine
// chips) live in CompanionCore's `DefaultModelSlots.swift` and are unit
// tested; this file only draws them.
//
// The model chooser copies the bot profile's Provider and Model pickers
// rather than sharing them: those live inline in `AgentProfileView.body` on
// that view's private form state, so there is no component to reuse yet.
// Per-bot edits go through the same profile PATCH that sheet saves with.
import CompanionCore
import SwiftUI

/// Which place the chooser sheet is editing.
private enum ModelChoiceTarget: Identifiable, Hashable {
    case defaultPrimary
    case defaultFallback(Int)
    case botPrimary(String)
    case botFallback(String, Int)

    var id: String {
        switch self {
        case .defaultPrimary: return "default-primary"
        case let .defaultFallback(index): return "default-fallback-\(index)"
        case let .botPrimary(botId): return "bot-\(botId)-primary"
        case let .botFallback(botId, index): return "bot-\(botId)-fallback-\(index)"
        }
    }
}

struct FleetModelsView: View {
    @EnvironmentObject private var session: Session
    @State private var instances: [Instance] = []
    /// Whether the engine list has been fetched, so an empty list reads as
    /// "none reported" rather than "still loading".
    @State private var instancesLoaded = false
    @State private var query = ""
    /// Apply to All Bots: one slot per fixed place, nil leaves that place
    /// alone on every bot.
    @State private var primary: DefaultModelSlot?
    @State private var fallbacks: [DefaultModelSlot?] = DefaultModelSlots.emptyFallbacks()
    @State private var applying = false
    @State private var applyError: String?
    @State private var skippedSummary: String?
    @State private var choosing: ModelChoiceTarget?
    /// Bots whose model save is in flight.  Their rows wait for it, so two
    /// quick edits cannot each send a chain built from the same old one.
    @State private var savingBots: Set<String> = []

    private var standIn: Bot? { FleetModels.standIn(session.state.bots) }
    private var bots: [Bot] { FleetModels.filteredBots(session.state.bots, query: query) }
    private var spread: [FleetModels.EngineCount] { FleetModels.engineSpread(session.state.bots) }
    private var hasQuery: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        Form {
            spreadSection
            applySection
            filterSection
            botSections
        }
        .navigationTitle("Models")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadInstances() }
        .refreshable { await loadInstances() }
        .sheet(item: $choosing) { target in
            ModelChoiceSheet(
                title: choiceTitle(target),
                engines: instances,
                enginesLoaded: instancesLoaded,
                initial: initialChoice(target),
                onChoose: { instanceId, model in
                    choose(target, instanceId: instanceId, model: model)
                }
            )
        }
    }

    // MARK: - Sections

    /// How many bots sit on each engine, so the shape of the fleet is legible
    /// without reading every row.
    private var spreadSection: some View {
        Section {
            if !spread.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(spread, id: \.instanceId) { entry in
                            Text("\(engineName(entry.instanceId)) \u{00B7} \(entry.count)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(Capsule().fill(Color.secondary.opacity(0.12)))
                        }
                    }
                }
            }
        } footer: {
            Text("Every bot's primary model and its fallbacks, together.\u{00A0} A turn that fails because a model is out of capacity moves down this list, so the fallbacks matter most when a provider is having a bad day.")
        }
    }

    private var applySection: some View {
        Section {
            if let seed = standIn {
                defaultSlotRow(label: "Primary", value: primary, target: .defaultPrimary, seed: seed)
                ForEach(0..<ModelLimits.maxFallbacks, id: \.self) { index in
                    defaultSlotRow(
                        label: "Fallback \(index + 1)",
                        value: fallbackSlot(index),
                        target: .defaultFallback(index),
                        seed: seed
                    )
                }
                Button {
                    apply()
                } label: {
                    HStack {
                        Text(applying ? "Applying\u{2026}" : "Set All Bots To Default")
                        if applying {
                            Spacer()
                            ProgressView().controlSize(.small)
                        }
                    }
                }
                .disabled(applying || !DefaultModelSlots.hasDefaults(primary: primary, fallbacks: fallbacks))
                if let skippedSummary {
                    Text(skippedSummary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let applyError {
                    Text(applyError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } else {
                Text("Add a bot first to apply models to every bot.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Apply to All Bots")
        } footer: {
            if standIn != nil {
                Text("Choose models and apply them to every bot at once.\u{00A0} This is not a saved default: each bot keeps its own list afterward.\u{00A0} Empty places keep each bot's current model.\u{00A0} Fallbacks fill in order: a bot that would be left with an empty place before a chosen fallback is skipped and named under the button.")
            }
        }
    }

    private var filterSection: some View {
        Section {
            TextField("Filter by bot or model", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Filter Bots by Name or Model")
        }
    }

    @ViewBuilder
    private var botSections: some View {
        if bots.isEmpty {
            Section {
                Text(hasQuery ? "Nothing matches \u{201C}\(query)\u{201D}" : "No bots yet")
                    .foregroundStyle(.secondary)
            }
        } else {
            ForEach(bots) { bot in
                botSection(bot)
            }
        }
    }

    // MARK: - Rows

    /// One bot: who it is, its Primary, every fallback it stores, and Add
    /// Fallback at the next empty place while it is under the cap.
    private func botSection(_ bot: Bot) -> some View {
        Section {
            HStack(spacing: 12) {
                BotAvatarView(bot: bot, size: 32, state: .idle, animated: false)
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if !bot.title.isEmpty {
                        Text(bot.title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                if savingBots.contains(bot.id) {
                    ProgressView().controlSize(.small)
                }
            }

            choiceRow(
                label: "Primary",
                instanceId: bot.modelSelection.instanceId,
                model: bot.modelSelection.model,
                target: .botPrimary(bot.id),
                removeLabel: nil,
                onRemove: nil
            )
            .disabled(savingBots.contains(bot.id))

            ForEach(FleetModels.fallbackPlaces(stored: (bot.modelSelection.fallbacks ?? []).count), id: \.self) { place in
                switch place {
                case let .stored(index):
                    if let entry = fallback(of: bot, at: index) {
                        choiceRow(
                            label: "Fallback \(index + 1)",
                            instanceId: entry.instanceId,
                            model: entry.model,
                            target: .botFallback(bot.id, index),
                            removeLabel: "Remove Fallback \(index + 1) from \(bot.name)",
                            onRemove: { removeFallback(from: bot, at: index) }
                        )
                        .disabled(savingBots.contains(bot.id))
                    }
                case let .add(index):
                    Button("Add Fallback", systemImage: "plus.circle") {
                        addFallback(to: bot)
                    }
                    .disabled(savingBots.contains(bot.id))
                    .accessibilityLabel("Add Fallback \(index + 1) to \(bot.name)")
                }
            }
        }
    }

    /// An empty Apply to All Bots place is a Set Default button, seeded from
    /// the first bot so the chooser opens on a real model; a filled one is
    /// the chosen model with a clear control.
    @ViewBuilder
    private func defaultSlotRow(
        label: String,
        value: DefaultModelSlot?,
        target: ModelChoiceTarget,
        seed: Bot
    ) -> some View {
        if let slot = value {
            choiceRow(
                label: label,
                instanceId: slot.instanceId,
                model: slot.model,
                target: target,
                removeLabel: "Clear \(label)",
                onRemove: { setDefault(target, nil) }
            )
            .disabled(applying)
        } else {
            HStack {
                Text(label)
                Spacer()
                Button("Set Default", systemImage: "plus.circle") {
                    setDefault(target, DefaultModelSlots.slotFromPick(seed.modelSelection))
                }
                .buttonStyle(.borderless)
            }
            .disabled(applying)
        }
    }

    /// A place's model and engine; tapping it opens the chooser.  Separate
    /// borderless buttons so the clear control does not also open it.
    private func choiceRow(
        label: String,
        instanceId: String,
        model: String,
        target: ModelChoiceTarget,
        removeLabel: String?,
        onRemove: (() -> Void)?
    ) -> some View {
        HStack(spacing: 8) {
            Button {
                choosing = target
            } label: {
                HStack {
                    Text(label)
                        .foregroundStyle(.primary)
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(modelLabel(instanceId: instanceId, model: model))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Text(engineName(instanceId))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)

            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(removeLabel ?? "Remove")
            }
        }
    }

    // MARK: - Lookups

    private func engineName(_ instanceId: String) -> String {
        instances.first(where: { $0.instanceId == instanceId })?.settingsDisplayName ?? instanceId
    }

    private func modelLabel(instanceId: String, model: String) -> String {
        let engine = instances.first(where: { $0.instanceId == instanceId })
        return engine?.models.options.first(where: { $0.id == model })?.label ?? model
    }

    /// Nil when the engine is not in the roster, which leaves effort alone.
    private func effortLevels(instanceId: String, model: String) -> [String]? {
        instances.first(where: { $0.instanceId == instanceId })?.effortLevels(for: model)
    }

    private func fallbackSlot(_ index: Int) -> DefaultModelSlot? {
        fallbacks.indices.contains(index) ? fallbacks[index] : nil
    }

    private func fallback(of bot: Bot, at index: Int) -> ModelSelection? {
        let entries = bot.modelSelection.fallbacks ?? []
        return entries.indices.contains(index) ? entries[index] : nil
    }

    private func choiceTitle(_ target: ModelChoiceTarget) -> String {
        switch target {
        case .defaultPrimary:
            return "Primary for All Bots"
        case let .defaultFallback(index):
            return "Fallback \(index + 1) for All Bots"
        case let .botPrimary(botId):
            return "Primary for \(session.state.bot(botId)?.name ?? "Bot")"
        case let .botFallback(botId, index):
            return "Fallback \(index + 1) for \(session.state.bot(botId)?.name ?? "Bot")"
        }
    }

    private func initialChoice(_ target: ModelChoiceTarget) -> ModelSelection {
        let none = ModelSelection(instanceId: "", model: "")
        switch target {
        case .defaultPrimary:
            return primary?.selection ?? standIn?.modelSelection ?? none
        case let .defaultFallback(index):
            return fallbackSlot(index)?.selection ?? standIn?.modelSelection ?? none
        case let .botPrimary(botId):
            return session.state.bot(botId)?.modelSelection ?? none
        case let .botFallback(botId, index):
            guard let bot = session.state.bot(botId) else { return none }
            return fallback(of: bot, at: index) ?? none
        }
    }

    // MARK: - Actions

    private func loadInstances() async {
        instances = await session.instances()
        instancesLoaded = true
    }

    private func setDefault(_ target: ModelChoiceTarget, _ slot: DefaultModelSlot?) {
        switch target {
        case .defaultPrimary:
            primary = slot
        case let .defaultFallback(index):
            fallbacks = DefaultModelSlots.withSlot(fallbacks, at: index, slot)
        case .botPrimary, .botFallback:
            break
        }
    }

    private func choose(_ target: ModelChoiceTarget, instanceId: String, model: String) {
        let levels = effortLevels(instanceId: instanceId, model: model)
        switch target {
        case .defaultPrimary, .defaultFallback:
            setDefault(target, DefaultModelSlot(instanceId: instanceId, model: model))
        case let .botPrimary(botId):
            guard let bot = session.state.bot(botId) else { return }
            save(bot, FleetModels.withPrimary(
                bot.modelSelection,
                instanceId: instanceId,
                model: model,
                effortLevels: levels
            ))
        case let .botFallback(botId, index):
            guard let bot = session.state.bot(botId) else { return }
            save(bot, FleetModels.withFallback(
                bot.modelSelection,
                at: index,
                instanceId: instanceId,
                model: model,
                effortLevels: levels
            ))
        }
    }

    private func addFallback(to bot: Bot) {
        let current = session.state.bot(bot.id) ?? bot
        guard let next = FleetModels.addingFallback(current.modelSelection) else { return }
        save(current, next)
    }

    private func removeFallback(from bot: Bot, at index: Int) {
        let current = session.state.bot(bot.id) ?? bot
        save(current, FleetModels.removingFallback(current.modelSelection, at: index))
    }

    /// The same profile PATCH the bot's own sheet saves with.  A refusal (a
    /// busy bot answers 409) reaches the app-wide alert from there, and the
    /// row keeps showing what the computer has.
    private func save(_ bot: Bot, _ selection: ModelSelection) {
        guard selection != bot.modelSelection, !savingBots.contains(bot.id) else { return }
        savingBots.insert(bot.id)
        Task {
            _ = await session.updateProfile(BotProfilePatch(modelSelection: selection), for: bot)
            savingBots.remove(bot.id)
        }
    }

    private func apply() {
        guard !applying else { return }
        let primarySlot = primary
        let fallbackSlots = fallbacks
        applying = true
        applyError = nil
        skippedSummary = nil
        Task {
            let outcome = await session.applyModelDefaults(primary: primarySlot, fallbacks: fallbackSlots)
            switch outcome {
            case let .saved(result):
                skippedSummary = result.skippedSummary
                // The next action starts from a clean "nothing chosen" form.
                primary = nil
                fallbacks = DefaultModelSlots.emptyFallbacks()
            case .needsMacUpdate:
                applyError = "Update BotFleet on your Mac to apply models from your phone."
            case let .failed(message):
                applyError = message
            }
            applying = false
        }
    }
}

/// Provider, then Model, chosen the way the bot profile chooses them and
/// handed back on Done.  Effort is not chosen here: a bot keeps its own while
/// the new model still offers it, and an Apply to All Bots place never
/// carries one.
private struct ModelChoiceSheet: View {
    let title: String
    let engines: [Instance]
    let enginesLoaded: Bool
    let onChoose: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var instanceId: String
    @State private var modelId: String
    private let initialInstanceId: String

    init(
        title: String,
        engines: [Instance],
        enginesLoaded: Bool,
        initial: ModelSelection,
        onChoose: @escaping (String, String) -> Void
    ) {
        self.title = title
        self.engines = engines
        self.enginesLoaded = enginesLoaded
        self.onChoose = onChoose
        self.initialInstanceId = initial.instanceId
        _instanceId = State(initialValue: initial.instanceId)
        _modelId = State(initialValue: initial.model)
    }

    private var choosable: [Instance] {
        FleetModels.choosableEngines(engines, keeping: initialInstanceId.isEmpty ? nil : initialInstanceId)
    }

    private var selectedEngine: Instance? {
        engines.first(where: { $0.instanceId == instanceId })
    }

    var body: some View {
        NavigationStack {
            Form {
                if choosable.isEmpty {
                    Section {
                        Text(enginesLoaded
                             ? "No models to choose from.\u{00A0} Your computer did not report any."
                             : "Loading models\u{2026}")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        Picker("Provider", selection: $instanceId) {
                            ForEach(choosable) { instance in
                                Text(instance.settingsDisplayName).tag(instance.instanceId)
                            }
                        }
                        .pickerStyle(.navigationLink)
                        .onChange(of: instanceId) { _, newInstanceId in
                            if let instance = engines.first(where: { $0.instanceId == newInstanceId }),
                               !instance.models.options.contains(where: { $0.id == modelId }) {
                                modelId = instance.models.default
                            }
                        }

                        if let engine = selectedEngine {
                            Picker("Model", selection: $modelId) {
                                ForEach(engine.models.options) { option in
                                    Text(option.label).tag(option.id)
                                }
                            }
                            .pickerStyle(.navigationLink)
                        }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onChoose(instanceId, modelId)
                        dismiss()
                    }
                    .disabled(selectedEngine == nil || modelId.isEmpty)
                }
            }
        }
    }
}
