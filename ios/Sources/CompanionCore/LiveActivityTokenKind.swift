/// Which Live Activity token is being registered.
///
/// These two are genuinely different credentials, not two names for one
/// thing.  A push-to-start token is per device, is minted whether or not an
/// activity is running, and is the only credential that can start an activity
/// while the app is dead.  An update token is minted per activity, rotates,
/// and can only update or end that one activity.
///
/// The sidecar stores one token per device today, so posting an update token
/// there would overwrite the push-to-start token with one APNs cannot use to
/// start anything — turning a working feature into a silent one.  Until it
/// stores both, only `.pushToStart` is posted.
public enum LiveActivityTokenKind: String, Codable, Sendable {
    case pushToStart = "push-to-start"
    case update = "update"
}