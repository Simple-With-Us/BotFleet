// Composer send recovery — when an optimistic clear should come back.
//
// ChatView clears the draft as soon as the user sends.  If the transport
// fails after the harness already folded the user line, restoring on `!ok`
// alone puts the text back even though the bubble is already in the
// transcript.  Gate restore on whether that outgoing line actually landed.
import Foundation

public enum ComposerSendRecovery {
    /// Whether to put a cleared draft back after `send` reports failure.
    public static func shouldRestoreClearedDraft(
        sendSucceeded: Bool,
        clientNonce: String,
        sentText: String,
        priorUserMessageIDs: Set<String>,
        transcript: [Message]
    ) -> Bool {
        if sendSucceeded { return false }
        return !outgoingLineLanded(
            clientNonce: clientNonce,
            sentText: sentText,
            priorUserMessageIDs: priorUserMessageIDs,
            transcript: transcript
        )
    }

    /// True when the outgoing user line is already in the held transcript.
    public static func outgoingLineLanded(
        clientNonce: String,
        sentText: String,
        priorUserMessageIDs: Set<String>,
        transcript: [Message]
    ) -> Bool {
        for message in transcript where message.role == .user {
            if message.id == clientNonce || message.queueId == clientNonce { return true }
            if !priorUserMessageIDs.contains(message.id), message.text == sentText { return true }
        }
        return false
    }

    /// Draft text when opening slash commands from the + sheet.
    ///
    /// An empty field becomes `/`.  Non-empty text that does not already
    /// start with `/` keeps what the user typed and prefixes `/` so the
    /// command HUD can open without discarding the prompt.
    public static func slashCommandDraft(from draft: String) -> String {
        if draft.hasPrefix("/") { return draft }
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "/" }
        return "/" + draft
    }

    /// Whether + sheet dismissal should return focus to the composer field.
    public static func shouldReassertComposerFocusAfterPlusDismisses(
        wasShowingPlus: Bool,
        isShowingPlus: Bool,
        focusAfterDismiss: Bool
    ) -> Bool {
        focusAfterDismiss && wasShowingPlus && !isShowingPlus
    }
}
