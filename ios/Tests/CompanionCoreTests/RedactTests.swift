import XCTest
@testable import CompanionCore

/// Swift port of the `shared/redact.test.ts` contract, plus XCTest cases for
/// every other redaction rule in `shared/redact.ts`.
///
/// Secret-shaped samples are assembled at runtime from parts, so no
/// token-shaped literal sits in the source. Each expectation below was
/// checked against the TypeScript implementation before it was encoded.
final class RedactTests: XCTestCase {

    // MARK: - Provider table

    /// The shapes added for S13, with the shortest value that must still mask.
    private var providerCases: [(label: String, prefix: String, sample: String)] {
        [
            ("generic access key", "ak_", "ak" + "_" + "test" + "_" + String(repeating: "0", count: 16)),
            ("webhook signing secret", "whsec_", "wh" + "sec_" + "test" + "_" + "fake"),
            ("stripe live key", "sk_live_", "sk" + "_live_" + String(repeating: "0", count: 14)),
            ("stripe test key", "sk_test_", "sk" + "_test_" + String(repeating: "0", count: 14)),
            ("google oauth access token", "ya29.", "ya29" + "." + "fake"),
            ("gitlab personal access token", "glpat-", "glpat" + "-" + "fake0000"),
            ("infisical service token", "st.", "st" + "." + "fake" + String(repeating: "0", count: 19)),
        ]
    }

    func testMasksProviderSampleWhereverItAppears() {
        for c in providerCases {
            XCTAssertTrue(c.sample.hasPrefix(c.prefix), c.label)
            let out = Redact.redactSecretsInText("the request failed carrying \(c.sample) in the header")
            XCTAssertFalse(out.contains(c.sample), "\(c.label) leaked: \(out)")
            XCTAssertTrue(out.contains("«redacted \(c.sample.utf16.count) chars»"), "\(c.label): \(out)")
        }
    }

    func testLeavesPlainProseAlone() {
        let prose = "the deployment finished and the invoice went out by email"
        XCTAssertEqual(Redact.redactSecretsInText(prose), prose)
    }

    func testMasksDottedInfisicalTokenWhole() {
        // Infisical issues `st.<uuid>.<segment>.<segment>`: masking only the
        // first segment would leave the two secret segments in the clear.
        let token = ["st", ".", "11111111-2222-3333-4444-555555555555", ".", "abcdefabcdefabcdefabcdefabcdefab", ".", "0123456789abcdef0123456789abcdef"].joined()
        let out = Redact.redactSecretsInText("the header carried \(token) to the vault")
        XCTAssertFalse(out.contains("abcdefabcdefabcdefabcdefabcdefab"))
        XCTAssertFalse(out.contains("0123456789abcdef0123456789abcdef"))
        XCTAssertFalse(out.contains(token))
        XCTAssertTrue(out.contains("«redacted"))
    }

    func testDoesNotSwallowOrdinaryWordAfterDottedPhrase() {
        let prose = "the st. credential was rotated by the operator"
        XCTAssertEqual(Redact.redactSecretsInText(prose), prose)
    }

    func testLeavesBarePrefixMentionsAlone() {
        for prose in [
            "copy the whsec_ value from the dashboard",
            "the ya29. prefix is what google issues",
            "set sk_live_ to your restricted key",
        ] {
            XCTAssertEqual(Redact.redactSecretsInText(prose), prose, prose)
        }
    }

    // MARK: - The exported pattern list

    func testCredentialTokenPatternsAreNonEmptyAndGlobal() {
        XCTAssertGreaterThan(Redact.credentialTokenPatterns.count, 0)
        XCTAssertEqual(Redact.credentialTokenPatterns.count, Redact.credentialTokenPatternSources.count)
        // Global: every occurrence is replaced, not just the first.
        let sample = "sk" + "-" + "ant" + "-" + String(repeating: "0", count: 16)
        let out = Redact.redactSecretsInText("first \(sample) then \(sample) again ok here")
        XCTAssertFalse(out.contains(sample))
        XCTAssertEqual(out.components(separatedBy: "«redacted \(sample.utf16.count) chars»").count - 1, 2)
    }

    func testEveryProviderSampleMatchesAnExportedPattern() {
        for c in providerCases {
            let covered = Redact.credentialTokenPatterns.contains {
                $0.firstMatch(in: c.sample, range: NSRange(c.sample.startIndex..<c.sample.endIndex, in: c.sample)) != nil
            }
            XCTAssertTrue(covered, "no exported shape matches the \(c.label) value")
        }
    }

    // MARK: - Short strings and floors

    func testShortStringsPassThroughUnchanged() {
        XCTAssertEqual(Redact.redactSecretsInText(""), "")
        XCTAssertEqual(Redact.redactSecretsInText("short"), "short")
        XCTAssertEqual(Redact.redactSecretsInText("1234567"), "1234567")
    }

    func testKeepsNpmPrefixBelowFloor() {
        let short = "npm_" + String(repeating: "g", count: 19)
        XCTAssertEqual(Redact.redactSecretsInText(short + " tail ok!"), short + " tail ok!")
        let full = "npm_" + String(repeating: "g", count: 20)
        XCTAssertEqual(Redact.redactSecretsInText(full + " tail ok!"), "«redacted \(full.utf16.count) chars» tail ok!")
    }

    // MARK: - Vendor token shapes

    func testMasksOtherVendorShapes() {
        let samples = [
            "sk" + "-ant-" + String(repeating: "0", count: 16),
            "xai-" + String(repeating: "1", count: 22),
            "gsk_" + String(repeating: "f", count: 40),
            "hf_" + String(repeating: "a", count: 30),
            "ghp_" + String(repeating: "b", count: 20),
            "github_pat_" + String(repeating: "c", count: 20),
            "xoxb-" + String(repeating: "d", count: 20),
            "AKIA" + String(repeating: "E", count: 16),
            "AIza" + String(repeating: "F", count: 30),
        ]
        for sample in samples {
            let out = Redact.redactSecretsInText("carrying \(sample) home ok")
            XCTAssertFalse(out.contains(sample), sample)
            XCTAssertTrue(out.contains("«redacted \(sample.utf16.count) chars»"), sample)
        }
    }

    func testMasksJwtAndClippedJwt() {
        let header = "eyJ" + "hbGciOiJIUzI1NiJ9"
        let payload = "cGF5bG9hZDExMTExMTExMQ"
        let signature = "c2lnbmF0dXJlMjIyMjIyMjI"
        let full = header + "." + payload + "." + signature
        let out = Redact.redactSecretsInText("jwt \(full) end")
        XCTAssertFalse(out.contains(payload))
        XCTAssertFalse(out.contains(signature))
        XCTAssertTrue(out.contains("«redacted \(full.utf16.count) chars»"))
        // A token clipped to two segments still masks: the third segment is
        // optional on purpose.
        let clipped = header + "." + payload
        let clippedOut = Redact.redactSecretsInText("jwt clipped \(clipped) end")
        XCTAssertFalse(clippedOut.contains(payload))
        XCTAssertTrue(clippedOut.contains("«redacted \(clipped.utf16.count) chars»"))
    }

    // MARK: - Bearer tokens

    func testMasksTwelveCharBearerToken() {
        let tok = String(repeating: "p", count: 12)
        XCTAssertEqual(
            Redact.redactSecretsInText("see Bearer \(tok) now ok!"),
            "see Bearer «redacted 12 chars» now ok!"
        )
    }

    func testKeepsElevenCharBearerToken() {
        let tok = String(repeating: "q", count: 11)
        XCTAssertEqual(
            Redact.redactSecretsInText("see Bearer \(tok) now ok!"),
            "see Bearer \(tok) now ok!"
        )
    }

    func testAuthorizationHeaderOwnsBearerScheme() {
        // The header pass runs before the Bearer pass, so a bare header value
        // runs to the end of the line instead of stopping at the token.
        let tok = String(repeating: "Z", count: 24)
        XCTAssertEqual(
            Redact.redactSecretsInText("authorization: bearer \(tok) end"),
            "authorization: bearer «redacted 28 chars»"
        )
    }

    // MARK: - Authorization headers

    func testBareAuthorizationHeaderMasksToEndOfLine() {
        let tok = String(repeating: "k", count: 20)
        XCTAssertEqual(
            Redact.redactSecretsInText("Authorization: Basic \(tok) done"),
            "Authorization: Basic «redacted 25 chars»"
        )
    }

    func testQuotedAuthorizationHeaderKeepsSchemeAndSiblings() {
        let tok = String(repeating: "k", count: 20)
        XCTAssertEqual(
            Redact.redactSecretsInText("{\"authorization\": \"Basic \(tok)\", \"status\": \"ok\"}"),
            "{\"authorization\": \"Basic «redacted 20 chars»\", \"status\": \"ok\"}"
        )
    }

    func testCurlWrapperCutsAtClosingQuote() {
        let tok = String(repeating: "T", count: 24)
        XCTAssertEqual(
            Redact.redactSecretsInText("curl -H \"Authorization: Basic \(tok)\" https://example.com ok"),
            "curl -H \"Authorization: Basic «redacted \(tok.utf16.count) chars»\" https://example.com ok"
        )
    }

    func testFoldedDigestHeaderMasksWholeContinuation() {
        let sig = String(repeating: "S", count: 344)
        XCTAssertEqual(
            Redact.redactSecretsInText("Authorization: Digest\n  username=u1, response=\(sig)"),
            "Authorization: Digest\n  «redacted 366 chars»"
        )
    }

    // MARK: - Key=value shapes

    func testMasksKeyValuePairs() {
        let value = String(repeating: "m", count: 16)
        XCTAssertEqual(
            Redact.redactSecretsInText("api_key=\(value) rest"),
            "api_key=«redacted 16 chars» rest"
        )
    }

    func testMasksClippedKeyValueAtEndOfText() {
        // The closing quote was lost to a clip upstream; the unterminated
        // variant anchors at end-of-text and masks anyway.
        let value = String(repeating: "z", count: 300)
        XCTAssertEqual(
            Redact.redactSecretsInText("{\"api_key\":\"\(value)\"}"),
            "{\"api_key\":\"«redacted 300 chars»\"}"
        )
    }

    func testKeyAloneIsNotASecretName() {
        // `keyboard`, `hotkey`, `monkey` all contain `key` without being one.
        XCTAssertEqual(
            Redact.redactSecretsInText("hotkey=ctrl-x should stay visible ok!"),
            "hotkey=ctrl-x should stay visible ok!"
        )
        XCTAssertEqual(
            Redact.redactSecretsInText("the keyboard shortcut is ctrl-k for secrets"),
            "the keyboard shortcut is ctrl-k for secrets"
        )
        XCTAssertEqual(
            Redact.redactSecretsInText("monkey=notakeyatall see here ok"),
            "monkey=notakeyatall see here ok"
        )
    }

    // MARK: - PEM blocks

    func testMasksPemBlockKeepingFrame() {
        // Assembled from parts so no key-block literal sits in the source.
        let body = "MIIE " + "realsupersecretkeymaterial"
        let input = "-----BEGIN RSA" + " PRIVATE KEY-----\n" + body + "\n-----END RSA" + " PRIVATE KEY-----"
        XCTAssertEqual(
            Redact.redactSecretsInText(input),
            "-----BEGIN RSA" + " PRIVATE KEY-----\n«redacted 31 chars»\n-----END RSA" + " PRIVATE KEY-----"
        )
    }

    func testMasksClippedPemBlockWithoutEnd() {
        // Assembled from parts so no key-block literal sits in the source.
        let body = "clippedwithoutend" + "0123456789abcdef"
        let input = "-----BEGIN EC" + " PRIVATE KEY-----\n" + body
        XCTAssertEqual(
            Redact.redactSecretsInText(input),
            "-----BEGIN EC" + " PRIVATE KEY-----\n«redacted 33 chars»"
        )
    }

    // MARK: - Placeholders, status sentences, and idempotence

    func testLeavesDocumentationPlaceholderAlone() {
        XCTAssertEqual(
            Redact.redactSecretsInText("Use Authorization: Basic token."),
            "Use Authorization: Basic token."
        )
    }

    func testLeavesTrueStatusSentenceAlone() {
        XCTAssertEqual(
            Redact.redactSecretsInText("Authorization: no value"),
            "Authorization: no value"
        )
    }

    func testMasksNonStatusSentenceAfterScheme() {
        // "today" and "man" are not status words, so this is a credential
        // with a scheme, not a status sentence.
        XCTAssertEqual(
            Redact.redactSecretsInText("Authorization: not provided today man"),
            "Authorization: not «redacted 18 chars»"
        )
    }

    func testShortSchemeLowersLengthFloor() {
        XCTAssertEqual(
            Redact.redactSecretsInText("Authorization: Basic dGVzdA=="),
            "Authorization: Basic «redacted 8 chars»"
        )
        XCTAssertEqual(
            Redact.redactSecretsInText("Authorization: Basic configured"),
            "Authorization: Basic «redacted 10 chars»"
        )
    }

    func testSecondPassKeepsReportedLength() {
        let once = Redact.redactSecretsInText("Authorization: Basic " + String(repeating: "k", count: 20) + " done")
        XCTAssertEqual(Redact.redactSecretsInText(once), once)
    }

    // MARK: - The tree walk

    func testTreeRedactionMasksSecretShapedKeys() {
        let out = Redact.redactSecrets(["AK": "supersecretvalue", "keyboard": "ctrl-k here ok"]) as? [String: Any]
        XCTAssertEqual(out?["AK"] as? String, "supersecretvalue")
        XCTAssertEqual(out?["keyboard"] as? String, "ctrl-k here ok")
        let nested = Redact.redactSecrets(["nested": ["api_key": "anothersecret123"]]) as? [String: Any]
        let inner = nested?["nested"] as? [String: Any]
        XCTAssertEqual(inner?["api_key"] as? String, "«redacted 16 chars»")
    }

    func testTreeRedactionOfEnvEntries() {
        let input: [[String: String]] = [
            ["name": "OMB_COMMS_TOKEN", "value": "supersecret123456"],
            ["name": "FEATURE_FLAG", "value": "plain-enough-value-ok"],
        ]
        let out = Redact.redactSecrets(input) as? [[String: String]]
        XCTAssertEqual(out?[0]["value"], "«redacted 17 chars»")
        XCTAssertEqual(out?[1]["value"], "plain-enough-value-ok")
    }

    func testTreePassesThroughScalars() {
        XCTAssertEqual(Redact.redactSecrets(42) as? Int, 42)
        XCTAssertNil(Redact.redactSecrets(nil))
    }

    func testRedactSecretsWithCustomPass() {
        let out = Redact.redactSecretsWith(
            ["api_key": "keepme-visible-00", "note": "hello world ok!"],
            text: { "[\($0)]" }
        ) as? [String: Any]
        // Secret-shaped keys are masked outright, never through the custom pass.
        XCTAssertEqual(out?["api_key"] as? String, "«redacted 17 chars»")
        XCTAssertEqual(out?["note"] as? String, "[hello world ok!]")
    }

    // MARK: - The log tee cap

    func testLogTeeMaxStringCharsValue() {
        XCTAssertEqual(Redact.logTeeMaxStringChars, 256 * 1024)
    }

    func testLogTextRedactsThenCuts() {
        let head = "log " + String(repeating: "L", count: 60)
        XCTAssertEqual(
            Redact.redactSecretsInLogText("log " + String(repeating: "L", count: 200) + " end", maxChars: 64),
            head + "[… 144 characters elided from log]"
        )
    }

    func testLogTextLeavesShortStringsOnNormalPath() {
        XCTAssertEqual(Redact.redactSecretsInLogText("tiny ok", maxChars: 64), "tiny ok")
    }

    func testForLogCapsTreeStrings() {
        let long = "log " + String(repeating: "L", count: 200) + " end"
        let out = Redact.redactSecretsForLog(["line": long], maxChars: 64) as? [String: Any]
        let line = out?["line"] as? String ?? ""
        XCTAssertTrue(line.contains("characters elided from log"), line)
        XCTAssertFalse(line.contains(String(repeating: "L", count: 200)))
    }
}
