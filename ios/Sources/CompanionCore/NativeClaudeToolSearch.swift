import Foundation

public enum NativeClaudeToolSearch {
    public static func value(_ configured: String?) -> String {
        guard let configured, !configured.isEmpty else { return "true" }
        if configured == "auto" { return "true" }
        if configured.hasPrefix("auto:") {
            let suffix = String(configured.dropFirst(5))
            if let amount = Double(suffix), amount.isFinite {
                return amount > 0 && amount < 100 ? "true" : configured
            }
            return "true"
        }
        return configured
    }

    /// Reads only the ToolSearch preference; no settings contents reach logs or child arguments.
    public static func setting(input: TurnInput) -> String {
        if let explicit = input.configOptions["toolSearch"] { return value(explicit) }
        var folders: [URL] = []
        if let cwd = input.workingDirectory {
            let launch = URL(fileURLWithPath: cwd, isDirectory: true).standardizedFileURL
            var root = launch
            while root.path != "/" {
                if FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path) { break }
                root.deleteLastPathComponent()
            }
            if root.path != "/" { folders.append(root) }
            if folders.first != launch { folders.append(launch) }
        }
        var paths = folders.map { $0.appendingPathComponent(".claude/settings.local.json") }
        paths += folders.map { $0.appendingPathComponent(".claude/settings.json") }
        let userConfig = input.environment["CLAUDE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) } ??
            URL(fileURLWithPath: input.environment["HOME"] ?? NSHomeDirectory()).appendingPathComponent(".claude")
        paths.append(userConfig.appendingPathComponent("settings.json"))
        for path in paths {
            guard let size = try? path.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 1_048_576,
                  let data = try? Data(contentsOf: path),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let env = object["env"] as? [String: Any] else { continue }
            if let setting = env["ENABLE_TOOL_SEARCH"] as? String { return value(setting) }
            if let setting = env["ENABLE_TOOL_SEARCH"] as? Bool { return value(setting ? "true" : "false") }
        }
        return value(input.environment["ENABLE_TOOL_SEARCH"])
    }
}
