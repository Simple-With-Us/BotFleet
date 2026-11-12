import Foundation

/// Rules for whether a finished thumbnail decode should update UI or cache.
public enum ComposerThumbnailCachePolicy: Sendable, Equatable {
  public static func shouldApplyThumbnailToRow(
    requestedId: UUID,
    rowId: UUID,
    isCancelled: Bool
  ) -> Bool {
    !isCancelled && requestedId == rowId
  }

  public static func shouldStoreThumbnailInCache(
    attachmentId: UUID,
    isCancelled: Bool,
    droppedFromStrip: Bool
  ) -> Bool {
    !isCancelled && !droppedFromStrip
  }
}
