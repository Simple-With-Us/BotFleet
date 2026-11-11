import XCTest
@testable import CompanionCore

final class ComposerPendingThumbnailCacheTests: XCTestCase {
    private static let onePixelPNG = Data(
        base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )!

    override func setUp() {
        super.setUp()
        ComposerPendingThumbnailCache.resetForTests()
    }

    func testDownsampleStaysWithinTheChipBudget() {
        let thumb = ComposerPendingThumbnailCache.downsample(
            data: Self.onePixelPNG,
            maxPixelSize: 72
        )
        XCTAssertNotNil(thumb)
        XCTAssertLessThanOrEqual(thumb?.cgImage.width ?? 0, 72)
        XCTAssertLessThanOrEqual(thumb?.cgImage.height ?? 0, 72)
    }

    func testThumbnailCachesAndReusesDecodedPixels() async {
        let attachment = PendingChatAttachment(name: "a.png", mime: "image/png", data: Self.onePixelPNG)
        let first = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        XCTAssertNotNil(first)
        let second = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        XCTAssertTrue(first === second)
    }

    func testRemoveEvictsAndBlocksAStoreDecision() async {
        let attachment = PendingChatAttachment(name: "gone.png", mime: "image/png", data: Self.onePixelPNG)
        _ = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        XCTAssertNotNil(ComposerPendingThumbnailCache.cachedThumbnail(for: attachment.id))
        ComposerPendingThumbnailCache.remove(id: attachment.id)
        XCTAssertNil(ComposerPendingThumbnailCache.cachedThumbnail(for: attachment.id))
        XCTAssertFalse(
            ComposerThumbnailCachePolicy.shouldStoreThumbnailInCache(
                attachmentId: attachment.id,
                isCancelled: false,
                droppedFromStrip: true
            )
        )
    }

    func testRemoveDuringDecodeDoesNotPopulateCache() async {
        let id = UUID()
        let attachment = PendingChatAttachment(id: id, name: "flight.png", mime: "image/png", data: Self.onePixelPNG)
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                _ = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 1_000)
                ComposerPendingThumbnailCache.remove(id: id)
            }
            await group.waitForAll()
        }
        XCTAssertNil(ComposerPendingThumbnailCache.cachedThumbnail(for: id))
    }

    func testAFailedSendRestoreMustReinstateBeforeThumbnailsCache() async {
        let attachment = PendingChatAttachment(name: "retry.png", mime: "image/png", data: Self.onePixelPNG)
        let id = attachment.id
        ComposerPendingThumbnailCache.remove(id: id)

        let blocked = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        XCTAssertNil(blocked)
        XCTAssertNil(ComposerPendingThumbnailCache.cachedThumbnail(for: id))

        ComposerPendingThumbnailCache.remove(id: id)
        ComposerPendingThumbnailCache.reinstate(id: id)
        let restored = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        XCTAssertNotNil(restored)
        XCTAssertNotNil(ComposerPendingThumbnailCache.cachedThumbnail(for: id))
    }

    func testReinstateLetsAThumbLoadAgainAfterReplacement() async {
        let attachment = PendingChatAttachment(name: "back.png", mime: "image/png", data: Self.onePixelPNG)
        ComposerPendingThumbnailCache.remove(id: attachment.id)
        ComposerPendingThumbnailCache.reinstate(id: attachment.id)
        let thumb = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        XCTAssertNotNil(thumb)
        XCTAssertNotNil(ComposerPendingThumbnailCache.cachedThumbnail(for: attachment.id))
    }

    func testCancelledTaskSkipsCachePopulation() async {
        let attachment = PendingChatAttachment(name: "slow.png", mime: "image/png", data: Self.onePixelPNG)
        let task = Task {
            await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        }
        task.cancel()
        _ = await task.value
        XCTAssertNil(ComposerPendingThumbnailCache.cachedThumbnail(for: attachment.id))
    }

    func testManyRemovesStayWithinTheTombstoneCap() {
        for _ in 0..<50 {
            ComposerPendingThumbnailCache.remove(id: UUID())
        }
        XCTAssertLessThanOrEqual(
            ComposerPendingThumbnailCache.tombstoneCountForTests(),
            32
        )
    }

    func testPruneDropsTombstonesThatNoLongerGuardAStripId() {
        let gone = UUID()
        ComposerPendingThumbnailCache.remove(id: gone)
        ComposerPendingThumbnailCache.pruneTombstones(keeping: [])
        XCTAssertEqual(ComposerPendingThumbnailCache.tombstoneCountForTests(), 0)
    }

    func testDecodeCompletionClearsItsTombstone() async {
        let attachment = PendingChatAttachment(name: "once.png", mime: "image/png", data: Self.onePixelPNG)
        _ = await ComposerPendingThumbnailCache.thumbnail(for: attachment, screenScale: 2)
        XCTAssertEqual(ComposerPendingThumbnailCache.tombstoneCountForTests(), 0)
    }

    func testOverlappingDecodesKeepGuardsUntilTheLastOneEnds() {
        let id = UUID()
        ComposerPendingThumbnailCache.beginDecodeForTests(id: id)
        ComposerPendingThumbnailCache.beginDecodeForTests(id: id)
        ComposerPendingThumbnailCache.remove(id: id)
        ComposerPendingThumbnailCache.endDecodeForTests(id: id)

        XCTAssertEqual(ComposerPendingThumbnailCache.inFlightDecodeCountForTests(id: id), 1)
        ComposerPendingThumbnailCache.pruneTombstones(keeping: [])
        XCTAssertGreaterThan(ComposerPendingThumbnailCache.tombstoneCountForTests(), 0)

        ComposerPendingThumbnailCache.endDecodeForTests(id: id)
        XCTAssertEqual(ComposerPendingThumbnailCache.inFlightDecodeCountForTests(id: id), 0)
        ComposerPendingThumbnailCache.pruneTombstones(keeping: [])
        XCTAssertEqual(ComposerPendingThumbnailCache.tombstoneCountForTests(), 0)
    }
}

final class ComposerThumbnailCachePolicyTests: XCTestCase {
    func testStaleDecodeIsDroppedWhenRowIdentityChanged() {
        let first = UUID()
        let second = UUID()
        XCTAssertFalse(
            ComposerThumbnailCachePolicy.shouldApplyThumbnailToRow(
                requestedId: first,
                rowId: second,
                isCancelled: false
            )
        )
    }

    func testRemovedAttachmentIsNotStoredInCache() {
        XCTAssertFalse(
            ComposerThumbnailCachePolicy.shouldStoreThumbnailInCache(
                attachmentId: UUID(),
                isCancelled: false,
                droppedFromStrip: true
            )
        )
    }
}
