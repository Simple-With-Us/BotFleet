/// Pure helpers that decide whether a Settings draft should keep an in-flight
/// user edit or adopt the latest server value after a config load / push.
public enum SettingsDraftPreservation {
    /// Keep `draft` when it differs from `previousSaved`; otherwise take `server`.
    public static func text(draft: String, previousSaved: String, server: String) -> String {
        draft == previousSaved ? server : draft
    }

    /// Keep `draft` when its parsed integer differs from `previousSaved`; otherwise
    /// take `server` as a string.  Unparseable drafts are treated as dirty.
    public static func timeoutMinutes(draft: String, previousSaved: Int, server: Int) -> String {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if Int(trimmed) == previousSaved {
            return String(server)
        }
        return draft
    }
}
