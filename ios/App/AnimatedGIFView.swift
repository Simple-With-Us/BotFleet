// Minimal animated-GIF host for TV-Face packs. UIImageView already knows how
// to play multi-frame GIFs; SwiftUI does not, so we wrap it.
import SwiftUI
import UIKit
import ImageIO

struct AnimatedGIFView: UIViewRepresentable {
    let data: Data?
    /// Decode cap in pixels (0 = native size).  Passed through to the GIF
    /// decoder so a 52pt avatar never retains 480x480 frames.
    var maxPixelSize: Int = 0
    let contentMode: UIView.ContentMode

    init(data: Data?, contentMode: UIView.ContentMode = .scaleAspectFit) {
        self.data = data
        self.contentMode = contentMode
    }

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.contentMode = contentMode
        view.clipsToBounds = true
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: UIImageView, context: Context) {
        view.contentMode = contentMode
        guard let data else {
            view.stopAnimating()
            view.image = nil
            view.animationImages = nil
            context.coordinator.lastData = nil
            return
        }
        // TVFaceAvatar reads player.imageData in body, so this fires on every
        // parent re-render: re-decoding the full frame set and restarting the
        // animation at frame 0 each time would stutter a scrolling bot list.
        guard context.coordinator.lastData != data else { return }
        context.coordinator.lastData = data
        if let animated = UIImage.animatedImage(withAnimatedGIFData: data, maxPixelSize: maxPixelSize) {
            view.image = animated
            view.startAnimating()
        } else {
            view.image = UIImage(data: data)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator { var lastData: Data? }

    static func dismantleUIView(_ view: UIImageView, coordinator: Coordinator) {
        view.stopAnimating()
        coordinator.lastData = nil
    }
}

extension UIImage {
    /// Decode a multi-frame GIF into an animated UIImage. Falls back to the
    /// first frame when the source is not animated.
    /// Decode a multi-frame GIF into an animated UIImage. Falls back to the
    /// first frame when the source is not animated.
    /// - Parameter maxPixelSize: when > 0, each frame is decoded as an ImageIO
    ///   thumbnail capped at this pixel size.  Several visible avatars used to
    ///   each hold every 480x480 frame (about 62 MiB per 71-frame pack before
    ///   UIKit overhead); at avatar sizes the decode is capped to the pixels
    ///   actually rendered.
    static func animatedImage(withAnimatedGIFData data: Data, maxPixelSize: Int = 0) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1 else {
            guard let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
            return UIImage(cgImage: cg)
        }
        var frames: [(UIImage, Double)] = []
        for i in 0..<count {
            let cg: CGImage?
            if maxPixelSize > 0 {
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                ]
                cg = CGImageSourceCreateThumbnailAtIndex(source, i, options as CFDictionary)
            } else {
                cg = CGImageSourceCreateImageAtIndex(source, i, nil)
            }
            guard let cg else { continue }
            frames.append((UIImage(cgImage: cg), gifFrameDuration(source: source, index: i)))
        }
        guard !frames.isEmpty else { return nil }
        // UIImage.animatedImage(with:duration:) distributes one total duration
        // uniformly, which would discard the authored per-frame cadence (holds
        // mixing 80/160 ms, transitions mixing 40/80 ms).  Expand frames on a
        // common 20 ms quantum instead; repeated entries share the same
        // UIImage/CGImage, so the expansion costs pointers, not pixels.
        let quantum = 0.02
        var images: [UIImage] = []
        var duration: Double = 0
        var expanded = 0
        for (image, delay) in frames {
            let copies = max(1, Int((delay / quantum).rounded()))
            expanded += copies
            guard expanded <= 2000 else {
                // Pathological pack: fall back to uniform timing rather than
                // building an unbounded frame list.
                return UIImage.animatedImage(with: frames.map(\.0), duration: max(duration + frames[frames.count - 1].1, 0.1))
            }
            images.append(contentsOf: repeatElement(image, count: copies))
            duration += delay
        }
        return UIImage.animatedImage(with: images, duration: max(duration, 0.1))
    }

    private static func gifFrameDuration(source: CGImageSource, index: Int) -> Double {
        let defaultDuration = 0.1
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
              let gif = props[kCGImagePropertyGIFDictionary] as? [CFString: Any] else {
            return defaultDuration
        }
        if let unclamped = gif[kCGImagePropertyGIFUnclampedDelayTime] as? Double, unclamped > 0.011 {
            return unclamped
        }
        if let delay = gif[kCGImagePropertyGIFDelayTime] as? Double, delay > 0.011 {
            return delay
        }
        return defaultDuration
    }
}
