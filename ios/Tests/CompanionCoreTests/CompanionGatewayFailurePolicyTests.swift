import XCTest
@testable import CompanionCore

final class CompanionGatewayFailurePolicyTests: XCTestCase {
    /// `CompanionEndpoint.init` is failable; every URL here is valid for its kind.
    private static func endpoint(_ url: String, _ kind: CompanionEndpointKind, _ priority: Int) -> CompanionEndpoint {
        guard let endpoint = CompanionEndpoint(url: url, kind: kind, priority: priority) else {
            preconditionFailure("invalid test endpoint \(url)")
        }
        return endpoint
    }

    private let paired = Connection(
        name: "Mac",
        host: "mac.companion.example",
        port: 443,
        activeEndpoint: CompanionGatewayFailurePolicyTests.endpoint("https://mac.companion.example", .hosted, 0),
        endpoints: [CompanionGatewayFailurePolicyTests.endpoint("https://mac.companion.example", .hosted, 0)],
        allowedRouteKinds: [.hosted]
    )

    private let pairedWithTailnet = Connection(
        name: "Mac",
        host: "mac.companion.example",
        port: 443,
        activeEndpoint: CompanionGatewayFailurePolicyTests.endpoint("https://mac.companion.example", .hosted, 0),
        endpoints: [
            CompanionGatewayFailurePolicyTests.endpoint("https://mac.companion.example", .hosted, 0),
            CompanionGatewayFailurePolicyTests.endpoint("http://mac.tail1234.ts.net:8810", .tailnet, 1)
        ],
        allowedRouteKinds: [.hosted, .tailnet]
    )

    private static let tunnelDown = ["cf-error-type": "1033"]

    func testRequiresTheCloudflare1033MarkerOnA530() {
        let cases: [([String: String]?, Bool)] = [
            (["cf-error-type": "1033"], true),
            (["CF-Error-Type": " 1033 "], true),
            (["cf-error-type": "1016"], false),
            (["cf-error-type": "1000"], false),
            (["server": "cloudflare"], false),
            ([:], false),
            (nil, false)
        ]
        for (headers, expected) in cases {
            XCTAssertEqual(
                CompanionGatewayFailurePolicy.shouldSuppress(
                    statusCode: 530,
                    responseHeaders: headers,
                    requestURL: "https://mac.companion.example/api/health",
                    pairedConnection: paired
                ),
                expected,
                "headers \(String(describing: headers))"
            )
        }
    }

    func testSuppressesTheTunnelOfflineStatusFromThePairedHostedGateway() {
        XCTAssertTrue(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                requestURL: "https://mac.companion.example/api/health",
                pairedConnection: paired
            )
        )
    }

    func testKeepsCompanionAndHarnessFaultsReportableOnAReachableGateway() {
        // The companion proxy answers 502 for its own faults and forwards the
        // harness's 503s; neither means the gateway is offline.
        for statusCode in [500, 501, 502, 503, 504, 599] {
            XCTAssertFalse(
                CompanionGatewayFailurePolicy.shouldSuppress(
                    statusCode: statusCode,
                    responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                    requestURL: "https://mac.companion.example/api/health",
                    pairedConnection: paired
                ),
                "Status \(statusCode) from the paired gateway must remain reportable"
            )
        }
    }

    func testPreservesTheOfflineStatusFromOtherHosts() {
        XCTAssertFalse(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                requestURL: "https://status.example/api/health",
                pairedConnection: paired
            )
        )
    }

    func testDirectTailnetRoutesNeverCarryTheTunnelSignal() {
        XCTAssertFalse(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                requestURL: "http://mac.tail1234.ts.net:8810/api/health",
                pairedConnection: pairedWithTailnet
            )
        )
        XCTAssertTrue(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                requestURL: "https://mac.companion.example/api/health",
                pairedConnection: pairedWithTailnet
            )
        )
    }

    func testRequiresAnExactPairedOriginIncludingPortAndScheme() {
        for requestURL in [
            "https://mac.companion.example:8443/api/health",
            "http://mac.companion.example/api/health",
            "https://sub.mac.companion.example/api/health"
        ] {
            XCTAssertFalse(
                CompanionGatewayFailurePolicy.shouldSuppress(
                    statusCode: 530,
                    responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                    requestURL: requestURL,
                    pairedConnection: paired
                ),
                "Unpaired origin \(requestURL) must remain reportable"
            )
        }
    }

    func testMissingConnectionOrMalformedURLDoesNotSuppress() {
        XCTAssertFalse(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                requestURL: "https://mac.companion.example/api/health",
                pairedConnection: nil
            )
        )
        XCTAssertFalse(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                responseHeaders: CompanionGatewayFailurePolicyTests.tunnelDown,
                requestURL: "not a url",
                pairedConnection: paired
            )
        )
    }
}
