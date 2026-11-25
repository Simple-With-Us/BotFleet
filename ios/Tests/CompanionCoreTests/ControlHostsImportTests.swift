#if os(macOS)
import Foundation
import Testing
@testable import CompanionCore

// The one-time import of BotFleet Control's saved servers (BF-2702).
//
// Every proof runs on synthetic fixtures in a temporary directory:  a Control
// file written by the test, a native store in a temp directory, and an effects
// double that records what it was asked to do.  Nothing touches a real
// `~/.botfleet`, a real Keychain, or a live host.
private final class FakeEffects: ControlHostsImportEffects, @unchecked Sendable {
    private let lock = NSLock()
    private var native: [HostRecord] = []
    private var credentials: [String] = []
    private var controlFile: [ControlHostEntry] = []
    private var writes = 0
    private var upserted: [String] = []
    private var enrolled: [String] = []
    private var removed: [String] = []
    private var enrollments = 0
    /// When set, the enrollment at this one-based position fails, so a run
    /// can be broken after its earlier writes are already in flight.
    private var failOnEnrollmentNumber: Int?
    /// When set, the upsert at this one-based position fails after its
    /// enrollment already succeeded, so a credential has no record.
    private var failOnUpsertNumber: Int?
    private var upserts = 0
    /// Makes Control's rewrite fail, so the transaction's last step can be
    /// broken after its earlier writes.
    var failControlWrite = false

    init(
        native: [HostRecord] = [],
        controlFile: [ControlHostEntry] = [],
        failOnEnrollmentNumber: Int? = nil,
        failOnUpsertNumber: Int? = nil
    ) {
        self.native = native
        self.controlFile = controlFile
        self.failOnEnrollmentNumber = failOnEnrollmentNumber
        self.failOnUpsertNumber = failOnUpsertNumber
    }

    func readNativeHosts() async throws -> [HostRecord] {
        //  `withLock` rather than `lock()`/`unlock()`:  the raw pair is
        //  unavailable from an async context in Swift 6.
        lock.withLock { native }
    }

    func nativeHasCredential(for host: HostRecord) async throws -> Bool {
        lock.withLock { credentials.contains(host.id) }
    }

    func enroll(_ token: String, for host: HostRecord) async throws {
        let failing = lock.withLock {
            enrollments += 1
            let failing = failOnEnrollmentNumber == enrollments
            if !failing {
                credentials.append(host.id)
                enrolled.append(host.id)
            }
            return failing
        }
        if failing { throw ControlHostsImportError.unreadableFile }
    }

    func upsert(_ host: HostRecord) async throws {
        let failing = lock.withLock {
            upserts += 1
            let failing = failOnUpsertNumber == upserts
            if !failing {
                native.append(host)
                upserted.append(host.id)
            }
            return failing
        }
        if failing { throw ControlHostsImportError.unreadableFile }
    }

    func removeRecord(id: String) throws {
        lock.lock(); defer { lock.unlock() }
        native.removeAll { $0.id == id }
        removed.append(id)
    }

    func removeCredential(recordID: String) {
        lock.lock(); defer { lock.unlock() }
        credentials.removeAll { $0 == recordID }
    }

    func writeControlFile(_ entries: [ControlHostEntry]) throws {
        lock.lock()
        defer { lock.unlock() }
        if failControlWrite { throw ControlHostsImportError.unreadableFile }
        controlFile = entries
        writes += 1
    }

    var currentNative: [HostRecord] { lock.lock(); defer { lock.unlock() }; return native }
    var currentControlFile: [ControlHostEntry] { lock.lock(); defer { lock.unlock() }; return controlFile }
    var writeCount: Int { lock.lock(); defer { lock.unlock() }; return writes }
    var writtenIDs: [String] { lock.lock(); defer { lock.unlock() }; return upserted }
    var enrolledIDs: [String] { lock.lock(); defer { lock.unlock() }; return enrolled }
    var removedIDs: [String] { lock.lock(); defer { lock.unlock() }; return removed }
    var credentialIDs: [String] { lock.lock(); defer { lock.unlock() }; return credentials }
}

// MARK: - The Control file fixture

private func entry(
    id: String,
    name: String,
    url: String,
    token: String? = nil,
    isLocal: Bool = false
) -> ControlHostEntry {
    ControlHostEntry(id: id, name: name, baseURL: URL(string: url)!, authToken: token, isLocal: isLocal)
}

/// A synthetic `control-hosts.json` with the cases that matter:  the local
/// anchor, Control's synthetic seed, two remote hosts with tokens, one remote
/// without a token, and one whose origin native already holds.  The ids are
/// fixed so two calls describe the same fixture.
private func fixtureEntries() -> [ControlHostEntry] {
    [
        entry(id: "local", name: "Local Mac", url: "http://127.0.0.1:8799", isLocal: true),
        entry(id: "hetzner", name: "Hetzner Server", url: "https://hetzner.botfleet.app"),
        entry(id: "h1", name: "Production Server", url: "https://prod.example.invalid", token: "tok-one"),
        entry(id: "h2", name: "Staging Server", url: "https://stage.example.invalid", token: "tok-two"),
        entry(id: "h3", name: "No Token Server", url: "http://127.0.0.1:9100"),
        entry(id: "h4", name: "Already Native", url: "https://native.example.invalid", token: "tok-four"),
    ]
}

/// The synthetic Control file on disk, owner-only, the way Control writes it.
private func writeControlFile(_ entries: [ControlHostEntry], into dir: URL) -> URL {
    let url = dir.appendingPathComponent("control-hosts.json")
    let data = try! ControlHostEntry.fileData(entries)
    try! data.write(to: url)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    return url
}

private func makeTempDir() -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("botfleet-import-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// This Mac, plus one remote host native already holds.
private func existingNative() -> [HostRecord] {
    [.thisMac, HostRecord(id: "6C2A4E5B-8D1F-4A3B-9C7E-2F5A8B0D1E44", name: "Already Native",
                          origin: try! HostOrigin("https://native.example.invalid"))]
}

private func originStrings(_ hosts: [HostRecord]) -> [String] {
    hosts.map { $0.origin.url.absoluteString }
}

@Suite("BotFleet Control Saved Server Import", .serialized)
struct ControlHostsImportTests {

    // MARK: - The plan and the dry run

    @Test("The dry run says what each entry becomes without touching anything")
    func testDryRunTouchesNothing() {
        let effects = FakeEffects(native: existingNative(), controlFile: fixtureEntries())
        let summary = ControlHostsImport.dryRun(entries: fixtureEntries(), existing: effects.currentNative)

        //  Three remotes become records -- two with tokens and one without --
        //  one credential moves for the native origin, and the anchor and the
        //  seed are left alone.
        #expect(summary.toImport == 3)
        #expect(summary.credentialsForExisting == 1)
        #expect(summary.leftInPlace[.localAnchor] == 1)
        #expect(summary.leftInPlace[.syntheticSeed] == 1)
        #expect(summary.refused.isEmpty)

        //  A dry run runs nothing:  no write, no enrollment, no change.
        #expect(effects.writeCount == 0)
        #expect(effects.writtenIDs.isEmpty)
        #expect(effects.enrolledIDs.isEmpty)
        #expect(effects.currentNative == existingNative())
    }

    @Test("The plan classifies every entry by its own facts")
    func testPlanClassifiesEachEntry() {
        let outcomes = ControlHostsImport.plan(entries: fixtureEntries(), existing: existingNative())
        #expect(outcomes.count == fixtureEntries().count)

        guard case .leftInPlace(.localAnchor) = outcomes[0] else { Issue.record("the anchor moved"); return }
        guard case .leftInPlace(.syntheticSeed) = outcomes[1] else { Issue.record("the seed moved"); return }
        guard case .toImport(_, "Production Server", true) = outcomes[2] else { Issue.record("h1"); return }
        guard case .toImport(_, "Staging Server", true) = outcomes[3] else { Issue.record("h2"); return }
        guard case .toImport(_, "No Token Server", false) = outcomes[4] else { Issue.record("h3"); return }
        guard case .credentialForExisting(_, "Already Native", true) = outcomes[5] else { Issue.record("h4"); return }
    }

    @Test("An entry native would refuse is refused, and keeps its token in Control")
    func testRefusedEntriesKeepTheirToken() {
        let cases: [(ControlHostEntry, ControlHostImportOutcome.Reason)] = [
            (entry(id: "blank", name: "   ", url: "https://blank.example.invalid", token: "t"), .unnamed),
            (entry(id: "http", name: "Plain HTTP", url: "http://remote.example.invalid", token: "t"), .invalidOrigin),
            (entry(id: "path", name: "With Path", url: "https://path.example.invalid/x", token: "t"), .invalidOrigin),
        ]
        for (host, reason) in cases {
            let outcomes = ControlHostsImport.plan(entries: [host], existing: existingNative())
            guard case .refused(let found) = outcomes[0] else {
                Issue.record("\(host.name) should be refused")
                continue
            }
            #expect(found == reason)
        }
        //  HTTP on loopback is a legal native origin and is imported.
        let loopback = ControlHostsImport.plan(
            entries: [entry(id: "loop", name: "Loopback", url: "http://127.0.0.1:9101")],
            existing: []
        )
        guard case .toImport = loopback[0] else { Issue.record("loopback HTTP was refused"); return }
    }

    @Test("A malformed, oversized or linked Control file is refused whole")
    func testUnreadableFileIsRefused() throws {
        let dir = makeTempDir()
        defer { try? FileManager.default.removeItem(at: dir) }

        let malformed = dir.appendingPathComponent("malformed.json")
        try Data("{\"not\": \"an array\"}".utf8).write(to: malformed)
        #expect(throws: ControlHostsImportError.unreadableFile) {
            try ControlHostsImport.readEntries(from: malformed)
        }

        //  The read opens with O_NOFOLLOW, so a link planted in the path is
        //  never followed into someone else's file.
        let real = writeControlFile(fixtureEntries(), into: dir)
        let link = dir.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        #expect(throws: ControlHostsImportError.unreadableFile) {
            try ControlHostsImport.readEntries(from: link)
        }

        //  The real file reads back as what was written.
        let read = try ControlHostsImport.readEntries(from: real)
        #expect(read == fixtureEntries())
    }

    // MARK: - Running the import

    @Test("A run moves every token, keeps the anchor and the seed, strips Control once")
    func testRunImportsAndStripsControlFile() async throws {
        let fixture = fixtureEntries()
        let effects = FakeEffects(native: existingNative(), controlFile: fixture)
        let summary = try await ControlHostsImport.run(entries: fixture, effects: effects)

        #expect(summary.toImport == 3)
        #expect(effects.writtenIDs.count == 3)
        #expect(effects.enrolledIDs.count == 3)     //  h1, h2, and h4's credential; h3 has none

        //  Every new record carries a fresh, valid native id.
        #expect(Set(effects.writtenIDs).count == 3)
        let written = effects.currentNative
        #expect(written.count == existingNative().count + 3)
        //  The records this run wrote, not the fixture's own synthetic id,
        //  which the real store would never hold.
        for record in written.dropFirst(existingNative().count) {
            #expect(throws: Never.self) { try record.validate() }
        }

        //  Control's file keeps every real entry:  only the tokens that moved
        //  are gone, the anchor and the tokenless host are as they were, and
        //  the synthetic seed is dropped, which is what the import step of the
        //  ruling does.
        let after = effects.currentControlFile
        #expect(effects.writeCount == 1)
        #expect(after.count == fixture.count - 1, "the seed is dropped")
        #expect(!after.contains(where: ControlHostsImport.isSyntheticSeed))
        #expect(after[0] == fixture[0])                  //  the local anchor
        #expect(after[1].id == "h1" && after[1].authToken == nil)
        #expect(after[2].id == "h2" && after[2].authToken == nil)
        #expect(after[3] == fixture[4])                  //  the tokenless host
        #expect(after[4].id == "h4" && after[4].authToken == nil)
    }

    @Test("Existing saved hosts are preserved and never rewritten")
    func testExistingHostsArePreserved() async throws {
        let before = existingNative()
        let effects = FakeEffects(native: before, controlFile: fixtureEntries())
        _ = try await ControlHostsImport.run(entries: fixtureEntries(), effects: effects)

        let after = effects.currentNative
        #expect(after.count == before.count + 3)
        //  The hosts that were there first are still there, unchanged, in
        //  their original order:  the run appends, it never rewrites the list.
        for (index, record) in before.enumerated() {
            #expect(after[index].id == record.id)
            #expect(after[index].name == record.name)
            #expect(after[index].origin == record.origin)
        }
        #expect(after.filter(\.isLocal).count == 1)
        #expect(after.first?.isLocal == true)
    }

    @Test("A second run is a no-op: no duplicates, no writes, no tokens moved")
    func testRepeatImportIsIdempotent() async throws {
        let effects = FakeEffects(native: existingNative(), controlFile: fixtureEntries())

        let first = try await ControlHostsImport.run(entries: fixtureEntries(), effects: effects)
        #expect(first.toImport == 3)

        //  Control's file as the first run left it:  the moved hosts carry no
        //  token now, which is the state a repeat run finds.
        let stripped = effects.currentControlFile
        let second = try await ControlHostsImport.run(entries: stripped, effects: effects)

        #expect(second.toImport == 0)
        #expect(second.credentialsForExisting == 0)
        #expect(second.isEmpty)

        #expect(effects.writtenIDs.count == 3, "no new record appeared")
        #expect(effects.writeCount == 1, "Control's file was not rewritten")
        #expect(effects.currentNative.count == existingNative().count + 3)

        //  No duplicate origin anywhere in the native store.
        let origins = originStrings(effects.currentNative)
        #expect(Set(origins).count == origins.count, "a duplicate host appeared")

        //  The decision is stable:  the same plan says the same thing.
        let again = ControlHostsImport.dryRun(entries: stripped, existing: effects.currentNative)
        #expect(again.isEmpty)
    }

    // MARK: - Failure and rollback

    /// A run broken on the second of its three enrollments:  h1 has already
    /// written its record and credential, and h2 fails before its record.
    private func brokenRun() async throws -> (effects: FakeEffects, fixture: [ControlHostEntry], error: any Error) {
        let fixture = fixtureEntries()
        let effects = FakeEffects(
            native: existingNative(),
            controlFile: fixture,
            failOnEnrollmentNumber: 2
        )
        do {
            _ = try await ControlHostsImport.run(entries: fixture, effects: effects)
            Issue.record("the run should have failed")
        } catch {
            return (effects, fixture, error)
        }
        return (effects, fixture, ControlHostsImportError.unreadableFile)
    }

    @Test("A failure mid-run undoes every record and credential it wrote")
    func testFailureRollsBack() async throws {
        let (effects, fixture, _) = try await brokenRun()

        //  The store is back to exactly what it was.
        #expect(effects.currentNative == existingNative())
        #expect(effects.removedIDs == effects.writtenIDs)
        #expect(effects.writtenIDs.count == 1, "the run had created one record before it failed")
        //  The credential filed for that record is gone with it.
        #expect(effects.credentialIDs.isEmpty, "no credential survives the rollback")
        #expect(effects.enrolledIDs.count == 1)

        //  Control's file was never rewritten, so every token is still there.
        #expect(effects.writeCount == 0)
        #expect(effects.currentControlFile == fixture)
        for host in fixture where host.authToken != nil {
            let kept = effects.currentControlFile.first { $0.id == host.id }
            #expect(kept?.authToken == host.authToken, "\(host.name) lost its token without a native copy")
        }
    }

    @Test("After a failed run the same entries import cleanly")
    func testRetryAfterFailureIsClean() async throws {
        let (broken, fixture, _) = try await brokenRun()
        #expect(broken.currentNative == existingNative())

        let healthy = FakeEffects(
            native: broken.currentNative,
            controlFile: broken.currentControlFile
        )
        let summary = try await ControlHostsImport.run(entries: fixture, effects: healthy)

        #expect(summary.toImport == 3)
        #expect(healthy.currentNative.count == existingNative().count + 3)
        let origins = originStrings(healthy.currentNative)
        #expect(Set(origins).count == origins.count, "the retry created a duplicate")
    }

    @Test("Control's file is written only after every credential and record")
    func testControlFileIsWrittenLast() async throws {
        let (effects, fixture, _) = try await brokenRun()
        #expect(effects.writeCount == 0, "half a native store never reaches Control's file")
        #expect(effects.currentNative == existingNative())
        #expect(effects.currentControlFile == fixture)
    }

    @Test("One origin becomes one record, and its credential goes to that record")
    func testCredentialMovesToTheExistingRecord() async throws {
        let host = HostRecord(id: "kept-native", name: "Kept",
                              origin: try HostOrigin("https://kept.example.invalid"))
        let effects = FakeEffects(
            native: [.thisMac, host],
            controlFile: [entry(id: "k1", name: "Kept", url: "https://kept.example.invalid", token: "new-token")]
        )
        let summary = try await ControlHostsImport.run(
            entries: [entry(id: "k1", name: "Kept", url: "https://kept.example.invalid", token: "new-token")],
            effects: effects
        )

        //  The credential landed on the record that already exists…
        #expect(effects.credentialIDs == ["kept-native"])
        #expect(summary.credentialAlreadyNative == 0)
        //  …and no second record was created for one origin.
        #expect(effects.writtenIDs.isEmpty)
        #expect(effects.currentNative.count == 2)
        //  Its token was moved, so Control's copy is stripped.
        #expect(effects.currentControlFile[0].authToken == nil)
    }

    @Test("Two Control entries naming one origin become one record, not two")
    func testDuplicateOriginsInOneFileBecomeOneRecord() async throws {
        let duplicate = entry(id: "d1", name: "First Name", url: "https://dup.example.invalid", token: "tok-a")
        let sameOrigin = entry(id: "d2", name: "Second Name", url: "https://dup.example.invalid", token: "tok-b")
        let effects = FakeEffects(native: [.thisMac], controlFile: [duplicate, sameOrigin])

        let summary = try await ControlHostsImport.run(entries: [duplicate, sameOrigin], effects: effects)

        #expect(summary.toImport == 1, "only the first becomes a record")
        #expect(effects.writtenIDs.count == 1)
        let origins = originStrings(effects.currentNative)
        #expect(Set(origins).count == origins.count, "one origin is one record")
        //  The second entry's token is a second copy for one origin, so it is
        //  reported and kept rather than dropped.
        #expect(summary.credentialAlreadyNative == 1)
        #expect(effects.currentControlFile.first { $0.id == "d2" }?.authToken == "tok-b")
    }

    @Test("The synthetic seed is dropped from Control's file")
    func testTheSyntheticSeedIsDropped() async throws {
        let seed = entry(id: "hetzner", name: "Hetzner Server", url: "https://hetzner.botfleet.app")
        let effects = FakeEffects(native: [.thisMac], controlFile: [seed, entry(id: "a", name: "A", url: "https://a.example.invalid")])

        _ = try await ControlHostsImport.run(entries: effects.currentControlFile, effects: effects)

        #expect(!effects.currentControlFile.contains(where: ControlHostsImport.isSyntheticSeed))
        #expect(effects.writeCount == 1, "dropping the seed alone is a rewrite")
        //  A seed spelled with a trailing slash, another case or the scheme's
        //  default port names the same origin and is dropped the same way.
        for url in ["https://hetzner.botfleet.app/", "https://Hetzner.BotFleet.App", "https://hetzner.botfleet.app:443"] {
            #expect(ControlHostsImport.isSyntheticSeed(entry(id: "hetzner", name: "Hetzner Server", url: url)))
        }
        //  A seed the owner gave a token is a real host and is imported.
        let tokenSeed = entry(id: "hetzner", name: "Hetzner Server", url: "https://hetzner.botfleet.app", token: "t")
        #expect(!ControlHostsImport.isSyntheticSeed(tokenSeed))
    }

    @Test("A Control file that cannot be rewritten undoes the records and credentials")
    func testARewriteFailureRollsBack() async throws {
        let fixture = fixtureEntries()
        let effects = FakeEffects(native: existingNative(), controlFile: fixture)
        effects.failControlWrite = true

        do {
            _ = try await ControlHostsImport.run(entries: fixture, effects: effects)
            Issue.record("the run should have failed")
        } catch {
            //  Expected:  the Control file could not be rewritten.
        }

        //  Nothing is left half-migrated:  the store is what it was, no
        //  credential survives, and Control's file still holds every token, so
        //  a retry starts from the same place and strips them this time.
        #expect(effects.currentNative == existingNative())
        #expect(effects.credentialIDs.isEmpty)
        #expect(effects.currentControlFile == fixture)

        effects.failControlWrite = false
        let retried = try await ControlHostsImport.run(entries: fixture, effects: effects)
        #expect(retried.toImport == 3)
        #expect(effects.currentControlFile.first { $0.id == "h1" }?.authToken == nil, "the retry strips the token")
    }

    @Test("A run that moved nothing reports empty, even when native already held a credential")
    func testAlreadyNativeCredentialDoesNotCountAsMoved() async throws {
        let host = HostRecord(id: "kept-native", name: "Kept",
                              origin: try HostOrigin("https://kept.example.invalid"))
        let effects = FakeEffects(
            native: [.thisMac, host],
            controlFile: [entry(id: "k1", name: "Kept", url: "https://kept.example.invalid", token: "x")]
        )
        try await effects.enroll("stored-earlier", for: host)

        let summary = try await ControlHostsImport.run(entries: effects.currentControlFile, effects: effects)

        #expect(summary.toImport == 0)
        #expect(summary.credentialsForExisting == 0, "nothing moved")
        #expect(summary.credentialAlreadyNative == 1)
        #expect(summary.isEmpty, "a run that moved nothing is empty")
        #expect(effects.writeCount == 0)
    }

    @Test("A credential native already holds is left in Control, not dropped")
    func testExistingCredentialIsLeftInPlace() async throws {
        let host = HostRecord(id: "kept-native", name: "Kept",
                              origin: try HostOrigin("https://kept.example.invalid"))
        //  The fixture's native side already has a credential for it, which
        //  is the state after an earlier enrollment.
        let effects = FakeEffects(
            native: [.thisMac, host],
            controlFile: [entry(id: "k2", name: "Kept", url: "https://kept.example.invalid", token: "x")]
        )
        try await effects.enroll("stored-earlier", for: host)
        #expect(effects.credentialIDs == ["kept-native"])
        let enrolledBeforeRun = effects.enrolledIDs

        let summary = try await ControlHostsImport.run(
            entries: [entry(id: "k2", name: "Kept", url: "https://kept.example.invalid", token: "x")],
            effects: effects
        )

        //  Nothing was enrolled over it and nothing was created for it.
        #expect(effects.enrolledIDs == enrolledBeforeRun, "a credential native holds is not replaced")
        #expect(effects.writtenIDs.isEmpty, "one origin is one record")
        #expect(effects.currentNative.count == 2)
        //  Control keeps its copy:  this run never moved it, so it must not
        //  remove it.  Dropping a token nobody stored would be the one bug
        //  this importer exists to avoid.
        #expect(effects.currentControlFile[0].authToken == "x")
        #expect(effects.writeCount == 0, "nothing moved, so the file was not rewritten")
        #expect(summary.credentialAlreadyNative == 1)
    }

    @Test("An upsert that fails after its enrollment leaves no orphan credential")
    func testAFailedUpsertLeavesNoOrphanCredential() async throws {
        let fixture = fixtureEntries()
        let effects = FakeEffects(native: existingNative(), controlFile: fixture, failOnUpsertNumber: 1)
        do {
            _ = try await ControlHostsImport.run(entries: fixture, effects: effects)
            Issue.record("the run should have failed")
        } catch {
            //  Expected:  the first record's upsert failed after its enrollment.
        }

        //  h1's credential was enrolled before its record write failed, and
        //  the rollback removes it:  a credential no record names is an entry
        //  the app can neither use nor repair.
        #expect(effects.credentialIDs.isEmpty, "no credential survives a record that was never written")
        #expect(effects.writtenIDs.isEmpty)
        #expect(effects.currentNative == existingNative())
        #expect(effects.writeCount == 0)
    }
}
#endif
