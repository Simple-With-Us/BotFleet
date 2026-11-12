// Values the tests share and that must never be mistaken for anything real.
import Foundation

enum TestFixtures {
    /// A stand-in device token for stubbed requests.  It authorizes nothing: no
    /// harness or sidecar ever sees it, only a `URLProtocol` stub.
    static let fakeCompanionToken = "fake-test-token"
}
