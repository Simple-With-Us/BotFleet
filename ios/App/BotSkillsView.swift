// A bot's imported Agent Skills, on the phone.
//
// Mirrors the Skills panel on the Mac's bot profile
// (`src/components/BotSkillsPanel.tsx`): the list, each skill's SKILL.md, the
// scan warnings, and an Enable or Disable button.  `server/skills.ts` states
// the policy this screen carries out: an import lands DISABLED, a person reads
// the full SKILL.md and the scan warnings, and only then enables it.  So the
// gate here is the product, not decoration: Enable stays unavailable until this
// session has opened that skill's SKILL.md.  Disable is always available.
//
// Importing a skill folder is done on the computer.  It reads a path off the
// computer's own disk, and the phone does not offer it.
import CompanionCore
import SwiftUI

struct BotSkillsView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @State private var skills: [SkillListing] = []
    @State private var notIndexed: [String] = []
    @State private var loading = true
    @State private var errorMessage: String?
    /// Skills whose SKILL.md this session has fetched, which is what unlocks
    /// Enable for them.
    @State private var opened: Set<String> = []
    @State private var texts: [String: String] = [:]
    @State private var showing: Set<String> = []
    @State private var busy: Set<String> = []

    private var engineNote: String? {
        SkillsDisplay.engineNote(driverKind: session.instanceDriverKinds[bot.modelSelection.instanceId])
    }

    var body: some View {
        List {
            noticesSection
            skillsSection
            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(SkillsDisplay.title)
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if loading && skills.isEmpty { ProgressView() }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder
    private var noticesSection: some View {
        let indexNotice = SkillsDisplay.notIndexedNotice(notIndexed)
        if engineNote != nil || indexNotice != nil {
            Section {
                if let engineNote {
                    Text(engineNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let indexNotice {
                    Label(indexNotice, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    @ViewBuilder
    private var skillsSection: some View {
        Section {
            if skills.isEmpty {
                if !loading && errorMessage == nil {
                    Text(SkillsDisplay.emptyCopy)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                ForEach(skills) { skill in
                    row(skill)
                }
            }
        } footer: {
            Text(SkillsDisplay.panelDescription)
        }
    }

    @ViewBuilder
    private func row(_ skill: SkillListing) -> some View {
        let view = SkillsDisplay.rowView(skill, opened: opened.contains(skill.name), busy: busy.contains(skill.name))
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(skill.name)
                        .font(.system(.subheadline, design: .monospaced))
                    Text(skill.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button(view.actionLabel) { toggle(skill) }
                    .buttonStyle(.bordered)
                    .disabled(view.actionDisabled)
            }
            Text(view.status)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let gate = view.gateReason {
                Text(gate)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let heading = view.warningsHeading {
                VStack(alignment: .leading, spacing: 4) {
                    Label(heading, systemImage: "exclamationmark.triangle")
                        .font(.footnote.weight(.semibold))
                    ForEach(view.warnings, id: \.self) { warning in
                        Text("\u{2022}\u{00A0}\(warning)")
                            .font(.footnote)
                    }
                }
                .foregroundStyle(.orange)
            }
            if let skipped = view.skippedNote {
                Text(skipped)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text(view.provenance)
                .font(.caption)
                .foregroundStyle(.secondary)
            Button(showing.contains(skill.name) ? SkillsDisplay.hideLabel : SkillsDisplay.openLabel) {
                openText(skill)
            }
            .buttonStyle(.borderless)
            .font(.subheadline)
            if showing.contains(skill.name), let text = texts[skill.name] {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.secondary.opacity(0.12)))
            }
        }
        .padding(.vertical, 4)
    }

    private func load() async {
        loading = true
        errorMessage = nil
        do {
            let response = try await session.loadBotSkills(botId: bot.id)
            skills = response.skills
            notIndexed = response.notIndexed
        } catch {
            // A failed load must not read as "no skills imported yet".
            if !(error is CancellationError) {
                errorMessage = error.localizedDescription
            }
        }
        loading = false
    }

    private func openText(_ skill: SkillListing) {
        let name = skill.name
        if texts[name] != nil {
            if showing.contains(name) { showing.remove(name) } else { showing.insert(name) }
            return
        }
        errorMessage = nil
        Task {
            do {
                let text = try await session.loadSkillText(botId: bot.id, name: name)
                texts[name] = text
                showing.insert(name)
                opened.insert(name)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func toggle(_ skill: SkillListing) {
        let name = skill.name
        let enable = !skill.enabled
        busy.insert(name)
        errorMessage = nil
        Task {
            do {
                let updated = try await session.setSkillEnabled(botId: bot.id, name: name, enabled: enable)
                if let index = skills.firstIndex(where: { $0.name == updated.name }) {
                    skills[index] = updated
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            busy.remove(name)
        }
    }
}
