// Whether re-posting the APNs device token is worth doing (IO17).
import XCTest
@testable import CompanionCore

final class PushTokenRegistrationTests: XCTestCase {
    func testFirstEverPostIsAlwaysWorthSending() {
        let candidate = PostedPushToken(token: "abc", endpointURL: "https://mac.companion.example")
        XCTAssertTrue(PushTokenRegistration.shouldPost(candidate, lastPosted: nil))
    }

    func testIdenticalTokenAndEndpointIsNotRepostedOnTheNextLaunch() {
        let posted = PostedPushToken(token: "abc", endpointURL: "https://mac.companion.example")
        XCTAssertFalse(PushTokenRegistration.shouldPost(posted, lastPosted: posted))
    }

    func testAChangedTokenIsPostedEvenWithTheSameEndpoint() {
        let lastPosted = PostedPushToken(token: "abc", endpointURL: "https://mac.companion.example")
        let candidate = PostedPushToken(token: "def", endpointURL: "https://mac.companion.example")
        XCTAssertTrue(PushTokenRegistration.shouldPost(candidate, lastPosted: lastPosted))
    }

    func testTheSameTokenIsRepostedAfterRePairingToADifferentEndpoint() {
        // The token itself did not change, but it is meaningless to a
        // different Mac — re-pairing must still re-post it.
        let lastPosted = PostedPushToken(token: "abc", endpointURL: "https://old-mac.companion.example")
        let candidate = PostedPushToken(token: "abc", endpointURL: "https://new-mac.companion.example")
        XCTAssertTrue(PushTokenRegistration.shouldPost(candidate, lastPosted: lastPosted))
    }

    func testANilEndpointIsTreatedConsistently() {
        let lastPosted = PostedPushToken(token: "abc", endpointURL: nil)
        XCTAssertFalse(PushTokenRegistration.shouldPost(
            PostedPushToken(token: "abc", endpointURL: nil),
            lastPosted: lastPosted
        ))
        XCTAssertTrue(PushTokenRegistration.shouldPost(
            PostedPushToken(token: "abc", endpointURL: "https://mac.companion.example"),
            lastPosted: lastPosted
        ))
    }
}
