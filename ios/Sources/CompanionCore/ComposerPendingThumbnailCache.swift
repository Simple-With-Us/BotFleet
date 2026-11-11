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

  private static let removedIds = RemovedIdSet()

  public static func remove(id: UUID) {
    images.removeObject(forKey: id.uuidString as NSString)
    removedIds.insert(id)
  }

  /// A thumb is loading again for an attachment the strip still holds.
  public static func reinstate(id: UUID) {
    removedIds.clear(id)
  }

  public static func thumbnail(
    for item: PendingChatAttachment,
    screenScale: CGFloat
  ) async -> Thumbnail? {
    guard let data = item.previewImageData else { return nil }
    let attachmentId = item.id
    let key = attachmentId.uuidString as NSString

    if let cached = images.object(forKey: key) { return cached }

    let maxPixel = max(Int((pointSize * max(screenScale, 1)).rounded(.up)), 1)
    let decoded = await downsampleOffMain(data: data, maxPixelSize: maxPixel)
    guard let decoded else { return nil }
    guard ComposerThumbnailCachePolicy.shouldStoreThumbnailInCache(
      attachmentId: attachmentId,
      isCancelled: Task.isCancelled,
      droppedFromStrip: removedIds.contains(attachmentId)
    ) else {
      return nil
    }

    let thumb = decoded
    let cost = thumb.cgImage.bytesPerRow * thumb.cgImage.height
    images.setObject(thumb, forKey: key, cost: cost)
    return thumb
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

  private final class RemovedIdSet: @unchecked Sendable {
    private let lock = NSLock()
    private var ids = Set<UUID>()

    func insert(_ id: UUID) {
      lock.lock()
      ids.insert(id)
      lock.unlock()
    }

    func contains(_ id: UUID) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return ids.contains(id)
    }

    func clear(_ id: UUID) {
      lock.lock()
      ids.remove(id)
      lock.unlock()
    }

    func clearAll() {
      lock.lock()
      ids.removeAll()
      lock.unlock()
    }
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
    removedIds.clearAll()
  }
}
#endif
