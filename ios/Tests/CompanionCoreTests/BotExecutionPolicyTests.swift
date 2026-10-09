import Foundation
import XCTest
@testable import CompanionCore

/// The execution policy the owner put on the phone on 2026-10-09: what a save
/// carries, what the phone says while it asks, and the one thing it does not
/// offer (turning Auto Mode or Bypass Permissions ON for a bot that can use
/// This Mac, which the computer refuses).
final class BotExecutionPolicyTests: XCTestCase {
    private func body(_ patch: BotProfilePatch) throws -> [String: Any] {
        let data = try JSONEncoder().encode(patch)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - What a save carries

    func testASaveThatChangesNoPolicyCarriesNone() throws {
        let sent = try body(BotProfilePatch(name: "Scout", computers: ["cloud"]))
        for key in ["autoApprove", "autoReview", "approvePeerComms", "bypassPermissions"] {
            XCTAssertNil(sent[key], key)
        }
    }

    func testEachSwitchRidesAloneAndOnTheWireNames() throws {
        XCTAssertEqual(try body(BotProfilePatch(autoApprove: true)).keys.sorted(), ["autoApprove"])
        XCTAssertEqual(try body(BotProfilePatch(bypassPermissions: false)).keys.sorted(), ["bypassPermissions"])
        XCTAssertEqual(try body(BotProfilePatch(approvePeerComms: true)).keys.sorted(), ["approvePeerComms"])
        let sent = try body(BotProfilePatch(autoApprove: false, autoReview: .enforce, bypassPermissions: true))
        XCTAssertEqual(sent["autoApprove"] as? Bool, false, "an explicit off is sent, not dropped")
        XCTAssertEqual(sent["autoReview"] as? String, "enforce")
        XCTAssertEqual(sent["bypassPermissions"] as? Bool, true)
        XCTAssertEqual(try body(BotProfilePatch(autoReview: .shadow))["autoReview"] as? String, "shadow")
        XCTAssertEqual(try body(BotProfilePatch(autoReview: .off))["autoReview"] as? String, "off")
    }

    // MARK: - Reading what the computer holds

    func testABotDecodesItsBypassAndOlderComputersReadAsOff() throws {
        let base = #""id":"b1","threadId":"t1","name":"Scout","title":"","description":"","notifications":true,"color":"blue","unread":false,"modelSelection":{"instanceId":"claude","model":"sonnet"},"createdAt":1"#
        let on = try JSONDecoder().decode(Bot.self, from: Data(("{" + base + #","bypassPermissions":true,"autoApprove":false,"autoReview":"shadow"}"#).utf8))
        XCTAssertEqual(on.bypassPermissions, true)
        XCTAssertEqual(AutoReviewMode(stored: on.autoReview), .shadow)
        let old = try JSONDecoder().decode(Bot.self, from: Data(("{" + base + "}").utf8))
        XCTAssertNil(old.bypassPermissions)
        XCTAssertEqual(AutoReviewMode(stored: old.autoReview), .off)
    }

    func testAutoReviewReadsAnythingUnknownAsOffLikeTheDesktop() {
        XCTAssertEqual(AutoReviewMode(stored: nil), .off)
        XCTAssertEqual(AutoReviewMode(stored: "enforce"), .enforce)
        XCTAssertEqual(AutoReviewMode(stored: "shadow"), .shadow)
        XCTAssertEqual(AutoReviewMode(stored: "strict"), .off)
        XCTAssertEqual(AutoReviewMode.allCases.map(\.label), ["Off", "Watch", "On"])
    }

    func testEngineCapabilitiesCarryTheTwoGatesAndOlderComputersSayNothing() throws {
        let capable = try JSONDecoder().decode(
            Instance.self,
            from: Data(#"{"instanceId":"claude","driverKind":"claude","snapshot":{"state":"available"},"models":{"default":"sonnet","options":[]},"capabilities":{"approvalReview":true,"agentsMcp":false}}"#.utf8)
        )
        XCTAssertEqual(capable.capabilities?.approvalReview, true)
        XCTAssertEqual(capable.capabilities?.agentsMcp, false)
        let older = try JSONDecoder().decode(
            Instance.self,
            from: Data(#"{"instanceId":"claude","driverKind":"claude","snapshot":{"state":"available"},"models":{"default":"sonnet","options":[]},"capabilities":{"toolLoop":true}}"#.utf8)
        )
        XCTAssertNil(older.capabilities?.approvalReview)
        XCTAssertNil(older.capabilities?.agentsMcp)
    }

    func testAControlTheEngineCannotUseStaysOffUntilTheComputerSaysYes() throws {
        func engine(_ capabilities: String) throws -> Instance {
            try JSONDecoder().decode(
                Instance.self,
                from: Data(#"{"instanceId":"e","driverKind":"claude","snapshot":{"state":"available"},"models":{"default":"m","options":[]},"capabilities":\#(capabilities)}"#.utf8)
            )
        }
        let yes = try engine(#"{"approvalReview":true,"agentsMcp":true}"#)
        let no = try engine(#"{"approvalReview":false,"agentsMcp":false}"#)
        let silent = try engine(#"{"toolLoop":true}"#)
        XCTAssertEqual(BotExecutionPolicy.autoReviewSupport(yes), .supported)
        XCTAssertEqual(BotExecutionPolicy.peerCommsSupport(yes), .supported)
        XCTAssertEqual(BotExecutionPolicy.autoReviewSupport(no), .unsupported)
        XCTAssertEqual(BotExecutionPolicy.peerCommsSupport(no), .unsupported)
        // Not loaded yet, or too old to say: not "cannot", and not allowed on.
        XCTAssertEqual(BotExecutionPolicy.autoReviewSupport(nil), .unknown)
        XCTAssertEqual(BotExecutionPolicy.peerCommsSupport(silent), .unknown)
        XCTAssertTrue(EngineSupport.supported.allowsTurningOn)
        XCTAssertFalse(EngineSupport.unsupported.allowsTurningOn)
        XCTAssertFalse(EngineSupport.unknown.allowsTurningOn)
    }

    // MARK: - This Mac

    func testThePhoneDoesNotOfferToTurnAutoOnForABotThatHoldsThisMac() {
        XCTAssertFalse(BotExecutionPolicy.mayTurnOnAuto(computers: ["local"]))
        XCTAssertFalse(BotExecutionPolicy.mayTurnOnAuto(computers: ["cloud", "local"]))
        XCTAssertTrue(BotExecutionPolicy.mayTurnOnAuto(computers: ["cloud", "vm"]))
        XCTAssertTrue(BotExecutionPolicy.mayTurnOnAuto(computers: []))
        // An Auto bot has no list.  The computer knows whether it can reach
        // the desktop, so the phone asks and shows its sentence if declined.
        XCTAssertTrue(BotExecutionPolicy.mayTurnOnAuto(computers: nil))
    }

    // MARK: - What the phone says

    private let gap = "\u{00A0} "

    private func texts() -> [String] {
        [
            BotExecutionPolicy.thisMacNote,
            BotExecutionPolicy.bypassWarning(botName: "Scout", model: "claude-sonnet-4"),
            BotExecutionPolicy.bypassWarning(botName: "Scout", model: "claude-haiku-4"),
            BotExecutionPolicy.bypassWarning(botName: "Scout", model: nil),
            BotExecutionPolicy.bypassSummary(isOn: true),
            BotExecutionPolicy.bypassSummary(isOn: false),
            BotExecutionPolicy.autoSummary(isOn: true),
            BotExecutionPolicy.autoSummary(isOn: false),
            BotExecutionPolicy.autoReviewSummary(bypassIsOn: true, support: .supported),
            BotExecutionPolicy.autoReviewSummary(bypassIsOn: false, support: .supported),
            BotExecutionPolicy.autoReviewSummary(bypassIsOn: false, support: .unsupported),
            BotExecutionPolicy.autoReviewSummary(bypassIsOn: false, support: .unknown),
            BotExecutionPolicy.peerCommsSummary(isOn: true, support: .supported),
            BotExecutionPolicy.peerCommsSummary(isOn: false, support: .supported),
            BotExecutionPolicy.peerCommsSummary(isOn: false, support: .unsupported),
            BotExecutionPolicy.peerCommsSummary(isOn: false, support: .unknown),
        ]
    }

    func testEverySentenceGapIsANoBreakSpaceAndASpace() {
        for text in texts() {
            XCTAssertFalse(text.contains(".  "), "ASCII double space in: \(text)")
            XCTAssertFalse(text.contains(". "), "single-space gap in: \(text)")
        }
        XCTAssertTrue(BotExecutionPolicy.thisMacNote.contains("." + gap))
    }

    func testTheBypassWarningSaysWhatItCoversAndThatThisMacStillAsks() {
        let warning = BotExecutionPolicy.bypassWarning(botName: "Scout", model: "claude-sonnet-4")
        XCTAssertTrue(warning.hasPrefix("Scout will run commands, file edits and routine proposals without waiting for approval cards."))
        XCTAssertTrue(warning.contains("destructive actions and credential files"))
        XCTAssertTrue(warning.contains("webhook or alert while you are away"))
        XCTAssertTrue(warning.contains("Actions that control This Mac still ask."))
        XCTAssertFalse(warning.contains("small or unrecognized model"))
        XCTAssertTrue(BotExecutionPolicy.bypassSummary(isOn: false).contains("This Mac still ask"))
        XCTAssertTrue(BotExecutionPolicy.bypassSummary(isOn: true).contains("except actions that control This Mac"))
    }

    func testAHighRiskModelGetsTheDesktopsExtraWarning() {
        let haiku = BotExecutionPolicy.bypassWarning(botName: "Scout", model: "claude-haiku-4")
        XCTAssertTrue(haiku.contains("claude-haiku-4 is a small or unrecognized model"))
        let unknown = BotExecutionPolicy.bypassWarning(botName: "Scout", model: "  ")
        XCTAssertTrue(unknown.contains("This bot's model is a small or unrecognized model"))
    }

    func testModelRiskFollowsTheDesktopsPatterns() {
        for risky in ["claude-haiku-4-5", "gpt-4o-mini", "gemini-2.5-flash-lite", "Llama-3.1-8B", "qwen-14b", "o4-nano", "GPT-3.5-turbo", ""] {
            XCTAssertTrue(BypassModelRisk.isHighRisk(model: risky), risky)
        }
        for sturdy in ["claude-sonnet-4-5", "claude-opus-4", "gpt-4o", "deepseek-r1", "grok-3", "MiniMax-M3"] {
            XCTAssertFalse(BypassModelRisk.isHighRisk(model: sturdy), sturdy)
        }
        XCTAssertTrue(BypassModelRisk.isHighRisk(model: nil))
    }
}
