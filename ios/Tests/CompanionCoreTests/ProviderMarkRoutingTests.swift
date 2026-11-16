import XCTest
@testable import CompanionCore

/// Pins the iOS provider-mark lookup beside the web `ProviderMark` tests so a
/// model id cannot route to a different engine's artwork on one surface.
final class ProviderMarkRoutingTests: XCTestCase {
    func testHarnessDriversKeepIdentityDespiteModelKeywords() {
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "mcodeAgent", model: "claude-sonnet-5"),
            "mcodeAgent"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "antigravityAgent", model: "gemini-2.5-pro"),
            "antigravityAgent"
        )
    }

    func testAMiniMaxModelOnTheDeepSeekHarnessRoutesToMiniMax() {
        // The harness that carries the model is not the engine that answers
        // it.  The DeepSeek Harness hosts MiniMax models, and a MiniMax
        // session wearing the DeepSeek logo names the wrong provider, which
        // is the bug this row reports.  The web `ProviderMark` routes the
        // same row to the MiniMax mark, so the two surfaces agree here.
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "dshAgent", model: "MiniMax-M3.1-Flash"),
            "minimax"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "dsh", model: "minimax-m2"),
            "minimax"
        )
        // A DeepSeek model on the same harness keeps the harness's own
        // identity, so the "deepseek" keyword still does not clobber it.
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "dshAgent", model: "deepseek-chat"),
            "dshAgent"
        )
        // And a harness with no model at all keeps its identity too.
        XCTAssertEqual(
            ProviderMarkRouting.resolvedDriverKind(for: "dshAgent", model: nil),
            "dshAgent"
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
