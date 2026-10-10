// The two workspace-wide voice settings in Settings, the iPhone half of
// src/components/WorkspaceVoiceSettings.tsx:
//
// - Default Voice: the voice every bot without a voice of its own speaks
//   with, on the Mac and here (cfg.tts.voice).  Always shown by name.
//   Saved through its own narrow route (PATCH /api/tts/default-voice), so
//   /api/config stays closed to writes from a phone.  Personal Voices are
//   device-local, so they are never offered.
// - Pronunciations: terms the voice keeps saying wrong and how to say them
//   (shared/pronunciations.ts), saved through PATCH /api/tts/pronunciations,
//   which validates exactly as the Mac does and answers a refusal in words.
import SwiftUI
import CompanionCore

struct WorkspaceVoiceSection: View {
    @EnvironmentObject private var session: Session
    @State private var voices: [Voice] = []
    @State private var saving = false
    @State private var error = ""

    private var defaultVoice: String { session.config?.workspaceDefaultVoice ?? "" }
    private var hostedVoices: [Voice] { voices.filter { !BotVoice.isPersonalVoiceId($0.id) } }
    private var listed: Bool { hostedVoices.contains(where: { $0.id == defaultVoice }) }
    private var defaultName: String {
        defaultVoice.isEmpty ? BotVoice.noDefaultVoice : BotVoice.displayName(defaultVoice, voices: voices)
    }
    /// The phone's write routes shipped with the list, so a computer that
    /// sends no list cannot take the change: show the voice, read-only.
    private var canChange: Bool { session.config?.pronunciations != nil }

    var body: some View {
        Section {
            if canChange {
                picker
            } else {
                LabeledContent {
                    Text(defaultName)
                } label: {
                    Label {
                        Text("Default Voice")
                    } icon: {
                        SettingsIcon(symbol: "speaker.wave.2", color: .pink)
                    }
                }
            }

            NavigationLink {
                PronunciationsView()
            } label: {
                Label {
                    HStack {
                        Text("Pronunciations")
                        Spacer()
                        if let count = session.config?.pronunciations?.count {
                            Text("\(count)")
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    SettingsIcon(symbol: "character.bubble", color: .teal)
                }
            }
            .disabled(!canChange)

            if !error.isEmpty {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Voice")
        } footer: {
            Text(footer)
        }
        .task(id: session.connection?.id) {
            voices = await session.voiceOptions()
        }
    }

    private var picker: some View {
        Picker(selection: Binding(get: { defaultVoice }, set: { save($0) })) {
            if defaultVoice.isEmpty {
                Text(BotVoice.noDefaultVoice).tag("")
            } else if !listed {
                Text(BotVoice.displayName(defaultVoice, voices: voices)).tag(defaultVoice)
            }
            ForEach(hostedVoices) { voice in
                Text(BotVoice.displayName(voice.id, voices: hostedVoices)).tag(voice.id)
            }
        } label: {
            Label {
                Text("Default Voice")
            } icon: {
                SettingsIcon(symbol: "speaker.wave.2", color: .pink)
            }
        }
        .disabled(saving || session.config?.tts == nil)
        .accessibilityValue(defaultName)
    }

    private var footer: String {
        var parts: [String] = []
        if defaultVoice.isEmpty {
            parts.append("No default voice is picked, so a bot without a voice of its own stays silent until you pick one.")
        } else {
            parts.append("Every bot without a voice of its own speaks with this one, on the Mac and on iPhone.")
        }
        parts.append(BotVoice.personalVoiceNotDefault)
        if session.config?.tts != nil, !canChange {
            parts.append("Change it on the Mac, or update BotFleet on your computer to change it and the pronunciations here.")
        } else {
            parts.append("Pronunciations say terms the voice keeps getting wrong.")
        }
        return parts.joined(separator: "\u{00A0} ")
    }

    private func save(_ next: String) {
        guard !next.isEmpty, next != defaultVoice else { return }
        saving = true
        error = ""
        Task {
            if let refusal = await session.updateDefaultVoice(next) { error = refusal }
            saving = false
        }
    }
}

struct PronunciationsView: View {
    @EnvironmentObject private var session: Session
    @State private var rows: [Row] = []
    @State private var seeded = false
    @State private var saving = false
    @State private var error = ""

    struct Row: Identifiable, Equatable {
        let id = UUID()
        var term: String
        var say: String
    }

    private var saved: [Pronunciation] { session.config?.pronunciations ?? [] }

    /// The rows a person means, trimmed; a row with both fields blank is not
    /// an entry.  The harness does the full check and says what is wrong.
    private var entries: [Pronunciation] {
        rows.compactMap { row in
            let term = row.term.trimmingCharacters(in: .whitespacesAndNewlines)
            let say = row.say.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            return term.isEmpty && say.isEmpty ? nil : Pronunciation(term: term, say: say)
        }
    }

    private var incomplete: String? {
        for entry in entries {
            if entry.term.isEmpty { return "Add the term that is said as \u{201C}\(entry.say)\u{201D}." }
            if entry.say.isEmpty { return "Add how to say \(entry.term)." }
        }
        return nil
    }

    private var dirty: Bool { entries != saved }

    var body: some View {
        Form {
            Section {
                ForEach($rows) { $row in
                    HStack(spacing: 12) {
                        TextField("Term", text: $row.term)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .frame(maxWidth: 120, alignment: .leading)
                            .accessibilityLabel("Term")
                        Divider()
                        TextField("Say It As", text: $row.say)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityLabel(row.term.isEmpty ? "Say It As" : "Say \(row.term) As")
                    }
                }
                .onDelete { rows.remove(atOffsets: $0) }
                Button {
                    rows.append(Row(term: "", say: ""))
                } label: {
                    Label("Add Term", systemImage: "plus")
                }
            } header: {
                HStack {
                    Text("Term")
                        .frame(maxWidth: 120, alignment: .leading)
                    Text("Say It As")
                    Spacer()
                }
            } footer: {
                Text("How the voice says terms it keeps getting wrong, for every bot.\u{00A0} A change applies to replies voiced after you save; clips already made keep their sound.")
            }

            if let message = incomplete ?? (error.isEmpty ? nil : error) {
                Section {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Pronunciations")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task { await save() }
                }
                .disabled(saving || !dirty || incomplete != nil)
            }
        }
        .onAppear {
            guard !seeded else { return }
            seeded = true
            rows = saved.map { Row(term: $0.term, say: $0.say) }
        }
    }

    private func save() async {
        saving = true
        error = ""
        if let refusal = await session.updatePronunciations(entries) {
            error = refusal
        } else {
            rows = saved.map { Row(term: $0.term, say: $0.say) }
        }
        saving = false
    }
}
