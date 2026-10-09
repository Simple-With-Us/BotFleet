// Move To Section, for a bot or a room.  Bots and rooms share one set of
// section names, the same set the roster draws its section headers from, so
// Work can hold both.  The desktop's picker (`SectionPicker` in
// src/components/Sidebar.tsx) is the reference.
import SwiftUI
import CompanionCore

struct SectionPickerSheet: View {
    /// The chat's section now, trimmed; nil when it has none.
    let current: String?
    /// The sections already in use, in roster order.
    let sections: [String]
    /// A section name, or nil to take the chat out of its section.  Called
    /// after the sheet closes, so a refusal shows on the screen beneath.
    let onAssign: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var newName = ""
    @FocusState private var nameFocused: Bool

    private var typedSection: String? { BotOrganize.sectionName(from: newName) }

    var body: some View {
        NavigationStack {
            List {
                if !sections.isEmpty {
                    Section("Sections") {
                        ForEach(sections, id: \.self) { section in
                            sectionRow(section)
                        }
                    }
                }

                Section {
                    HStack(spacing: 10) {
                        TextField("New section", text: $newName)
                            .focused($nameFocused)
                            .submitLabel(.done)
                            .autocorrectionDisabled()
                            .onSubmit { addTyped() }
                            .onChange(of: newName) { _, typed in
                                let capped = BotOrganize.cappedSectionInput(typed)
                                if capped != typed { newName = capped }
                            }
                        Button("Add") { addTyped() }
                            .disabled(typedSection == nil)
                    }
                } header: {
                    Text("New Section")
                } footer: {
                    Text("Up to \(BotOrganize.sectionMaxLength) characters.")
                }

                if current != nil {
                    Section {
                        Button("Remove From Section", systemImage: "folder.badge.minus", role: .destructive) {
                            assign(nil)
                        }
                    }
                }
            }
            .navigationTitle("Move To Section")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func sectionRow(_ section: String) -> some View {
        Button {
            assign(section)
        } label: {
            HStack {
                Text(section)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if section == current {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(section == current ? .isSelected : [])
    }

    private func addTyped() {
        guard let section = typedSection else { return }
        assign(section)
    }

    /// Picking the section the chat is already in changes nothing, so it
    /// only closes the sheet.
    private func assign(_ section: String?) {
        dismiss()
        guard section != current else { return }
        onAssign(section)
    }
}
