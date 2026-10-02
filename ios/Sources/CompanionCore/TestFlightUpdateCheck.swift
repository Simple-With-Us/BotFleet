// Whether a newer TestFlight build of THIS app exists.
//
// Unlike everything else in this package, the source here is not the
// paired Mac — it is a small public manifest the fleet publishes at
// `ai-fleet-coordinator/site/ios-versions.json` (served from
// https://jaywedgeworth22.github.io/ai-fleet-coordinator/ios-versions.json),
// listing the latest TestFlight build per app by bundle id.  A phone checks it
// whether or not it is paired with anything, so it cannot live behind
// `CompanionClient`, which requires a `Connection`.  It gets the same
// treatment anyway: the network call is a thin, injectable fetcher, and the
// comparison it feeds is a pure function tested without one.
import Foundation

/// One app's entry in the manifest, keyed there by bundle id.
public struct VersionManifestEntry: Codable, Hashable, Sendable {
    public var marketingVersion: String?
    public var build: String?
    public var appleId: Int?
    public var displayName: String?

    public init(marketingVersion: String? = nil, build: String? = nil, appleId: Int? = nil, displayName: String? = nil) {
        self.marketingVersion = marketingVersion
        self.build = build
        self.appleId = appleId
        self.displayName = displayName
    }
}

/// The fleet's published version manifest, keyed by bundle id.  Unknown apps
/// and unknown top-level fields decode and are ignored — this phone only
/// ever asks about its own entry.
public struct VersionManifest: Codable, Hashable, Sendable {
    public var schemaVersion: Int?
    public var updatedAt: String?
    public var apps: [String: VersionManifestEntry]

    public init(schemaVersion: Int? = nil, updatedAt: String? = nil, apps: [String: VersionManifestEntry] = [:]) {
        self.schemaVersion = schemaVersion
        self.updatedAt = updatedAt
        self.apps = apps
    }
}

/// A build identity, either the one running or one offered by the manifest —
/// the same two fields Xcode stamps into `Info.plist` as
/// `CFBundleShortVersionString` and `CFBundleVersion`.
public struct AppBuildInfo: Equatable, Sendable {
    public var marketingVersion: String
    public var build: String

    public init(marketingVersion: String, build: String) {
        self.marketingVersion = marketingVersion
        self.build = build
    }
}

/// Fetches the manifest over plain HTTPS.  No auth, no pairing — this is a
/// public file — so the only thing worth injecting for a test is the
/// session, exactly like `CompanionClient` does for the harness.
public struct VersionManifestFetcher: Sendable {
    public static let manifestURL = URL(string: "https://jaywedgeworth22.github.io/ai-fleet-coordinator/ios-versions.json")!

    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetch() async throws -> VersionManifest {
        var request = URLRequest(url: Self.manifestURL)
        // A phone on a bad connection should give up quickly — this check
        // must never be the reason launch feels slow.
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.status(code: http.statusCode, message: nil)
        }
        return try JSONDecoder().decode(VersionManifest.self, from: data)
    }
}

/// Compares this app's own bundle identifier's manifest entry against the
/// build actually running.
public enum TestFlightUpdateCheck {
    /// Matches `PRODUCT_BUNDLE_IDENTIFIER` in `ios/project.yml`.
    public static let bundleId = "app.botfleet"

    /// Whether `candidate` is a newer build than `running`.
    ///
    /// Compares the build number, not the marketing version: the build is
    /// the fleet's monotonically increasing `YYYYMMDDHHmm` stamp and totally
    /// orders two builds even across marketing-version bumps, while
    /// `"1.0.9"` sorting before `"1.0.30"` as strings is exactly the bug a
    /// marketing-version compare would invite.  Both sides here are that
    /// same stamp, so a plain numeric compare is enough; a non-numeric build
    /// (hand-edited fixture, or a future format change) falls back to a
    /// string inequality rather than silently claiming "no update".
    public static func isNewer(_ candidate: AppBuildInfo, than running: AppBuildInfo) -> Bool {
        if let candidateBuild = Int64(candidate.build), let runningBuild = Int64(running.build) {
            return candidateBuild > runningBuild
        }
        return candidate.build != running.build && candidate.build > running.build
    }

    /// The manifest's offer for this app, when it beats what is running.
    /// `nil` covers both "no update" and "the manifest has nothing to say" —
    /// a phone with an unlisted or malformed entry should never claim an
    /// update it cannot describe.
    public static func availableUpdate(in manifest: VersionManifest, running: AppBuildInfo) -> AppBuildInfo? {
        guard let entry = manifest.apps[bundleId],
              let marketingVersion = entry.marketingVersion,
              let build = entry.build
        else { return nil }
        let candidate = AppBuildInfo(marketingVersion: marketingVersion, build: build)
        return isNewer(candidate, than: running) ? candidate : nil
    }

    /// Whether `candidateBuild` already has a matching dismissal on record.
    ///
    /// This is the comparison that makes a dismissal survive a relaunch:
    /// a fresh `TestFlightUpdateMonitor` starts with no in-memory memory of
    /// what was dismissed, so restoring that state on launch means reading
    /// the persisted dismissed build back and comparing it to the candidate
    /// — not merely defaulting to "not dismissed" and waiting for some later
    /// signal to say otherwise, which never arrives when the two already
    /// match.  A build newer than the one on record is correctly not
    /// dismissed, which is what lets a later build reopen the banner.
    public static func isDismissed(candidateBuild: String, dismissedBuild: String?) -> Bool {
        dismissedBuild == candidateBuild
    }
}

/// A pure, UserDefaults-free rate limiter — the caller owns persisting
/// `lastCheckedAt`, this just answers whether enough time has passed.
public enum TestFlightCheckThrottle {
    public static let defaultMinimumInterval: TimeInterval = 3_600

    public static func isDue(lastCheckedAt: Date?, now: Date = Date(), minimumInterval: TimeInterval = defaultMinimumInterval) -> Bool {
        guard let lastCheckedAt else { return true }
        return now.timeIntervalSince(lastCheckedAt) >= minimumInterval
    }
}
