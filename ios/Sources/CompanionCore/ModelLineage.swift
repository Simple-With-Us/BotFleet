import Foundation

public struct LatestOption: Hashable, Identifiable, Sendable {
    public var classKey: String
    public var label: String
    public var resolvedId: String
    public var resolvedLabel: String

    public var id: String { classKey }

    public init(classKey: String, label: String, resolvedId: String, resolvedLabel: String) {
        self.classKey = classKey
        self.label = label
        self.resolvedId = resolvedId
        self.resolvedLabel = resolvedLabel
    }
}

public struct ModelClassDefinition: Hashable, Sendable {
    public var key: String
    public var label: String

    public init(key: String, label: String) {
        self.key = key
        self.label = label
    }
}

public enum ModelLineage {
    public static let claudeClasses: [ModelClassDefinition] = [
        ModelClassDefinition(key: "fable", label: "Fable"),
        ModelClassDefinition(key: "opus", label: "Opus"),
        ModelClassDefinition(key: "sonnet", label: "Sonnet"),
        ModelClassDefinition(key: "haiku", label: "Haiku"),
    ]

    public static let codexClasses: [ModelClassDefinition] = [
        ModelClassDefinition(key: "astra", label: "Astra"),
        ModelClassDefinition(key: "sol", label: "Sol"),
        ModelClassDefinition(key: "terra", label: "Terra"),
        ModelClassDefinition(key: "luna", label: "Luna"),
    ]

    public static let grokClasses: [ModelClassDefinition] = [
        ModelClassDefinition(key: "grok", label: "Grok"),
        ModelClassDefinition(key: "grok-build-fast", label: "Grok Build Fast"),
    ]

    public static let cursorClasses: [ModelClassDefinition] = [
        ModelClassDefinition(key: "composer", label: "Composer"),
    ]

    public static func classes(for driverKind: String?) -> [ModelClassDefinition] {
        guard let driverKind else { return [] }
        switch driverKind {
        case "claude", "claudeAgent":
            return claudeClasses
        case "codex":
            return codexClasses
        case "grok", "grokAgent":
            return grokClasses
        case "cursor", "cursorAgent":
            return cursorClasses
        case "droidAgent":
            return claudeClasses + codexClasses + grokClasses
        default:
            return []
        }
    }

    public static var allKnownClasses: [ModelClassDefinition] {
        claudeClasses + codexClasses + grokClasses + cursorClasses
    }

    public static func classLabel(for classKey: String, driverKind: String? = nil) -> String {
        if let driverKind, let hit = classes(for: driverKind).first(where: { $0.key == classKey }) {
            return hit.label
        }
        if let hit = allKnownClasses.first(where: { $0.key == classKey }) {
            return hit.label
        }
        return classKey.capitalized
    }

    /// Detects if a model slug or user-facing string is an alias like
    /// "Latest Composer", "latest-composer", "Latest Sonnet", etc.
    public static func detectAlias(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let lower = trimmed.lowercased()

        if lower.hasPrefix("latest ") {
            let rest = String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespacesAndNewlines)
            return normalizedClassKey(rest) ?? rest.lowercased()
        }
        if lower.hasPrefix("latest-") {
            let rest = String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespacesAndNewlines)
            return normalizedClassKey(rest) ?? rest.lowercased()
        }
        return nil
    }

    public static func normalizedClassKey(_ raw: String) -> String? {
        let lower = raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if let hit = allKnownClasses.first(where: { $0.key == lower || $0.label.lowercased() == lower }) {
            return hit.key
        }
        return nil
    }

    public static func matchesClass(_ id: String, classKey: String) -> Bool {
        let lower = id.lowercased()
        switch classKey {
        case "composer":
            return lower.hasPrefix("composer") || lower.contains("composer")
        case "sonnet":
            return lower.contains("sonnet")
        case "opus":
            return lower.contains("opus")
        case "haiku":
            return lower.contains("haiku")
        case "fable":
            return lower.contains("fable")
        case "luna":
            return lower.contains("luna")
        case "astra":
            return lower.contains("astra")
        case "sol":
            return lower.contains("sol")
        case "terra":
            return lower.contains("terra")
        case "grok-build-fast":
            return lower.hasPrefix("grok") && lower.contains("build-fast")
        case "grok":
            return lower.hasPrefix("grok") && !lower.contains("build-fast")
        default:
            return lower.contains(classKey.lowercased())
        }
    }

    public static func versionRank(_ id: String, classKey: String) -> [Int] {
        var numbers: [Int] = []
        let pattern = #"\d+(?:\.\d+)?"#
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let nsString = id as NSString
            let matches = regex.matches(in: id, range: NSRange(location: 0, length: nsString.length))
            for match in matches {
                let matchedStr = nsString.substring(with: match.range)
                let parts = matchedStr.split(separator: ".")
                for part in parts {
                    if let n = Int(part) {
                        if n < 10000 {
                            numbers.append(n)
                        }
                    }
                }
            }
        }
        return numbers
    }

    public static func compareRanks(_ a: [Int], _ b: [Int]) -> Int {
        let maxLen = max(a.count, b.count)
        for i in 0..<maxLen {
            let valA = i < a.count ? a[i] : 0
            let valB = i < b.count ? b[i] : 0
            if valA != valB {
                return valA < valB ? -1 : 1
            }
        }
        return 0
    }

    public static func newestModel(for classKey: String, in options: [ModelOption]) -> ModelOption? {
        let matching = options.filter { matchesClass($0.id, classKey: classKey) }
        guard !matching.isEmpty else { return nil }

        return matching.max { a, b in
            let rankA = versionRank(a.id, classKey: classKey)
            let rankB = versionRank(b.id, classKey: classKey)
            let cmp = compareRanks(rankA, rankB)
            if cmp != 0 {
                return cmp < 0
            }
            let aFast = a.id.contains("fast")
            let bFast = b.id.contains("fast")
            if aFast != bFast {
                return aFast // non-fast ranks higher
            }
            return false
        }
    }

    public static func latestOptions(for instance: Instance) -> [LatestOption] {
        var result: [LatestOption] = []
        var classDefs = classes(for: instance.driverKind)
        if classDefs.isEmpty {
            for def in allKnownClasses {
                if instance.models.options.contains(where: { matchesClass($0.id, classKey: def.key) }) {
                    classDefs.append(def)
                }
            }
        }

        for def in classDefs {
            if let newest = newestModel(for: def.key, in: instance.models.options) {
                result.append(LatestOption(
                    classKey: def.key,
                    label: "Latest \(def.label)",
                    resolvedId: newest.id,
                    resolvedLabel: newest.label
                ))
            }
        }
        return result
    }

    public static func resolveClass(_ classKey: String, in instance: Instance) -> LatestOption? {
        latestOptions(for: instance).first(where: { $0.classKey == classKey })
    }

    public static func displayLabel(
        selection: ModelSelection,
        instance: Instance?
    ) -> String {
        let alias = selection.latest ?? detectAlias(from: selection.model)
        if let alias {
            let label = classLabel(for: alias, driverKind: instance?.driverKind)
            let latestTitle = "Latest \(label)"
            let concreteSlug: String
            if let instance, let resolved = resolveClass(alias, in: instance) {
                concreteSlug = resolved.resolvedId
            } else if let instance, let newest = newestModel(for: alias, in: instance.models.options) {
                concreteSlug = newest.id
            } else if !selection.model.isEmpty && detectAlias(from: selection.model) == nil {
                concreteSlug = selection.model
            } else {
                concreteSlug = alias
            }
            if !concreteSlug.isEmpty && detectAlias(from: concreteSlug) == nil {
                return "\(latestTitle) \u{00B7} \(concreteSlug)"
            }
            return latestTitle
        }
        if let instance, let option = instance.models.options.first(where: { $0.id == selection.model }) {
            return option.label
        }
        return selection.model
    }
}
