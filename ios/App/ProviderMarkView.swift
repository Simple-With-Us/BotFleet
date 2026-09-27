import SwiftUI

/// A small brand mark for the provider driving a bot's current model — the
/// Claude, Grok, OpenAI, etc. logo.  Mirrors `ProviderMark(driverKind:)` in
/// src/components/ProviderIcons.tsx so web and iOS agree; add a provider in
/// both places, keeping this switch as the single source of truth for the
/// iOS mapping.
///
/// Falls back to an uppercase monogram when no logo asset exists for the
/// driver kind, matching the house pattern in `BotAvatarView`: identity
/// never becomes an empty placeholder.
struct ProviderMarkView: View {
    let driverKind: String
    var model: String? = nil
    var size: CGFloat = 20

    static func resolvedDriverKind(for driverKind: String, model: String?) -> String {
        // Antigravity runs Gemini-family and Claude-family models, but the
        // provider is still Antigravity. Keep the driver identity for both
        // its mark and VoiceOver label instead of renaming it from model text.
        if driverKind == "antigravity" || driverKind == "antigravityAgent" { return driverKind }
        guard let model = model?.lowercased() else { return driverKind }
        if model.contains("minimax") { return "minimax" }
        if model.contains("qwen") { return "qwenAgent" }
        if model.contains("hermes") { return "hermesAgent" }
        if model.contains("claude") { return "claude" }
        if model.contains("deepseek") { return "deepseek" }
        if model.contains("gpt") || model.contains("o1") || model.contains("o3") || model.contains("o4") { return "openai" }
        if model.contains("antigravity") { return "antigravity" }
        if model.contains("gemini") { return "gemini" }
        return driverKind
    }

    private var effectiveDriverKind: String {
        Self.resolvedDriverKind(for: driverKind, model: model)
    }

    private enum Mark {
        /// Full-color brand asset, rendered as-is.
        case asset(String)
        /// Monochrome brand asset, tinted to the current foreground style so
        /// it stays visible on both light and dark headers.
        case templateAsset(String)
        /// A generic SF Symbol standing in for a mark that has no brand
        /// artwork of its own (e.g. the "computer" driver).
        case symbol(String)
        /// No art shipped for this driver kind — fall back to a monogram.
        case monogram
    }

    private var mark: Mark {
        switch effectiveDriverKind {
        case "claude", "claudeAgent":
            return .asset("ProviderMarkClaude")
        case "grok", "grokAgent":
            return .templateAsset("ProviderMarkGrok")
        case "grok-bot":
            // The bot variant of the Grok mark — same X-shape with a small
            // filled dot in the upper-right corner so a row of "Grok / Grok
            // Bot" reads as related but distinguishable.  Mirrors the
            // grok-bot.svg in CodeCaps' ProviderMarks folder.
            return .templateAsset("ProviderMarkGrokBot")
        case "deepseek", "deepseekAgent", "dsh", "dshAgent":
            return .asset("ProviderMarkDeepSeek")
        case "codex":
            // Template-rendered so the mark picks up the foreground style on
            // every surface and never ships a fixed brand color that drifts in
            // dark mode (the old rasterized PNG read as gold on dark backgrounds).
            return .templateAsset("ProviderMarkCodex")
        case "openai-compat", "openai":
            return .templateAsset("ProviderMarkOpenAI")
        case "gemini", "geminiAgent", "antigravity", "antigravityAgent":
            return .asset("ProviderMarkGemini")
        case "cursor", "cursorAgent":
            return .templateAsset("ProviderMarkCursor")
        case "minimax", "minimaxAgent":
            return .asset("ProviderMarkMiniMax")
        case "boxAgent":
            return .symbol("desktopcomputer")
        // No source art shipped for these — they render on the monogram
        // fallback below, which is expected and fine.
        case "droid", "droidAgent", "kimi", "kimiAgent", "qwenAgent",
             "opencodeGo", "hermesAgent", "piAgent":
            return .monogram
        default:
            return .monogram
        }
    }

    /// Human-readable provider name for VoiceOver — this mark is identity,
    /// not decoration, so it must never read as silent chrome.
    private var displayName: String { Self.displayName(for: driverKind, model: model) }

    /// Shared so the chat-header profile button can fold the provider into
    /// its own accessibility label (SwiftUI replaces child labels on a
    /// Button with an explicit `.accessibilityLabel`).
    static func displayName(for driverKind: String, model: String? = nil) -> String {
        let effective = resolvedDriverKind(for: driverKind, model: model)
        switch effective {
        case "claude", "claudeAgent": return "Claude"
        case "grok", "grokAgent": return "Grok"
        case "grok-bot": return "Grok Bot"
        case "deepseek", "deepseekAgent", "dsh", "dshAgent": return "DeepSeek"
        case "codex": return "Codex"
        case "openai-compat", "openai": return "OpenAI"
        case "gemini", "geminiAgent": return "Gemini"
        case "antigravity", "antigravityAgent": return "Antigravity"
        case "cursor", "cursorAgent": return "Cursor"
        case "minimax", "minimaxAgent": return "MiniMax"
        case "boxAgent": return "Computer"
        case "kimi", "kimiAgent": return "Kimi"
        case "droid", "droidAgent": return "Droid"
        case "qwenAgent": return "Qwen"
        case "opencodeGo": return "OpenCode"
        case "hermesAgent": return "Hermes"
        case "piAgent": return "Pi"
        default: return effective
        }
    }

    /// Mirrors the web fallback exactly: `driverKind.replace(/Agent$/i, "").slice(0, 1).toUpperCase()`.
    private var monogram: String {
        var stripped = effectiveDriverKind
        if stripped.lowercased().hasSuffix("agent") {
            stripped = String(stripped.dropLast(5))
        }
        return stripped.first.map { String($0).uppercased() } ?? "?"
    }

    var body: some View {
        Group {
            switch mark {
            case let .asset(name):
                Image(name)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.14)
            case let .templateAsset(name):
                Image(name)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.16)
                    .foregroundStyle(Color.primary)
            case let .symbol(systemImage):
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.6, weight: .medium))
                    .foregroundStyle(Color.secondary)
            case .monogram:
                Text(monogram)
                    .font(.system(size: size * 0.55, weight: .semibold))
                    .foregroundStyle(Color.secondary)
            }
        }
        .frame(width: size, height: size)
        .background(Circle().fill(Color(uiColor: .systemBackground)))
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.75))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(displayName)
    }
}
