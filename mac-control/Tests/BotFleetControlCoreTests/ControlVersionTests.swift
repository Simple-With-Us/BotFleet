import XCTest
@testable import BotFleetControlCore

final class ControlVersionTests: XCTestCase {
    private func relation(_ ownVersion: String?, _ ownBuild: String?, _ serverVersion: String?, _ serverBuild: String?) -> ControlVersionRelation {
        ControlVersionHandshake(control: .init(version: ownVersion, build: ownBuild),
                                server: .init(version: serverVersion, build: serverBuild)).relation
    }

    func testNumericBuildOrderAndSharedTimestampMigration() {
        XCTAssertEqual(relation("1.0.9", "9", "1.0.10", "10"), .controlOlder)
        XCTAssertEqual(relation("0.1.0", "202610301230", "1.0.9999", "9999"), .controlNewer)
        XCTAssertEqual(relation("0.1.0", "202610301230", "0.1.0", "202610301231"), .controlOlder)
        XCTAssertEqual(relation("0.1.0", "202610301230", "0.1.0", "202610301230.0"), .matching)
        XCTAssertEqual(relation("1.0.1", "11.2", "1.0.1", "11.10"), .controlOlder)
    }

    func testUnknownMetadataDoesNotInventVersionOrder() {
        XCTAssertEqual(relation("0.1.0", "202610301230", "0.1.0", nil), .unknown)
        XCTAssertEqual(relation("0.1.0", "202610301230", nil, "202610301231"), .unknown)
        XCTAssertEqual(relation("0.1.0", "202610301230", "1.0.31", nil), .different)
        XCTAssertEqual(relation("0.1.0", "bad", "0.1.0", "202610301231"), .unknown)
        XCTAssertEqual(relation("not-a-version", "1", "0.1.0", "2"), .unknown)
        XCTAssertEqual(relation("0.1.0", "18446744073709551616", "0.1.0", "2"), .unknown)
        XCTAssertEqual(relation("0.1.0", "12", "1.0.31", "12"), .different)
        let unknown = ControlVersionHandshake(control: .init(version: nil, build: nil), server: nil)
        XCTAssertTrue(unknown.summary.contains("unknown"))
    }

    func testMatchingNumbersWithDifferentCommitsRemainDifferent() {
        let handshake = ControlVersionHandshake(
            control: .init(version: "0.1.0", build: "202610301230", sourceCommit: String(repeating: "a", count: 40)),
            server: .init(version: "0.1.0", build: "202610301230", sourceCommit: String(repeating: "b", count: 40)))
        XCTAssertEqual(handshake.relation, .different)
        XCTAssertEqual(ControlBuildIdentity(version: "0.1.0", build: "1", sourceCommit: String(repeating: "0", count: 40)).sourceCommit, nil)
    }

    func testStatusDecodesHandshakeAndPreservesOlderAndUnknownResponses() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        MockURLProtocol.failure = nil
        for metadata in ["", ",\"serverBuild\":null", ",\"serverBuild\":\"unknown\"",
                         ",\"serverBuild\":{\"version\":42,\"build\":\"invalid\"}"] {
            MockURLProtocol.handler = { request in
                if request.url?.path == "/api/health" {
                    return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8))
                }
                return (200, Data("{\"activeBotCount\":0,\"localVms\":[],\"persistOnExit\":true\(metadata)}".utf8))
            }
            let status = try await ControlAPI(session: session).status()
            XCTAssertEqual(status.activeBotCount, 0)
            XCTAssertEqual(ControlVersionHandshake(control: .init(version: "0.1.0", build: "12"),
                                                   server: status.serverBuild).relation, .unknown)
        }
        MockURLProtocol.handler = { request in
            if request.url?.path == "/api/health" {
                return (200, Data(#"{"app":"botfleet","pid":42,"ready":true}"#.utf8))
            }
            return (200, Data(#"{"activeBotCount":0,"localVms":[],"persistOnExit":true,"serverBuild":{"version":"0.1.0","build":"202610301231"}}"#.utf8))
        }
        let status = try await ControlAPI(session: session).status()
        XCTAssertEqual(ControlVersionHandshake(control: .init(version: "0.1.0", build: "202610301230"),
                                               server: status.serverBuild).relation, .controlOlder)
    }

    func testUpdateRequiresExplicitSelectionAndSupportedBundledPackage() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let commands = UpdateCommands()
        let handoff = ControlUpdateHandoff(commands: commands)
        XCTAssertFalse(try handoff.perform(selection: .cancel, application: nil))
        XCTAssertTrue(commands.calls.isEmpty)
        XCTAssertThrowsError(try handoff.perform(selection: .updateControl, application: nil))
        let app = root.appendingPathComponent("BotFleet.app")
        try writePlist(["CFBundleIdentifier": "app.botfleet.macos"], bundle: app)
        // A native-only app has no bundled Control package and cannot update it.
        XCTAssertThrowsError(try handoff.perform(selection: .updateControl, application: app))
        XCTAssertTrue(commands.calls.isEmpty)
        let control = app.appendingPathComponent("Contents/Resources/BotFleet Control.app")
        try writePlist(["CFBundleIdentifier": "app.botfleet.control.macos"], bundle: control)
        let resources = control.appendingPathComponent("Contents/Resources")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let marker = resources.appendingPathComponent("control-update-protocol.json")
        try Data(#"{"protocolVersion":99}"#.utf8).write(to: marker)
        XCTAssertThrowsError(try handoff.perform(selection: .updateControl, application: app))
        XCTAssertTrue(commands.calls.isEmpty)
        try Data(#"{"protocolVersion":1}"#.utf8).write(to: marker)
        XCTAssertTrue(try handoff.perform(selection: .updateControl, application: app))
        XCTAssertEqual(commands.calls, [["/usr/bin/open", "-n", "-a", app.path, "--args", "--update-control"]])
    }

    private func writePlist(_ values: [String: String], bundle: URL) throws {
        try FileManager.default.createDirectory(at: bundle.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: values, format: .xml, options: 0)
        try data.write(to: bundle.appendingPathComponent("Contents/Info.plist"))
    }
}

private final class UpdateCommands: CommandRunning {
    var calls: [[String]] = []
    func run(_ executable: String, _ arguments: [String]) throws -> String {
        calls.append([executable] + arguments)
        return ""
    }
}
