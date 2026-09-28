import AVFAudio
import CompanionCore
import PhotosUI
import SwiftUI
import UIKit

/// The paired-safe subset of an agent profile. Shared provider keys remain on
/// the computer; the phone sees only configured/not-configured status and the
/// renderer-neutral voice/avatar operations.
struct AgentProfileView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var title: String
    @State private var description: String
    @State private var notifications: Bool
    @State private var crop: AvatarCrop
    @State private var voice: String
    @State private var speechDevices: Set<String>
    @State private var instanceId: String
    @State private var modelId: String
    @State private var effort: String?
    @State private var fallbacks: [ModelSelection]
    @State private var maxToolRoundsText: String
    @State private var photo: PhotosPickerItem?
    @State private var prompt = ""
    @State private var voices: [Voice] = []
    @State private var instances: [Instance] = []
    /// Whether the engine list has been fetched yet.  Without this an empty
    /// list is indistinguishable from a slow one, and the picker sat on
    /// "Loading models…" forever whenever the fetch timed out.
    @State private var instancesLoaded = false
    @State private var config: ConfigStatus?
    @State private var busy = false
    @State private var player: AVAudioPlayer?
    @State private var autoApprove: Bool
    @State private var autoReview: String
    @State private var approvePeerComms: Bool
    @State private var computers: Set<String>
    @State private var cwd: String
    @State private var baseline: ProfileFormSnapshot

    init(bot: Bot) {
        self.bot = bot
        _name = State(initialValue: bot.name)
        _title = State(initialValue: bot.title)
        _description = State(initialValue: bot.description)
        _notifications = State(initialValue: bot.notifications)
        _crop = State(initialValue: bot.avatarCrop ?? .mascot)
        _voice = State(initialValue: bot.voice ?? "")
        _speechDevices = State(initialValue: Set(bot.speechDevices ?? (bot.speakReplies == true ? ["mac"] : [])))
        _instanceId = State(initialValue: bot.modelSelection.instanceId)
        _modelId = State(initialValue: bot.modelSelection.model)
        _effort = State(initialValue: bot.modelSelection.effort)
        _fallbacks = State(initialValue: bot.modelSelection.fallbacks ?? [])
        _maxToolRoundsText = State(initialValue: Self.roundsText(bot.maxToolRounds))
        _autoApprove = State(initialValue: bot.autoApprove ?? false)
        _autoReview = State(initialValue: bot.autoReview ?? "off")
        _approvePeerComms = State(initialValue: bot.approvePeerComms ?? false)
        _computers = State(initialValue: Set(bot.computers ?? []))
        _cwd = State(initialValue: bot.cwd ?? "")
        _baseline = State(initialValue: ProfileFormSnapshot(bot: bot))
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var imageGenerationReady: Bool { config?.imageGen?.configured == true }
    private var voiceConfigured: Bool { config?.isTTSConfigured == true }
    private var hasWorkspaceDefaultVoice: Bool { config?.hasWorkspaceDefaultVoice == true }
    private var selectedVoiceCanSpeak: Bool { config?.canSpeak(agentVoice: voice) == true }
    private var voiceProvider: VoiceProvider { config?.voiceProvider ?? .minimax }

    private var unavailableVoiceLabel: String {
        switch voiceProvider {
        case .minimax: return "MiniMax voice is not configured"
        case .elevenlabs: return "ElevenLabs is not configured"
        case .system: return "Built-in Mac voices are unavailable"
        case .unknown: return "Voice is not configured"
        }
    }

    private var unavailableVoiceGuidance: String {
        switch voiceProvider {
        case .minimax:
            return "Add the shared MiniMax key in this agent's profile on the computer. The key is never returned to iOS."
        case .elevenlabs:
            return "Add the shared ElevenLabs key in this agent's profile on the computer. The key is never returned to iOS."
        case .system:
            return "Built-in Mac voices need no key, and this computer has none available. Switch the voice engine in this agent's profile on the computer to keep using voice."
        case .unknown:
            return "Configure the selected voice engine in this agent's profile on the computer. Provider keys are never returned to iOS."
        }
    }

    private var missingDefaultVoiceGuidance: String {
        switch voiceProvider {
        case .minimax:
            return "No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the shared MiniMax key on your computer."
        case .elevenlabs:
            return "No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the shared ElevenLabs key on your computer."
        case .system:
            return "No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the built-in Mac voices on your computer."
        case .unknown:
            return "No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the selected voice engine on your computer."
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        BotAvatarView(bot: current, size: 112, state: .happy, animated: true)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)

                    Picker("Shape", selection: $crop) {
                        ForEach(AvatarCrop.allCases, id: \.self) { shape in
                            Text(shape.label).tag(shape)
                        }
                    }
                    .pickerStyle(.segmented)

                    PhotosPicker(selection: $photo, matching: .images) {
                        Label("Upload image", systemImage: "photo.badge.plus")
                    }
                    .disabled(busy)

                    if current.avatarUrl != nil {
                        Button("Use mascot", systemImage: "trash", role: .destructive) {
                            Task { await clearImage() }
                        }
                        .disabled(busy)
                    }
                } header: {
                    Text("Avatar")
                } footer: {
                    Text("PNG, JPEG, GIF, or WebP, up to 10 MB. Images are stored on your paired computer and loaded with this phone's pairing token.")
                }

                Section {
                    TextField("Art direction", text: $prompt, axis: .vertical)
                        .lineLimit(2...5)
                    Button("Generate on computer", systemImage: "sparkles") {
                        Task { await generateImage() }
                    }
                    .disabled(busy || !imageGenerationReady || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text("Generate an avatar")
                } footer: {
                    Text(imageGenerationReady
                         ? "Generation uses the shared image provider configured on your computer. No provider key is sent to or stored on this phone."
                         : "To generate images, configure the shared image provider in BotFleet on your computer. Provider keys cannot be added from a phone.")
                }

                Section("Identity") {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                    TextField("Title", text: $title)
                    TextField("What this agent does", text: $description, axis: .vertical)
                        .lineLimit(3...8)
                    Toggle("Agent notifications", isOn: $notifications)
                }

                if instances.isEmpty {
                    Section("Models") {
                        Text(instancesLoaded
                             ? "No models to choose from.  Your computer did not report any."
                             : "Loading models\u{2026}")
                            .foregroundStyle(.secondary)
                        if instancesLoaded {
                            Button("Try Again") { Task { await reloadInstances() } }
                        }
                    }
                } else {
                    primaryModelSection

                    ForEach(fallbacks.indices, id: \.self) { index in
                        Section("Fallback \(index + 1)") {
                            Picker("Provider", selection: Binding(
                                get: { fallbacks[index].instanceId },
                                set: { newInstanceId in
                                    fallbacks[index].instanceId = newInstanceId
                                    if let inst = instances.first(where: { $0.id == newInstanceId }) {
                                        if !inst.models.options.contains(where: { $0.id == fallbacks[index].model }) {
                                            fallbacks[index].model = inst.models.default
                                        }
                                        if let effort = fallbacks[index].effort,
                                           !inst.effortLevels(for: fallbacks[index].model).contains(effort) {
                                            fallbacks[index].effort = nil
                                        }
                                    }
                                }
                            )) {
                                ForEach(fallbackAvailableInstances(for: fallbacks[index].instanceId)) { instance in
                                    Text(instance.settingsDisplayName).tag(instance.id)
                                }
                            }
                            .pickerStyle(.navigationLink)

                            if let fallbackInstance = instances.first(where: { $0.id == fallbacks[index].instanceId }) {
                                Picker("Model", selection: Binding(
                                    get: { fallbacks[index].model },
                                    set: { newModel in
                                        fallbacks[index].model = newModel
                                        if let effort = fallbacks[index].effort,
                                           !fallbackInstance.effortLevels(for: newModel).contains(effort) {
                                            fallbacks[index].effort = nil
                                        }
                                    }
                                )) {
                                    ForEach(fallbackInstance.models.options) { option in
                                        Text(option.label).tag(option.id)
                                    }
                                }
                                .pickerStyle(.navigationLink)

                                effortPicker(
                                    selection: Binding(
                                        get: { fallbacks[index].effort },
                                        set: { fallbacks[index].effort = $0 }
                                    ),
                                    instance: fallbackInstance,
                                    modelId: fallbacks[index].model
                                )
                            }

                            Button("Remove Fallback", role: .destructive) {
                                fallbacks.remove(at: index)
                            }
                        }
                    }

                    if fallbacks.count < 2 {
                        Section {
                            Button("Add Fallback", systemImage: "plus.circle") {
                                let firstInst = instances.first
                                let instId = firstInst?.id ?? instanceId
                                let mdl = firstInst?.models.default ?? modelId
                                fallbacks.append(ModelSelection(instanceId: instId, model: mdl))
                            }
                        }
                    }

                    if toolRoundsVisible {
                        Section {
                            TextField(String(Self.defaultToolRounds), text: maxToolRoundsBinding)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                                .disabled(!toolRoundsEditable)
                                .accessibilityLabel("Maximum Tool Rounds")
                        } header: {
                            Text("Maximum Tool Rounds")
                        } footer: {
                            Text(toolRoundsCaption)
                        }
                    }
                }

                automationAndApprovalsSection
                computersSection
                workingDirectorySection

                Section {
                    if voiceConfigured {
                        Picker("Voice", selection: $voice) {
                            if hasWorkspaceDefaultVoice {
                                Text("Workspace default").tag("")
                            } else {
                                Text("Choose an agent voice").tag("").disabled(true)
                            }
                            if !voice.isEmpty, !voices.contains(where: { $0.id == voice }) {
                                Text("Current agent voice").tag(voice)
                            }
                            ForEach(voices) { option in
                                VStack(alignment: .leading) {
                                    Text(option.label)
                                    if let detail = option.description { Text(detail) }
                                }
                                .tag(option.id)
                            }
                        }
                        Toggle("Play on Mac", isOn: Binding(
                            get: { speechDevices.contains("mac") },
                            set: { if $0 { speechDevices.insert("mac") } else { speechDevices.remove("mac") } }
                        ))
                        .disabled(!selectedVoiceCanSpeak)
                        Toggle("Play on iPhone (while app is open)", isOn: Binding(
                            get: { speechDevices.contains("iphone") },
                            set: { if $0 { speechDevices.insert("iphone") } else { speechDevices.remove("iphone") } }
                        ))
                        .disabled(!selectedVoiceCanSpeak)
                        Button("Preview Voice", systemImage: "speaker.wave.2") {
                            Task { await previewVoice() }
                        }
                        .disabled(busy || !selectedVoiceCanSpeak)

                        if !hasWorkspaceDefaultVoice, voice.isEmpty {
                            Label("Pick a voice for this agent before enabling speech.", systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Label(unavailableVoiceLabel, systemImage: "speaker.slash")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Voice")
                } footer: {
                    if !voiceConfigured {
                        Text(unavailableVoiceGuidance)
                    } else if !hasWorkspaceDefaultVoice {
                        Text(missingDefaultVoiceGuidance)
                    } else {
                        Text("The voice choice belongs to this agent. Workspace default uses the shared voice selected on your computer.")
                    }
                }

                Section("Speech to text") {
                    Label("Apple on-device dictation", systemImage: "waveform")
                    Text("Recordings you send from this iPhone keep their original audio and transcript on the message. Available languages depend on this device.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text("Cloud fallback and translation are not configured. Siri and iOS 27 speech features still need device testing.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let tasks = current.tasks, !tasks.isEmpty {
                    let totalTurns = tasks.compactMap { $0.usage?.turns }.reduce(0, +)
                    let totalInput = tasks.compactMap { $0.usage?.input }.reduce(0, +)
                    let totalOutput = tasks.compactMap { $0.usage?.output }.reduce(0, +)
                    let totalCost = tasks.compactMap { $0.usage?.costUsd }.reduce(0, +)
                    let hasCost = tasks.contains(where: { $0.usage?.costUsd != nil })
                    
                    if totalTurns > 0 {
                        Section("Usage") {
                            HStack {
                                Text("Turns")
                                Spacer()
                                Text("\(totalTurns)")
                                    .foregroundStyle(.secondary)
                            }
                            HStack {
                                Text("Tokens")
                                Spacer()
                                Text("\((totalInput + totalOutput) / 1000)k (\(totalInput / 1000)k in, \(totalOutput / 1000)k out)")
                                    .foregroundStyle(.secondary)
                            }
                            if hasCost {
                                HStack {
                                    Text("Cost")
                                    Spacer()
                                    Text(String(format: "$%.2f", totalCost))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Agent Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Save") {
                        Task {
                            if await save() { dismiss() }
                        }
                    }
                    .fontWeight(.semibold)
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Discard") {
                        dismiss()
                    }
                }
            }
            .overlay { if busy { ProgressView().controlSize(.large) } }
            .task {
                if !session.cachedInstances.isEmpty {
                    let cached = session.cachedInstances
                    let usable = cached.filter { inst in
                        inst.snapshot.isAvailable || inst.id == current.modelSelection.instanceId
                    }
                    instances = usable.isEmpty ? cached : usable
                    instancesLoaded = true
                }
                async let status = session.configStatus()
                async let options = session.voiceOptions()
                async let fetchedInstances = session.instances()
                let loadedConfig = await status
                config = loadedConfig
                voices = await options
                let rawInstances = await fetchedInstances
                if !rawInstances.isEmpty || instances.isEmpty {
                    let usable = rawInstances.filter { inst in
                        inst.snapshot.isAvailable || inst.id == current.modelSelection.instanceId
                    }
                    // Offering only healthy engines is right, but never at the cost
                    // of an empty picker: if the computer reports none as available
                    // the person should still see the list and be able to choose.
                    instances = usable.isEmpty ? rawInstances : usable
                }
                instancesLoaded = true
                if let loadedConfig, !loadedConfig.canSpeak(agentVoice: voice) {
                    speechDevices.removeAll()
                }
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                Task { await upload(item) }
            }
        }
    }

    /// Re-fetch the engine list after a slow or failed load.
    private func reloadInstances() async {
        instancesLoaded = false
        let raw = await session.instances()
        let usable = raw.filter { inst in
            inst.snapshot.isAvailable || inst.id == current.modelSelection.instanceId
        }
        instances = usable.isEmpty ? raw : usable
        instancesLoaded = true
    }

    @ViewBuilder
    private func effortPicker(selection: Binding<String?>, instance: Instance, modelId: String) -> some View {
        let levels = instance.effortLevels(for: modelId)
        let saved = selection.wrappedValue
        if !levels.isEmpty {
            Picker("Reasoning", selection: Binding(
                get: { selection.wrappedValue.flatMap { levels.contains($0) ? $0 : nil } },
                set: { selection.wrappedValue = $0 }
            )) {
                Text("Default").tag(String?.none)
                ForEach(levels, id: \.self) { level in
                    Text(effortLabel(level)).tag(Optional(level))
                }
            }
            .pickerStyle(.navigationLink)

            if let saved, !levels.contains(saved) {
                Text("Saved reasoning “\(effortLabel(saved))” is kept until you choose a supported level.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if let saved {
            LabeledContent("Reasoning", value: "Saved: \(effortLabel(saved))")
        }
    }

    private func effortLabel(_ effort: String) -> String {
        switch effort {
        case "none": return "None"
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "X-High"
        case "max": return "Maximum"
        default: return effort
        }
    }

    private func profilePatch() -> BotProfilePatch {
        let savedDevices = config.map { $0.canSpeak(agentVoice: voice) ? speechDevices : [] } ?? speechDevices
        let newModelSelection = ModelSelection(
            instanceId: instanceId,
            model: modelId,
            effort: effort,
            fallbacks: fallbacks.isEmpty ? nil : fallbacks
        )
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        let cwdPatch: BotProfilePatch.CwdString? = {
            guard cwd != baseline.cwd else { return nil }
            return trimmedCwd.isEmpty ? .clear : .set(trimmedCwd)
        }()
        let computersArray = ["cloud", "vm", "local"].filter { computers.contains($0) }
        return BotProfilePatch(
            name: name == baseline.name ? nil : name.trimmingCharacters(in: .whitespacesAndNewlines),
            title: title == baseline.title ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description == baseline.description
                ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            notifications: notifications == baseline.notifications ? nil : notifications,
            avatarCrop: crop == baseline.crop ? nil : crop,
            voice: voice == baseline.voice ? nil : voice,
            speechDevices: savedDevices == baseline.speechDevices ? nil : ["mac", "iphone"].filter { savedDevices.contains($0) },
            modelSelection: newModelSelection == baseline.modelSelection ? nil : newModelSelection,
            maxToolRounds: maxToolRoundsPatch,
            autoApprove: autoApprove == baseline.autoApprove ? nil : autoApprove,
            autoReview: autoReview == baseline.autoReview ? nil : autoReview,
            approvePeerComms: approvePeerComms == baseline.approvePeerComms ? nil : approvePeerComms,
            computers: computers == baseline.computers ? nil : computersArray,
            cwd: cwdPatch
        )
    }

    @ViewBuilder
    private var primaryModelSection: some View {
        Section("Primary Model") {
            Picker("Provider", selection: $instanceId) {
                ForEach(availableInstances) { instance in
                    Text(instance.settingsDisplayName).tag(instance.id)
                }
            }
            .pickerStyle(.navigationLink)
            .onChange(of: instanceId) { _, newInstanceId in
                if let instance = instances.first(where: { $0.id == newInstanceId }) {
                    if !instance.models.options.contains(where: { $0.id == modelId }) {
                        modelId = instance.models.default
                    }
                    if let effort, !instance.effortLevels(for: modelId).contains(effort) {
                        self.effort = nil
                    }
                }
            }

            if let selectedInstance = instances.first(where: { $0.id == instanceId }) {
                Picker("Model", selection: $modelId) {
                    ForEach(selectedInstance.models.options) { option in
                        Text(option.label).tag(option.id)
                    }
                }
                .pickerStyle(.navigationLink)
                .onChange(of: modelId) { _, newModelId in
                    if let effort, !selectedInstance.effortLevels(for: newModelId).contains(effort) {
                        self.effort = nil
                    }
                }

                effortPicker(selection: $effort, instance: selectedInstance, modelId: modelId)
            }
        }
    }

    @ViewBuilder
    private var automationAndApprovalsSection: some View {
        Section {
            Toggle("Automatic approvals", isOn: $autoApprove)
            Picker("Auto review", selection: $autoReview) {
                Text("Off").tag("off")
                Text("Shadow (advisory)").tag("shadow")
                Text("Enforce (blocks unsafe)").tag("enforce")
            }
            Toggle("Ask before contacting other bots", isOn: $approvePeerComms)
        } header: {
            Text("Automation & Approvals")
        } footer: {
            Text("Automatic approvals run safe read-only and non-destructive tool operations without confirmation. Auto review inspects changes for syntax and safety.")
        }
    }

    @ViewBuilder
    private var computersSection: some View {
        Section {
            if computers.isEmpty {
                HStack {
                    Text("Assigned computers")
                    Spacer()
                    Text("(no computer)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Toggle("Local Mac desktop", isOn: Binding(
                get: { computers.contains("local") },
                set: { if $0 { computers.insert("local") } else { computers.remove("local") } }
            ))
            Toggle("Self-hosted VPS / Box", isOn: Binding(
                get: { computers.contains("cloud") },
                set: { if $0 { computers.insert("cloud") } else { computers.remove("cloud") } }
            ))
            Toggle("Local VM", isOn: Binding(
                get: { computers.contains("vm") },
                set: { if $0 { computers.insert("vm") } else { computers.remove("vm") } }
            ))
        } header: {
            Text("Computers")
        } footer: {
            Text("Controls which execution environments this bot can mount for shell commands, browser tools, and desktop control.")
        }
    }

    @ViewBuilder
    private var workingDirectorySection: some View {
        Section {
            TextField("Folder path on host (optional)", text: $cwd)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        } header: {
            Text("Working Directory")
        } footer: {
            Text("Default repository or workspace folder path on the paired Mac.")
        }
    }

    /// Shared with `shared/bot-profile.ts` `MAX_TOOL_ROUNDS`.
    private static let maximumToolRoundsCap = 200

    /// Shared with `shared/bot-profile.ts` `DEFAULT_MAX_TOOL_ROUNDS`.  This is
    /// the number the harness actually stops an unset turn at, and the number
    /// the turn's own prompt names — the two used to disagree (12 versus 40),
    /// so a bot was told it had 40 rounds and was cut off at 12.
    private static let defaultToolRounds = 40

    /// True when this engine runs the harness HTTP tool loop, and so applies
    /// `maxToolRounds`.  An engine the companion has not heard of is NOT
    /// treated as "cannot": we do not know yet.
    private var toolRoundsEngine: Instance? {
        instances.first(where: { $0.id == instanceId })
    }

    private var toolRoundsEditable: Bool {
        toolRoundsEngine?.capabilities?.toolLoop == true
    }

    /// A saved ceiling stays visible even on an engine that ignores it, so it
    /// can be read and cleared instead of being stranded on the record.  See
    /// `src/lib/bot-settings-gates.ts` for the same rule on the desktop.
    private var toolRoundsVisible: Bool {
        toolRoundsEditable || !maxToolRoundsText.isEmpty
    }

    private var toolRoundsCaption: String {
        let base = "Per turn.  Empty uses \(Self.defaultToolRounds).  Cap is \(Self.maximumToolRoundsCap)."
        guard !toolRoundsEditable else { return base }
        // "Does not apply" and "we do not know yet" are different claims, and on
        // a cold start this view renders before the engine list arrives.  Saying
        // the ceiling is inapplicable then reads as permanent, when the very
        // next load may make it editable.  Mirrors toolRoundsGate()'s
        // engine-presence check on the desktop.
        if toolRoundsEngine == nil {
            return base + "  This engine has not reported its capabilities yet, so this ceiling may not apply to it."
        }
        return base + "  This engine runs its own tool loop, so this ceiling does not apply to it."
    }

    private static func roundsText(_ rounds: Int?) -> String {
        guard let rounds else { return "" }
        return String(rounds)
    }

    /// Digits only, 1...200. Empty clears. Anything else is ignored.
    private var maxToolRoundsBinding: Binding<String> {
        Binding(
            get: { maxToolRoundsText },
            set: { raw in
                let digits = raw.filter(\.isNumber)
                if digits.isEmpty {
                    if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        maxToolRoundsText = ""
                    }
                    return
                }
                guard let value = Int(digits), value >= 1, value <= Self.maximumToolRoundsCap else { return }
                maxToolRoundsText = String(value)
            }
        )
    }

    private var maxToolRoundsPatch: BotProfilePatch.MaxToolRounds? {
        guard maxToolRoundsText != baseline.maxToolRoundsText else { return nil }
        if maxToolRoundsText.isEmpty { return .clear }
        guard let rounds = Int(maxToolRoundsText), (1...Self.maximumToolRoundsCap).contains(rounds) else { return nil }
        return .set(rounds)
    }

    private func save() async -> Bool {
        busy = true
        defer { busy = false }
        return await ProfileSaveGate.run(
            save: { await session.updateProfile(profilePatch(), for: current) },
            accept: synchronizeForm(with:)
        )
    }

    private func clearImage() async {
        busy = true
        defer { busy = false }
        if let updated = await session.updateProfile(
            BotProfilePatch(avatarUrl: .clear, avatarCrop: .mascot),
            for: current
        ) {
            crop = updated.avatarCrop ?? .mascot
            baseline.crop = crop
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        busy = true
        defer { busy = false; photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let mime = ChatAttachments.sniffImageMIME(data)
        else {
            session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        if data.count > 10 * 1_024 * 1_024 {
            session.actionError = "That image is larger than 10 MB."
            return
        }
        var uploadData = data
        var uploadMIME = mime
        if !ChatAttachments.isDisplayImageMIME(mime) {
            guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else {
                session.actionError = "That image could not be converted to PNG, JPEG, GIF, or WebP."
                return
            }
            uploadData = jpeg
            uploadMIME = "image/jpeg"
        }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        if let updated = await session.uploadAvatar(uploadData, mime: uploadMIME, for: current, crop: intendedCrop) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        }
    }

    private func generateImage() async {
        busy = true
        defer { busy = false }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        guard let generated = await session.generateAvatar(
            prompt: String(prompt.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400)),
            for: current
        ) else { return }
        let shapePatch = BotProfilePatch(avatarCrop: intendedCrop)
        if let updated = await session.updateProfile(shapePatch, for: generated) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        } else {
            crop = generated.avatarCrop ?? .mascot
            baseline.crop = crop
        }
    }

    private func previewVoice() async {
        guard selectedVoiceCanSpeak else {
            session.actionError = "Pick an agent voice or configure a workspace default on your computer first."
            return
        }
        busy = true
        defer { busy = false }
        guard let data = await session.previewVoice(voice, for: current) else { return }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio)
            try audioSession.setActive(true)

            let nextPlayer = try AVAudioPlayer(data: data)
            guard nextPlayer.prepareToPlay(), nextPlayer.play() else {
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                player = nil
                session.actionError = "The generated audio could not be played."
                return
            }
            player = nextPlayer
        } catch {
            player = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            session.actionError = "The generated audio could not be played."
        }
    }

    private var availableInstances: [Instance] {
        instances.filter { inst in
            // DeepSeek is Harness only: filter out standalone/legacy direct deepseek driver
            if inst.driverKind == "deepseek" || inst.driverKind == "deepseekAgent" || (inst.id == "deepseek" && inst.driverKind != "dshAgent") {
                return inst.id == instanceId
            }
            return (inst.snapshot.state == "available" || inst.id == instanceId) &&
                inst.snapshot.reason != "Disabled in settings" &&
                (inst.id != "kimi" || (inst.snapshot.state == "available" && inst.snapshot.authenticated != false))
        }
    }

    private func fallbackAvailableInstances(for currentFallbackInstanceId: String) -> [Instance] {
        instances.filter { inst in
            if inst.driverKind == "deepseek" || inst.driverKind == "deepseekAgent" || (inst.id == "deepseek" && inst.driverKind != "dshAgent") {
                return inst.id == currentFallbackInstanceId
            }
            return (inst.snapshot.state == "available" || inst.id == currentFallbackInstanceId) &&
                inst.snapshot.reason != "Disabled in settings" &&
                (inst.id != "kimi" || (inst.snapshot.state == "available" && inst.snapshot.authenticated != false))
        }
    }

    private func synchronizeForm(with bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speechDevices = Set(bot.speechDevices ?? (bot.speakReplies == true ? ["mac"] : []))
        instanceId = bot.modelSelection.instanceId
        modelId = bot.modelSelection.model
        effort = bot.modelSelection.effort
        fallbacks = bot.modelSelection.fallbacks ?? []
        maxToolRoundsText = Self.roundsText(bot.maxToolRounds)
        autoApprove = bot.autoApprove ?? false
        autoReview = bot.autoReview ?? "off"
        approvePeerComms = bot.approvePeerComms ?? false
        computers = Set(bot.computers ?? [])
        cwd = bot.cwd ?? ""
        baseline = ProfileFormSnapshot(bot: bot)
    }
}

private struct ProfileFormSnapshot {
    var name: String
    var title: String
    var description: String
    var notifications: Bool
    var crop: AvatarCrop
    var voice: String
    var speechDevices: Set<String>
    var modelSelection: ModelSelection
    var maxToolRoundsText: String
    var autoApprove: Bool
    var autoReview: String
    var approvePeerComms: Bool
    var computers: Set<String>
    var cwd: String

    init(bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speechDevices = Set(bot.speechDevices ?? (bot.speakReplies == true ? ["mac"] : []))
        modelSelection = bot.modelSelection
        maxToolRoundsText = bot.maxToolRounds.map(String.init) ?? ""
        autoApprove = bot.autoApprove ?? false
        autoReview = bot.autoReview ?? "off"
        approvePeerComms = bot.approvePeerComms ?? false
        computers = Set(bot.computers ?? [])
        cwd = bot.cwd ?? ""
    }
}

private extension AvatarCrop {
    var label: String {
        switch self {
        case .mascot: "Mascot"
        case .circle: "Circle"
        case .rounded: "Rounded"
        case .square: "Square"
        }
    }
}
