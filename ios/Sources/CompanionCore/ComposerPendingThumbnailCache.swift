import CoreGraphics
import Foundation
import ImageIO

/// Downsampled composer photo thumbnails, keyed by pending attachment id.
///
/// ImageIO decodes off the main actor.  Removals cancel in-flight work and
/// block a late decode from repopulating the cache after the strip drops an
/// attachment.
public enum ComposerPendingThumbnailCache {
    /// The chip draws the photo at 36 points.
    public static let pointSize: CGFloat = 36
    /// The composer holds eight attachments.  A few extra slots cover a send
    /// that puts the same photos back.
    public static let countLimit = 16
    /// Tombstones only cover in-flight work; this caps stray entries.
    static let tombstoneLimit = countLimit * 2

    public final class Thumbnail: NSObject {
        public let cgImage: CGImage

        public init(cgImage: CGImage) {
            self.cgImage = cgImage
        }
    }

    private static let images: NSCache<NSString, Thumbnail> = {
        let cache = NSCache<NSString, Thumbnail>()
        cache.countLimit = countLimit
        cache.totalCostLimit = countLimit * 128 * 128 * 4
        return cache
    }()

    private static let gate = CacheGate()

    public static func remove(id: UUID) {
        gate.remove(id: id)
    }

    /// A thumb is loading again for an attachment the strip still holds.
    public static func reinstate(id: UUID) {
        gate.reinstate(id: id)
    }

    /// Drop removal tombstones that no longer guard a strip id or in-flight decode.
    public static func pruneTombstones(keeping pending: Set<UUID>) {
        gate.pruneTombstones(keeping: pending)
    }

    public static func thumbnail(
        for item: PendingChatAttachment,
        screenScale: CGFloat
    ) async -> Thumbnail? {
        guard let data = item.previewImageData else { return nil }
        let attachmentId = item.id
        let key = attachmentId.uuidString as NSString

        if let cached = images.object(forKey: key) { return cached }

        gate.beginDecode(id: attachmentId)
        defer { gate.endDecode(id: attachmentId) }

        let maxPixel = max(Int((pointSize * max(screenScale, 1)).rounded(.up)), 1)
        let decoded = await downsampleOffMain(data: data, maxPixelSize: maxPixel)
        guard let decoded else { return nil }
        guard ComposerThumbnailCachePolicy.shouldStoreThumbnailInCache(
            attachmentId: attachmentId,
            isCancelled: Task.isCancelled,
            droppedFromStrip: false
        ) else {
            return nil
        }

        let cost = decoded.cgImage.bytesPerRow * decoded.cgImage.height
        return gate.store(decoded, for: attachmentId, cost: cost, isCancelled: Task.isCancelled)
            ? decoded
            : nil
    }

    /// ImageIO decodes only the pixels the chip needs.
    public static func downsample(data: Data, maxPixelSize: Int) -> Thumbnail? {
        let sourceOptions: [CFString: Any] = [
            kCGImageSourceShouldCache: false,
        ]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions as CFDictionary) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return Thumbnail(cgImage: cgImage)
    }

    private static func downsampleOffMain(data: Data, maxPixelSize: Int) async -> Thumbnail? {
        guard !Task.isCancelled else { return nil }
        let box = ThumbnailBox()
        let resumeBox = DecodeResumeBox()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                resumeBox.lock.lock()
                if resumeBox.didResume {
                    resumeBox.lock.unlock()
                    continuation.resume()
                    return
                }
                resumeBox.continuation = continuation
                resumeBox.lock.unlock()
                DispatchQueue.global(qos: .userInitiated).async {
                    resumeBox.lock.lock()
                    let cancelled = resumeBox.didResume
                    resumeBox.lock.unlock()
                    if !cancelled {
                        box.thumbnail = downsample(data: data, maxPixelSize: maxPixelSize)
                    }
                    resumeBox.resume()
                }
            }
        } onCancel: {
            resumeBox.resume()
        }
        guard !Task.isCancelled else { return nil }
        return box.thumbnail
    }

    private final class ThumbnailBox: @unchecked Sendable {
        var thumbnail: Thumbnail?
    }

    private final class DecodeResumeBox: @unchecked Sendable {
        let lock = NSLock()
        var continuation: CheckedContinuation<Void, Never>?
        var didResume = false

        func resume() {
            lock.lock()
            guard !didResume else {
                lock.unlock()
                return
            }
            didResume = true
            let cont = continuation
            continuation = nil
            lock.unlock()
            cont?.resume()
        }
    }

    private final class CacheGate: @unchecked Sendable {
        private let lock = NSLock()
        private var removedIds = Set<UUID>()
        private var inFlightDecodes = Set<UUID>()

        func remove(id: UUID) {
            lock.lock()
            images.removeObject(forKey: id.uuidString as NSString)
            removedIds.insert(id)
            capTombstonesLocked()
            lock.unlock()
        }

        func reinstate(id: UUID) {
            lock.lock()
            removedIds.remove(id)
            lock.unlock()
        }

        func pruneTombstones(keeping pending: Set<UUID>) {
            lock.lock()
            removedIds.subtract(pending)
            removedIds = removedIds.filter { inFlightDecodes.contains($0) }
            capTombstonesLocked()
            lock.unlock()
        }

        func beginDecode(id: UUID) {
            lock.lock()
            inFlightDecodes.insert(id)
            lock.unlock()
        }

        func endDecode(id: UUID) {
            lock.lock()
            inFlightDecodes.remove(id)
            removedIds.remove(id)
            lock.unlock()
        }

        func store(
            _ thumb: Thumbnail,
            for id: UUID,
            cost: Int,
            isCancelled: Bool
        ) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !isCancelled, !removedIds.contains(id) else { return false }
            images.setObject(thumb, forKey: id.uuidString as NSString, cost: cost)
            return true
        }

        private func capTombstonesLocked() {
            guard removedIds.count > ComposerPendingThumbnailCache.tombstoneLimit else { return }
            let droppable = removedIds.subtracting(inFlightDecodes)
            let overflow = removedIds.count - ComposerPendingThumbnailCache.tombstoneLimit
            guard overflow > 0 else { return }
            let dropCount = min(droppable.count, overflow)
            for id in droppable.prefix(dropCount) {
                removedIds.remove(id)
            }
        }

        #if DEBUG
        func tombstoneCountForTests() -> Int {
            lock.lock()
            defer { lock.unlock() }
            return removedIds.count
        }

        func clearAllForTests() {
            lock.lock()
            removedIds.removeAll()
            inFlightDecodes.removeAll()
            lock.unlock()
        }
        #endif
    }
}

#if DEBUG
extension ComposerPendingThumbnailCache {
    /// Test-only visibility into whether a thumb is still cached.
    public static func cachedThumbnail(for id: UUID) -> Thumbnail? {
        images.object(forKey: id.uuidString as NSString)
    }

    public static func resetForTests() {
        images.removeAllObjects()
        gate.clearAllForTests()
    }

    static func tombstoneCountForTests() -> Int {
        gate.tombstoneCountForTests()
    }
}
#endif
