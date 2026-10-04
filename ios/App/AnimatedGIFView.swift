// Minimal animated-GIF host for TV-Face packs. UIImageView already knows how
// to play multi-frame GIFs; SwiftUI does not, so we wrap it.
import SwiftUI
import UIKit
import ImageIO

struct AnimatedGIFView: UIViewRepresentable {
    let data: Data?
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
        if let animated = UIImage.animatedImage(withAnimatedGIFData: data) {
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
    static func animatedImage(withAnimatedGIFData data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1 else {
            guard let cg = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
            return UIImage(cgImage: cg)
        }
        var images: [UIImage] = []
        var duration: Double = 0
        for i in 0..<count {
            guard let cg = CGImageSourceCreateImageAtIndex(source, i, nil) else { continue }
            let frameDuration = gifFrameDuration(source: source, index: i)
            duration += frameDuration
            images.append(UIImage(cgImage: cg))
        }
        guard !images.isEmpty else { return nil }
        // UIImage animatedImageWithDuration expects the total duration.
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
