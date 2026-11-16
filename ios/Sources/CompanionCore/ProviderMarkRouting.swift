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
}
