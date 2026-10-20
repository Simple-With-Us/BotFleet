#if os(macOS)
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// Errors encountered during ScreenCaptureKit streaming and capture.
@available(macOS 14.0, *)
public enum ScreenStreamError: LocalizedError, Sendable {
    case notAuthorized
    case noDisplayFound
    case streamInitializationFailed(String)
    case captureFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notAuthorized:
            return "Screen Recording permission is not granted."
        case .noDisplayFound:
            return "No active display found matching the target specification."
        case .streamInitializationFailed(let reason):
            return "Failed to initialize SCStream: \(reason)"
        case .captureFailed(let reason):
            return "Failed to capture screen image: \(reason)"
        }
    }
}

/// Actor managing high-performance zero-copy ScreenCaptureKit streams and still captures.
@available(macOS 14.0, *)
public actor ScreenStreamActor: NSObject, SCStreamOutput, SCStreamDelegate {
    public static let shared = ScreenStreamActor()

    private var activeStream: SCStream?
    private var frameHandler: (@Sendable (CVPixelBuffer) -> Void)?
    private let streamQueue = DispatchQueue(label: "app.botfleet.screen-stream", qos: .userInteractive)

    public private(set) var isStreaming: Bool = false
    /// Set synchronously before the first `await` in `startStreaming` so a
    /// concurrent call (actors are re-entrant at suspension points) fails fast
    /// instead of racing a second SCStream over `activeStream`.
    private var isStarting: Bool = false

    public override init() {
        super.init()
    }

    // MARK: - Content Discovery

    /// Retrieves shareable content (displays, windows, applications) available for capture.
    public func availableContent() async throws -> SCShareableContent {
        do {
            return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw ScreenStreamError.captureFailed(error.localizedDescription)
        }
    }

    // MARK: - Still Capture

    /// Captures a single full-resolution frame from the specified display.
    public func captureStill(
        displayID: CGDirectDisplayID? = nil,
        cropRect: CGRect? = nil
    ) async throws -> CGImage {
        let content = try await availableContent()
        let targetDisplayID = displayID ?? CGMainDisplayID()

        guard let display = content.displays.first(where: { $0.displayID == targetDisplayID }) else {
            throw ScreenStreamError.noDisplayFound
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_32BGRA

        if let crop = cropRect {
            config.sourceRect = crop
            config.width = Int(crop.width)
            config.height = Int(crop.height)
        } else {
            config.width = display.width
            config.height = display.height
        }

        do {
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch {
            throw ScreenStreamError.captureFailed(error.localizedDescription)
        }
    }

    // MARK: - Zero-Copy Live Streaming

    /// Starts a zero-copy ScreenCaptureKit stream delivering `CVPixelBuffer` frames directly.
    public func startStreaming(
        displayID: CGDirectDisplayID? = nil,
        targetWidth: Int? = nil,
        targetHeight: Int? = nil,
        frameRate: Int = 30,
        onFrame: @Sendable @escaping (CVPixelBuffer) -> Void
    ) async throws {
        if isStreaming {
            await stopStreaming()
        }
        guard !isStarting else {
            throw ScreenStreamError.streamInitializationFailed("startStreaming is already in progress")
        }
        isStarting = true
        defer { isStarting = false }

        let content = try await availableContent()
        let targetDisplayID = displayID ?? CGMainDisplayID()

        guard let display = content.displays.first(where: { $0.displayID == targetDisplayID }) else {
            throw ScreenStreamError.noDisplayFound
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1)))
        config.width = targetWidth ?? display.width
        config.height = targetHeight ?? display.height

        let stream = SCStream(filter: filter, configuration: config, delegate: self)

        // Wire the handler before `startCapture`: frames the delegate receives
        // in the gap between capture start and these assignments would fail
        // `dispatchFrame`'s guard and the first frames would be dropped.
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: streamQueue)
            self.activeStream = stream
            self.frameHandler = onFrame
            self.isStreaming = true
            try await stream.startCapture()
        } catch {
            self.isStreaming = false
            self.frameHandler = nil
            self.activeStream = nil
            throw ScreenStreamError.streamInitializationFailed(error.localizedDescription)
        }
    }

    /// Stops the active ScreenCaptureKit stream and releases hardware buffers.
    public func stopStreaming() async {
        guard let stream = activeStream else { return }
        try? await stream.stopCapture()
        self.activeStream = nil
        self.frameHandler = nil
        self.isStreaming = false
    }

    // MARK: - SCStreamOutput & SCStreamDelegate

    public nonisolated func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        Task {
            await self.dispatchFrame(pixelBuffer)
        }
    }

    public nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task {
            await self.stopStreaming()
        }
    }

    private func dispatchFrame(_ pixelBuffer: CVPixelBuffer) {
        guard isStreaming, let handler = frameHandler else { return }
        handler(pixelBuffer)
    }
}
#endif
