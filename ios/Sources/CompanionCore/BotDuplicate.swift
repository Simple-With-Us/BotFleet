import Foundation

/// Duplicate Bot from the phone.
///
/// The desktop does `POST /api/bots` and then `PATCH /api/bots/:id` with the
/// whole profile.  A paired phone cannot use that PATCH: the sidecar only
/// forwards `PATCH /api/bots/:id/profile`, and rejects the whole request if
/// any field is outside `COMPANION_PROFILE_PATCH_FIELDS` (companion/src/routes.ts).
/// So the phone copies the subset it owns, and says out loud what it did not
/// copy instead of leaving a duplicate that quietly differs from its source.
public enum BotDuplicate {
    /// The desktop's suffix, lowercase (`${source.name} copy` in
    /// src/state/store.tsx), so a bot duplicated on either device is named
    /// the same way.
    public static let nameSuffix = " copy"

    /// The harness refuses a longer name with a 400, and the phone cannot let
    /// a long source name turn Duplicate into an error.  Counted in UTF-16
    /// units because that is how the harness measures a string.
    public static let nameLimit = 100

    public static func name(for source: Bot) -> String {
        var base = source.name.trimmingCharacters(in: .whitespacesAndNewlines)
        while (base + nameSuffix).utf16.count > nameLimit, !base.isEmpty {
            base.removeLast()
        }
        base = base.trimmingCharacters(in: .whitespacesAndNewlines)
        return base.isEmpty ? "Bot" + nameSuffix : base + nameSuffix
    }

    /// The fields a paired phone may change, taken from `source`.  Nothing
    /// here is outside `COMPANION_PROFILE_PATCH_FIELDS`, and no unset field is
    /// sent as `null`: the avatar is `.set` only when the source has one.
    public static func profilePatch(from source: Bot) -> BotProfilePatch {
        var avatarUrl: BotProfilePatch.AvatarURL?
        if let path = source.avatarUrl, !path.isEmpty {
            avatarUrl = .set(path)
        }
        return BotProfilePatch(
            name: name(for: source),
            title: source.title,
            description: source.description,
            notifications: source.notifications,
            avatarUrl: avatarUrl,
            avatarCrop: source.avatarCrop,
            voice: source.voice,
            modelSelection: source.modelSelection
        )
    }

    /// Rendered UI copy (sentence gap is a no-break space and a space).
    public static let copiedNote =
        "The copy keeps the name, title, description, notifications, model and fallbacks, avatar, and voice."

    public static let notCopiedNote =
        "Computers, folders, approvals, and connected apps stay as defaults.\u{00A0} Adjust them on your Mac."

    public static var summary: String {
        copiedNote + "\u{00A0} " + notCopiedNote
    }
}
