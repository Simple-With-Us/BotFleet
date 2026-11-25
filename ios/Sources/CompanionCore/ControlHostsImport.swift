import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// One entry in BotFleet Control's saved-server file.
///
/// The shape is Control's own `ServerHost` exactly:  `control-hosts.json` is a
/// JSON array of these.  The type is redeclared here because `CompanionCore`
/// cannot import `mac-control`'s module, and a migration that guessed at the
/// file's keys would refuse a real file or, worse, read it wrong.
public struct ControlHostEntry: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let baseURL: URL
    public let authToken: String?
    public let isLocal: Bool

    public init(id: String, name: String, baseURL: URL, authToken: String?, isLocal: Bool) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.authToken = authToken
        self.isLocal = isLocal
    }

    /// The same entry with its token removed.
    public var withoutToken: ControlHostEntry {
        ControlHostEntry(id: id, name: name, baseURL: baseURL, authToken: nil, isLocal: isLocal)
    }

    /// The file's bytes, written the way Control writes them:  pretty, sorted,
    /// owner-only, so Control keeps reading what this app rewrites.
    public static func fileData(_ entries: [ControlHostEntry]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(entries)
    }
}

/// What one entry in Control's file becomes, decided without touching anything.
public enum ControlHostImportOutcome: Equatable, Sendable {
    /// Move this one:  a new native record, and its token into the Keychain.
    case toImport(origin: HostOrigin, name: String, hasToken: Bool)
    /// Native already holds this origin.  Control's token, if it has one, is
    /// enrolled for the record that already exists only when native holds no
    /// credential for it;  when native does, both copies stay put and the
    /// entry is reported.
    case credentialForExisting(origin: HostOrigin, name: String, hasToken: Bool)
    /// Not imported, and Control's entry is left exactly as it is:  the local
    /// anchor, or the synthetic seed Control itself drops at load time.
    case leftInPlace(Reason)
    /// Cannot become a native record:  Control keeps it and its token, because
    /// refusing to move a secret is better than discarding it.
    case refused(Reason)

    public enum Reason: String, Equatable, Sendable {
        /// `isLocal` — native's This Mac anchor already exists.
        case localAnchor
        /// Control's seeded `hetzner` default, which has no token.
        case syntheticSeed
        /// A blank name; `HostRecord.validate()` would refuse the record.
        case unnamed
        /// Not HTTPS, or HTTP that is not loopback.
        case invalidOrigin
    }
}

/// The effects a run applies, so a test can prove them without a Keychain.
public protocol ControlHostsImportEffects: Sendable {
    /// What the native store holds now.
    func readNativeHosts() async throws -> [HostRecord]
    /// Whether the Keychain already holds a credential for that record.
    func nativeHasCredential(for host: HostRecord) async throws -> Bool
    /// Puts the token in the Keychain for the record.
    func enroll(_ token: String, for host: HostRecord) async throws
    /// Writes the record into the native store.
    func upsert(_ host: HostRecord) async throws
    /// Removes a record the native store now holds, for rollback only.
    func removeRecord(id: String) throws
    /// Rewrites Control's file.  Called once, after every effect succeeded.
    func writeControlFile(_ entries: [ControlHostEntry]) throws
    /// Removes a credential the run enrolled, for rollback only.  The
    /// Keychain files by the record's UUID, so this names the record the run
    /// created.
    func removeCredential(recordID: String)
}

/// The one-time import of BotFleet Control's saved servers (BF-2702).
///
/// The plan is the decision, and it is pure:  given Control's entries and what
/// the native store already holds, it says what each entry becomes, and
/// running it changes nothing.  That is what a dry run is, and it is what the
/// tests read.
///
/// A run then applies the plan in the order the two stores require:
///
/// 1. every token goes into the Keychain first, one entry at a time, so a
///    failure never leaves a record without the credential it needs;
/// 2. the records follow, each with a fresh UUID for its native id;
/// 3. only then is Control's file rewritten without the tokens that moved.
///
/// A failure anywhere before step 3 undoes what was written — the records the
/// run created and the credentials it enrolled — and leaves Control's file
/// untouched, so the next attempt starts from the state the first one found.
/// Nothing is ever deleted from Control's file unless the same data now lives
/// in the native store.
///
/// Re-running is therefore free:  after a successful run every origin is
/// already present and every token has already moved, so a second plan imports
/// nothing and writes nothing.
public enum ControlHostsImport {
    /// Reads Control's file, which holds the owner's tokens, through a
    /// descriptor opened with `O_NOFOLLOW` and bounded in size —  the same
    /// read the deliberate-stop marker gets, because a token file is worth
    /// the same care as a marker.  An unreadable, malformed or foreign file
    /// is refused whole:  a migration that half-reads a file is worse than
    /// one that will not start.
    public static func readEntries(from fileURL: URL) throws -> [ControlHostEntry] {
        var listed = stat()
        if lstat(fileURL.path, &listed) != 0 { throw ControlHostsImportError.unreadableFile }
        let largest = Int64(1_048_576)
        guard listed.st_mode & S_IFMT == S_IFREG, listed.st_size >= 0, listed.st_size <= largest else {
            throw ControlHostsImportError.unreadableFile
        }
        let descriptor = Darwin.open(fileURL.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard descriptor >= 0 else { throw ControlHostsImportError.unreadableFile }
        defer { Darwin.close(descriptor) }
        var opened = stat()
        guard fstat(descriptor, &opened) == 0, opened.st_mode & S_IFMT == S_IFREG,
              opened.st_size >= 0, opened.st_size <= largest else {
            throw ControlHostsImportError.unreadableFile
        }
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = buffer.withUnsafeMutableBytes { raw in Darwin.read(descriptor, raw.baseAddress, raw.count) }
            guard count >= 0, bytes.count + count <= 1_048_576 else {
                throw ControlHostsImportError.unreadableFile
            }
            if count == 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        guard !bytes.isEmpty else { return [] }
        guard let entries = try? JSONDecoder().decode([ControlHostEntry].self, from: bytes) else {
            throw ControlHostsImportError.unreadableFile
        }
        return entries
    }

    /// The decision for every entry, computed from the file's contents and the
    /// native store's, and from nothing else.
    public static func plan(entries: [ControlHostEntry], existing: [HostRecord]) -> [ControlHostImportOutcome] {
        // HostOrigin is Equatable but not Hashable, so the origins native
        // holds are an array the decision walks; the list is a handful of
        // hosts, never a hot path.
        let existingOrigins = existing.map(\.origin)
        return entries.map { entry in
            if entry.isLocal { return .leftInPlace(.localAnchor) }
            if entry.id == "hetzner" && entry.name == "Hetzner Server"
                && entry.baseURL.absoluteString == "https://hetzner.botfleet.app"
                && entry.authToken == nil {
                return .leftInPlace(.syntheticSeed)
            }
            guard !entry.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .refused(.unnamed)
            }
            guard let origin = try? HostOrigin(entry.baseURL.absoluteString) else {
                return .refused(.invalidOrigin)
            }
            if existingOrigins.contains(origin) {
                return .credentialForExisting(origin: origin, name: entry.name, hasToken: entry.authToken != nil)
            }
            return .toImport(origin: origin, name: entry.name, hasToken: entry.authToken != nil)
        }
    }

    /// What a run would do, without doing any of it.
    public static func dryRun(entries: [ControlHostEntry], existing: [HostRecord]) -> ControlHostsImportSummary {
        summary(of: plan(entries: entries, existing: existing))
    }

    /// Applies the plan through the given effects.
    ///
    /// `makeRecordID` exists so a test can pin the ids the records receive.
    /// It is a fresh UUID by default, because a record's id is also the
    /// Keychain account the credential is filed under.
    @discardableResult
    public static func run(
        entries: [ControlHostEntry],
        effects: any ControlHostsImportEffects,
        makeRecordID: @escaping () -> String = { UUID().uuidString }
    ) async throws -> ControlHostsImportSummary {
        let outcomes = plan(entries: entries, existing: try await effects.readNativeHosts())

        // Which entries lose their token, decided as the run goes rather than
        // from the plan:  a token is only ever removed from Control when this
        // run moved it somewhere that keeps it.  An entry whose credential
        // native already holds is left as it is, because the two copies are
        // not provably the same token and this run never reads one to compare.
        var stripToken = Array(repeating: false, count: entries.count)
        var credentialAlreadyNative = 0

        // The written state, kept so a failure can be undone in reverse.
        var createdRecords: [String] = []
        var enrolledRecords: [String] = []
        do {
            for (index, (entry, outcome)) in zip(entries, outcomes).enumerated() {
                switch outcome {
                case .toImport(let origin, let name, let hasToken):
                    let id = makeRecordID()
                    let record = HostRecord(id: id, name: name, origin: origin)
                    try record.validate()
                    if let token = entry.authToken, hasToken {
                        try await effects.enroll(token, for: record)
                        enrolledRecords.append(id)
                        stripToken[index] = true
                    } else if entry.authToken == nil {
                        stripToken[index] = false
                    } else {
                        stripToken[index] = hasToken
                    }
                    try await effects.upsert(record)
                    createdRecords.append(id)
                case .credentialForExisting(let origin, _, let hasToken):
                    guard let token = entry.authToken, hasToken else { continue }
                    let existing = try await effects.readNativeHosts()
                    // Matched on the origin and never on the name:  two hosts
                    // can share a name, and the origin is what native's own
                    // records are keyed by.
                    guard let record = existing.first(where: { $0.origin == origin && !$0.isLocal }) else { continue }
                    if try await effects.nativeHasCredential(for: record) {
                        // Native already holds a credential for this origin.
                        // Control's copy is a second one, and nothing proves
                        // the two are the same token, so it is kept where it
                        // is and reported rather than dropped.
                        credentialAlreadyNative += 1
                        stripToken[index] = false
                        continue
                    }
                    try await effects.enroll(token, for: record)
                    enrolledRecords.append(record.id)
                    stripToken[index] = true
                case .leftInPlace, .refused:
                    continue
                }
            }
        } catch {
            // Undo in reverse:  a record first, then the credential that was
            // filed for it, so no record is left behind without its token and
            // no token is left behind for a record that no longer exists.
            for id in createdRecords.reversed() {
                try? effects.removeRecord(id: id)
            }
            for id in enrolledRecords.reversed() {
                effects.removeCredential(recordID: id)
            }
            throw error
        }

        // Only now does Control's file move:  the entries whose token this
        // run put somewhere that keeps it lose it, and everything else —  the
        // anchor, the seed, the refused, and any credential native already
        // held —  stays byte for byte as it was.
        if stripToken.contains(true) {
            try effects.writeControlFile(zip(entries, stripToken).map { entry, strip in
                strip ? entry.withoutToken : entry
            })
        }
        var summary = self.summary(of: outcomes)
        summary.credentialAlreadyNative = credentialAlreadyNative
        return summary
    }

    /// The counts a dry run and a completed run both report.
    public static func summary(of outcomes: [ControlHostImportOutcome]) -> ControlHostsImportSummary {
        var leftInPlace: [ControlHostImportOutcome.Reason: Int] = [:]
        var refused: [ControlHostImportOutcome.Reason: Int] = [:]
        var imports = 0
        var credentials = 0
        for outcome in outcomes {
            switch outcome {
            case .toImport: imports += 1
            case .credentialForExisting(_, _, let hasToken): if hasToken { credentials += 1 }
            case .leftInPlace(let reason): leftInPlace[reason, default: 0] += 1
            case .refused(let reason): refused[reason, default: 0] += 1
            }
        }
        return ControlHostsImportSummary(
            toImport: imports,
            credentialsForExisting: credentials,
            leftInPlace: leftInPlace,
            refused: refused
        )
    }
}

/// What one run or one dry run would do, in counts.
public struct ControlHostsImportSummary: Equatable, Sendable {
    /// Entries that become new native records.
    public let toImport: Int
    /// Credentials moved for origins native already holds.
    public let credentialsForExisting: Int
    /// Entries left in Control's file without their token removed.
    public let leftInPlace: [ControlHostImportOutcome.Reason: Int]
    /// Entries Control keeps, token and all, because they cannot move.
    public let refused: [ControlHostImportOutcome.Reason: Int]
    /// Credentials Control still holds because native already held one for
    /// that origin, so this run never moved them.  A dry run reports 0:  it
    /// reads no credentials, so it cannot know.
    public var credentialAlreadyNative = 0

    public init(
        toImport: Int,
        credentialsForExisting: Int,
        leftInPlace: [ControlHostImportOutcome.Reason: Int] = [:],
        refused: [ControlHostImportOutcome.Reason: Int] = [:]
    ) {
        self.toImport = toImport
        self.credentialsForExisting = credentialsForExisting
        self.leftInPlace = leftInPlace
        self.refused = refused
    }

    /// True when there is nothing left to do:  what a repeat run reports.
    public var isEmpty: Bool { toImport == 0 && credentialsForExisting == 0 }
}

/// Why the file itself could not be used.
public enum ControlHostsImportError: LocalizedError, Equatable, Sendable {
    case unreadableFile

    public var errorDescription: String? {
        switch self {
        case .unreadableFile:
            return "BotFleet Control's saved-server file could not be read, so nothing was imported."
        }
    }
}
