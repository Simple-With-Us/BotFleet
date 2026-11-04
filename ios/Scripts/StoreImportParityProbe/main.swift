// Import an Electron-era Node store into the native Swift store and write the
// parity report the decommission evidence bundle needs.
//
// The gap this closes:  the Phase 6 gate asks for `final-import-parity`, and
// the importer already computes the verdict, but a `Codable` struct does not
// carry a computed property.  `StoreImportParityReport.isParityVerified` and
// `isFullyVerified` are computed, so encoding the report alone produces a
// file with no verdict in it, and a file with no verdict in it is a file
// nothing can check.  So the report is encoded and the two verdicts are
// written into it explicitly.
//
// The probe is deliberately the same shape as the other executables in this
// package:  it reads a source directory, writes one file, and exits non-zero
// when the thing it checked did not hold.
//
// Usage:
//   swift run --package-path ios StoreImportParityProbe -- \
//     --source /path/to/node-store --out /path/to/import-parity.json
//
// `--source` must hold the stores the importer reads:  `messages.db`,
// `bots.json`, `groups.json`, `routines.json` and `webhooks.json`.
// `--target` names the native database the import writes into;  it must not
// exist yet, because a run that reused an older database would report a
// parity that the run did not produce.
import Foundation
import CompanionCore

/// The usage text, printed when the arguments are wrong.
let usage = """
usage: StoreImportParityProbe --source <node-store-directory> --out <report.json> [--target <native.sqlite>]

  --source  a directory holding messages.db, bots.json, groups.json, routines.json and webhooks.json
  --out     the file the parity report is written to
  --target  the native database the import writes into (default: <out-dir>/native-store.sqlite)
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

/// Run the import and write the report.
func run() async throws {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let sourcePath = flagValue(args, "--source"), let outPath = flagValue(args, "--out") else {
        FileHandle.standardError.write(Data((usage + "\n").utf8))
        exit(2)
    }
    let source = URL(fileURLWithPath: sourcePath)
    let out = URL(fileURLWithPath: outPath)
    let targetPath = flagValue(args, "--target")
        ?? out.deletingLastPathComponent().appendingPathComponent("native-store.sqlite").path

    guard FileManager.default.fileExists(atPath: source.path) else {
        throw NSError(domain: "StoreImportParityProbe", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "the source store does not exist: \(source.path)",
        ])
    }
    // A run that reused an older database would report a parity it did not
    // produce, so the target has to be new.
    guard !FileManager.default.fileExists(atPath: targetPath) else {
        throw NSError(domain: "StoreImportParityProbe", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "the target database already exists: \(targetPath)",
        ])
    }

    // The target's parent has to exist before the database is opened, or a
    // fresh --out directory fails instead of importing.  It is created
    // owner-only, because the imported database and its journal siblings
    // hold the message bodies the report names.
    let outDirectory = out.deletingLastPathComponent()
    let targetDirectory = URL(fileURLWithPath: targetPath).deletingLastPathComponent()
    try FileManager.default.createDirectory(
        at: outDirectory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    try FileManager.default.createDirectory(
        at: targetDirectory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    // A directory that already existed does not get those permissions from
    // the creation above, and it is the directory that holds the imported
    // database and its journal siblings.
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: outDirectory.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: targetDirectory.path)

    let target = try DatabaseService(path: targetPath)
    let importer = StoreImporter(batchSize: 2_000)
    let report = try await importer.importStore(from: source, into: target)
    // The imported database holds the same message bodies the report names,
    // so it is owner-only like the report, and so are the journal siblings
    // that hold the rows written since the last checkpoint.
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: targetPath)
    for suffix in ["-wal", "-shm"] {
        let sibling = targetPath + suffix
        if FileManager.default.fileExists(atPath: sibling) {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: sibling)
        }
    }

    // The struct's own encoding, plus the two verdicts it computes but cannot
    // encode.  This is the whole point of the probe.
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    var object = try JSONSerialization.jsonObject(
        with: encoder.encode(report)
    ) as? [String: Any] ?? [:]
    object["isParityVerified"] = report.isParityVerified
    object["isFullyVerified"] = report.isFullyVerified

    let bytes = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    try bytes.write(to: out, options: [.atomic])
    // The report may hold message bodies, so it is owner-only.
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: out.path)

    let summary: [String: Any] = [
        "report": out.path,
        "target": targetPath,
        "isParityVerified": report.isParityVerified,
        "isFullyVerified": report.isFullyVerified,
        "sourceMessageCount": report.sourceMessageCount,
        "targetMessageCount": report.targetMessageCount,
        "warnings": report.warnings.count,
        "mismatches": report.mismatches.count,
    ]
    print(String(data: try JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted]), encoding: .utf8) ?? "{}")
    // A probe that checked something and found it did not hold says so in its
    // exit code, so a caller cannot mistake it for a pass.
    if !report.isFullyVerified {
        exit(1)
    }
}

do {
    try await run()
} catch {
    FileHandle.standardError.write(Data("StoreImportParityProbe refused: \(error.localizedDescription)\n".utf8))
    exit(2)
}
