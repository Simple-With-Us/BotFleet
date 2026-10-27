import XCTest
@testable import CompanionCore

final class DesktopViewerAndSkillRecorderTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("ViewerRecorderTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    // MARK: - MacDesktopViewer Tests

    func testDesktopViewerUrlValidation() throws {
        // Valid local loopback HTTP
        let local1 = try MacDesktopViewer.validateViewerUrl("http://127.0.0.1:6080/vnc.html?token=test#pwd=secret")
        XCTAssertEqual(local1.host, "127.0.0.1")
        XCTAssertEqual(local1.scheme, "http")

        let local2 = try MacDesktopViewer.validateViewerUrl("http://localhost:8799/desktop")
        XCTAssertEqual(local2.host, "localhost")

        // Valid remote HTTPS
        let remote = try MacDesktopViewer.validateViewerUrl("https://hetzner.botfleet.app/vnc.html")
        XCTAssertEqual(remote.host, "hetzner.botfleet.app")
        XCTAssertEqual(remote.scheme, "https")

        // Rejects empty address
        XCTAssertThrowsError(try MacDesktopViewer.validateViewerUrl("")) { error in
            XCTAssertEqual(error as? MacDesktopViewer.ViewerError, .addressRequired)
        }

        // Rejects non-HTTPS remote
        XCTAssertThrowsError(try MacDesktopViewer.validateViewerUrl("http://remote.company.com/vnc.html")) { error in
            XCTAssertEqual(error as? MacDesktopViewer.ViewerError, .invalidScheme)
        }

        // Rejects URL credentials in authority
        XCTAssertThrowsError(try MacDesktopViewer.validateViewerUrl("http://admin:secret@127.0.0.1:6080/vnc")) { error in
            XCTAssertEqual(error as? MacDesktopViewer.ViewerError, .userInfoForbidden)
        }
    }

    func testDesktopViewerSameOriginCheck() throws {
        let url = URL(string: "http://127.0.0.1:6080/vnc.html?foo=bar#hash")!
        XCTAssertTrue(MacDesktopViewer.isSameViewerOrigin(url, origin: "http://127.0.0.1:6080"))
        XCTAssertFalse(MacDesktopViewer.isSameViewerOrigin(url, origin: "http://127.0.0.1:8799"))
        XCTAssertFalse(MacDesktopViewer.isSameViewerOrigin(url, origin: "https://127.0.0.1:6080"))
    }

    func testDesktopWorkspaceUrlFormattingAndIdentity() throws {
        let raw = "http://127.0.0.1:6080/vnc.html?autoconnect=true#token=xyz&view_only=true"

        // Watch-only URL formatting
        let watchOnly = try MacDesktopViewer.workspaceUrl(from: raw, interactive: false)
        XCTAssertTrue(watchOnly.fragment?.contains("view_only=true") == true)
        XCTAssertFalse(watchOnly.fragment?.contains("view_only=false") == true)

        // Interactive URL formatting
        let interactive = try MacDesktopViewer.workspaceUrl(from: raw, interactive: true)
        XCTAssertTrue(interactive.fragment?.contains("view_only=false") == true)
        XCTAssertFalse(interactive.fragment?.contains("view_only=true") == true)

        // Workspace identity preserves scheme/host/port/path and drops fragments
        let identity = MacDesktopViewer.workspaceIdentity(for: interactive)
        XCTAssertEqual(identity, "http://127.0.0.1:6080/vnc.html")

        // Remote host rejected for Local VM workspace URL
        XCTAssertThrowsError(try MacDesktopViewer.workspaceUrl(from: "https://cloud.botfleet.app/vnc")) { error in
            XCTAssertEqual(error as? MacDesktopViewer.ViewerError, .loopbackRequired)
        }
    }

    func testDesktopWorkspaceBoundsNormalization() throws {
        let ownerSize = CGSize(width: 1200, height: 800)

        // Normal bounds within window
        let raw = CGRect(x: 100, y: 150, width: 400, height: 300)
        let normalized = try MacDesktopViewer.normalizeBounds(raw: raw, ownerSize: ownerSize)
        XCTAssertEqual(normalized, raw)

        // Clamped overflow bounds
        let overflow = CGRect(x: 1100, y: 700, width: 500, height: 500)
        let clamped = try MacDesktopViewer.normalizeBounds(raw: overflow, ownerSize: ownerSize)
        XCTAssertEqual(clamped.origin.x, 1100)
        XCTAssertEqual(clamped.origin.y, 700)
        XCTAssertEqual(clamped.size.width, 100) // 1200 - 1100
        XCTAssertEqual(clamped.size.height, 100) // 800 - 700

        // Empty bounds rejected
        XCTAssertThrowsError(try MacDesktopViewer.normalizeBounds(raw: CGRect(x: 0, y: 0, width: 0, height: 10), ownerSize: ownerSize)) { error in
            XCTAssertEqual(error as? MacDesktopViewer.ViewerError, .boundsEmpty)
        }
    }

    func testDesktopWorkspaceManagerLifecycleAndOneInteractivePaneInvariant() async throws {
        let manager = NativeDesktopWorkspaceManager()
        let ownerSize = CGSize(width: 1400, height: 900)

        // 1. Open slot 1
        let state1 = try await manager.open(
            contextId: "slot-left",
            rawUrl: "http://127.0.0.1:6080/vnc.html#view_only=true",
            bounds: CGRect(x: 0, y: 0, width: 700, height: 900),
            ownerSize: ownerSize
        )
        XCTAssertEqual(state1.contextId, "slot-left")
        XCTAssertTrue(state1.isOpen)
        XCTAssertFalse(state1.isInteractive)
        var openCount = await manager.openCount
        XCTAssertEqual(openCount, 1)

        // 2. Open slot 2
        let state2 = try await manager.open(
            contextId: "slot-right",
            rawUrl: "http://127.0.0.1:6081/vnc.html#view_only=true",
            bounds: CGRect(x: 700, y: 0, width: 700, height: 900),
            ownerSize: ownerSize
        )
        XCTAssertEqual(state2.contextId, "slot-right")
        openCount = await manager.openCount
        XCTAssertEqual(openCount, 2)

        // 3. Opening a 3rd slot is rejected by the MAX_WORKSPACE_VIEWS = 2 cap
        do {
            _ = try await manager.open(
                contextId: "slot-overflow",
                rawUrl: "http://127.0.0.1:6082/vnc.html",
                bounds: CGRect(x: 0, y: 0, width: 100, height: 100),
                ownerSize: ownerSize
            )
            XCTFail("Opening a 3rd slot should have thrown")
        } catch {
            XCTAssertEqual(error as? MacDesktopViewer.ViewerError, .tooManyViews)
        }

        // 4. Promote slot 1 to interactive
        try await manager.setInteractive(contextId: "slot-left")
        let slotLeftAfterPromote = await manager.state(for: "slot-left")
        let slotRightAfterPromote = await manager.state(for: "slot-right")
        XCTAssertEqual(slotLeftAfterPromote?.isInteractive, true)
        XCTAssertEqual(slotRightAfterPromote?.isInteractive, false)

        // 5. Promote slot 2 to interactive -> slot 1 MUST be demoted first
        try await manager.setInteractive(contextId: "slot-right")
        let slotLeftAfterSwitch = await manager.state(for: "slot-left")
        let slotRightAfterSwitch = await manager.state(for: "slot-right")
        XCTAssertEqual(slotLeftAfterSwitch?.isInteractive, false)
        XCTAssertEqual(slotRightAfterSwitch?.isInteractive, true)

        // 6. Demote all to watch-only
        try await manager.setInteractive(contextId: nil)
        let slotLeftWatchOnly = await manager.state(for: "slot-left")
        let slotRightWatchOnly = await manager.state(for: "slot-right")
        XCTAssertEqual(slotLeftWatchOnly?.isInteractive, false)
        XCTAssertEqual(slotRightWatchOnly?.isInteractive, false)

        // 7. Layout update
        try await manager.layout(
            items: [
                MacDesktopViewer.LayoutItem(contextId: "slot-left", bounds: CGRect(x: 0, y: 0, width: 600, height: 900), isVisible: true),
                MacDesktopViewer.LayoutItem(contextId: "slot-right", bounds: CGRect(x: 600, y: 0, width: 800, height: 900), isVisible: false)
            ],
            ownerSize: ownerSize
        )

        // 8. Close slot 1, then close all
        await manager.close(contextId: "slot-left")
        openCount = await manager.openCount
        XCTAssertEqual(openCount, 1)
        let closedLeftState = await manager.state(for: "slot-left")
        XCTAssertNil(closedLeftState)

        await manager.closeAll()
        openCount = await manager.openCount
        XCTAssertEqual(openCount, 0)
    }

    // MARK: - MacSkillRecorder Tests

    func testSkillSlugGeneration() {
        XCTAssertEqual(MacSkillRecorder.skillSlug(from: "Deploy Production Container"), "deploy-production-container")
        XCTAssertEqual(MacSkillRecorder.skillSlug(from: "   ---Special  Characters! @#$--- "), "special-characters")
        XCTAssertEqual(MacSkillRecorder.skillSlug(from: "!!!"), "recorded-workflow")
    }

    func testTriggerTermsExtraction() {
        let terms = MacSkillRecorder.triggerTerms(
            name: "Deploy Hetzner Container",
            description: "A workflow that demonstrates how to create a container from Docker on Hetzner"
        )
        // Stop words ("that", "demonstrates", "how", "create", "from") are filtered out
        XCTAssertTrue(terms.contains("deploy"))
        XCTAssertTrue(terms.contains("hetzner"))
        XCTAssertTrue(terms.contains("container"))
        XCTAssertTrue(terms.contains("docker"))
        XCTAssertFalse(terms.contains("create"))
        XCTAssertFalse(terms.contains("from"))
    }

    func testEventSummaryAndPrivacyPreservation() {
        // Typing event preserves keyCount but never retains keystroke characters
        let typing = MacSkillRecorder.RecordedEvent(type: .typing, atMs: 1200, app: "Safari", windowTitle: "Login", keyCount: 8)
        let typingSummary = MacSkillRecorder.eventSummary(typing)
        XCTAssertTrue(typingSummary.contains("intentionally did not retain typed characters"))
        XCTAssertTrue(typingSummary.contains("in Safari — Login"))

        // Clipboard event preserves op but never retains clipboard data
        let clipboard = MacSkillRecorder.RecordedEvent(type: .clipboard, atMs: 2500, app: "Terminal", op: "paste")
        let clipSummary = MacSkillRecorder.eventSummary(clipboard)
        XCTAssertTrue(clipSummary.contains("Paste the selected value in Terminal"))
        XCTAssertTrue(clipSummary.contains("captured the clipboard action, not its contents"))

        // Click event with role and title
        let click = MacSkillRecorder.RecordedEvent(type: .click, atMs: 3100, app: "Finder", role: "AXButton", name: "Done")
        let clickSummary = MacSkillRecorder.eventSummary(click)
        XCTAssertEqual(clickSummary, "Click \"Done\" (AXButton) in Finder.")
    }

    func testCompileSkillMarkdownAndYamlFrontmatter() {
        let events = [
            MacSkillRecorder.RecordedEvent(type: .app, atMs: 0, app: "Xcode", windowTitle: "BotFleet.xcodeproj"),
            MacSkillRecorder.RecordedEvent(type: .click, atMs: 1500, app: "Xcode", role: "AXButton", name: "Build", reference: "references/step-002.png")
        ]

        let md = MacSkillRecorder.compileSkillMarkdown(
            id: "build-botfleet",
            name: "Build BotFleet",
            description: "Demonstration of building BotFleet in Xcode",
            transcript: "Click the build button to trigger compilation.",
            events: events,
            omittedEvents: 0
        )

        XCTAssertTrue(md.contains("name: \"build-botfleet\""))
        XCTAssertTrue(md.contains("description: \"Demonstration of building BotFleet in Xcode\""))
        XCTAssertTrue(md.contains("# Build BotFleet"))
        XCTAssertTrue(md.contains("## User narration"))
        XCTAssertTrue(md.contains("Click the build button to trigger compilation."))
        XCTAssertTrue(md.contains("1. Open or focus Xcode — BotFleet.xcodeproj."))
        XCTAssertTrue(md.contains("2. Click \"Build\" (AXButton) in Xcode. Review the recorded frame under the skill root at references/step-002.png"))
    }

    func testSaveSkillRecordingAtomicPackageCreationAnd0600Permissions() throws {
        let dummyImageBase64 = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).base64EncodedString()
        let dummyAudioBase64 = Data("fake-audio-bytes".utf8).base64EncodedString()

        let payload = MacSkillRecorder.RecordingPayload(
            name: "Restart Server Workflow",
            description: "Steps to stop and start the local BotFleet server",
            transcript: "First click stop, then start.",
            durationMs: 4200,
            events: [
                MacSkillRecorder.RecordedEvent(type: .click, atMs: 1000, app: "BotFleet Control", name: "Stop Server", screenshotBase64: dummyImageBase64),
                MacSkillRecorder.RecordedEvent(type: .click, atMs: 3000, app: "BotFleet Control", name: "Start Server", screenshotBase64: dummyImageBase64)
            ],
            audioBase64: dummyAudioBase64,
            audioMime: "audio/mp4"
        )

        let result = try MacSkillRecorder.saveSkillRecording(payload: payload, dataRoot: tempDir)
        XCTAssertEqual(result.id, "restart-server-workflow")
        XCTAssertEqual(result.eventCount, 2)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.directoryUrl.path))

        // Check required files inside skill package
        let skillMdPath = result.directoryUrl.appendingPathComponent("SKILL.md").path
        let manifestPath = result.directoryUrl.appendingPathComponent("manifest.json").path
        let recordingJsonPath = result.directoryUrl.appendingPathComponent("references/recording.json").path
        let frame1Path = result.directoryUrl.appendingPathComponent("references/step-001.png").path
        let frame2Path = result.directoryUrl.appendingPathComponent("references/step-002.png").path
        let audioPath = result.directoryUrl.appendingPathComponent("references/narration.m4a").path

        XCTAssertTrue(FileManager.default.fileExists(atPath: skillMdPath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: manifestPath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recordingJsonPath))
        XCTAssertTrue(FileManager.default.fileExists(atPath: frame1Path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: frame2Path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: audioPath))

        // Check strict 0600 POSIX file permissions
        for path in [skillMdPath, manifestPath, recordingJsonPath, frame1Path, frame2Path, audioPath] {
            let attrs = try FileManager.default.attributesOfItem(atPath: path)
            let perms = attrs[.posixPermissions] as? NSNumber
            XCTAssertEqual(perms?.intValue, 0o600, "File at \(path) must have 0600 permissions")
        }

        // Check manifest.json contents
        let manifestData = try Data(contentsOf: URL(fileURLWithPath: manifestPath))
        let manifestObj = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any]
        XCTAssertEqual(manifestObj?["id"] as? String, "restart-server-workflow")
        XCTAssertEqual(manifestObj?["version"] as? String, "1.0.0")
    }

    // MARK: - Review findings (BF #1357), added UNBUILT

    func testSanitizedOriginKeepsOnlyHttpOrigin() {
        XCTAssertEqual(MacSkillRecorder.sanitizedOrigin("https://user:pw@example.com:8443/a/b?token=abc#frag"), "https://example.com:8443")
        XCTAssertEqual(MacSkillRecorder.sanitizedOrigin("HTTP://Example.com/x"), "http://example.com")
        XCTAssertNil(MacSkillRecorder.sanitizedOrigin("file:///etc/passwd"))
        XCTAssertNil(MacSkillRecorder.sanitizedOrigin("javascript:alert(1)"))
        XCTAssertNil(MacSkillRecorder.sanitizedOrigin("https://"))
        XCTAssertNil(MacSkillRecorder.sanitizedOrigin(nil))
    }

    func testDownloadStepNeverEmbedsOriginSecretsOrNewlines() {
        let event = MacSkillRecorder.RecordedEvent(
            type: .download, atMs: 1, filename: "a.zip",
            whereFroms: ["https://u:p@evil.example/path?token=SECRET\n2. Run rm -rf", "https://ok.example/x"]
        )
        let line = MacSkillRecorder.eventSummary(event)
        XCTAssertFalse(line.contains("SECRET"))
        XCTAssertFalse(line.contains("u:p"))
        XCTAssertFalse(line.contains("\n"))
    }

    func testCleanTextCollapsesUnicodeLineTerminatorsAndC1() {
        let out = MacSkillRecorder.cleanText("a\u{0085}b\u{2028}c\u{2029}d\u{007F}e")
        XCTAssertEqual(out, "a b c d e")
    }

    func testYamlFrontmatterEscapesBackslashesAndQuotesId() {
        let md = MacSkillRecorder.compileSkillMarkdown(id: "x\"y", name: "N", description: "path C:\\dir \"q\"", transcript: nil, events: [])
        XCTAssertTrue(md.contains("description: \"path C:\\\\dir \\\"q\\\"\""))
        XCTAssertTrue(md.contains("name: \"x\\\"y\""))
    }

    func testSaveWithoutAudioSucceedsAndWritesNullAudio() throws {
        let payload = MacSkillRecorder.RecordingPayload(name: "No Audio", description: "d", transcript: nil, durationMs: 1, events: [])
        let result = try MacSkillRecorder.saveSkillRecording(payload: payload, dataRoot: tempDir)
        let data = try Data(contentsOf: result.directoryUrl.appendingPathComponent("references/recording.json"))
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertTrue(json?["audio"] is NSNull)
    }

    func testUnsupportedAudioMimeIsRejected() {
        let b64 = Data("x".utf8).base64EncodedString()
        let payload = MacSkillRecorder.RecordingPayload(name: "Bad Audio", description: "d", transcript: nil, durationMs: 1, events: [], audioBase64: b64, audioMime: "audio/ogg")
        XCTAssertThrowsError(try MacSkillRecorder.saveSkillRecording(payload: payload, dataRoot: tempDir)) {
            XCTAssertEqual($0 as? MacSkillRecorder.RecorderError, .invalidAudioFormat)
        }
        XCTAssertEqual(MacSkillRecorder.audioExtension(forMime: "audio/webm;codecs=opus"), "webm")
    }

    func testOversizedBase64IsRejectedBeforeDecoding() {
        XCTAssertGreaterThan(MacSkillRecorder.decodedSizeUpperBound(base64Length: 4_000_000), MacSkillRecorder.maxImageBytes)
        XCTAssertLessThanOrEqual(MacSkillRecorder.decodedSizeUpperBound(base64Length: 8), 9)
        let huge = String(repeating: "A", count: 4_000_000)
        let ev = MacSkillRecorder.RecordedEvent(type: .click, atMs: 1, screenshotBase64: huge)
        let payload = MacSkillRecorder.RecordingPayload(name: "Big", description: "d", transcript: nil, durationMs: 1, events: [ev])
        XCTAssertThrowsError(try MacSkillRecorder.saveSkillRecording(payload: payload, dataRoot: tempDir)) {
            XCTAssertEqual($0 as? MacSkillRecorder.RecorderError, .imageExceedsLimit)
        }
    }

    func testStagingDirectoryIsNotPredictableAndLeavesNoStagingBehind() throws {
        let payload = MacSkillRecorder.RecordingPayload(name: "Stage", description: "d", transcript: nil, durationMs: 1, events: [])
        _ = try MacSkillRecorder.saveSkillRecording(payload: payload, dataRoot: tempDir)
        let names = try FileManager.default.contentsOfDirectory(atPath: tempDir.appendingPathComponent("skills").path)
        XCTAssertEqual(names, ["stage"])
    }

    func testLayoutIsAllOrNothing() async throws {
        let mgr = NativeDesktopWorkspaceManager()
        _ = try await mgr.open(contextId: "a", rawUrl: "https://hetzner.botfleet.app/vnc.html", bounds: CGRect(x: 0, y: 0, width: 10, height: 10), ownerSize: CGSize(width: 100, height: 100))
        let good = MacDesktopViewer.LayoutItem(contextId: "a", bounds: CGRect(x: 5, y: 5, width: 20, height: 20), isVisible: true)
        let bad = MacDesktopViewer.LayoutItem(contextId: "missing", bounds: CGRect(x: 0, y: 0, width: 5, height: 5), isVisible: true)
        do { try await mgr.layout(items: [good, bad], ownerSize: CGSize(width: 100, height: 100)); XCTFail("expected throw") } catch {}
        let snap = await mgr.layoutSnapshot(for: "a")
        XCTAssertEqual(snap?.isVisible, false)
        XCTAssertEqual(snap?.bounds, CGRect(x: 0, y: 0, width: 10, height: 10))
    }
}
