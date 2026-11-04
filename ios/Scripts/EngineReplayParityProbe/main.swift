// Drive the native engine replay harness and write the per-engine report the
// decommission evidence bundle reads.
//
// The gap this closes.  The Phase 6 gate asks for `replay-parity`, and the
// bundle's `replay` receipt names one check per engine:  `engine:<id>`, for
// every id in the packet's own `engines` list.  Nothing in the tree produced
// those checks, so the receipt could only ever be asserted by a person.
//
// The vocabulary is not this probe's to pick, and the probe does not pick it.
// The bundle derives its check names from `bundle.engines`, so the probe reads
// the engine list from the bundle request and names its checks from that
// list.  A request that names an engine with no replay family behind it is
// NOT silently skipped and NOT certified:  it earns a failing check with the
// reason named, because a receipt that certifies an engine nobody replayed is
// worse than a receipt that refuses.
//
// The measurement itself lives in `EngineReplayCatalog`, next to the code it
// measures, because that is where it can be tested.  This file is the probe
// around it:  it reads the request, runs the catalog, and writes the report.
//
// What the probe does not do.  It does not write the recorded stdin trace into
// the report:  the Claude family's user frame carries a fresh `UUID()` per
// call, so that trace is not byte-stable across runs and a report carrying it
// would show spurious drift.  The catalog records the stdin guard's verdict
// instead, which is the part that is stable.  It does not record the spawn
// spec's environment either:  it names the variables an engine expects, and a
// report is a thing that gets hashed into a packet.
//
// Usage:
//   swift run --package-path ios EngineReplayParityProbe -- \
//     --request <bundle-request.json> --out <report.json>
//
// `--request` is the evidence bundle request.  It is read for its `engines`
// list and nothing else; the candidate, mode and hosts in the receipt come
// from the same request, so the probe and the receipt cannot disagree about
// which engines are in scope.
//
// `--out` is the file the report is written to.  It is owner-only:  the report
// names the executables the engines were launched with, and those name the
// engine a person is talking to.
import Foundation
import CompanionCore

/// The usage text, printed when the arguments are wrong.
let usage = """
usage: EngineReplayParityProbe --request <bundle-request.json> --out <report.json>

  --request  the evidence bundle request; its `engines` list names the engines to replay
  --out      the file the per-engine replay report is written to
"""

/// A flag's value, or nil when the flag is absent.
func flagValue(_ args: [String], _ flag: String) -> String? {
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    let value = args[index + 1]
    // A flag with no value is a usage error, not a path that happens to be
    // the next flag's name.
    guard !value.hasPrefix("--") else { return nil }
    return value
}

/// The engine ids the packet names, in the packet's order.
///
/// The request is untrusted input, so it is parsed strictly:  a request that
/// is not a JSON object, or whose `engines` is not an array of non-empty
/// strings, is refused rather than read loosely.  A request that names the
/// same engine twice is refused too, because the bundle's check names would
/// then collide and one engine's result would silently overwrite the other's.
func requestedEngines(in requestPath: String) throws -> [String] {
    let data = try Data(contentsOf: URL(fileURLWithPath: requestPath))
    let parsed = try JSONSerialization.jsonObject(with: data)
    guard let object = parsed as? [String: Any] else {
        throw ProbeError("the bundle request is not a JSON object")
    }
    guard let engines = object["engines"] as? [Any] else {
        throw ProbeError("the bundle request has no `engines` list")
    }
    var ids: [String] = []
    for entry in engines {
        guard let id = entry as? String, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ProbeError("the bundle request's `engines` list holds something that is not an engine id")
        }
        ids.append(id)
    }
    guard !ids.isEmpty else {
        throw ProbeError("the bundle request names no engines")
    }
    guard Set(ids).count == ids.count else {
        throw ProbeError("the bundle request names the same engine more than once")
    }
    return ids
}

/// A refusal the probe states in words.
struct ProbeError: Error, LocalizedError, CustomStringConvertible {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
    var errorDescription: String? { message }
}

/// One engine's result:  the fixtures behind it, and whether they all held.
struct EngineReport: Codable {
    let engineId: String
    /// The replay family the engine id resolved to, or null when it resolved
    /// to none.
    let family: String?
    /// Whether the engine could be measured at all.
    let measured: Bool
    /// Why the engine could not be measured, when it could not.
    let unmeasuredReason: String?
    let fixtureCount: Int
    let passedCount: Int
    let fixtures: [EngineReplayOutcome]
    /// Whether every fixture behind this engine held.
    let isFullyVerified: Bool
}

/// The whole report.
struct ReplayParityReport: Codable {
    let version: Int
    let engines: [EngineReport]
    /// Whether every engine the packet named was measured and held.
    let isFullyVerified: Bool
    /// The engine ids the packet named, in the packet's order.
    let requestedEngines: [String]
}

/// Measure one engine the packet named.
///
/// An engine with no replay family behind it earns a failing check with the
/// reason named.  It is never certified and never skipped.
func measure(engineId: String) async -> EngineReport {
    guard let family = EngineReplayCatalog.family(forEngineId: engineId) else {
        return EngineReport(
            engineId: engineId,
            family: nil,
            measured: false,
            unmeasuredReason: "no replay family drives this engine, so no fixture could be run for it",
            fixtureCount: 0,
            passedCount: 0,
            fixtures: [],
            isFullyVerified: false
        )
    }
    let outcomes = await EngineReplayCatalog.measureFamily(family)
    let passedCount = outcomes.filter(\.passed).count
    return EngineReport(
        engineId: engineId,
        family: family.rawValue,
        measured: true,
        unmeasuredReason: nil,
        fixtureCount: outcomes.count,
        passedCount: passedCount,
        fixtures: outcomes,
        isFullyVerified: !outcomes.isEmpty && passedCount == outcomes.count
    )
}

/// Measure every engine the packet named.
func measure(engines: [String]) async -> [EngineReport] {
    var reports: [EngineReport] = []
    for engineId in engines {
        reports.append(await measure(engineId: engineId))
    }
    return reports
}

/// Run the probe and write the report.
func run() async throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let requestPath = flagValue(args, "--request"), let outPath = flagValue(args, "--out") else {
        FileHandle.standardError.write(Data((usage + "\n").utf8))
        exit(2)
    }
    let engines = try requestedEngines(in: requestPath)
    let reports = await measure(engines: engines)
    let fullyVerified = reports.allSatisfy(\.isFullyVerified)

    let report = ReplayParityReport(
        version: 1,
        engines: reports,
        isFullyVerified: fullyVerified,
        requestedEngines: engines
    )

    let out = URL(fileURLWithPath: outPath)
    let outDirectory = out.deletingLastPathComponent()
    // The directory is made private only when this probe creates it.  A
    // directory that was already there belongs to whoever made it, and
    // changing its mode out from under them is not this probe's business.
    var isDirectory: ObjCBool = false
    if !FileManager.default.fileExists(atPath: outDirectory.path, isDirectory: &isDirectory) {
        try FileManager.default.createDirectory(
            at: outDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
    } else if isDirectory.boolValue {
        let mode = try FileManager.default.attributesOfItem(atPath: outDirectory.path)[.posixPermissions] as? NSNumber
        if let mode = mode?.intValue, mode & 0o077 != 0 {
            throw ProbeError("the report directory is not private, so the report would not be owner-only: \(outDirectory.path)")
        }
    } else {
        throw ProbeError("the report's parent path is not a directory: \(outDirectory.path)")
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    let bytes = try encoder.encode(report)
    try bytes.write(to: out, options: [.atomic])
    // The report names the executables the engines were launched with, so it
    // is owner-only.
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: out.path)

    let summary: [String: Any] = [
        "report": out.path,
        "requestedEngines": engines,
        "isFullyVerified": fullyVerified,
        "engines": reports.map { report -> [String: Any] in
            [
                "engine": report.engineId,
                "measured": report.measured,
                "fixtures": report.fixtureCount,
                "passed": report.passedCount,
                "unmeasuredReason": report.unmeasuredReason as Any,
            ]
        },
    ]
    print(String(data: try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8) ?? "{}")
    // A probe that checked something and found it did not hold says so in its
    // exit code, so a caller cannot mistake it for a pass.
    if !fullyVerified {
        exit(1)
    }
}

do {
    try await run()
} catch {
    FileHandle.standardError.write(Data("EngineReplayParityProbe refused: \(error.localizedDescription)\n".utf8))
    exit(2)
}
