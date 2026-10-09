import Foundation
import XCTest
@testable import CompanionCore

// MARK: - Fixtures

private func makeBot(
    id: String,
    name: String = "Aria",
    hidden: Bool? = nil,
    chief: Bool? = nil,
    section: String? = nil,
    instanceId: String = "claude"
) throws -> Bot {
    var object: [String: Any] = [
        "id": id, "threadId": "thread-\(id)", "name": name, "title": "", "description": "",
        "notifications": true, "color": "blue", "unread": false,
        "modelSelection": ["instanceId": instanceId, "model": "default"], "createdAt": 1,
    ]
    if let hidden { object["hidden"] = hidden }
    if let chief { object["chiefOfStaff"] = chief }
    if let section { object["section"] = section }
    return try JSONDecoder().decode(Bot.self, from: JSONSerialization.data(withJSONObject: object))
}

private func makeRoom(id: String, section: String? = nil, dm: Bool? = nil) throws -> Room {
    var object: [String: Any] = [
        "id": id, "threadId": "thread-\(id)", "name": "Work", "memberIds": ["a"],
        "defaultResponder": ["kind": "mentions"], "bulletin": "", "unread": false, "createdAt": 1,
    ]
    if let section { object["section"] = section }
    if let dm { object["dm"] = dm }
    return try JSONDecoder().decode(Room.self, from: JSONSerialization.data(withJSONObject: object))
}

private func makeInstance(id: String, agentsMcp: Bool?) throws -> Instance {
    var capabilities: [String: Any] = [:]
    if let agentsMcp { capabilities["agentsMcp"] = agentsMcp }
    let object: [String: Any] = [
        "instanceId": id, "driverKind": id, "snapshot": ["state": "available"],
        "models": ["default": "default", "options": [] as [Any]], "capabilities": capabilities,
    ]
    return try JSONDecoder().decode(Instance.self, from: JSONSerialization.data(withJSONObject: object))
}

private func makeMessage(id: String, role: Message.Role = .bot, kind: Message.Kind = .text, text: String?) -> Message {
    var message = Message(id: id, role: role, kind: kind, at: 1)
    message.text = text
    return message
}

private func encodedObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

// MARK: - Pure rules

final class BotOrganizeTests: XCTestCase {
    func testArchiveIsBlockedForTheChiefOfStaff() throws {
        let chief = try makeBot(id: "a", chief: true)
        let other = try makeBot(id: "b")
        XCTAssertEqual(BotOrganize.archiveBlockReason(for: chief, among: [chief, other]), "Choose another Chief of Staff first")
    }

    func testArchiveIsBlockedForTheLastActiveBot() throws {
        let only = try makeBot(id: "a")
        let archived = try makeBot(id: "b", hidden: true)
        XCTAssertEqual(BotOrganize.archiveBlockReason(for: only, among: [only, archived]), "Keep at least one active bot")
        XCTAssertEqual(BotOrganize.archiveBlockReason(for: only, among: [only]), "Keep at least one active bot")
    }

    func testChiefReasonWinsWhenBothRulesApply() throws {
        let chief = try makeBot(id: "a", chief: true)
        XCTAssertEqual(BotOrganize.archiveBlockReason(for: chief, among: [chief]), BotOrganize.archiveChiefFirst)
    }

    func testArchiveIsAllowedWithAnotherActiveBot() throws {
        let first = try makeBot(id: "a")
        let second = try makeBot(id: "b")
        XCTAssertNil(BotOrganize.archiveBlockReason(for: first, among: [first, second]))
    }

    func testArchivedBotsAreTheHiddenOnesByName() throws {
        let bots = [
            try makeBot(id: "a", name: "zed", hidden: true),
            try makeBot(id: "b", name: "Visible"),
            try makeBot(id: "c", name: "Aria", hidden: true, chief: true),
        ]
        XCTAssertEqual(BotOrganize.archivedBots(bots).map(\.id), ["c", "a"])
    }

    func testMakeChiefNeedsACoordinationEngine() throws {
        let bot = try makeBot(id: "a", instanceId: "grok")
        let coordinating = try makeInstance(id: "grok", agentsMcp: true)
        let plain = try makeInstance(id: "grok", agentsMcp: false)
        let older = try makeInstance(id: "grok", agentsMcp: nil)

        XCTAssertTrue(BotOrganize.canCoordinate(bot, instances: [coordinating]))
        XCTAssertNil(BotOrganize.makeChiefBlockReason(for: bot, instances: [coordinating]))
        XCTAssertEqual(BotOrganize.makeChiefBlockReason(for: bot, instances: [plain]), "Choose an engine with coordination first")
        XCTAssertEqual(BotOrganize.makeChiefBlockReason(for: bot, instances: [older]), BotOrganize.chiefNeedsCoordination)
        // An engine list that has not loaded, or another engine's capability, is no.
        XCTAssertEqual(BotOrganize.makeChiefBlockReason(for: bot, instances: []), BotOrganize.chiefNeedsCoordination)
        let elsewhere = try makeInstance(id: "claude", agentsMcp: true)
        XCTAssertFalse(BotOrganize.canCoordinate(bot, instances: [elsewhere]))
    }

    func testRemovingTheChiefIsNeverBlocked() throws {
        let chief = try makeBot(id: "a", chief: true, instanceId: "grok")
        XCTAssertNil(BotOrganize.makeChiefBlockReason(for: chief, instances: []))
    }

    func testNewChiefDemotesOnlyTheChiefInItsSection() throws {
        let newChief = try makeBot(id: "new", chief: true, section: " Work ")
        var oldChief = try makeBot(id: "old", chief: true, section: "Work")
        oldChief.messages = [makeMessage(id: "m1", text: "kept elsewhere")]
        let otherSection = try makeBot(id: "home", chief: true, section: "Home")
        let unsectioned = try makeBot(id: "none", chief: true)

        let demoted = BotOrganize.demotedChiefs(after: newChief, in: [newChief, oldChief, otherSection, unsectioned])
        XCTAssertEqual(demoted.map(\.id), ["old"])
        XCTAssertEqual(demoted.first?.chiefOfStaff, false)
        XCTAssertNil(demoted.first?.messages, "a demotion must never replace the thread's scrollback")

        let notChief = try makeBot(id: "x", chief: false, section: "Work")
        XCTAssertTrue(BotOrganize.demotedChiefs(after: notChief, in: [oldChief]).isEmpty)
    }

    func testABotDeletedWhileItsPatchWasInFlightIsNotPutBack() throws {
        var state = CompanionState()
        let bot = try makeBot(id: "gone", name: "Gone", section: "Work")
        state.apply(.bot(bot))
        XCTAssertNotNil(state.bot("gone"))

        // the PATCH was sent, then the delete frame landed, then the answer came
        state.apply(.botDeleted(botId: "gone"))
        var answer = bot
        answer.pinned = true
        let toApply = BotOrganize.botsToApply(after: answer, in: state.bots)
        XCTAssertTrue(toApply.isEmpty)
        for folded in toApply { state.apply(.bot(folded)) }

        XCTAssertNil(state.bot("gone"))
        XCTAssertTrue(state.bots.isEmpty)
        // Applying the answer unguarded is what re-inserted it.
        state.apply(.bot(answer))
        XCTAssertNotNil(state.bot("gone"))
    }

    func testAPatchedBotThatIsStillThereIsAppliedAfterTheChiefItDemoted() throws {
        let oldChief = try makeBot(id: "old", chief: true, section: "Work")
        let newChief = try makeBot(id: "new", chief: true, section: "Work")
        let roster = [oldChief, try makeBot(id: "new", section: "Work")]
        let toApply = BotOrganize.botsToApply(after: newChief, in: roster)
        XCTAssertEqual(toApply.map(\.id), ["old", "new"])
        XCTAssertEqual(toApply.first?.chiefOfStaff, false)
        XCTAssertEqual(toApply.last?.chiefOfStaff, true)
    }

    func testSectionNameIsTrimmedAndCappedAtSixtyUTF16Units() {
        XCTAssertEqual(BotOrganize.sectionName(from: "  Work  "), "Work")
        XCTAssertNil(BotOrganize.sectionName(from: "   "))
        XCTAssertNil(BotOrganize.sectionName(from: ""))
        XCTAssertEqual(BotOrganize.sectionName(from: String(repeating: "a", count: 60))?.count, 60)
        XCTAssertNil(BotOrganize.sectionName(from: String(repeating: "a", count: 61)))
        // 30 emoji are 30 characters but 60 UTF-16 units, the harness's measure.
        XCTAssertNotNil(BotOrganize.sectionName(from: String(repeating: "\u{1F680}", count: 30)))
        XCTAssertNil(BotOrganize.sectionName(from: String(repeating: "\u{1F680}", count: 31)))
    }

    func testTypedSectionInputIsCutOnWholeCharacters() {
        XCTAssertEqual(BotOrganize.cappedSectionInput("Work"), "Work")
        XCTAssertEqual(BotOrganize.cappedSectionInput(String(repeating: "b", count: 75)).count, 60)
        let emoji = BotOrganize.cappedSectionInput("a" + String(repeating: "\u{1F680}", count: 40))
        XCTAssertEqual(emoji.utf16.count, 59)
        XCTAssertEqual(emoji.count, 30)
    }

    func testSectionNamesFollowTheSavedOrderThenName() throws {
        let bots = [
            try makeBot(id: "a", section: "Zeta"),
            try makeBot(id: "b", section: " Alpha "),
            try makeBot(id: "c", hidden: true, section: "Archived Only"),
            try makeBot(id: "d", section: "   "),
        ]
        let rooms = [
            try makeRoom(id: "r1", section: "Ops"),
            try makeRoom(id: "r2", section: "Bot Talk", dm: true),
            try makeRoom(id: "r3", section: "Zeta"),
        ]
        XCTAssertEqual(
            BotOrganize.sectionNames(bots: bots, rooms: rooms, order: ["Zeta", "Missing", "Zeta"]),
            ["Zeta", "Alpha", "Ops"]
        )
        XCTAssertEqual(BotOrganize.sectionNames(bots: bots, rooms: rooms, order: []), ["Alpha", "Ops", "Zeta"])
    }

    func testDeleteBotCopyNamesTheBotAndWhatIsLost() {
        let copy = BotOrganize.deleteBotConfirmation(name: "Aria")
        XCTAssertEqual(copy.title, "Delete Aria?")
        XCTAssertEqual(copy.confirmLabel, "Delete Bot")
        XCTAssertEqual(
            copy.message,
            "Every conversation and task with Aria is deleted for good, along with its computers, routines, webhooks and triggers.\u{00A0} A turn in progress is stopped.\u{00A0} This cannot be undone.\u{00A0} Archive it instead to keep the history."
        )

        let unnamed = BotOrganize.deleteBotConfirmation(name: "  ")
        XCTAssertEqual(unnamed.title, "Delete Bot?")
        XCTAssertTrue(unnamed.message.hasPrefix("Every conversation and task with this bot is deleted"))
    }

    func testDeleteRoomCopyUsesTheWorkspaceWordForARoom() {
        let channel = BotOrganize.deleteRoomConfirmation(name: "Launch", roomTerm: "Channel")
        XCTAssertEqual(channel.title, "Delete Launch?")
        XCTAssertEqual(channel.confirmLabel, "Delete Channel")
        XCTAssertEqual(
            channel.message,
            "Every conversation in this channel is deleted for good.\u{00A0} The bots in it are not affected.\u{00A0} This cannot be undone."
        )

        let project = BotOrganize.deleteRoomConfirmation(name: "Site", roomTerm: "project")
        XCTAssertEqual(project.confirmLabel, "Delete Project")
        XCTAssertTrue(project.message.hasPrefix("Every conversation in this project is deleted for good."))

        let fallback = BotOrganize.deleteRoomConfirmation(name: "", roomTerm: "")
        XCTAssertEqual(fallback.title, "Delete Channel?")
        XCTAssertEqual(fallback.confirmLabel, "Delete Channel")
    }

    func testOnlySettledTextWithAHarnessIdCanBePinned() {
        XCTAssertTrue(BotOrganize.canPin(makeMessage(id: "msg-abc_123", text: "Ship it")))
        XCTAssertFalse(BotOrganize.canPin(makeMessage(id: "m1", text: "   ")))
        XCTAssertFalse(BotOrganize.canPin(makeMessage(id: "m1", text: nil)))
        XCTAssertFalse(BotOrganize.canPin(makeMessage(id: "m1", kind: .activity, text: "Read")))
        XCTAssertFalse(BotOrganize.canPin(makeMessage(id: "bad id!", text: "Ship it")))

        // A row drawn for a send still in flight carries its local id.
        var pending = makeMessage(id: "queue-1", role: .user, text: "Later")
        pending.queueId = "queue-1"
        XCTAssertFalse(BotOrganize.canPin(pending))
        // A stored message that drained from the queue keeps its own id.
        var landed = makeMessage(id: "stored-1", role: .user, text: "Later")
        landed.queueId = "queue-1"
        XCTAssertTrue(BotOrganize.canPin(landed))
    }

    func testPinnedMessageResolvesOnlyToLoadedText() {
        let messages = [
            makeMessage(id: "a", text: "First\n\n  line"),
            makeMessage(id: "b", kind: .activity, text: "tool"),
            makeMessage(id: "c", text: "  "),
        ]
        XCTAssertEqual(BotOrganize.pinnedMessage(id: "a", in: messages)?.id, "a")
        XCTAssertNil(BotOrganize.pinnedMessage(id: "b", in: messages))
        XCTAssertNil(BotOrganize.pinnedMessage(id: "c", in: messages))
        XCTAssertNil(BotOrganize.pinnedMessage(id: "gone", in: messages))
        XCTAssertNil(BotOrganize.pinnedMessage(id: nil, in: messages))
        XCTAssertNil(BotOrganize.pinnedMessage(id: "", in: messages))
        XCTAssertEqual(BotOrganize.pinnedText(messages[0]), "First line")
    }

    func testPinnedSenderSaysYouOnlyForWhatThePersonTyped() throws {
        let mine = makeMessage(id: "a", role: .user, text: "hi")
        XCTAssertEqual(BotOrganize.pinnedSender(mine, chatName: "Aria"), "You")

        let peerData = Data(#"{"id":"b","role":"user","kind":"text","at":1,"text":"hi","from":{"botId":"x","name":"Scout","color":"red"}}"#.utf8)
        let peer = try JSONDecoder().decode(Message.self, from: peerData)
        XCTAssertEqual(BotOrganize.pinnedSender(peer, chatName: "Aria"), "Scout")

        let reply = makeMessage(id: "c", role: .bot, text: "done")
        XCTAssertEqual(BotOrganize.pinnedSender(reply, chatName: "Aria"), "Aria")
        XCTAssertEqual(BotOrganize.pinnedSender(reply, chatName: nil), "A bot")
    }

    func testAChatIsGoneWhenDeletedOrArchived() throws {
        let live = try makeBot(id: "a")
        let archived = try makeBot(id: "b", hidden: true)
        XCTAssertFalse(BotOrganize.isBotGone("a", in: [live, archived]))
        XCTAssertTrue(BotOrganize.isBotGone("b", in: [live, archived]))
        XCTAssertTrue(BotOrganize.isBotGone("deleted", in: [live]))

        let room = try makeRoom(id: "r")
        XCTAssertFalse(BotOrganize.isRoomGone("r", in: [room]))
        XCTAssertTrue(BotOrganize.isRoomGone("other", in: [room]))
    }

    // MARK: - Wire

    func testOrganizePatchCarriesOnlyTheSixFieldsTheSidecarAllows() {
        XCTAssertEqual(
            BotOrganizePatch.CodingKeys.allCases.map(\.rawValue).sorted(),
            ["chiefOfStaff", "hidden", "pinned", "pinnedMessageId", "section", "unread"]
        )
    }

    func testEachActionSendsExactlyItsOwnField() throws {
        let archive = try encodedObject(BotOrganizePatch.archive)
        XCTAssertEqual(archive.keys.sorted(), ["hidden"])
        XCTAssertEqual(archive["hidden"] as? Bool, true)

        let restore = try encodedObject(BotOrganizePatch.restore)
        XCTAssertEqual(restore.keys.sorted(), ["hidden"])
        XCTAssertEqual(restore["hidden"] as? Bool, false)

        let pin = try encodedObject(BotOrganizePatch.pin(true))
        XCTAssertEqual(pin.keys.sorted(), ["pinned"])
        XCTAssertEqual(pin["pinned"] as? Bool, true)

        let unread = try encodedObject(BotOrganizePatch.markUnread)
        XCTAssertEqual(unread.keys.sorted(), ["unread"])
        XCTAssertEqual(unread["unread"] as? Bool, true)

        let chief = try encodedObject(BotOrganizePatch.chiefOfStaff(false))
        XCTAssertEqual(chief.keys.sorted(), ["chiefOfStaff"])
        XCTAssertEqual(chief["chiefOfStaff"] as? Bool, false)

        let move = try encodedObject(BotOrganizePatch.moveToSection("  Work "))
        XCTAssertEqual(move.keys.sorted(), ["section"])
        XCTAssertEqual(move["section"] as? String, "Work")

        let pinMessage = try encodedObject(BotOrganizePatch.pinMessage("msg-1"))
        XCTAssertEqual(pinMessage.keys.sorted(), ["pinnedMessageId"])
        XCTAssertEqual(pinMessage["pinnedMessageId"] as? String, "msg-1")
    }

    func testClearingASectionOrPinSendsExplicitNull() throws {
        for removal in [BotOrganizePatch.moveToSection(nil), .moveToSection("   ")] {
            let body = try encodedObject(removal)
            XCTAssertEqual(body.keys.sorted(), ["section"])
            XCTAssertTrue(body["section"] is NSNull)
        }
        for unpin in [BotOrganizePatch.pinMessage(nil), .pinMessage("")] {
            let body = try encodedObject(unpin)
            XCTAssertEqual(body.keys.sorted(), ["pinnedMessageId"])
            XCTAssertTrue(body["pinnedMessageId"] is NSNull)
        }
    }

    func testAFullPatchNeverCarriesAnyOtherKey() throws {
        let full = BotOrganizePatch(
            hidden: true, pinned: true, unread: true, chiefOfStaff: true,
            section: .set("Work"), pinnedMessageId: .clear
        )
        let body = try encodedObject(full)
        XCTAssertEqual(body.keys.sorted(), BotOrganizePatch.CodingKeys.allCases.map(\.rawValue).sorted())
        XCTAssertFalse(full.isEmpty)
        XCTAssertTrue(BotOrganizePatch().isEmpty)
        XCTAssertTrue(try encodedObject(BotOrganizePatch()).isEmpty)
    }

    func testRoomPatchPinsAndUnpinsAMessage() throws {
        let pin = try encodedObject(RoomPatch(pinnedMessageId: .set("msg-9")))
        XCTAssertEqual(pin.keys.sorted(), ["pinnedMessageId"])
        XCTAssertEqual(pin["pinnedMessageId"] as? String, "msg-9")

        let unpin = try encodedObject(RoomPatch(pinnedMessageId: .clear))
        XCTAssertEqual(unpin.keys.sorted(), ["pinnedMessageId"])
        XCTAssertTrue(unpin["pinnedMessageId"] is NSNull)

        let untouched = try encodedObject(RoomPatch(section: .set("Work")))
        XCTAssertNil(untouched["pinnedMessageId"])
    }

    func testDecodesPinsAndCoordinationWithAndWithoutTheNewFields() throws {
        let pinnedBot = try JSONDecoder().decode(Bot.self, from: Data(#"""
        {"id":"a","threadId":"t","name":"Aria","title":"","description":"","notifications":true,"color":"blue","unread":false,"modelSelection":{"instanceId":"claude","model":"default"},"createdAt":1,"pinnedMessageId":"msg-1"}
        """#.utf8))
        XCTAssertEqual(pinnedBot.pinnedMessageId, "msg-1")
        XCTAssertNil(try makeBot(id: "b").pinnedMessageId)

        let pinnedRoom = try JSONDecoder().decode(Room.self, from: Data(#"""
        {"id":"g","threadId":"t","name":"Work","memberIds":["a"],"defaultResponder":{"kind":"mentions"},"bulletin":"","unread":false,"createdAt":1,"pinnedMessageId":"msg-2"}
        """#.utf8))
        XCTAssertEqual(pinnedRoom.pinnedMessageId, "msg-2")
        XCTAssertNil(try makeRoom(id: "r").pinnedMessageId)

        XCTAssertEqual(try makeInstance(id: "grok", agentsMcp: true).capabilities?.agentsMcp, true)
        XCTAssertNil(try makeInstance(id: "grok", agentsMcp: nil).capabilities?.agentsMcp)
        let bare = try JSONDecoder().decode(InstanceCapabilities.self, from: Data(#"{"effortLevels":["low"]}"#.utf8))
        XCTAssertNil(bare.agentsMcp)
        XCTAssertNil(bare.toolLoop)
    }
}

// MARK: - Client

private final class OrganizeRequestStub: URLProtocol {
    struct Capture {
        let method: String?
        let path: String
        let body: Data?
    }

    static let lock = NSLock()
    static var captures: [Capture] = []
    static var statusCode = 200
    static var responseBody = Data(#"{"ok":true}"#.utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.captures.append(Capture(
            method: request.httpMethod,
            path: request.url?.path ?? "",
            body: Self.readBody(from: request)
        ))
        let statusCode = Self.statusCode
        let responseBody = Self.responseBody
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func reset(statusCode: Int = 200, responseBody: Data = Data(#"{"ok":true}"#.utf8)) {
        lock.lock()
        captures = []
        self.statusCode = statusCode
        self.responseBody = responseBody
        lock.unlock()
    }

    static func captured() -> [Capture] {
        lock.lock()
        defer { lock.unlock() }
        return captures
    }

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

final class BotOrganizeClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    private static let botResponse = Data(#"""
    {"bot":{"id":"bot-1","threadId":"t","name":"Aria","title":"","description":"","notifications":true,"color":"blue","unread":false,"modelSelection":{"instanceId":"claude","model":"default"},"createdAt":1,"hidden":true,"pinnedMessageId":"msg-1"}}
    """#.utf8)

    override func setUp() {
        super.setUp()
        OrganizeRequestStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OrganizeRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testOrganizeBotPatchesTheBotRouteWithOnlyItsField() async throws {
        OrganizeRequestStub.reset(responseBody: Self.botResponse)

        let bot = try await client.organizeBot(id: "bot-1", patch: .archive)

        let captures = OrganizeRequestStub.captured()
        XCTAssertEqual(captures.count, 1)
        let request = try XCTUnwrap(captures.first)
        XCTAssertEqual(request.method, "PATCH")
        XCTAssertEqual(request.path, "/api/bots/bot-1", "the organize route, not /profile")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["hidden"])
        XCTAssertEqual(bot.hidden, true)
        XCTAssertEqual(bot.pinnedMessageId, "msg-1")
    }

    func testDeleteBotSendsDelete() async throws {
        try await client.deleteBot(id: "bot-1")

        let captures = OrganizeRequestStub.captured()
        XCTAssertEqual(captures.count, 1)
        XCTAssertEqual(captures.first?.method, "DELETE")
        XCTAssertEqual(captures.first?.path, "/api/bots/bot-1")
    }

    func testDeleteRoomSendsDelete() async throws {
        try await client.deleteRoom(id: "group-1")

        let captures = OrganizeRequestStub.captured()
        XCTAssertEqual(captures.count, 1)
        XCTAssertEqual(captures.first?.method, "DELETE")
        XCTAssertEqual(captures.first?.path, "/api/groups/group-1")
    }

    func testARefusedDeleteCarriesTheHarnessSentence() async throws {
        OrganizeRequestStub.reset(
            statusCode: 409,
            responseBody: Data(#"{"error":"this channel is working -- stop that turn first"}"#.utf8)
        )

        do {
            try await client.deleteRoom(id: "group-1")
            XCTFail("a 409 must throw")
        } catch let error as APIError {
            XCTAssertEqual(error.errorDescription, "this channel is working -- stop that turn first")
        }
        XCTAssertEqual(OrganizeRequestStub.captured().count, 1, "a refusal is not retried")
    }

    func testARefusedArchiveCarriesTheHarnessSentence() async throws {
        OrganizeRequestStub.reset(
            statusCode: 400,
            responseBody: Data(#"{"error":"choose another Chief of Staff before hiding this bot"}"#.utf8)
        )

        do {
            _ = try await client.organizeBot(id: "bot-1", patch: .archive)
            XCTFail("a 400 must throw")
        } catch let error as APIError {
            XCTAssertEqual(error.errorDescription, "choose another Chief of Staff before hiding this bot")
        }
    }
}
