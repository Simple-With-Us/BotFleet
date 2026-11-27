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
/// importer returns, so a failed or interrupted run is tried again on the
/// next launch.
public struct NativeLegacyStoreImport: Sendable {
    /// What one call of `runIfNeeded` did.
    public enum Outcome: Equatable, Sendable {
        /// Nothing was imported, and why.
        case skipped(SkipReason)
        /// The import finished.  The counts are what the native store holds
        /// afterwards, as the importer's parity report gives them.
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
        let mismatches: [String]
    }

    /// The folder holding the legacy `bots.json` and `messages.db`.
    public let sourceDirectory: URL
    /// The file whose presence means the import already finished.
    public let markerURL: URL
    /// Whether no Node harness is installed on this Mac.
    public let harnessIsGone: @Sendable () -> Bool
    let importer: StoreImporter

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
        let marker = Marker(
            importedAt: Date().timeIntervalSince1970,
            bots: report.targetBotCount,
            threads: report.targetThreadCount,
            messages: report.targetMessageCount,
            parityVerified: report.isParityVerified,
            mismatches: report.mismatches
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
        return .imported(
            bots: report.targetBotCount,
            threads: report.targetThreadCount,
            messages: report.targetMessageCount,
            parityVerified: report.isParityVerified
        )
    }
}
