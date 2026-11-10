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
        // DeepSeek Harness and MiniMax Code also keep their distinct driver identities
        // so that model keywords (e.g. "minimax" or "deepseek") do not clobber them.
        if driverKind == "dsh" || driverKind == "dshAgent" { return driverKind }
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
