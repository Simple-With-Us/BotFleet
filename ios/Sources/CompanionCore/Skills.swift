// A bot's imported Agent Skills (SKILL.md), as the phone shows them.
//
// Mirrors `src/components/BotSkillsPanel.tsx` and the policy in
// `server/skills.ts`: an import lands DISABLED, and a person turns a skill on
// after reading its text.  The phone has the same two actions the Mac's panel
// has, read a skill's SKILL.md and switch it on or off, and the same gate:
// Enable stays unavailable until that skill's SKILL.md has been opened in this
// session, because enabling is a decision about text you have read.  Disable
// is always available.  Importing a skill folder is done on the computer; it
// reads a path off the computer's own disk, and the phone does not offer it.
import Foundation

private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

/// One row of `GET /api/bots/:id/skills`.
public struct SkillListing: Codable, Hashable, Identifiable, Sendable {
    public var name: String
    public var description: String
    public var enabled: Bool
    public var source: String
    /// ISO-8601.
    public var importedAt: String
    public var license: String?
    public var compatibility: String?
    /// What the harness's scan found in the text.
    public var warnings: [String]
    /// Files the import left where they were (scripts, binaries).
    public var skippedFiles: [String]

    public var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, description, enabled, source, importedAt, license, compatibility, warnings, skippedFiles
    }

    public init(
        name: String,
        description: String = "",
        enabled: Bool = false,
        source: String = "",
        importedAt: String = "",
        license: String? = nil,
        compatibility: String? = nil,
        warnings: [String] = [],
        skippedFiles: [String] = []
    ) {
        self.name = name
        self.description = description
        self.enabled = enabled
        self.source = source
        self.importedAt = importedAt
        self.license = license
        self.compatibility = compatibility
        self.warnings = warnings
        self.skippedFiles = skippedFiles
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? ""
        enabled = (try? container.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        source = (try? container.decodeIfPresent(String.self, forKey: .source)) ?? ""
        importedAt = (try? container.decodeIfPresent(String.self, forKey: .importedAt)) ?? ""
        license = try? container.decodeIfPresent(String.self, forKey: .license)
        compatibility = try? container.decodeIfPresent(String.self, forKey: .compatibility)
        warnings = (try? container.decodeIfPresent([String].self, forKey: .warnings)) ?? []
        skippedFiles = (try? container.decodeIfPresent([String].self, forKey: .skippedFiles)) ?? []
    }
}

/// `{ skills, notIndexed }`.  `notIndexed` names enabled skills the prompt's
/// index budget left out: still enabled, just not self-discoverable.
public struct SkillsResponse: Decodable, Sendable {
    public var skills: [SkillListing]
    public var notIndexed: [String]

    private enum CodingKeys: String, CodingKey { case skills, notIndexed }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        skills = (try? container.decodeIfPresent([Lossy<SkillListing>].self, forKey: .skills))?.compactMap(\.value) ?? []
        notIndexed = (try? container.decodeIfPresent([String].self, forKey: .notIndexed)) ?? []
    }
}

/// `PATCH` answers `{ skill }`.
public struct SkillResponse: Decodable, Sendable {
    public var skill: SkillListing
}

/// `GET .../skills/:name` answers `{ text }`.
public struct SkillTextResponse: Decodable, Sendable {
    public var text: String
}

/// Everything one row shows, derived in one place.
public struct SkillRowView: Hashable, Sendable {
    /// Sentence case: it is status, not a heading.
    public var status: String
    public var provenance: String
    public var actionLabel: String
    public var actionDisabled: Bool
    /// Why the action is unavailable, or nil when it is available.
    public var gateReason: String?
    public var warnings: [String]
    public var warningsHeading: String?
    public var skippedNote: String?
}

public enum SkillsDisplay {
    /// Sentence gap: a no-break space, then a space.
    private static let gap = "\u{00A0} "

    public static let title = "Skills"
    public static let openLabel = "Open SKILL.md"
    public static let hideLabel = "Hide SKILL.md"
    public static let warningsHeading = "Before you enable this"

    public static let panelDescription =
        "Reference material this bot reads when a task matches.\(gap)An imported skill starts disabled and reaches nothing until you read it and turn it on."

    /// The empty state.  Importing is done on the computer, and the copy says
    /// so, because a list with no way to fill it reads as broken.
    public static let emptyCopy =
        "No skills imported yet.\(gap)Import a skill folder in BotFleet on your computer: its own folder, the one holding SKILL.md.\(gap)Only markdown is imported; scripts are left where they are and listed for you."

    /// A bot on the ASCII.dev Box engine runs its turn on box.ascii.dev, so it
    /// has no workspace on the computer for a skill to live in.
    public static func engineNote(driverKind: String?) -> String? {
        guard driverKind == "boxAgent" else { return nil }
        return "This bot runs on the ASCII.dev Box engine, so it has no workspace on your computer.\(gap)Imported skills never reach it."
    }

    /// Enabled skills the prompt's index budget left out.
    public static func notIndexedNotice(_ names: [String]) -> String? {
        guard !names.isEmpty else { return nil }
        let count = names.count
        return "\(count) enabled skill\(count == 1 ? "" : "s") not indexed \u{2014} \(names.joined(separator: ", ")).\(gap)Still enabled, but there are too many (or they are too long) for this bot to discover on its own.\(gap)Disable one you don't need, or ask the bot to read it directly."
    }

    /// "Oct 9, 2026, 3:15pm", or "an unknown date".
    public static func importedAtLabel(_ importedAt: String) -> String {
        OwnerClock.stamp(iso: importedAt) ?? "an unknown date"
    }

    /// The three states the harness can hand back (enabled, disabled with scan
    /// warnings, disabled and clean) as one function's output.  `opened` is
    /// whether this session has fetched that skill's SKILL.md.
    public static func rowView(_ skill: SkillListing, opened: Bool, busy: Bool) -> SkillRowView {
        let gateReason: String? = (skill.enabled || opened)
            ? nil
            : "Open the SKILL.md first.\(gap)Enabling is a decision about text you have read."
        return SkillRowView(
            status: skill.enabled
                ? "Enabled \u{2014} this bot lists this skill and reads it when a task matches."
                : "Disabled \u{2014} nothing in this skill reaches this bot yet.",
            provenance: "Imported from \(skill.source) on \(importedAtLabel(skill.importedAt)).",
            actionLabel: busy ? "Working\u{2026}" : (skill.enabled ? "Disable" : "Enable"),
            actionDisabled: busy || gateReason != nil,
            gateReason: gateReason,
            warnings: skill.warnings,
            warningsHeading: skill.warnings.isEmpty ? nil : warningsHeading,
            skippedNote: skill.skippedFiles.isEmpty ? nil : "Not imported: \(skill.skippedFiles.joined(separator: ", "))."
        )
    }
}
