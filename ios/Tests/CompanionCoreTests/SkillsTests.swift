// A bot's skills on the phone, and the shared-memory row in Settings.
//
// The point of the skills tests is the gate: `BotSkillsPanel.tsx` keeps
// Enable unavailable until that skill's SKILL.md has been opened this
// session, because enabling is a decision about text a person has read, and
// the phone must not be the way around that.  Disable is always available.
import Foundation
import XCTest
@testable import CompanionCore

private final class SkillsRequestStub: URLProtocol {
    static var responseBody = Data()
    static var statusCode = 200
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class SkillsTests: XCTestCase {
    private let listing = """
    {"skills":[
      {"name":"pdf-tools","description":"Fill and read PDFs","enabled":false,"source":"anthropics/skills","sha256":"abc",
       "importedAt":"2026-10-09T20:15:00.000Z","license":"MIT","warnings":["mentions curl"],"skippedFiles":["run.sh"]},
      {"name":"sql-helper","description":"Write SQL","enabled":true,"source":"~/.claude/skills/sql-helper","sha256":"def",
       "importedAt":"2026-09-01T12:00:00.000Z","warnings":[],"skippedFiles":[]}],
     "notIndexed":["sql-helper"]}
    """

    // MARK: - Decoding

    func testTheListDecodesWithItsWarningsAndSkippedFiles() throws {
        let response = try JSONDecoder().decode(SkillsResponse.self, from: Data(listing.utf8))
        XCTAssertEqual(response.skills.map(\.name), ["pdf-tools", "sql-helper"])
        XCTAssertEqual(response.skills.first?.warnings, ["mentions curl"])
        XCTAssertEqual(response.skills.first?.skippedFiles, ["run.sh"])
        XCTAssertEqual(response.skills.first?.enabled, false)
        XCTAssertEqual(response.notIndexed, ["sql-helper"])
    }

    func testARowItCannotReadIsLeftOutAndAMissingFieldIsDefaulted() throws {
        let response = try JSONDecoder().decode(
            SkillsResponse.self,
            from: Data(#"{"skills":[7,{"description":"no name"},{"name":"bare"}]}"#.utf8)
        )
        XCTAssertEqual(response.skills.map(\.name), ["bare"])
        XCTAssertEqual(response.skills.first?.enabled, false, "an unknown state reads as the safe one")
        XCTAssertEqual(response.skills.first?.warnings, [])
        XCTAssertEqual(response.notIndexed, [])
    }

    // MARK: - The gate (BotSkillsPanel.tsx)

    func testEnableStaysClosedUntilTheSkillMdHasBeenOpened() throws {
        let skill = try XCTUnwrap(JSONDecoder().decode(SkillsResponse.self, from: Data(listing.utf8)).skills.first)
        let unread = SkillsDisplay.rowView(skill, opened: false, busy: false)
        XCTAssertEqual(unread.actionLabel, "Enable")
        XCTAssertTrue(unread.actionDisabled)
        XCTAssertEqual(unread.gateReason, "Open the SKILL.md first.\u{00A0} Enabling is a decision about text you have read.")
        let read = SkillsDisplay.rowView(skill, opened: true, busy: false)
        XCTAssertEqual(read.actionLabel, "Enable")
        XCTAssertFalse(read.actionDisabled)
        XCTAssertNil(read.gateReason)
    }

    func testDisableIsAlwaysAvailable() throws {
        let skill = try XCTUnwrap(JSONDecoder().decode(SkillsResponse.self, from: Data(listing.utf8)).skills.last)
        let view = SkillsDisplay.rowView(skill, opened: false, busy: false)
        XCTAssertEqual(view.actionLabel, "Disable")
        XCTAssertFalse(view.actionDisabled, "turning a skill off needs no reading")
        XCTAssertNil(view.gateReason)
        XCTAssertTrue(view.status.hasPrefix("Enabled"))
    }

    func testABusyRowCannotBeTappedAgain() throws {
        let skill = try XCTUnwrap(JSONDecoder().decode(SkillsResponse.self, from: Data(listing.utf8)).skills.last)
        let view = SkillsDisplay.rowView(skill, opened: true, busy: true)
        XCTAssertEqual(view.actionLabel, "Working\u{2026}")
        XCTAssertTrue(view.actionDisabled)
    }

    func testScanWarningsAndSkippedFilesAreShownBeforeAnyEnable() throws {
        let skill = try XCTUnwrap(JSONDecoder().decode(SkillsResponse.self, from: Data(listing.utf8)).skills.first)
        let view = SkillsDisplay.rowView(skill, opened: false, busy: false)
        XCTAssertEqual(view.warningsHeading, "Before you enable this")
        XCTAssertEqual(view.warnings, ["mentions curl"])
        XCTAssertEqual(view.skippedNote, "Not imported: run.sh.")
        XCTAssertTrue(view.status.hasPrefix("Disabled"))
        let clean = SkillsDisplay.rowView(SkillListing(name: "x"), opened: false, busy: false)
        XCTAssertNil(clean.warningsHeading)
        XCTAssertNil(clean.skippedNote)
    }

    func testProvenanceUsesTheOwnersClock() throws {
        let skill = try XCTUnwrap(JSONDecoder().decode(SkillsResponse.self, from: Data(listing.utf8)).skills.first)
        XCTAssertEqual(SkillsDisplay.rowView(skill, opened: true, busy: false).provenance, "Imported from anthropics/skills on Oct 9, 2026, 3:15pm.")
        XCTAssertEqual(SkillsDisplay.importedAtLabel("garbage"), "an unknown date")
    }

    func testTheEmptyStateSaysImportingHappensOnTheComputer() {
        XCTAssertTrue(SkillsDisplay.emptyCopy.contains("on your computer"))
        XCTAssertTrue(SkillsDisplay.emptyCopy.contains("No skills imported yet.\u{00A0} Import"))
    }

    func testNotesForTheBoxEngineAndTheIndexBudget() {
        XCTAssertNotNil(SkillsDisplay.engineNote(driverKind: "boxAgent"))
        XCTAssertNil(SkillsDisplay.engineNote(driverKind: "claudeAgent"))
        XCTAssertNil(SkillsDisplay.engineNote(driverKind: nil))
        XCTAssertNil(SkillsDisplay.notIndexedNotice([]))
        XCTAssertTrue(SkillsDisplay.notIndexedNotice(["a"])?.hasPrefix("1 enabled skill not indexed \u{2014} a.") == true)
        XCTAssertTrue(SkillsDisplay.notIndexedNotice(["a", "b"])?.hasPrefix("2 enabled skills not indexed \u{2014} a, b.") == true)
    }

    // MARK: - Requests

    private func client() -> CompanionClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SkillsRequestStub.self]
        let connection = Connection(id: "c1", name: "Mac", host: "192.168.1.5", port: 4748)
        return CompanionClient(connection: connection, token: "tok", session: URLSession(configuration: configuration))
    }

    override func setUp() {
        SkillsRequestStub.responseBody = Data()
        SkillsRequestStub.statusCode = 200
        SkillsRequestStub.capturedRequest = nil
        SkillsRequestStub.capturedBody = nil
    }

    func testListingAndReadingAreGets() async throws {
        SkillsRequestStub.responseBody = Data(listing.utf8)
        let response = try await client().botSkills(botId: "bot_1")
        XCTAssertEqual(response.skills.count, 2)
        XCTAssertEqual(SkillsRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(SkillsRequestStub.capturedRequest?.url?.path, "/api/bots/bot_1/skills")

        SkillsRequestStub.responseBody = Data(##"{"text":"# PDF tools"}"##.utf8)
        let text = try await client().skillText(botId: "bot_1", name: "pdf-tools")
        XCTAssertEqual(text, "# PDF tools")
        XCTAssertEqual(SkillsRequestStub.capturedRequest?.httpMethod, "GET")
        XCTAssertEqual(SkillsRequestStub.capturedRequest?.url?.path, "/api/bots/bot_1/skills/pdf-tools")
    }

    func testTurningASkillOnPatchesOnlyTheEnabledFlag() async throws {
        SkillsRequestStub.responseBody = Data(#"{"skill":{"name":"pdf-tools","description":"d","enabled":true,"source":"s","importedAt":"2026-10-09T20:15:00.000Z","warnings":[],"skippedFiles":[]}}"#.utf8)
        let skill = try await client().setSkillEnabled(botId: "bot_1", name: "pdf-tools", enabled: true)
        XCTAssertTrue(skill.enabled)
        XCTAssertEqual(SkillsRequestStub.capturedRequest?.httpMethod, "PATCH")
        XCTAssertEqual(SkillsRequestStub.capturedRequest?.url?.path, "/api/bots/bot_1/skills/pdf-tools")
        let sent = try XCTUnwrap(SkillsRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(Array(body.keys), ["enabled"])
        XCTAssertEqual(body["enabled"] as? Bool, true)
    }

    func testTurningASkillOffSendsFalse() async throws {
        SkillsRequestStub.responseBody = Data(#"{"skill":{"name":"pdf-tools","enabled":false}}"#.utf8)
        let skill = try await client().setSkillEnabled(botId: "bot_1", name: "pdf-tools", enabled: false)
        XCTAssertFalse(skill.enabled)
        let sent = try XCTUnwrap(SkillsRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        XCTAssertEqual(body["enabled"] as? Bool, false)
    }

    func testAFailedToggleThrowsSoTheRowCanSayWhy() async {
        SkillsRequestStub.statusCode = 404
        SkillsRequestStub.responseBody = Data(#"{"error":"no such skill"}"#.utf8)
        do {
            _ = try await client().setSkillEnabled(botId: "bot_1", name: "gone", enabled: true)
            XCTFail("a 404 is a failure")
        } catch let error as APIError {
            XCTAssertTrue(error.isNotFound)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

final class SharedMemoryStatusTests: XCTestCase {
    private func status(_ json: String) throws -> SharedMemoryStatus {
        try JSONDecoder().decode(SharedMemoryStatus.self, from: Data(json.utf8))
    }

    func testAReadyServiceNamesItsRouteAndPoints() throws {
        let ready = try status(#"{"ready":true,"configured":true,"state":"ready","source":"recall-service","url":"https://recall.internal.example","collection":"agent-memory","checkedAt":1791576900000,"lastSuccessAt":1791576900000,"pointsCount":12345,"accessTokenState":"complete"}"#)
        XCTAssertEqual(ready.stateLabel, "Ready")
        XCTAssertEqual(ready.routeLabel, "Recall service")
        XCTAssertEqual(ready.pointsLabel, "12,345 points")
        XCTAssertEqual(ready.collection, "agent-memory")
        XCTAssertEqual(ready.lastSuccessLabel, "Oct 9, 2026, 3:15pm")
        XCTAssertNil(ready.accessWarning)
    }

    func testTheConfiguredServiceAddressIsNeverCarried() throws {
        // The route's answer includes the recall service's address; the type
        // has no field for it, so no view can ever show it.
        let ready = try status(#"{"ready":true,"configured":true,"source":"recall-service","url":"https://recall.internal.example"}"#)
        XCTAssertFalse(Mirror(reflecting: ready).children.contains { $0.label == "url" })
        XCTAssertFalse(String(describing: ready).contains("recall.internal.example"))
    }

    func testTheLabelsMatchTheDesktops() throws {
        XCTAssertEqual(try status(#"{"ready":false,"configured":false,"state":"unconfigured","source":"unconfigured"}"#).stateLabel, "Not configured")
        XCTAssertEqual(try status(#"{"ready":false,"configured":true,"state":"degraded","source":"recall-cli","error":"timeout"}"#).stateLabel, "Needs attention")
        XCTAssertEqual(try status(#"{"ready":true,"configured":true,"source":"recall-cli"}"#).stateLabel, "Ready")
        XCTAssertEqual(try status(#"{"ready":false,"configured":true,"source":"recall-cli"}"#).routeLabel, "Your computer's recall CLI")
        XCTAssertEqual(try status(#"{"ready":false,"configured":false,"source":"unconfigured"}"#).routeLabel, "Not configured")
        XCTAssertEqual(try status("{}").lastSuccessLabel, "None recorded")
        XCTAssertNil(try status(#"{"ready":false,"pointsCount":3}"#).pointsLabel, "points only count once it answers")
        XCTAssertEqual(try status(#"{"ready":true,"pointsCount":1}"#).pointsLabel, "1 point")
    }

    func testAHalfConfiguredAccessTokenIsWarnedAboutInWords() throws {
        XCTAssertTrue(try XCTUnwrap(status(#"{"accessTokenState":"missing-id"}"#).accessWarning).contains("client id is missing"))
        XCTAssertTrue(try XCTUnwrap(status(#"{"accessTokenState":"missing-secret"}"#).accessWarning).contains("client secret is missing"))
        XCTAssertNil(try status(#"{"accessTokenState":"none"}"#).accessWarning)
        XCTAssertNil(try status(#"{"accessTokenState":"complete"}"#).accessWarning)
    }

    func testAnUnreadableFieldCostsThatFieldOnly() throws {
        let odd = try status(#"{"ready":"yes","configured":1,"pointsCount":"many","collection":9,"state":"ready"}"#)
        XCTAssertFalse(odd.ready)
        XCTAssertNil(odd.pointsCount)
        XCTAssertNil(odd.collection)
        XCTAssertEqual(odd.stateLabel, "Ready")
    }
}
