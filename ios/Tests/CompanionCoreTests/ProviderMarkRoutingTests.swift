import XCTest
@testable import CompanionCore

/// Pins the iOS provider-mark lookup beside the web `ProviderMark` tests so a
/// model id cannot route to a different engine's artwork on one surface.
final class ProviderMarkRoutingTests: XCTestCase {
    func testHarnessDriversKeepIdentityDespiteModelKeywords() {
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "dshAgent", model: "MiniMax-M3.1-Flash"),
            "dshAgent"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "mcodeAgent", model: "claude-sonnet-5"),
            "mcodeAgent"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "antigravityAgent", model: "gemini-2.5-pro"),
            "antigravityAgent"
        )
    }

    func testModelNameRoutesWhenDriverIsGeneric() {
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "grok", model: "claude-sonnet-5"),
            "claude"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "openai-compat", model: "gpt-5.2"),
            "openai"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "grokAgent", model: "deepseek-chat"),
            "deepseek"
        )
    }

    func testNilModelPreservesDriverKind() {
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "codex", model: nil),
            "codex"
        )
    }
}
