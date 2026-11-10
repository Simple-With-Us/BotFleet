// xAI realtime speech-to-speech for a voice call, over URLSessionWebSocketTask.
//
// A port of src/lib/sts/xai-realtime.ts: the wire protocol is
// OpenAI-Realtime-compatible, so the event names are the OpenAI ones.
//
//  * Socket: wss://api.x.ai/v1/realtime?model=grok-voice-latest, authed as
//    the `Sec-WebSocket-Protocol` header `xai-client-secret.<token>` -- a
//    browser socket cannot set Authorization, and neither can this one.
//  * Ready means `session.updated`: the vendor's ack of our session config.
//  * Audio up is `input_audio_buffer.append`; audio down is base64 PCM16.
//  * Barge-in: server VAD reports `speech_started`; playback stops locally
//    and the unheard tail is dropped server-side with `conversation.item.
//    truncate`, or the model talks over itself for the rest of the turn.
//  * The permanent API key never comes near this file: `token` is the
//    short-lived mint from POST /api/sts/token.
//
// Frames this protocol does not speak are dropped by the decoder instead of
// failing the call; a field this file acts on is validated before use.
import AVFoundation
import Foundation
import CompanionCore

public final class XaiRealtimeSession: StsSession, @unchecked Sendable {
    public let provider: StsProviderKind = .xai

    private static let endpoint = "wss://api.x.ai/v1/realtime"
    private static let handshakeTimeout: TimeInterval = 10

    private let token: String
    private let playback: VoicePlayback

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var started = false
    private var starting = false
    private var stopped = false
    private var generation = 0

    private var engine: StsEngineTool?
    private var engineTimeoutMs = 10_000
    private var engineUnavailable = false
    private var persona = ""
    private var handledCalls = Set<String>()
    private var botText = ""
    private var userText = ""
    private var currentItemId = ""

    private var lineHandlers = [UUID: @Sendable (StsTranscriptLine) -> Void]()
    private var errorHandlers = [UUID: @Sendable (Error) -> Void]()
    private var closedHandlers = [UUID: @Sendable (String) -> Void]()
    private let lock = NSLock()

    private var handshakeContinuation: CheckedContinuation<Void, Error>?
    private var handshakeTimer: DispatchWorkItem?

    public init(token: String, playback: VoicePlayback) {
        self.token = token
        self.playback = playback
    }

    // MARK: - StsSession

    public func start(options: StsStartOptions) async throws {
        lock.lock()
        guard !started, !starting else {
            lock.unlock()
            throw StsSessionError.alreadyStarted("This xAI speech session is already started.")
        }
        starting = true
        stopped = false
        engine = options.engine
        engineTimeoutMs = options.engineTimeoutMs
        engineUnavailable = false
        persona = options.instructions
        handledCalls.removeAll()
        botText = ""
        userText = ""
        currentItemId = ""
        lock.unlock()

        var components = URLComponents(string: Self.endpoint)
        components?.queryItems = [URLQueryItem(name: "model", value: StsProviderKind.xai.realtimeModel)]
        guard let url = components?.url else {
            failStart("Could not open the xAI speech session.")
            throw StsSessionError.startFailed("Could not open the xAI speech session.")
        }
        var request = URLRequest(url: url)
        // The subprotocol IS the credential on this transport: there is no
        // Authorization header on a websocket handshake from here either.
        request.setValue("xai-client-secret.\(token)", forHTTPHeaderField: "Sec-WebSocket-Protocol")

        let session = URLSession(configuration: .ephemeral)
        self.session = session
        let task = session.webSocketTask(with: request)
        self.task = task

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            self.handshakeContinuation = continuation
            let timer = DispatchWorkItem { [weak self] in
                self?.lock.lock()
                if let pending = self?.handshakeContinuation {
                    self?.handshakeContinuation = nil
                    self?.lock.unlock()
                    pending.resume(throwing: StsSessionError.startFailed("xAI took too long to confirm the speech session."))
                } else {
                    self?.lock.unlock()
                }
            }
            self.handshakeTimer = timer
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.handshakeTimeout, execute: timer)

            task.resume()
            self.receive()
            // The session config goes out on open; the vendor's
            // `session.updated` ack resolves the handshake.
            self.sendHandshake()
        }

        lock.lock()
        starting = false
        started = true
        lock.unlock()
    }

    public func sendAudio(_ pcm: Data) {
        lock.lock()
        let ready = started && !stopped
        lock.unlock()
        guard ready, !pcm.isEmpty else { return }
        send(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()])
    }

    public func stop() async {
        lock.lock()
        stopped = true
        starting = false
        started = false
        handshakeTimer?.cancel()
        handshakeTimer = nil
        if let pending = handshakeContinuation {
            handshakeContinuation = nil
            lock.unlock()
            pending.resume(throwing: CancellationError())
        } else {
            lock.unlock()
        }
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    public func onLine(_ handler: @escaping @Sendable (StsTranscriptLine) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock()
        lineHandlers[id] = handler
        lock.unlock()
        return { [weak self] in
            self?.lock.lock()
            self?.lineHandlers.removeValue(forKey: id)
            self?.lock.unlock()
        }
    }

    public func onError(_ handler: @escaping @Sendable (Error) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock()
        errorHandlers[id] = handler
        lock.unlock()
        return { [weak self] in
            self?.lock.lock()
            self?.errorHandlers.removeValue(forKey: id)
            self?.lock.unlock()
        }
    }

    public func onClosed(_ handler: @escaping @Sendable (String) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock()
        closedHandlers[id] = handler
        lock.unlock()
        return { [weak self] in
            self?.lock.lock()
            self?.closedHandlers.removeValue(forKey: id)
            self?.lock.unlock()
        }
    }

    // MARK: - Wire

    /// Persona plus the tool preamble, plus the bypass once the engine has
    /// proven unreachable.  Mirrors the desktop's composedInstructions so a
    /// model that was told to delegate does not hedge when it must answer
    /// alone.
    private func composedInstructions() -> String {
        lock.lock()
        let unavailable = engineUnavailable
        let persona = self.persona
        lock.unlock()
        var sections = [persona.trimmingCharacters(in: .whitespacesAndNewlines), StsEngineInstructions.preamble]
        if unavailable { sections.append(StsEngineInstructions.bypass) }
        return sections.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    private func sendHandshake() {
        // The handshake frame must wait for the socket; URLSession buffers
        // pre-open sends, but a send before resume is a logic error here, so
        // it goes out on the next runloop turn after resume above.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self else { return }
            var tools: [[String: Any]] = []
            self.lock.lock()
            let engine = self.engine
            self.lock.unlock()
            if let engine {
                tools.append([
                    "type": "function",
                    "name": engine.name,
                    "description": engine.description,
                    "parameters": engine.parameters.mapValues(\.jsonValue),
                ])
            }
            self.send([
                "type": "session.update",
                "session": [
                    // Composed live (not the `instructions` parameter): the
                    // bypass flag can flip mid-call.
                    "instructions": self.composedInstructions(),
                    "tools": tools,
                    "turn_detection": ["type": "server_vad"],
                ],
            ])
        }
    }

    private func send(_ frame: [String: Any]) {
        guard let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { [weak self] error in
            if error != nil {
                self?.teardown()
            }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .string(text):
                    self.onFrame(text)
                case .data:
                    break // binary frames are not part of this protocol
                @unknown default:
                    break
                }
                self.lock.lock()
                let alive = !self.stopped
                self.lock.unlock()
                if alive { self.receive() }
            case .failure:
                self.lock.lock()
                let wasOurs = self.stopped
                self.lock.unlock()
                // A close after stop() is ours and stays quiet; anything
                // else is a disconnect the call screen has to hear about.
                if !wasOurs {
                    self.emitError(StsSessionError.transport("The xAI speech session disconnected."))
                }
            }
        }
    }

    private func onFrame(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else { return }

        if type == "error" || type == "session.error" {
            let detail: String = {
                if let error = json["error"] as? [String: Any] {
                    return (error["message"] as? String) ?? (error["type"] as? String) ?? "unknown error"
                }
                return "unknown error"
            }()
            emitError(StsSessionError.transport("xAI reported: \(detail)"))
            failHandshake(StsSessionError.startFailed("xAI rejected the session: \(detail)"))
            return
        }
        if type == "session.closed" || type == "session.expired" || type == "session.go_away" {
            lock.lock()
            let wasOurs = stopped
            lock.unlock()
            guard !wasOurs else { return }
            emitClosed(type == "session.expired" ? "The xAI session expired." : "The xAI session ended.")
            teardown()
            return
        }

        lock.lock()
        let alive = !stopped
        lock.unlock()
        guard alive else { return }

        switch type {
        case "session.updated":
            // The vendor's ack of our session config: this is "ready".
            resolveHandshake()
        case "response.output_item.added":
            if let item = json["item"] as? [String: Any], let id = item["id"] as? String {
                lock.lock()
                currentItemId = id
                lock.unlock()
            }
        case "response.audio.delta", "response.output_audio.delta":
            if let id = json["item_id"] as? String {
                lock.lock()
                currentItemId = id
                lock.unlock()
            }
            guard let b64 = json["audio"] as? String,
                  let bytes = Data(base64Encoded: b64)
            else { return }
            Task { @MainActor [playback] in
                playback.enqueue(bytes)
            }
        case "response.audio_transcript.delta", "response.output_audio_transcript.delta":
            if let delta = json["delta"] as? String, !delta.isEmpty {
                lock.lock()
                botText += delta
                lock.unlock()
            }
        case "response.audio_transcript.done", "response.output_audio_transcript.done":
            lock.lock()
            if let transcript = json["transcript"] as? String {
                botText = transcript
            }
            let text = botText
            botText = ""
            lock.unlock()
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                emitLine(StsTranscriptLine(text: text, from: .bot, final: true))
            }
        case "response.done":
            lock.lock()
            let text = botText
            botText = ""
            currentItemId = ""
            lock.unlock()
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                emitLine(StsTranscriptLine(text: text, from: .bot, final: true))
            }
        case "input_audio_buffer.speech_started":
            interrupt()
        case "conversation.item.input_audio_transcription.delta":
            guard let delta = json["delta"] as? String, !delta.isEmpty else { return }
            lock.lock()
            userText += delta
            let text = userText.trimmingCharacters(in: .whitespacesAndNewlines)
            lock.unlock()
            if !text.isEmpty {
                emitLine(StsTranscriptLine(text: text, from: .user, final: false))
            }
        case "conversation.item.input_audio_transcription.completed":
            lock.lock()
            let text = ((json["transcript"] as? String) ?? userText).trimmingCharacters(in: .whitespacesAndNewlines)
            userText = ""
            lock.unlock()
            if !text.isEmpty {
                emitLine(StsTranscriptLine(text: text, from: .user, final: true))
            }
        case "response.function_call_arguments.done":
            guard let callId = json["call_id"] as? String, !callId.isEmpty else { return }
            lock.lock()
            let seen = handledCalls.contains(callId)
            if !seen { handledCalls.insert(callId) }
            let pendingBot = botText
            botText = ""
            let name = json["name"] as? String
            let args = json["arguments"] as? String ?? "{}"
            lock.unlock()
            guard !seen else { return }
            // Any preamble the model sent before the call is its own line.
            if !pendingBot.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                emitLine(StsTranscriptLine(text: pendingBot, from: .bot, final: true))
            }
            runEngine(callId: callId, name: name, arguments: args)
        default:
            break
        }
    }

    // MARK: - Barge-in

    /// The caller spoke over the bot -- or pressed Interrupt: stop what they have
    /// not heard and tell the session to drop the tail, or the model talks over
    /// itself.  Public because the call's Interrupt control asks for exactly
    /// this and the seam is where that request belongs; the VAD path below is
    /// the same method, reached from `input_audio_buffer.speech_started`.
    public func interrupt() {
        // The playback clock is MainActor-isolated, and this arrives on the
        // socket's receive task, which is not the main thread.  Reading it
        // inline reported zero for every voice-activity barge-in -- so the
        // truncate told the model the caller heard none of a reply they had
        // interrupted two seconds into, and its transcript drifted out of step
        // with the room.  Hop to the actor that owns the clock first, then send.
        Task { @MainActor [weak self] in
            guard let self else { return }
            let played = playback.playedMs
            playback.stopPlayback()
            cutResponse(afterHeardMs: played)
        }
    }

    /// Clear the transcript of a reply that was cut, and tell the vendor how
    /// much of it the caller actually heard.
    private func cutResponse(afterHeardMs heard: Int) {
        lock.lock()
        // The truncated utterance never finished, so its transcript would be
        // a sentence the caller did not hear.
        botText = ""
        let itemId = currentItemId
        lock.unlock()
        for frame in StsInterrupt.frames(itemId: itemId, playedMs: heard) {
            switch frame {
            case let .truncate(itemId, contentIndex, audioEndMs):
                send([
                    "type": "conversation.item.truncate",
                    "item_id": itemId,
                    "content_index": contentIndex,
                    "audio_end_ms": audioEndMs,
                ])
            case .cancel:
                send(["type": "response.cancel"])
            }
        }
    }

    // MARK: - Engine tool

    private func runEngine(callId: String, name: String?, arguments: String) {
        lock.lock()
        let engine = self.engine
        let timeoutMs = self.engineTimeoutMs
        let gen = self.generation
        lock.unlock()
        guard let engine else {
            emitLine(StsTranscriptLine(text: "The bot's engine is unavailable right now.", from: .bot, final: true, engineBypassed: true))
            return
        }
        _ = name
        _ = callId
        Task {
            let args: [String: AnyCodable]
            if let data = arguments.data(using: .utf8),
               let dict = try? JSONDecoder().decode([String: AnyCodable].self, from: data) {
                args = dict
            } else {
                args = [:]
            }
            do {
                let reply = try await withThrowingTaskGroup(of: String.self) { group in
                    group.addTask {
                        try await engine.run(args)
                    }
                    group.addTask {
                        try await Task.sleep(for: .milliseconds(timeoutMs))
                        throw StsSessionError.engineTimeout
                    }
                    let first = try await group.next()!
                    group.cancelAll()
                    return first
                }
                self.lock.lock()
                let alive = !self.stopped && self.generation == gen
                self.lock.unlock()
                guard alive else { return }
                self.emitLine(StsTranscriptLine(text: reply, from: .bot, final: true))
            } catch {
                self.lock.lock()
                let alive = !self.stopped && self.generation == gen
                if alive { self.engineUnavailable = true }
                self.lock.unlock()
                guard alive else { return }
                // The session survives a dead engine: tell the model to
                // answer alone from now on, and mark the line that says so.
                self.send(["type": "session.update", "session": ["instructions": self.composedInstructions()]])
                self.emitLine(StsTranscriptLine(
                    text: "The bot's engine is unavailable right now, so here is my own answer.",
                    from: .bot,
                    final: true,
                    engineBypassed: true
                ))
            }
        }
    }

    // MARK: - Helpers

    private func resolveHandshake() {
        lock.lock()
        guard let pending = handshakeContinuation else {
            lock.unlock()
            return
        }
        handshakeContinuation = nil
        handshakeTimer?.cancel()
        handshakeTimer = nil
        lock.unlock()
        pending.resume()
    }

    private func failHandshake(_ error: Error) {
        lock.lock()
        guard let pending = handshakeContinuation else {
            lock.unlock()
            return
        }
        handshakeContinuation = nil
        handshakeTimer?.cancel()
        handshakeTimer = nil
        lock.unlock()
        pending.resume(throwing: error)
    }

    private func failStart(_ message: String) {
        lock.lock()
        starting = false
        lock.unlock()
    }

    private func teardown() {
        Task { await self.stop() }
    }

    private func emitLine(_ line: StsTranscriptLine) {
        lock.lock()
        let handlers = Array(lineHandlers.values)
        lock.unlock()
        for handler in handlers { handler(line) }
    }

    private func emitError(_ error: Error) {
        lock.lock()
        let handlers = Array(errorHandlers.values)
        lock.unlock()
        for handler in handlers { handler(error) }
    }

    private func emitClosed(_ reason: String) {
        lock.lock()
        let handlers = Array(closedHandlers.values)
        lock.unlock()
        for handler in handlers { handler(reason) }
    }
}

public enum StsSessionError: LocalizedError {
    case alreadyStarted(String)
    case startFailed(String)
    case transport(String)
    case engineTimeout

    public var errorDescription: String? {
        switch self {
        case let .alreadyStarted(message): return message
        case let .startFailed(message): return message
        case let .transport(message): return message
        case .engineTimeout: return "The bot's engine took too long."
        }
    }
}
