import Foundation

/// One engine's result:  the fixtures behind it, and whether they all held.
///
/// These types are public and `Sendable` so the probe executable, the node
/// receipt producer and the tests all read one shared shape.  They used to be
/// private to the probe, where a key renamed on one side of the Swift/node
/// contract drifted silently;  here the contract tests on both sides pin the
/// exact key names to one golden fixture, so a rename on either side fails a
/// test instead of drifting.  The JSON keys are identical to the ones the
/// probe wrote when the types lived in the executable.
public struct EngineReplayReport: Codable, Equatable, Sendable {
    public let engineId: String
    /// The replay family the engine id resolved to, or null when it resolved
    /// to none.
    public let family: String?
    /// Whether the engine could be measured at all.
    public let measured: Bool
    /// Why the engine could not be measured, when it could not.
    public let unmeasuredReason: String?
    public let fixtureCount: Int
    public let passedCount: Int
    public let fixtures: [EngineReplayOutcome]
    /// Whether every fixture behind this engine held.
    public let isFullyVerified: Bool

    public init(
        engineId: String,
        family: String?,
        measured: Bool,
        unmeasuredReason: String?,
        fixtureCount: Int,
        passedCount: Int,
        fixtures: [EngineReplayOutcome],
        isFullyVerified: Bool
    ) {
        self.engineId = engineId
        self.family = family
        self.measured = measured
        self.unmeasuredReason = unmeasuredReason
        self.fixtureCount = fixtureCount
        self.passedCount = passedCount
        self.fixtures = fixtures
        self.isFullyVerified = isFullyVerified
    }
}

/// The whole report the probe writes and the receipt producer reads.
public struct EngineReplayParityReport: Codable, Equatable, Sendable {
    public let version: Int
    public let engines: [EngineReplayReport]
    /// Whether every engine the packet named was measured and held.
    public let isFullyVerified: Bool
    /// The engine ids the packet named, in the packet's order.
    public let requestedEngines: [String]

    public init(
        version: Int,
        engines: [EngineReplayReport],
        isFullyVerified: Bool,
        requestedEngines: [String]
    ) {
        self.version = version
        self.engines = engines
        self.isFullyVerified = isFullyVerified
        self.requestedEngines = requestedEngines
    }

    /// The report-level verdict, computed out of the engines' own verdicts.
    ///
    /// This is the aggregation the probe writes into `isFullyVerified`, made
    /// pure so a test can hold a report to it:  a report whose stored flag
    /// disagrees with its engines' verdicts is internally contradictory and
    /// fails a test here rather than certifying anything downstream.
    public static func aggregateFullyVerified(engines: [EngineReplayReport]) -> Bool {
        engines.allSatisfy(\.isFullyVerified)
    }
}
