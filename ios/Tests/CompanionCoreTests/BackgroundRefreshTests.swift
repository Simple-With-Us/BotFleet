import XCTest
@testable import CompanionCore

private actor RefreshOrder {
    private(set) var steps: [String] = []

    func append(_ step: String) { steps.append(step) }
}

final class BackgroundRefreshTests: XCTestCase {
    func testSuccessCompletesAfterRefreshAndReportsNewData() async {
        let order = RefreshOrder()

        let result = await BackgroundRefreshCoordinator.run(timeoutNanoseconds: 1_000_000_000) {
            await order.append("started")
            try await Task.sleep(nanoseconds: 10_000_000)
            await order.append("hydrated")
            return true
        }
        await order.append("completed")

        XCTAssertEqual(result, .newData)
        let steps = await order.steps
        XCTAssertEqual(steps, ["started", "hydrated", "completed"])
    }

    func testUnchangedRefreshReportsNoData() async {
        let result = await BackgroundRefreshCoordinator.run(timeoutNanoseconds: 1_000_000_000) {
            false
        }

        XCTAssertEqual(result, .noData)
    }

    func testRefreshFailureReportsFailed() async {
        let result = await BackgroundRefreshCoordinator.run(timeoutNanoseconds: 1_000_000_000) {
            throw URLError(.cannotConnectToHost)
        }

        XCTAssertEqual(result, .failed)
    }

    func testRefreshTimeoutReportsFailed() async {
        let order = RefreshOrder()
        let result = await BackgroundRefreshCoordinator.run(timeoutNanoseconds: 5_000_000) {
            await order.append("started")
            try await Task.sleep(nanoseconds: 1_000_000_000)
            await order.append("hydrated")
            return true
        }

        XCTAssertEqual(result, .failed)
        let steps = await order.steps
        XCTAssertEqual(steps, ["started"])
    }

    func testBackgroundDeliveryCannotProduceNavigationTarget() {
        let payload: [AnyHashable: Any] = [
            "botId": "bot-1",
            "threadId": "task-2",
        ]

        XCTAssertNil(NotificationTarget.navigationTarget(
            fromRemoteUserInfo: payload,
            source: .backgroundDelivery
        ))
        XCTAssertEqual(
            NotificationTarget.navigationTarget(fromRemoteUserInfo: payload, source: .userResponse),
            NotificationTarget(botId: "bot-1", threadId: "task-2")
        )
    }
}
