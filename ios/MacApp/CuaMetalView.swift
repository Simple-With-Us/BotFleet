#if os(macOS)
import CoreImage
import CoreVideo
import MetalKit
import SwiftUI

/// High-performance Metal-accelerated view rendering live ScreenCaptureKit CUA frames with zero CPU copy.
public struct CuaMetalView: NSViewRepresentable {
    public let pixelBuffer: CVPixelBuffer?
    public let contentMode: ContentMode

    public enum ContentMode {
        case fit
        case fill
    }

    public init(pixelBuffer: CVPixelBuffer?, contentMode: ContentMode = .fit) {
        self.pixelBuffer = pixelBuffer
        self.contentMode = contentMode
    }

    public func makeNSView(context: Context) -> MTKView {
        guard let device = MTLCreateSystemDefaultDevice() else {
            // Loud, inert fallback: a bare MTKView() has no device or delegate,
            // so rendering silently no-ops while looking attached. Say so, and
            // make sure it never schedules draws.
            NSLog("CuaMetalView: MTLCreateSystemDefaultDevice() returned nil; CUA inspector rendering is disabled on this Mac.")
            let fallback = MTKView()
            fallback.isPaused = true
            fallback.enableSetNeedsDisplay = false
            return fallback
        }

        let mtkView = MTKView(frame: .zero, device: device)
        mtkView.framebufferOnly = false
        mtkView.clearColor = MTLClearColor(red: 0.05, green: 0.05, blue: 0.07, alpha: 1.0)
        mtkView.enableSetNeedsDisplay = true
        mtkView.isPaused = true
        mtkView.delegate = context.coordinator
        context.coordinator.mtkView = mtkView

        return mtkView
    }

    public func updateNSView(_ nsView: MTKView, context: Context) {
        context.coordinator.render(pixelBuffer: pixelBuffer)
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(contentMode: contentMode)
    }

    public final class Coordinator: NSObject, MTKViewDelegate {
        weak var mtkView: MTKView?
        private let commandQueue: MTLCommandQueue?
        private let ciContext: CIContext
        private let colorSpace = CGColorSpaceCreateDeviceRGB()
        private var currentBuffer: CVPixelBuffer?
        private let contentMode: ContentMode

        init(contentMode: ContentMode) {
            self.contentMode = contentMode
            let device = MTLCreateSystemDefaultDevice()
            self.commandQueue = device?.makeCommandQueue()
            if let device = device {
                self.ciContext = CIContext(mtlDevice: device, options: [
                    .workingColorSpace: NSNull(),
                    .cacheIntermediates: false,
                ])
            } else {
                self.ciContext = CIContext()
            }
            super.init()
        }

        func render(pixelBuffer: CVPixelBuffer?) {
            self.currentBuffer = pixelBuffer
            mtkView?.setNeedsDisplay(mtkView?.bounds ?? .zero)
        }

        public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
            view.setNeedsDisplay(view.bounds)
        }

        public func draw(in view: MTKView) {
            guard let currentDrawable = view.currentDrawable,
                  let commandBuffer = commandQueue?.makeCommandBuffer() else {
                return
            }

            if let buffer = currentBuffer {
                let inputImage = CIImage(cvPixelBuffer: buffer)
                let destinationBounds = CGRect(origin: .zero, size: view.drawableSize)

                let scaleX = destinationBounds.width / inputImage.extent.width
                let scaleY = destinationBounds.height / inputImage.extent.height
                let scale = contentMode == .fit ? min(scaleX, scaleY) : max(scaleX, scaleY)

                let scaledWidth = inputImage.extent.width * scale
                let scaledHeight = inputImage.extent.height * scale
                let originX = (destinationBounds.width - scaledWidth) / 2.0
                let originY = (destinationBounds.height - scaledHeight) / 2.0

                let transformedImage = inputImage
                    .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                    .transformed(by: CGAffineTransform(translationX: originX, y: originY))

                ciContext.render(
                    transformedImage,
                    to: currentDrawable.texture,
                    commandBuffer: commandBuffer,
                    bounds: destinationBounds,
                    colorSpace: colorSpace
                )
            }

            commandBuffer.present(currentDrawable)
            commandBuffer.commit()
        }
    }
}
#endif
