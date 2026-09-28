import SwiftUI
import CompanionCore

public struct MentionItem: Identifiable {
    public let id: String
    public let name: String
    public let detail: String?
    public let kind: Kind
    public let bot: Bot?
    public let room: Room?

    public enum Kind {
        case bot
        case channel
    }

    public init(id: String, name: String, detail: String?, kind: Kind, bot: Bot? = nil, room: Room? = nil) {
        self.id = id
        self.name = name
        self.detail = detail
        self.kind = kind
        self.bot = bot
        self.room = room
    }
}

public struct MentionAutocompleteView: View {
    @Binding public var text: String
    public let trigger: String // "@" or "#"
    public let query: String
    public let bots: [Bot]
    public let rooms: [Room]
    public let accentColor: Color
    public let onSelect: (MentionItem) -> Void

    @Environment(\.colorScheme) private var colorScheme

    public init(
        text: Binding<String>,
        trigger: String,
        query: String,
        bots: [Bot],
        rooms: [Room],
        accentColor: Color = .blue,
        onSelect: @escaping (MentionItem) -> Void
    ) {
        self._text = text
        self.trigger = trigger
        self.query = query
        self.bots = bots
        self.rooms = rooms
        self.accentColor = accentColor
        self.onSelect = onSelect
    }

    public var filteredItems: [MentionItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if trigger == "@" {
            let activeBots = bots.filter { $0.hidden != true }
            let items = activeBots.map {
                MentionItem(
                    id: $0.id,
                    name: $0.name,
                    detail: $0.title.isEmpty ? $0.description : $0.title,
                    kind: .bot,
                    bot: $0,
                    room: nil
                )
            }
            if q.isEmpty { return items }
            return items.filter {
                $0.name.lowercased().contains(q) || ($0.detail?.lowercased().contains(q) ?? false)
            }
        } else {
            let items = rooms.map {
                MentionItem(
                    id: $0.id,
                    name: $0.name,
                    detail: !$0.bulletin.isEmpty ? $0.bulletin : "\($0.memberIds.count) members",
                    kind: .channel,
                    bot: nil,
                    room: $0
                )
            }
            if q.isEmpty { return items }
            return items.filter {
                $0.name.lowercased().contains(q) || ($0.detail?.lowercased().contains(q) ?? false)
            }
        }
    }

    public var body: some View {
        let isDark = colorScheme == .dark
        let items = filteredItems

        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: trigger == "@" ? "at" : "number")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(accentColor)
                    Text(trigger == "@" ? "BOTS" : "CHANNELS")
                        .font(.system(size: 9.5, weight: .heavy, design: .monospaced))
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    Spacer()
                }
                .padding(.horizontal, 10)
                .padding(.top, 8)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(items) { item in
                            Button {
                                onSelect(item)
                                Haptics.selection()
                            } label: {
                                HStack(spacing: 8) {
                                    if let bot = item.bot {
                                        BotAvatarView(bot: bot, size: 24, state: .idle, animated: false)
                                    } else {
                                        Image(systemName: "number")
                                            .font(.system(size: 13, weight: .bold))
                                            .foregroundColor(accentColor)
                                            .frame(width: 24, height: 24)
                                            .background(Circle().fill(accentColor.opacity(0.15)))
                                    }
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text("\(trigger)\(item.name)")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundColor(.primary)
                                        if let detail = item.detail, !detail.isEmpty {
                                            Text(detail)
                                                .font(.system(size: 10))
                                                .foregroundColor(.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .fill(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(isDark ? Color.white.opacity(0.1) : Color.black.opacity(0.06), lineWidth: 0.5)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 8)
                }
            }
            .background(
                LinearGradient(
                    colors: isDark ? [
                        Color(hex: "#0F172A").opacity(0.96),
                        Color(hex: "#1E293B").opacity(0.94)
                    ] : [
                        Color.white.opacity(0.96),
                        Color(hex: "#F8FAFC").opacity(0.94)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(isDark ? Color.white.opacity(0.14) : Color.black.opacity(0.08), lineWidth: 0.8)
            )
            .shadow(color: Color.black.opacity(isDark ? 0.25 : 0.08), radius: 8, y: 3)
            .padding(.horizontal, 10)
            .padding(.bottom, 4)
        }
    }
}
