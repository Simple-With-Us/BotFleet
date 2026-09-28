// Make a room from the phone: a name, working directory, bulletin, responder, and members.
import SwiftUI
import CompanionCore

struct NewGroupSheet: View {
    let created: (Room) -> Void
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var cwd = ""
    @State private var bulletin = ""
    @State private var responderKind = "everyone"
    @State private var leadBotId = ""
    @State private var members = Set<String>()
    @State private var creating = false

    private var bots: [Bot] { session.state.bots.filter { $0.hidden != true } }
    private var roomTerm: String { session.config?.roomTerminologyLabel ?? "Channel" }

    var body: some View {
        NavigationStack {
            List {
                Section("\(roomTerm) Details") {
                    TextField("\(roomTerm) name (optional)", text: $name)
                        .autocorrectionDisabled()
                    TextField("Working directory path on host (optional)", text: $cwd)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("Bulletin (Shared Brief for the team)", text: $bulletin, axis: .vertical)
                        .lineLimit(2...5)
                }

                Section("Default Responder") {
                    Picker("Responder Mode", selection: $responderKind) {
                        Text("Everyone responds").tag("everyone")
                        Text("Lead bot").tag("member")
                        Text("Only when mentioned").tag("mentions")
                    }

                    if responderKind == "member" {
                        Picker("Lead Bot", selection: $leadBotId) {
                            Text("Select lead bot").tag("")
                            ForEach(bots.filter { members.contains($0.id) }) { bot in
                                Text(bot.name).tag(bot.id)
                            }
                        }
                    }
                }

                Section("Bots") {
                    ForEach(bots) { bot in
                        Button {
                            if members.contains(bot.id) {
                                members.remove(bot.id)
                                if leadBotId == bot.id {
                                    leadBotId = members.sorted().first ?? ""
                                }
                            } else {
                                members.insert(bot.id)
                                if leadBotId.isEmpty { leadBotId = bot.id }
                            }
                        } label: {
                            HStack(spacing: 12) {
                                BotAvatarView(bot: bot, size: 36, state: .idle, animated: false)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(bot.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.primary)
                                    if !bot.title.isEmpty {
                                        Text(bot.title).font(.system(size: 13)).foregroundStyle(Color.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: members.contains(bot.id) ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 22))
                                    .foregroundStyle(members.contains(bot.id) ? BotPalette.color(bot.color) : Color.secondary.opacity(0.4))
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .navigationTitle("New \(roomTerm.lowercased())")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        creating = true
                        Task {
                            let ordered = bots.map(\.id).filter(members.contains)
                            if var room = await session.createRoom(name: name, memberIds: ordered) {
                                let trimmedCwd = cwd.trimmingCharacters(in: .whitespaces)
                                let trimmedBulletin = bulletin.trimmingCharacters(in: .whitespaces)
                                let responder = GroupResponder(kind: responderKind, botId: responderKind == "member" ? (leadBotId.isEmpty ? nil : leadBotId) : nil)
                                if !trimmedCwd.isEmpty || !trimmedBulletin.isEmpty || responderKind != "everyone" {
                                    if await session.updateRoom(
                                        id: room.id,
                                        name: name.isEmpty ? room.name : name,
                                        bulletin: trimmedBulletin,
                                        avatarCrop: nil,
                                        cwd: trimmedCwd.isEmpty ? nil : trimmedCwd,
                                        extraCwds: nil,
                                        defaultResponder: responder,
                                        memberIds: ordered
                                    ) {
                                        if let updated = session.state.rooms.first(where: { $0.id == room.id }) {
                                            room = updated
                                        }
                                    }
                                }
                                created(room)
                            }
                            creating = false
                        }
                    }
                    .disabled(members.isEmpty || creating)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
