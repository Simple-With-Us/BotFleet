import Foundation

/// Persistence for the set of collapsed chat sections.
///
/// Section names come from `Bot.section` and `Room.section` and are free-form, so
/// a comma-joined string cannot round-trip a name that itself contains a comma —
/// "Sales, Marketing" came back as "Sales" plus " Marketing", and the section
/// could never stay collapsed.  The set is stored as a JSON array instead.
///
/// The pre-JSON comma-joined value is still read, so an existing collapse
/// preference survives the upgrade.
public enum CollapsedSections {
    public static func decode(_ raw: String) -> Set<String> {
        guard let data = raw.data(using: .utf8),
              let names = try? JSONDecoder().decode([String].self, from: data) else {
            return legacyDecode(raw)
        }
        return Set(names)
    }

    public static func encode(_ sections: Set<String>) -> String {
        guard let data = try? JSONEncoder().encode(sections.sorted()),
              let encoded = String(data: data, encoding: .utf8) else {
            return ""
        }
        return encoded
    }

    /// The pre-JSON format: section names joined with a comma.
    static func legacyDecode(_ raw: String) -> Set<String> {
        Set(raw.split(separator: ",").map(String.init).filter { !$0.isEmpty })
    }
}
