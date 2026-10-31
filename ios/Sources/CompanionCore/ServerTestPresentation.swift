import Foundation

enum ServerTestPresentation {
    static func reached(_ server: VerifiedServer, name: String) -> String {
        let platform = server.platform == "darwin" ? "macOS" : "Linux"
        let cores = server.capacity?.cores.map { String(format: "%g cores", $0) } ?? "CPU capacity unknown"
        func gigabytes(_ bytes: Double?) -> String? {
            bytes.map { String(format: "%.1f GB", locale: Locale(identifier: "en_US_POSIX"), $0 / 1_000_000_000) }
        }
        let ram = gigabytes(server.capacity?.ramTotalBytes).map { "\($0) RAM" } ?? "RAM capacity unknown"
        let disk = gigabytes(server.capacity?.diskFreeBytes).map { "\($0) free on its data volume" } ?? "Data volume free space unknown"
        let capabilities = server.capabilities.sorted().joined(separator: ", ")
        var result = "Reached \(name): BotFleet \(server.version) on \(platform), \(cores), \(ram), \(disk).\u{00A0} Capabilities: \(capabilities.isEmpty ? "none reported" : capabilities)."
        if let milliseconds = server.capacity?.at {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(identifier: "America/Chicago")
            formatter.dateFormat = "h:mm a"
            result += "\u{00A0} Sampled at \(formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000)))."
        }
        return result
    }
}
