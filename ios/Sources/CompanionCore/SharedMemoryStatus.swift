// Shared memory (the recall corpus bots search), as one read-only row in
// Settings.
//
// Mirrors `GET /api/qdrant/status` (`RecallStatus` in
// `server/recall-transport.ts`) and the labels in `src/lib/qdrant-status.ts`.
// Read-only on purpose: the service address, the collection and the access
// credentials are set on the computer, and the phone neither shows nor edits
// them.  The status carries the configured service URL, which this type
// deliberately does not decode, so it can never reach a view.
import Foundation

public struct SharedMemoryStatus: Decodable, Hashable, Sendable {
    public var ready: Bool
    public var configured: Bool
    /// `unconfigured`, `degraded` or `ready`.
    public var state: String?
    /// `recall-service`, `recall-cli` or `unconfigured`.
    public var source: String?
    public var collection: String?
    /// Epoch milliseconds.
    public var checkedAt: Double?
    public var lastSuccessAt: Double?
    public var pointsCount: Double?
    /// `none`, `complete`, `missing-id` or `missing-secret`.
    public var accessTokenState: String?
    public var error: String?

    private enum CodingKeys: String, CodingKey {
        case ready, configured, state, source, collection, checkedAt, lastSuccessAt, pointsCount, accessTokenState, error
    }

    public init(
        ready: Bool = false,
        configured: Bool = false,
        state: String? = nil,
        source: String? = nil,
        collection: String? = nil,
        checkedAt: Double? = nil,
        lastSuccessAt: Double? = nil,
        pointsCount: Double? = nil,
        accessTokenState: String? = nil,
        error: String? = nil
    ) {
        self.ready = ready
        self.configured = configured
        self.state = state
        self.source = source
        self.collection = collection
        self.checkedAt = checkedAt
        self.lastSuccessAt = lastSuccessAt
        self.pointsCount = pointsCount
        self.accessTokenState = accessTokenState
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ready = (try? container.decodeIfPresent(Bool.self, forKey: .ready)) ?? false
        configured = (try? container.decodeIfPresent(Bool.self, forKey: .configured)) ?? false
        state = try? container.decodeIfPresent(String.self, forKey: .state)
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        collection = try? container.decodeIfPresent(String.self, forKey: .collection)
        checkedAt = try? container.decodeIfPresent(Double.self, forKey: .checkedAt)
        lastSuccessAt = try? container.decodeIfPresent(Double.self, forKey: .lastSuccessAt)
        pointsCount = try? container.decodeIfPresent(Double.self, forKey: .pointsCount)
        accessTokenState = try? container.decodeIfPresent(String.self, forKey: .accessTokenState)
        error = try? container.decodeIfPresent(String.self, forKey: .error)
    }

    /// "Not configured", "Ready" or "Needs attention".  Port of
    /// `qdrantStateLabel`.
    public var stateLabel: String {
        if state == "unconfigured" || source == "unconfigured" { return "Not configured" }
        if state == "ready" || ready { return "Ready" }
        return "Needs attention"
    }

    /// Which route answers recall queries.
    public var routeLabel: String {
        switch source {
        case "recall-service": return "Recall service"
        case "recall-cli": return "Your computer's recall CLI"
        default: return "Not configured"
        }
    }

    /// "Oct 9, 2026, 3:15pm", or "None recorded".
    public var lastSuccessLabel: String {
        guard let lastSuccessAt else { return "None recorded" }
        return OwnerClock.stamp(ms: lastSuccessAt)
    }

    /// "12,345 points" in the collection, once it answers.
    public var pointsLabel: String? {
        guard ready, let pointsCount, pointsCount.isFinite else { return nil }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_US")
        let count = formatter.string(from: NSNumber(value: pointsCount)) ?? "0"
        return "\(count) \(pointsCount == 1 ? "point" : "points")"
    }

    /// The warning for a half-configured Cloudflare Access service token, or
    /// nil when the pair is whole (or absent, the ordinary case).  Half a pair
    /// sends no Access headers at all, and the service answers a login page
    /// that reads like an outage.
    public var accessWarning: String? {
        switch accessTokenState {
        case "missing-id":
            return "The Cloudflare Access client id is missing, so the cloud recall service will refuse your computer."
        case "missing-secret":
            return "The Cloudflare Access client secret is missing, so the cloud recall service will refuse your computer."
        default:
            return nil
        }
    }
}
