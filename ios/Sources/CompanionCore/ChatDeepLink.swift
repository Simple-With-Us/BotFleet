import Foundation

/// Lock-screen Live Activity tap target, and any other in-app jump to a
/// specific bot thread. Pairing stays on `<scheme>://pair`; this host is
/// `<scheme>://chat`. New builds emit `botfleet-ios`; parsers still accept
/// the legacy `botfleet` scheme so older links keep working.
public enum ChatDeepLink: Sendable {
    public static let scheme = CompanionURLScheme.primary
    public static let legacyScheme = CompanionURLScheme.legacy
    public static let host = "chat"

    public static func url(botId: String, threadId: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.queryItems = [
            URLQueryItem(name: "bot", value: botId),
            URLQueryItem(name: "thread", value: threadId),
        ]
        return components.url
    }

    public static func parse(_ url: URL) -> (botId: String, threadId: String)? {
        guard CompanionURLScheme.accepts(url.scheme) else { return nil }
        guard url.host?.lowercased() == host else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let pathBot = url.path.split(separator: "/").map(String.init).first
        let botId = nonempty(value("bot") ?? value("botId") ?? pathBot)
        let threadId = nonempty(value("thread") ?? value("threadId"))
        guard let botId, let threadId else { return nil }
        return (botId, threadId)
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
