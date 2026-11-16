import Foundation

/// Maps a harness `driverKind` plus optional model id to the provider identity
/// used for logo artwork on iOS.  Mirrors the model-inference branch in
/// `ProviderMark` on web (`src/components/ProviderIcons.tsx`) so both surfaces
/// agree on which mark a row wears.
public enum ProviderMarkRouting {
    public static func resolvedDriverKind(for driverKind: String, model: String?) -> String {
        // Antigravity runs Gemini-family and Claude-family models, but the
        // provider is still Antigravity. Keep the driver identity for both
        // its mark and VoiceOver label instead of renaming it from model text.
        if driverKind == "antigravity" || driverKind == "antigravityAgent" { return driverKind }
        // The DeepSeek Harness carries models from other engines too, and a
        // MiniMax model running under it answers as MiniMax:  the mark has to
        // name the engine that answers, not the harness that carries it, or a
        // MiniMax bot wears the DeepSeek logo.  The web `ProviderMark` routes
        // the same row to MiniMax, so this is where the two surfaces agreed on
        // the model rather than on the driver.  A DeepSeek model on the same
        // harness keeps the harness's own identity, so the "deepseek" keyword
        // still does not clobber it.
        if driverKind == "dsh" || driverKind == "dshAgent" {
            if let model = model?.lowercased(), model.contains("minimax") { return "minimax" }
            return driverKind
        }
        // MiniMax Code keeps its distinct driver identity so that model
        // keywords do not clobber it.
        if driverKind == "mcode" || driverKind == "mcodeAgent" { return driverKind }
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

    /// The identity a session is announced as, which is the harness and not
    /// the model it carries.
    ///
    /// The DeepSeek Harness hosts MiniMax models, and a MiniMax session
    /// running under it wears the MiniMax artwork:  the mark names the
    /// engine that answers.  The name is the other half of the same row, and
    /// it stays with the harness, because a session on the harness is still a
    /// session on the harness, and the web surface announces the engine's
    /// registered name and only swaps the mark.
    public static func resolvedLabelDriverKind(for driverKind: String, model: String?) -> String {
        if driverKind == "dsh" || driverKind == "dshAgent" { return driverKind }
        return resolvedDriverKind(for: driverKind, model: model)
    }

    /// The product name a session announces.
    ///
    /// This is the engine's registered name and not the model's, because a
    /// model is not a product:  a MiniMax model running under the DeepSeek
    /// Harness is a session on the DeepSeek Harness.  The artwork is the
    /// other half of the same row and names the engine that answers.
    public static func displayName(for driverKind: String, model: String? = nil) -> String {
        let effective = resolvedLabelDriverKind(for: driverKind, model: model)
        switch effective {
        case "claude", "claudeAgent": return "Claude"
        case "grok", "grokAgent": return "Grok"
        case "grok-bot": return "Grok Bot"
        case "deepseek", "deepseekAgent": return "DeepSeek"
        case "dsh", "dshAgent": return "Clutch"
        case "codex": return "Codex"
        case "openai-compat", "openai": return "OpenAI"
        case "gemini", "geminiAgent": return "Gemini"
        case "antigravity", "antigravityAgent": return "Antigravity"
        case "cursor", "cursorAgent": return "Cursor"
        case "minimax", "minimaxAgent": return "MiniMax"
        // mcode is the same subscription read as a coding CLI, so it keeps the
        // MiniMax mark but announces as its own product name.
        case "mcode", "mcodeAgent": return "MiniMax Code"
        case "boxAgent": return "ASCII.dev Box"
        case "kimi", "kimiAgent": return "Kimi"
        case "droid", "droidAgent": return "Droid"
        case "qwenAgent": return "Qwen"
        case "opencodeGo": return "OpenCode"
        case "hermesAgent": return "Hermes"
        case "piAgent": return "Pi"
        default: return effective
        }
    }
}
