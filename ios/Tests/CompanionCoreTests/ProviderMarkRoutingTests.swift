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

    func testTheAnnouncedIdentityStaysWithTheHarness() {
        // The artwork names the engine that answers and the name names the
        // harness that carries it.  A MiniMax model under the DeepSeek
        // Harness wears the MiniMax mark, but it is still a Clutch session,
        // and the web surface announces the engine's registered name and only
        // swaps the mark.
        XCTAssertEqual(
            ProviderMarkRouting.resolvedLabelDriverKind(for: "dshAgent", model: "MiniMax-M3.1-Flash"),
            "dshAgent"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedLabelDriverKind(for: "dsh", model: "minimax-m2"),
            "dsh"
        )
        // A DeepSeek model on the same harness names the same thing.
        XCTAssertEqual(
            ProviderMarkRouting.resolvedLabelDriverKind(for: "dshAgent", model: "deepseek-chat"),
            "dshAgent"
        )
        // Every other driver keeps the model routing for both halves:  there
        // the engine itself is the identity, and nothing splits.
        XCTAssertEqual(
            ProviderMarkRouting.resolvedLabelDriverKind(for: "grok", model: "claude-sonnet-5"),
            "claude"
        )
        XCTAssertEqual(
            ProviderMarkRouting.resolvedLabelDriverKind(for: "codex", model: nil),
            "codex"
        )
    }

    func testTheAnnouncedNameStaysWithTheHarness() {
        // The name is what a person hears, so it is the harness:  a MiniMax
        // model under the DeepSeek Harness wears the MiniMax mark and is
        // announced as Clutch, exactly as the web surface announces the
        // engine's registered name and only swaps the mark.
        XCTAssertEqual(
            ProviderMarkRouting.displayName(for: "dshAgent", model: "MiniMax-M3.1-Flash"),
            "Clutch"
        )
        XCTAssertEqual(
            ProviderMarkRouting.displayName(for: "dsh", model: "minimax-m2"),
            "Clutch"
        )
        // A MiniMax session on MiniMax still announces as MiniMax.
        XCTAssertEqual(
            ProviderMarkRouting.displayName(for: "minimax", model: "MiniMax-M2"),
            "MiniMax"
        )
        XCTAssertEqual(
            ProviderMarkRouting.displayName(for: "mcodeAgent", model: nil),
            "MiniMax Code"
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
