import Foundation

/// Copies a Mac's legacy Node stores into the native store the first time the
/// app runs without the Node harness (`BF-2710`).
///
/// The harness kept bots in `bots.json` and transcripts in `messages.db` under
/// `~/.botfleet`.  The native chat window and companion listener read only the
/// native store, so without this copy a Mac whose harness was retired opens
/// with no bots.  `StoreImporter` does the copy: it reads the legacy files
/// read-only, upserts bots, threads and routines, and inserts messages by id,
/// so a second run adds nothing and an interrupted run resumes.
///
/// The import runs only while `harnessIsGone` answers true.  Beside an
/// installed harness, the harness is still the writer of those files and a
/// copy would go stale.  A marker beside the native store records a finished
/// import, so later launches skip it.  The marker is written only when the
/// importer returns with row and content parity, so a failed, interrupted or
/// unverified run is tried again on the next launch.  A source that still
/// misses parity after `maxUnverifiedRuns` launches (a bot made natively
/// after a partial import keeps the counts apart for good) gets the marker
/// anyway, recording the mismatches, so it does not repeat the whole copy on
/// every launch.  The marker alone decides that the import is done, whatever
/// the store holds afterwards: a user who deletes every bot must not see the
/// legacy ones come back on the next launch.  The app never deletes
/// `companion.sqlite` by itself, and resetting the native store means
/// removing the `native` folder, which takes the marker with it.
public struct NativeLegacyStoreImport: Sendable {
    /// What one call of `runIfNeeded` did.
    public enum Outcome: Equatable, Sendable {
        /// Nothing was imported, and why.
        case skipped(SkipReason)
        /// The import finished.  The counts are what the native store holds
        /// afterwards, as the importer's parity report gives them.  Without
        /// parity no marker is written, so the next launch imports again.
        case imported(bots: Int, threads: Int, messages: Int, parityVerified: Bool)
        /// The importer threw.  No marker was written, so the next launch
        /// tries again.
        case failed(String)
    }

    public enum SkipReason: Equatable, Sendable {
        /// A Node harness LaunchAgent is still installed.
        case harnessPresent
        /// An earlier launch already finished the import.
        case alreadyImported
        /// There is no legacy `bots.json` to import from.
        case noLegacyStore
    }

    /// What the marker file records about a finished import.
    struct Marker: Codable, Equatable {
        let importedAt: Double
        let bots: Int
        let threads: Int
        let messages: Int
        let parityVerified: Bool
        /// Parity and no warnings: the importer's `isFullyVerified`.
        let fullyVerified: Bool
        let mismatches: [String]
        let warnings: [String]
    }

    /// How many launches in a row may finish an import without parity before
    /// the marker is written anyway.
    static let maxUnverifiedRuns = 3

    /// The folder holding the legacy `bots.json` and `messages.db`.
    public let sourceDirectory: URL
    /// The file whose presence means the import already finished.
    public let markerURL: URL
    /// Whether no Node harness is installed on this Mac.
    public let harnessIsGone: @Sendable () -> Bool
    let importer: StoreImporter

    /// Counts the launches that finished an import without parity.
    var attemptsURL: URL { markerURL.appendingPathExtension("attempts") }

    public init(
        sourceDirectory: URL,
        markerURL: URL,
        harnessIsGone: @escaping @Sendable () -> Bool
    ) {
        self.init(
            sourceDirectory: sourceDirectory,
            markerURL: markerURL,
            harnessIsGone: harnessIsGone,
            importer: StoreImporter()
        )
    }

    init(
        sourceDirectory: URL,
        markerURL: URL,
        harnessIsGone: @escaping @Sendable () -> Bool,
        importer: StoreImporter
    ) {
        self.sourceDirectory = sourceDirectory
        self.markerURL = markerURL
        self.harnessIsGone = harnessIsGone
        self.importer = importer
    }

    /// The import for a Mac app whose native store is `native/companion.sqlite`
    /// under `dataDirectory`: the legacy files are read from `dataDirectory`
    /// and the marker sits beside the native store.
    public static func forMacDataDirectory(
        _ dataDirectory: URL,
        harnessPlists: [URL]
    ) -> NativeLegacyStoreImport {
        NativeLegacyStoreImport(
            sourceDirectory: dataDirectory,
            markerURL: dataDirectory
                .appendingPathComponent("native", isDirectory: true)
                .appendingPathComponent("legacy-import.json"),
            harnessIsGone: {
                !harnessPlists.contains { FileManager.default.fileExists(atPath: $0.path) }
            }
        )
    }

    /// Imports the legacy stores into `database` unless the harness is still
    /// installed, the import already finished, or there is nothing to import.
    public func runIfNeeded(into database: DatabaseService) async -> Outcome {
        guard harnessIsGone() else { return .skipped(.harnessPresent) }
        guard !FileManager.default.fileExists(atPath: markerURL.path) else {
            return .skipped(.alreadyImported)
        }
        guard FileManager.default.fileExists(
            atPath: sourceDirectory.appendingPathComponent("bots.json").path
        ) else {
            return .skipped(.noLegacyStore)
        }
        let report: StoreImportParityReport
        do {
            report = try await importer.importStore(from: sourceDirectory, into: database)
        } catch {
            return .failed(String(describing: error))
        }
        let outcome = Outcome.imported(
            bots: report.targetBotCount,
            threads: report.targetThreadCount,
            messages: report.targetMessageCount,
            parityVerified: report.isParityVerified
        )
        // Without parity a later launch must try again, so the marker that
        // would stop it is not written, up to `maxUnverifiedRuns` launches.
        // Warnings alone do not hold it back: they name source data the
        // importer cannot map (a snooze for a bot that is gone), which another
        // run would only report again.
        guard report.isParityVerified || recordUnverifiedRun() >= Self.maxUnverifiedRuns else {
            return outcome
        }
        let marker = Marker(
            importedAt: Date().timeIntervalSince1970,
            bots: report.targetBotCount,
            threads: report.targetThreadCount,
            messages: report.targetMessageCount,
            parityVerified: report.isParityVerified,
            fullyVerified: report.isFullyVerified,
            mismatches: report.mismatches,
            warnings: report.warnings
        )
        do {
            try FileManager.default.createDirectory(
                at: markerURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(marker).write(to: markerURL, options: .atomic)
        } catch {
            // The rows are in.  Without a marker the next launch runs the
            // import again, which adds nothing because the importer is
            // idempotent, so this is not a failure of the import.
        }
        // A verified run starts the count over even when its marker could not
        // be written, so a later unverified run is not sealed early.
        if report.isParityVerified || FileManager.default.fileExists(atPath: markerURL.path) {
            try? FileManager.default.removeItem(at: attemptsURL)
        }
        return outcome
    }

    /// Adds one to the count of launches that finished without parity and
    /// returns the new count.
    private func recordUnverifiedRun() -> Int {
        let previous = (try? String(contentsOf: attemptsURL, encoding: .utf8))
            .flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? 0
        let count = previous + 1
        try? FileManager.default.createDirectory(
            at: attemptsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? String(count).write(to: attemptsURL, atomically: true, encoding: .utf8)
        return count
    }
}
