// Parse a harness webhook prompt into the smaller view shown in chat.
//
// The stored message stays role=user so the model still sees it as the turn
// prompt.  The phone must not paint that as something the owner typed.
import Foundation

public struct WebhookMessageView: Equatable, Sendable {
    public var task: String
    public var payload: String?
    public var event: String?
    public var project: String?
    public var headline: String
    public var subtitle: String?

    private static let instructionMarkers = [
        "AUTHENTICATED WEBHOOK TASK",
        "USER-CONFIGURED WEBHOOK INSTRUCTIONS",
        "DEFAULT WEBHOOK INSTRUCTIONS",
    ]

    public static func parse(_ text: String?) -> WebhookMessageView? {
        guard let text, !text.isEmpty else { return nil }
        var task = ""
        for marker in instructionMarkers {
            if let found = block(marker, in: text) {
                task = found
                break
            }
        }
        guard !task.isEmpty, let eventData = block("UNTRUSTED WEBHOOK EVENT DATA", in: text) else {
            return nil
        }

        let payload: String?
        if let split = eventData.range(of: "\n\n") {
            let body = eventData[split.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
            payload = body.isEmpty ? nil : body
        } else {
            payload = nil
        }

        let event = metaLine("Event", in: eventData)
        let fields = payload.map(payloadFields) ?? [:]
        let title = fields["title"]
        let project = fields["project"]
        let headline = title ?? event ?? "Incoming Webhook"
        var subtitleParts: [String] = []
        if let project { subtitleParts.append(project) }
        if let event, event != headline { subtitleParts.append(event) }
        return WebhookMessageView(
            task: task,
            payload: payload,
            event: event,
            project: project,
            headline: headline,
            subtitle: subtitleParts.isEmpty ? nil : subtitleParts.joined(separator: " · ")
        )
    }

    private static func block(_ marker: String, in text: String) -> String? {
        let start = "[\(marker)]\n"
        let end = "\n[/\(marker)]"
        guard let startRange = text.range(of: start) else { return nil }
        guard let endRange = text.range(of: end, range: startRange.upperBound..<text.endIndex) else { return nil }
        let inner = text[startRange.upperBound..<endRange.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return inner.isEmpty ? nil : String(inner)
    }

    private static func metaLine(_ key: String, in eventData: String) -> String? {
        for line in eventData.split(separator: "\n", omittingEmptySubsequences: false) {
            let text = String(line)
            let prefix = "\(key): "
            if text.hasPrefix(prefix) {
                let value = String(text.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
                return value.isEmpty ? nil : value
            }
        }
        return nil
    }

    private static func payloadFields(_ payload: String) -> [String: String] {
        guard let data = payload.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        let dataObj = json["data"] as? [String: Any] ?? json
        let issue = dataObj["issue"] as? [String: Any]
        let projectValue = issue?["project"] ?? dataObj["project"] ?? json["project"]
        var project: String?
        if let slug = projectValue as? String, !slug.trimmingCharacters(in: .whitespaces).isEmpty {
            project = slug.trimmingCharacters(in: .whitespaces)
        } else if let proj = projectValue as? [String: Any] {
            let slug = (proj["slug"] as? String) ?? (proj["name"] as? String)
            if let slug, !slug.trimmingCharacters(in: .whitespaces).isEmpty {
                project = slug.trimmingCharacters(in: .whitespaces)
            }
        }
        let titleValue = (issue?["title"] as? String)
            ?? (issue?["culprit"] as? String)
            ?? (dataObj["title"] as? String)
            ?? (json["message"] as? String)
        let title = titleValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        var fields: [String: String] = [:]
        if let title, !title.isEmpty { fields["title"] = title }
        if let project { fields["project"] = project }
        return fields
    }
}
