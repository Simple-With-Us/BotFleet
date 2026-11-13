/// Which Live Activities survive the app going to the background.
///
/// The 2026-09-12 suspension policy ended every activity on background, because
/// a local-only stream has nothing to update them with once the app is gone.
/// That is right for ambient work and wrong for an unanswered ask: the one
/// card a person needs when the phone is locked is the card that was waiting
/// for them, and ending it on background made "approve it from the lock
/// screen" impossible to deliver.
///
/// So backgrounding ends what is decoration and keeps what is a decision.  An
/// activity is retained only while a request is still genuinely pending —
/// once the card is answered, `requestId` clears and the next sync ends it.
///
/// Deliberately not retained: a `working` bot (its face is stale the moment
/// the stream stops), an unread `toReview` (it dismisses itself when read),
/// and a `needsYou` card with no request behind it (nothing to tap).
public enum LiveActivityRetention {
    public static func shouldRetain(kind: String, requestId: String?, options: [String]) -> Bool {
        guard kind == "needsYou" else { return false }
        guard let requestId, !requestId.isEmpty else { return false }
        return !options.isEmpty
    }
}