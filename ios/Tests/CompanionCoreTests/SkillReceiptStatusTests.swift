import XCTest
@testable import CompanionCore

final class SkillReceiptStatusTests: XCTestCase {
    func testDoneOnlyWhenTheStatusIsSuccess() {
        XCTAssertEqual(SkillReceiptStatus("success"), .success)
        XCTAssertEqual(SkillReceiptStatus("SUCCESS").label, "Done")
        XCTAssertEqual(SkillReceiptStatus("  succeeded  "), .success)
        XCTAssertEqual(SkillReceiptStatus("succeeded").label, "Done")
    }

    func testFailedOnlyWhenTheStatusFailedOrErrored() {
        for raw in ["error", "failed", "failure", "errored", "FAILED"] {
            XCTAssertEqual(SkillReceiptStatus(raw), .failure, raw)
            XCTAssertEqual(SkillReceiptStatus(raw).label, "Failed", raw)
        }
    }

    func testCancelledOrStoppedIsNeutral() {
        for raw in ["cancelled", "canceled", "stopped", "Cancelled"] {
            XCTAssertEqual(SkillReceiptStatus(raw), .stopped, raw)
            XCTAssertEqual(SkillReceiptStatus(raw).label, "Stopped", raw)
        }
    }

    func testPendingEmptyAndUnknownStayRunning() {
        for raw in ["", "   ", "pending", "queued", "running", "in_progress", "in progress", "completed", "ok", "unknown"] {
            XCTAssertEqual(SkillReceiptStatus(raw), .running, raw)
            XCTAssertEqual(SkillReceiptStatus(raw).label, "Running", raw)
        }
    }

    func testToolStepWordsStillMap() {
        XCTAssertEqual(SkillReceiptStatus(ToolStepStatus(ok: true).receiptStatus), .success)
        XCTAssertEqual(SkillReceiptStatus(ToolStepStatus(ok: false).receiptStatus), .failure)
        XCTAssertEqual(SkillReceiptStatus(ToolStepStatus(ok: nil).receiptStatus), .running)
    }
}
