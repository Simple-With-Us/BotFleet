// Microphone capture for a voice call: 16 kHz mono PCM16 frames, the input
// contract every realtime provider expects.
//
// This mirrors the desktop's capture path (`src/lib/sts/call-session.ts`:
// ScriptProcessor into a zeroed gain, `pcm16FromFloat32` resample) in the
// AVAudioEngine equivalent: a mic tap, an explicit 16 kHz converter, and a
// mute gate.  The converter is not optional -- the hardware runs at 44.1 or
// 48 kHz, and shipping those frames unlabeled plays the caller an octave
// down on the provider's side.
//
// Ownership: one capture per call.  Starting capture stops dictation first
// (SpeechDictation owns the session in `.record`), and stopping deactivates
// only what this object activated, so ending a call does not silence a
// recording the user started elsewhere.
import AVFoundation
import Foundation
import CompanionCore

/// What the providers accept: 16 kHz mono signed 16-bit PCM.
public enum VoiceCaptureFormat {
    public static let sampleRate: Double = 16_000
    public static let channels: AVAudioChannelCount = 1
}

@MainActor
public final class VoiceCapture: ObservableObject {
    /// Audio the provider can send, one Data per tap.  Always 16 kHz mono
    /// PCM16, regardless of what the hardware runs at.
    public var onFrame: ((Data) -> Void)?
    /// The engine failed in a way retrying will not fix (no input hardware).
    public var onError: ((Error) -> Void)?

    public enum Failure: LocalizedError {
        case noMicrophone
        case permissionDenied
        case engineStartFailed(Error)

        public var errorDescription: String? {
            switch self {
            case .noMicrophone:
                return "This phone has no microphone available for the call."
            case .permissionDenied:
                return "Microphone access is off. Turn it on in Settings to talk on a call."
            case let .engineStartFailed(cause):
                return "Could not start the microphone (\(cause.localizedDescription))."
            }
        }
    }

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var muted = false
    private var stopped = false

    public init() {}

    public var isMuted: Bool { muted }

    /// Begin capturing.  Throws without starting anything when permission is
    /// denied or no input exists, so the call screen can say so instead of
    /// opening a silent call.
    public func start() async throws {
        stopped = false
        guard await AVAudioApplication.requestRecordPermission() else {
            throw Failure.permissionDenied
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let engine = AVAudioEngine()
        let input = engine.inputNode
        guard input.inputFormat(forBus: 0).channelCount > 0 else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw Failure.noMicrophone
        }
        let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: VoiceCaptureFormat.sampleRate,
            channels: VoiceCaptureFormat.channels,
            interleaved: true
        )
        guard let outputFormat else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw Failure.noMicrophone
        }
        guard let converter = AVAudioConverter(from: input.inputFormat(forBus: 0), to: outputFormat) else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw Failure.noMicrophone
        }
        self.converter = converter
        // 4096 frames per tap, matching the desktop's CAPTURE_FRAME: small
        // enough to feel live, large enough not to drown the socket.
        input.installTap(onBus: 0, bufferSize: 4096, format: input.inputFormat(forBus: 0)) { [weak self] buffer, _ in
            MainActor.assumeIsolated {
                self?.convert(buffer: buffer, outputFormat: outputFormat)
            }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw Failure.engineStartFailed(error)
        }
        self.engine = engine
    }

    /// Mute without tearing down: the tap keeps running so unmuting is
    /// instant, but no frames leave the phone.
    public func setMuted(_ muted: Bool) {
        self.muted = muted
    }

    public func stop() {
        stopped = true
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func convert(buffer: AVAudioPCMBuffer, outputFormat: AVAudioFormat) {
        guard !muted, !stopped, let converter, let onFrame else { return }
        let ratio = VoiceCaptureFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        var error: NSError?
        // A tap buffer converts in one call: input block supplies the buffer
        // once, then nil.  Anything else is a converter failure, not audio.
        var supplied = false
        converter.convert(to: out, error: &error, withInputFrom: { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return buffer
        })
        guard error == nil, out.frameLength > 0,
              let bytes = out.int16ChannelData
        else { return }
        let data = Data(bytes: bytes[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
        onFrame(data)
    }
}
