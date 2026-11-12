// What the phone believes about a computer's voice providers, and what it
// says when one is missing.
//
// The distinction these protect: "the computer says this provider has no
// key" and "the computer did not tell me" are different facts.  Collapsing
// them sends someone to Settings to add a key they already have.
import XCTest
@testable import CompanionCore

final class StsStatusTests: XCTestCase {

    // MARK: - Unknown is not false

    func testAbsentFieldsStayUnknownRatherThanFalse() {
        let status = StsStatus()
        XCTAssertFalse(status.isKnown)
        XCTAssertNil(status.isConfigured("xai"))
        XCTAssertNil(status.usableProvider)
    }

    func testAnUnknownStatusOffersNoProvider() {
        // A harness older than the route answers nothing. Offering a call
        // here would be offering one that cannot start.
        XCTAssertNil(StsStatus().usableProvider)
    }

    func testAPartialStatusIsStillKnown() {
        // Only one provider is reported. That is enough to offer that one,
        // and it is not the same as having no information at all.
        let status = StsStatus(xai: false, gemini: true)
        XCTAssertTrue(status.isKnown)
        XCTAssertEqual(status.usableProvider, "gemini")
    }

    // MARK: - Choice mirrors the computer

    func testUsesTheProviderTheComputerChose() {
        let status = StsStatus(xai: true, gemini: true, provider: "gemini")
        XCTAssertEqual(status.usableProvider, "gemini")
    }

    func testIgnoresAChosenProviderThatHasNoKey() {
        // The computer can be asked for a provider it has no key for. The
        // phone must not then claim that provider is ready.
        let status = StsStatus(xai: false, gemini: true, provider: "xai")
        XCTAssertEqual(status.usableProvider, "gemini")
    }

    func testFallsBackInProviderOrderWhenAuto() {
        XCTAssertEqual(StsStatus(xai: true, gemini: true).usableProvider, "xai")
        XCTAssertEqual(StsStatus(xai: false, gemini: true).usableProvider, "gemini")
        XCTAssertEqual(StsStatus(xai: true, gemini: false).usableProvider, "xai")
        XCTAssertNil(StsStatus(xai: false, gemini: false).usableProvider)
    }

    func testIgnoresAProviderNameItDoesNotImplement() {
        // An unknown name falls through to the normal order rather than being
        // offered as if it were real.
        let status = StsStatus(xai: false, gemini: true, provider: "openai")
        XCTAssertEqual(status.usableProvider, "gemini")
        XCTAssertNil(status.isConfigured("openai"))
    }

    // MARK: - Wire shape

    func testDecodesWhatTheHarnessSends() throws {
        let json = #"{"xai":true,"gemini":false,"provider":"xai"}"#
        let status = try JSONDecoder().decode(StsStatus.self, from: Data(json.utf8))
        XCTAssertEqual(status.xai, true)
        XCTAssertEqual(status.gemini, false)
        XCTAssertEqual(status.provider, "xai")
        XCTAssertEqual(status.usableProvider, "xai")
    }

    func testDecodesAnEmptyStatusWithoutFailing() throws {
        // A Mac too old to answer. It has to decode, not throw, or every
        // status read becomes an error the user has to dismiss.
        let status = try JSONDecoder().decode(StsStatus.self, from: Data("{}".utf8))
        XCTAssertFalse(status.isKnown)
    }

    func testDecodesTheSessionToken() throws {
        let json = #"{"token":"ephemeral","expiresInSeconds":300}"#
        let token = try JSONDecoder().decode(StsSessionToken.self, from: Data(json.utf8))
        XCTAssertEqual(token.token, "ephemeral")
        XCTAssertEqual(token.expiresInSeconds, 300)
    }
}