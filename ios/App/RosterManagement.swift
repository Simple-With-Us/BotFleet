// Shared pieces of bot and room management on the phone: the delete
// confirmation, the pinned-message banner, and closing a chat whose bot or
// room is gone.  The rules behind them live in CompanionCore
// (`BotOrganize`), where they are tested; these views only ask.
import SwiftUI
import CompanionCore

extension Chat {
    /// The one message pinned above this chat's transcript, if any.
    var pinnedMessageId: String? {
        switch self {
        case let .bot(bot): return bot.pinnedMessageId
        case let .room(room): return room.pinnedMessageId
        }
    }

    /// Deleted, or (for a bot) archived: no longer in the chat list.
    func isGone(in state: CompanionState) -> Bool {
        switch self {
        case let .bot(bot): return BotOrganize.isBotGone(bot.id, in: state.bots)
        case let .room(room): return BotOrganize.isRoomGone(room.id, in: state.rooms)
        }
    }

    /// `roomTerm` is the workspace's word for a room, such as Channel.
    func deleteConfirmation(roomTerm: String) -> DeleteConfirmation {
        switch self {
        case let .bot(bot): return BotOrganize.deleteBotConfirmation(name: bot.name)
        case let .room(room): return BotOrganize.deleteRoomConfirmation(name: room.name, roomTerm: roomTerm)
        }
    }
}

/// The confirmation every Delete goes through.  The desktop deletes without
/// asking.  The phone names the bot or room and says what is lost first,
/// because a long-press is easy to land by accident and a delete cannot be
/// undone.
struct DeleteChatAlert: ViewModifier {
    @Binding var target: Chat?
    let roomTerm: String
    let onConfirm: (Chat) -> Void

    private var title: String {
        target?.deleteConfirmation(roomTerm: roomTerm).title ?? ""
    }

    private var isPresented: Binding<Bool> {
        Binding(
            get: { target != nil },
            set: { presented in
                if !presented { target = nil }
            }
        )
    }

    func body(content: Content) -> some View {
        content.alert(title, isPresented: isPresented, presenting: target) { chat in
            Button(chat.deleteConfirmation(roomTerm: roomTerm).confirmLabel, role: .destructive) {
                onConfirm(chat)
            }
            Button("Cancel", role: .cancel) {}
        } message: { chat in
            Text(chat.deleteConfirmation(roomTerm: roomTerm).message)
        }
    }
}

/// A refusal shown where the person is, for a screen presented as a sheet:
/// the app-wide error alert sits under the sheet and would not be seen.
struct InlineErrorAlert: ViewModifier {
    @Binding var message: String?
    let title: String

    private var isPresented: Binding<Bool> {
        Binding(
            get: { message != nil },
            set: { presented in
                if !presented { message = nil }
            }
        )
    }

    func body(content: Content) -> some View {
        content.alert(title, isPresented: isPresented, presenting: message) { _ in
            Button("OK", role: .cancel) {}
        } message: { text in
            Text(text)
        }
    }
}

/// Closes a chat screen once its bot or room is deleted or archived, here or
/// on another device, so nobody is left typing into a chat that is gone.
/// While a sheet is up over the screen it waits: the sheet closes first, and
/// its `onDismiss` closes the chat.
struct CloseWhenGone: ViewModifier {
    let isGone: Bool
    let waiting: Bool
    let close: () -> Void

    func body(content: Content) -> some View {
        content.onChange(of: isGone) { _, gone in
            if gone && !waiting { close() }
        }
    }
}

/// The one pinned message, above the transcript: who said it, two lines of
/// it, tap to go to it, and Unpin.  The caller draws it only when the pin
/// resolves to a loaded message (`BotOrganize.pinnedMessage`).
struct PinnedMessageBanner: View {
    let message: Message
    /// The bot's name in a bot chat; nil in a room.
    let chatName: String?
    let tint: Color
    let onJump: () -> Void
    let onUnpin: () -> Void

    private var sender: String { BotOrganize.pinnedSender(message, chatName: chatName) }
    private var text: String { BotOrganize.pinnedText(message) }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "pin.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.top, 2)
                .accessibilityHidden(true)

            Button(action: onJump) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(sender)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(tint)
                        .lineLimit(1)
                    Text(text)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Pinned message from \(sender): \(text)")
            .accessibilityHint("Shows the message in the conversation")

            Button(action: onUnpin) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Unpin Message")
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(tint.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(tint.opacity(0.25), lineWidth: 1)
        )
    }
}
