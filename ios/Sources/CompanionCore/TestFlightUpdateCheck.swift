// Whether a newer TestFlight build of THIS app exists.
//
// Unlike everything else in this package, the source here is not the
// paired Mac — it is a small public manifest the fleet publishes at
// `ai-fleet-coordinator/site/ios-versions.json` (served from
// https://simple-with-us.github.io/AI-Fleet-Coordinator/ios-versions.json),
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
    public static let manifestURL = URL(string: "https://simple-with-us.github.io/AI-Fleet-Coordinator/ios-versions.json")!

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
    public static let bundleId = "app.botfleet.ios"

    /// Whether `candidate` is a newer build than `running`.
    ///
    /// Compares the build number, not the marketing version: the build totally
    /// orders two builds even across marketing-version bumps, while
    /// `"1.0.9"` sorting before `"1.0.30"` as strings is exactly the bug a
    /// marketing-version compare would invite.
    ///
    /// The fleet moved `CFBundleVersion` from a 12-digit `YYYYMMDDHHmm` stamp
    /// to the repo commit count (owner 2026-10-18), so a device can briefly
    /// compare across the two formats.  A stamp is always the larger number,
    /// so a plain numeric compare would read a fresh commit-count build as
    /// older than the timestamp build it replaces and never offer the update.
    /// Order the two schemes explicitly first: commit-count builds sort after
    /// timestamp builds, and within a scheme the number still decides.
    /// A non-numeric build (hand-edited fixture, or a future format change)
    /// falls back to a string inequality rather than silently claiming "no
    /// update".
    public static func isNewer(_ candidate: AppBuildInfo, than running: AppBuildInfo) -> Bool {
        let candidateScheme = BuildScheme(candidate.build)
        let runningScheme = BuildScheme(running.build)
        // Compare the scheme itself, not the enum cases: two different
        // timestamp builds are different *cases* carrying different numbers,
        // and falling through on that would skip the numeric compare entirely.
        if candidateScheme.scheme != runningScheme.scheme,
           candidateScheme.isKnown, runningScheme.isKnown {
            return candidateScheme.sortOrder > runningScheme.sortOrder
        }
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

/// Which numbering scheme a `CFBundleVersion` was cut under.
///
/// The fleet retired the UTC `YYYYMMDDHHmm` stamp on 2026-10-18 in favour of
/// the repo commit count.  A device running an older build and being offered a
/// newer one can compare across that boundary exactly once per install, and a
/// bare numeric compare gets it backwards: a 12-digit stamp is always the larger
/// number, so the new build looks older and is never offered.
enum BuildScheme: Equatable {
    /// A 12-digit UTC minute stamp, e.g. `202610080006`.
    case timestamp(Int64)
    /// A repo commit count, e.g. `2058`.
    case commitCount(Int64)
    /// Anything else — a hand-edited fixture or a future format.
    case unknown

    /// The scheme label, carrying no number, so two builds of the same scheme
    /// compare equal here and the caller falls through to a numeric compare.
    enum Kind: Equatable { case timestamp, commitCount, unknown }

    var scheme: Kind {
        switch self {
        case .timestamp: return .timestamp
        case .commitCount: return .commitCount
        case .unknown: return .unknown
        }
    }

    init(_ build: String) {
        guard let value = Int64(build), value >= 0 else { self = .unknown; return }
        // A 12-digit value is a stamp under the retired scheme.  Anything
        // shorter is a commit count; both are ordered by the number itself.
        self = build.count == 12 ? .timestamp(value) : .commitCount(value)
    }

    var isKnown: Bool { self != .unknown }

    /// Timestamp builds predate commit-count builds, so they sort lower.
    var sortOrder: Int {
        switch self {
        case .timestamp: return 0
        case .commitCount: return 1
        case .unknown: return 0
        }
    }
}
