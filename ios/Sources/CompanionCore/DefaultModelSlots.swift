// The Models screen: every bot's primary model and fallbacks on one page,
// plus an Apply to All Bots block that writes chosen models to every bot in
// one call.
//
// A Swift port of `src/lib/default-model-slots.ts`, the parts of
// `shared/model-limits.ts` the phone draws with, and the pure rules inside
// the desktop's `FleetModelsSection.tsx`.  Nothing here is stored as a
// workspace default: Set All Bots To Default is one
// `POST /api/bots/apply-model-defaults`, and each bot keeps its own list
// afterward.
//
// Each picker in the Apply to All Bots block owns one FIXED place: Primary,
// then Fallback 1, 2 and 3.  An empty place means "leave this place alone on
// every bot", and the body always carries exactly three fallback entries so
// the harness reads position N as Fallback N+1 without guessing which
// pickers were filled.  The harness used to compact whatever was filled,
// which turned "Fallback 2 only" into "overwrite every bot's Fallback 1".
import Foundation

/// Shared with `shared/model-limits.ts`.
public enum ModelLimits {
    /// `MAX_MODEL_FALLBACKS`: the most fallback models a bot may be given
    /// (owner decision 2026-09-30).
    public static let maxFallbacks = 3

    /// `fallbackSlotCount`: how many fallback places to draw for a bot that
    /// stores `stored` of them.  Never fewer than the cap, and never fewer
    /// than what is stored, so a chain written through the API before the
    /// cap existed is always shown and can always be trimmed.
    public static func fallbackSlotCount(stored: Int) -> Int {
        max(maxFallbacks, stored)
    }

    /// `canAddFallback`: a chain already at or over the cap offers nothing.
    public static func canAddFallback(stored: Int) -> Bool {
        stored < maxFallbacks
    }
}

/// One place in the Apply to All Bots block, as the route reads it.
///
/// `latest` rides along only when the slot floats ("Latest Sonnet"), so every
/// bot it lands on floats too; a pinned slot sends no `latest` and the route
/// pins it.  The phone's `ModelSelection` does not carry `latest` yet, so a
/// slot built from a pick is always pinned; the field is here so the wire
/// shape matches the desktop's the day the picker learns to float.
public struct DefaultModelSlot: Codable, Hashable, Sendable {
    public var instanceId: String
    public var model: String
    public var latest: String?

    public init(instanceId: String, model: String, latest: String? = nil) {
        self.instanceId = instanceId
        self.model = model
        self.latest = latest
    }

    /// `slotFromPick`: instance and model only, never effort or fallbacks,
    /// which belong to each bot rather than to the default.
    public init(pick selection: ModelSelection) {
        self.init(instanceId: selection.instanceId, model: selection.model)
    }

    /// The slot as a bare selection, for drawing it with the model picker.
    public var selection: ModelSelection {
        ModelSelection(instanceId: instanceId, model: model)
    }
}

/// State helpers for the Apply to All Bots block.  `nil` is an empty
/// picker: "leave this place alone".
public enum DefaultModelSlots {
    /// One empty slot per fallback place.
    public static func emptyFallbacks() -> [DefaultModelSlot?] {
        Array(repeating: nil, count: ModelLimits.maxFallbacks)
    }

    /// A copy of `slots` with place `index` replaced.  Out-of-range places
    /// are ignored rather than growing the list past the cap.
    public static func withSlot(
        _ slots: [DefaultModelSlot?],
        at index: Int,
        _ value: DefaultModelSlot?
    ) -> [DefaultModelSlot?] {
        guard index >= 0, index < ModelLimits.maxFallbacks else { return slots }
        var next = slots
        while next.count <= index { next.append(nil) }
        next[index] = value
        return next
    }

    /// Whether there is anything to apply.
    public static func hasDefaults(primary: DefaultModelSlot?, fallbacks: [DefaultModelSlot?]) -> Bool {
        primary != nil || fallbacks.contains { $0 != nil }
    }

    /// The picker's pick as a slot; see `DefaultModelSlot.init(pick:)`.
    public static func slotFromPick(_ selection: ModelSelection) -> DefaultModelSlot {
        DefaultModelSlot(pick: selection)
    }

    /// The body for `POST /api/bots/apply-model-defaults`.
    public static func applyModelDefaultsBody(
        primary: DefaultModelSlot?,
        fallbacks: [DefaultModelSlot?]
    ) -> ApplyModelDefaultsBody {
        ApplyModelDefaultsBody(primary: primary, fallbacks: fallbacks)
    }
}

/// `{"slots": {"primary": Slot|null, "fallbacks": [Slot|null, x3]}}`.
///
/// Only `slots` is sent: the paired phone's sidecar refuses unknown keys, and
/// the phone never clears a place (that needs `confirmClear`, which the
/// desktop UI does not send either).
public struct ApplyModelDefaultsBody: Encodable, Equatable, Sendable {
    public var primary: DefaultModelSlot?
    /// Always exactly `ModelLimits.maxFallbacks` places.
    public private(set) var fallbacks: [DefaultModelSlot?]

    public init(primary: DefaultModelSlot?, fallbacks: [DefaultModelSlot?]) {
        self.primary = primary
        var places: [DefaultModelSlot?] = []
        for index in 0..<ModelLimits.maxFallbacks {
            places.append(index < fallbacks.count ? fallbacks[index] : nil)
        }
        self.fallbacks = places
    }

    private enum CodingKeys: String, CodingKey { case slots }
    private enum SlotKeys: String, CodingKey { case primary, fallbacks }

    public func encode(to encoder: Encoder) throws {
        var root = encoder.container(keyedBy: CodingKeys.self)
        var slots = root.nestedContainer(keyedBy: SlotKeys.self, forKey: .slots)
        // An explicit null, not an omitted key: the place is "leave alone"
        // either way, but the body then reads the same as the desktop's.
        if let primary {
            try slots.encode(primary, forKey: .primary)
        } else {
            try slots.encodeNil(forKey: .primary)
        }
        var places = slots.nestedUnkeyedContainer(forKey: .fallbacks)
        for place in fallbacks {
            if let place {
                try places.encode(place)
            } else {
                try places.encodeNil()
            }
        }
    }
}

/// `200 {"ok": true, "applied": Int, "skipped": [{id, name, reason}]}`.
public struct ApplyModelDefaultsResult: Decodable, Equatable, Sendable {
    /// A bot the apply left exactly as it was, and the harness's own reason
    /// (busy, or an empty place before a chosen fallback).
    public struct Skipped: Decodable, Hashable, Sendable {
        public var id: String
        public var name: String
        public var reason: String

        public init(id: String, name: String, reason: String) {
            self.id = id
            self.name = name
            self.reason = reason
        }

        private enum CodingKeys: String, CodingKey { case id, name, reason }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decodeIfPresent(String.self, forKey: .id) ?? ""
            name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
            reason = try values.decodeIfPresent(String.self, forKey: .reason) ?? ""
        }
    }

    public var applied: Int
    public var skipped: [Skipped]

    public init(applied: Int, skipped: [Skipped] = []) {
        self.applied = applied
        self.skipped = skipped
    }

    private enum CodingKeys: String, CodingKey { case applied, skipped }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        applied = try values.decodeIfPresent(Int.self, forKey: .applied) ?? 0
        skipped = try values.decodeIfPresent([Skipped].self, forKey: .skipped) ?? []
    }

    /// The line under the button, worded as the desktop words it, with each
    /// reason exactly as the harness gave it: not every refusal is "busy".
    /// Nil when every bot took the change.
    public var skippedSummary: String? {
        guard !skipped.isEmpty else { return nil }
        let names = skipped.map { "\($0.name) (\($0.reason))" }.joined(separator: ", ")
        return "Still on their own model: \(names)."
    }
}

/// The pure rules behind the per-bot rows and the engine chips.
public enum FleetModels {
    /// One engine chip: "<Engine name> · <count>".
    public struct EngineCount: Hashable, Sendable {
        public var instanceId: String
        public var count: Int

        public init(instanceId: String, count: Int) {
            self.instanceId = instanceId
            self.count = count
        }
    }

    /// A fallback place a bot row draws: an entry the bot stores, or the one
    /// place that offers Add Fallback.
    public enum FallbackPlace: Hashable, Sendable {
        case stored(Int)
        case add(Int)
    }

    /// The bots the Models screen lists.  Hidden (archived) bots never.
    public static func listedBots(_ bots: [Bot]) -> [Bot] {
        bots.filter { $0.hidden != true }
    }

    /// The bot the Set Default buttons seed from: the first listed bot, as
    /// the desktop's stand-in.  Nil means there is nothing to apply to yet.
    public static func standIn(_ bots: [Bot]) -> Bot? {
        bots.first { $0.hidden != true }
    }

    /// "Filter by bot or model": name, title, primary model or any fallback
    /// model, trimmed and case-insensitive.
    public static func filteredBots(_ bots: [Bot], query: String) -> [Bot] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let listed = listedBots(bots)
        guard !needle.isEmpty else { return listed }
        return listed.filter { bot in
            bot.name.lowercased().contains(needle)
                || bot.title.lowercased().contains(needle)
                || bot.modelSelection.model.lowercased().contains(needle)
                || (bot.modelSelection.fallbacks ?? []).contains { $0.model.lowercased().contains(needle) }
        }
    }

    /// How many listed bots sit on each primary engine, most first.  Ties
    /// keep the order the engines first appear in, so the chips do not
    /// shuffle between renders.
    public static func engineSpread(_ bots: [Bot]) -> [EngineCount] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        for bot in listedBots(bots) {
            let instanceId = bot.modelSelection.instanceId
            if counts[instanceId] == nil { order.append(instanceId) }
            counts[instanceId, default: 0] += 1
        }
        let ranked = order.enumerated().map { position, instanceId in
            (position: position, entry: EngineCount(instanceId: instanceId, count: counts[instanceId] ?? 0))
        }
        return ranked
            .sorted { left, right in
                left.entry.count != right.entry.count
                    ? left.entry.count > right.entry.count
                    : left.position < right.position
            }
            .map(\.entry)
    }

    /// The fallback places a bot row draws.  Every stored entry, even past
    /// the cap; then only the next empty place offers Add Fallback, and only
    /// while the chain is under the cap.
    public static func fallbackPlaces(stored: Int) -> [FallbackPlace] {
        var places: [FallbackPlace] = []
        for index in 0..<ModelLimits.fallbackSlotCount(stored: stored) {
            if index < stored {
                places.append(.stored(index))
            } else if index == stored, ModelLimits.canAddFallback(stored: stored) {
                places.append(.add(index))
            }
        }
        return places
    }

    /// A bot's selection with a new primary engine and model.  Its fallbacks
    /// are kept, as the desktop's `savePrimary` keeps them.  Its effort is
    /// kept only while the new model still offers it; `effortLevels` nil
    /// means the engine is unknown here, so the effort is left alone.
    public static func withPrimary(
        _ selection: ModelSelection,
        instanceId: String,
        model: String,
        effortLevels: [String]?
    ) -> ModelSelection {
        var next = selection
        next.instanceId = instanceId
        next.model = model
        if let effort = next.effort, let effortLevels, !effortLevels.contains(effort) {
            next.effort = nil
        }
        return next
    }

    /// A bot's selection with fallback `index` moved to a new engine and
    /// model, by the same effort rule as `withPrimary`.  An index the bot
    /// does not store changes nothing.
    public static func withFallback(
        _ selection: ModelSelection,
        at index: Int,
        instanceId: String,
        model: String,
        effortLevels: [String]?
    ) -> ModelSelection {
        var fallbacks = selection.fallbacks ?? []
        guard fallbacks.indices.contains(index) else { return selection }
        fallbacks[index] = withPrimary(
            fallbacks[index],
            instanceId: instanceId,
            model: model,
            effortLevels: effortLevels
        )
        var next = selection
        next.fallbacks = fallbacks
        return next
    }

    /// A bot's selection without fallback `index`; the entries after it move
    /// up.  Removing the last one sends an empty list, as the desktop does.
    public static func removingFallback(_ selection: ModelSelection, at index: Int) -> ModelSelection {
        var fallbacks = selection.fallbacks ?? []
        guard fallbacks.indices.contains(index) else { return selection }
        fallbacks.remove(at: index)
        var next = selection
        next.fallbacks = fallbacks
        return next
    }

    /// A bot's selection with one more fallback, seeded from its primary
    /// (engine and model only) so the new row opens on something real.  Nil
    /// when the chain is already at the cap.
    public static func addingFallback(_ selection: ModelSelection) -> ModelSelection? {
        let fallbacks = selection.fallbacks ?? []
        guard ModelLimits.canAddFallback(stored: fallbacks.count) else { return nil }
        var next = selection
        next.fallbacks = fallbacks + [DefaultModelSlot(pick: selection).selection]
        return next
    }

    /// The engines a model chooser offers, mirroring the bot profile's
    /// picker: listed, available and not disabled, with the legacy DeepSeek
    /// engines only when the place already points at them.  The engine the
    /// place already uses always stays so the choice still resolves.  If
    /// nothing qualifies the whole listed roster is offered rather than an
    /// empty picker.
    public static func choosableEngines(_ instances: [Instance], keeping currentId: String?) -> [Instance] {
        var keep = Set<String>()
        if let currentId { keep.insert(currentId) }
        let usable = instances.filter { instance in
            if instance.driverKind == "deepseek" || instance.driverKind == "deepseekAgent"
                || (instance.instanceId == "deepseek" && instance.driverKind != "dshAgent") {
                return instance.instanceId == currentId
            }
            return instance.isListed(keeping: keep)
                && (instance.snapshot.isAvailable || instance.instanceId == currentId)
                && instance.snapshot.reason != "Disabled in settings"
                && (instance.instanceId != "kimi"
                    || (instance.snapshot.isAvailable && instance.snapshot.authenticated != false))
        }
        return usable.isEmpty ? instances.listed(keeping: keep) : usable
    }
}
