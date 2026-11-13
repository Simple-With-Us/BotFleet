import Foundation

public struct DelegationMessageView: Equatable, Sendable {
    public var senderName: String
    public var reason: String?
    public var payload: String?
    public var headline: String
    public var subtitle: String?

    public static let prefixStart = "[Delegated by @"
    public static let prefixMid = ", another bot in this BotFleet workspace. Do the work and reply directly.]"

    public static func isDelegation(_ text: String?, role: Message.Role, automationSource: String? = nil) -> Bool {
        if automationSource == "delegation" { return true }
        guard role == .user || role == .system, let text else { return false }
        return text.hasPrefix(prefixStart) && text.contains(prefixMid)
    }

    public static func parse(
        _ text: String?,
        role: Message.Role,
        fromName: String? = nil,
        automationSource: String? = nil
    ) -> DelegationMessageView? {
        guard let text else {
            if automationSource == "delegation" {
                let sender = fromName ?? "Peer Bot"
                return DelegationMessageView(
                    senderName: sender,
                    reason: nil,
                    payload: nil,
                    headline: "Delegated by @\(sender)",
                    subtitle: nil
                )
            }
            return nil
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty && automationSource != "delegation" {
            return nil
        }

        if (role == .user || role == .system || automationSource == "delegation"),
           trimmed.hasPrefix(prefixStart), let midRange = trimmed.range(of: prefixMid) {
            let senderStart = trimmed.index(trimmed.startIndex, offsetBy: prefixStart.count)
            let senderName = String(trimmed[senderStart..<midRange.lowerBound]).trimmingCharacters(in: .whitespaces)
            guard !senderName.isEmpty else { return nil }

            let afterPrefix = String(trimmed[midRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            var reason: String? = nil
            var payload = afterPrefix

            let reasonMarker = "\n\n[Reason: "
            if let reasonRange = afterPrefix.range(of: reasonMarker, options: .backwards), afterPrefix.hasSuffix("]") {
                let reasonValue = String(afterPrefix[reasonRange.upperBound..<afterPrefix.index(before: afterPrefix.endIndex)]).trimmingCharacters(in: .whitespaces)
                reason = reasonValue.isEmpty ? nil : reasonValue
                payload = String(afterPrefix[..<reasonRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            }

            let firstLine = payload.components(separatedBy: .newlines).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })?.trimmingCharacters(in: .whitespaces) ?? ""
            let headline = "Delegated by @\(senderName)"
            let subtitle = reason != nil ? "Reason: \(reason!)" : (firstLine.isEmpty ? nil : String(firstLine.prefix(80)))

            return DelegationMessageView(
                senderName: senderName,
                reason: reason,
                payload: payload.isEmpty ? nil : payload,
                headline: headline,
                subtitle: subtitle
            )
        }

        if automationSource == "delegation" {
            let sender = fromName ?? "Peer Bot"
            let firstLine = trimmed.components(separatedBy: .newlines).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })?.trimmingCharacters(in: .whitespaces) ?? ""
            return DelegationMessageView(
                senderName: sender,
                reason: nil,
                payload: trimmed.isEmpty ? nil : trimmed,
                headline: "Delegated by @\(sender)",
                subtitle: firstLine.isEmpty ? nil : String(firstLine.prefix(80))
            )
        }

        return nil
    }
}
