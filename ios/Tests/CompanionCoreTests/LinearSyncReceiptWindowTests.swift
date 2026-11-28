// The receipt window of `LinearSyncClient` (BF-2696): a host that runs for
// weeks holds a bounded number of completed mutations, and a replay inside
// the window still returns its receipt without a second mutation.
import Foundation
import Testing
@testable import CompanionCore

// MARK: - Test Double for Linear

private actor ReceiptWindowTransport: LinearGraphQLTransport {
    var executedRequests: [LinearGraphQLRequest] = []

    func execute(_ request: LinearGraphQLRequest, apiKey: String) async throws -> [String: String] {
        executedRequests.append(request)
        return ["ok": "true"]
    }

    func workflowStateId(named stateName: String, apiKey: String) async throws -> String {
        "state-uuid-\(stateName.lowercased().replacingOccurrences(of: " ", with: "-"))"
    }

    func requests() -> [LinearGraphQLRequest] {
        executedRequests
    }
}

// MARK: - BF-2696

@Suite("LinearSyncClient receipt window (BF-2696)")
struct LinearSyncReceiptWindowTests {
    @Test("LinearSyncClient keeps a bounded window of completed receipts and replays only inside it")
    func receiptWindowIsBounded() async throws {
        let transport = ReceiptWindowTransport()
        let client = try LinearSyncClient(
            seat: "ag",
            sessionId: "sess42",
            // assembled here so the fixture is not a credential-shaped literal
            apiKey: ["lin", "api", "test"].joined(separator: "_"),
            transport: transport,
            receiptCapacity: 3
        )

        // five mutations through a window of three
        for index in 0..<5 {
            _ = try await client.comment(
                issueId: "BF-\(index)",
                body: "note \(index)",
                idempotencyKey: "window-\(index)"
            )
        }
        #expect(await transport.requests().count == 5)
        #expect(await client.retainedReceiptCount == 3)

        // the newest receipt still replays without a second mutation
        let newest = try await client.comment(issueId: "BF-4", body: "note 4", idempotencyKey: "window-4")
        #expect(newest.wasDeduplicated)
        #expect(await transport.requests().count == 5)

        // the oldest has left the window, so its key posts again and takes
        // the place at the back of the order
        let requeued = try await client.comment(issueId: "BF-0", body: "note 0", idempotencyKey: "window-0")
        #expect(requeued.wasDeduplicated == false)
        #expect(await transport.requests().count == 6)
        #expect(await client.retainedReceiptCount == 3)

        // the window holds 3, 4 and 0 now: 3 still replays, and 2 has left it
        let third = try await client.comment(issueId: "BF-3", body: "note 3", idempotencyKey: "window-3")
        #expect(third.wasDeduplicated)
        let second = try await client.comment(issueId: "BF-2", body: "note 2", idempotencyKey: "window-2")
        #expect(second.wasDeduplicated == false)
        #expect(await transport.requests().count == 7)
    }

    @Test("The default window is bounded and holds more than a session's worth of mutations")
    func defaultWindowIsBounded() async throws {
        #expect(LinearSyncClient.defaultReceiptCapacity == 1_000)
        let transport = ReceiptWindowTransport()
        let client = try LinearSyncClient(
            seat: "ag",
            sessionId: "sess42",
            apiKey: ["lin", "api", "test"].joined(separator: "_"),
            transport: transport
        )
        for index in 0..<(LinearSyncClient.defaultReceiptCapacity + 25) {
            _ = try await client.comment(issueId: "BF-\(index)", body: "note", idempotencyKey: "key-\(index)")
        }
        #expect(await client.retainedReceiptCount == LinearSyncClient.defaultReceiptCapacity)
        // the newest key is inside the window and the oldest is not
        let last = LinearSyncClient.defaultReceiptCapacity + 24
        let inside = try await client.comment(issueId: "BF-\(last)", body: "note", idempotencyKey: "key-\(last)")
        #expect(inside.wasDeduplicated)
        let outside = try await client.comment(issueId: "BF-0", body: "note", idempotencyKey: "key-0")
        #expect(outside.wasDeduplicated == false)
    }
}
