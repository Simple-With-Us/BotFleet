// Whether a push-token registration POST is worth sending again.
//
// iOS calls `didRegisterForRemoteNotificationsWithDeviceToken` roughly once
// per launch, handing back the same token almost every time — so posting
// it unconditionally (`CompanionApp.swift`'s `onDeviceToken`) means every
// launch is a POST the sidecar already has the answer to.  See IO17.  Kept
// pure and separate from `Session` so the dedupe decision is testable
// without a live connection.
import Foundation

/// What was last posted to the paired companion, so a later launch can
/// tell whether posting again is worth it.
public struct PostedPushToken: Codable, Equatable, Sendable {
    public let token: String
    /// The paired endpoint's URL at the time of posting.  Included because
    /// the same token is meaningless to a *different* Mac — re-pairing (or
    /// the active route changing to a new endpoint) must re-post even
    /// though the token itself did not change.
    public let endpointURL: String?

    public init(token: String, endpointURL: String?) {
        self.token = token
        self.endpointURL = endpointURL
    }
}

public enum PushTokenRegistration {
    /// `true` when `candidate` is worth posting: nothing has been posted
    /// yet, or either the token or the paired endpoint changed since the
    /// last successful post.
    public static func shouldPost(_ candidate: PostedPushToken, lastPosted: PostedPushToken?) -> Bool {
        candidate != lastPosted
    }
}
