// Gemini live speech-to-speech for a voice call, over URLSessionWebSocketTask.
//
// A port of src/lib/sts/gemini-live.ts.
//
//  * Socket: wss://...BidiGenerateContentConstrained?access_token=<token>.
//    The token is single-use and short-lived, so the socket opens directly
//    from it with no other await in between.
//  * The setup frame is first and alone; every other outbound message waits
//    for setupComplete.  Audio before ready is dropped, not buffered.
//  * Audio up is realtimeInput media chunks ("audio/pcm;rate=16000"); audio
//    down is 24 kHz PCM16 inlineData, with input/outputTranscription text so
//    the transcript exists without a second recognizer.
//  * Interruption: the caller talking over the bot stops playback first
//    (queued audio is what they are interrupting), then flushes the cut-off
//    reply into the transcript.
//  * Tool calls come as toolCall.functionCalls and answer as
//    toolResponse.functionResponses.
//  * A goAway frame means the server ends the session shortly: surfaced as
//    onClosed so the call can reconnect rather than restart mid-sentence.
//
// The permanent API key never comes near this file.
import Foundation
import CompanionCore

public final class GeminiLiveSession: StsSession, @unchecked Sendable {
    public let provider: StsProviderKind = .gemini

    private static let endpoint =
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained"
    private static let setupTimeout: TimeInterval = 15
    private static let inputMimeType = "audio/pcm;rate=16000"

    private let token: String
    private let playback: VoicePlayback

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var started = false
    private var starting = false
    private var stopped = false
    private var ready = false
    private var ended = false
    private var generation = 0

    private var engine: StsEngineTool?
    private var engineTimeoutMs = 10_000
    private var bypassPending = false
    private var userText = ""
    private var botText = ""
    /// Which stream the bot's text arrives on, so it is never counted twice.
    private var botSource: String?
    private var handledCalls = Set<String>()

    private var lineHandlers = [UUID: @Sendable (StsTranscriptLine) -> Void]()
    private var errorHandlers = [UUID: @Sendable (Error) -> Void]()
    private var closedHandlers = [UUID: @Sendable (String) -> Void]()
    private let lock = NSLock()

    private var setupContinuation: CheckedContinuation<Void, Error>?
    private var setupTimer: DispatchWorkItem?

    public init(token: String, playback: VoicePlayback) {
        self.token = token
        self.playback = playback
    }

    // MARK: - StsSession

    public func start(options: StsStartOptions) async throws {
        lock.lock()
        guard !started, !starting else {
            lock.unlock()
            throw StsSessionError.alreadyStarted("This Gemini live session is already started.")
        }
        starting = true
        stopped = false
        ended = false
        ready = false
        engine = options.engine
        engineTimeoutMs = options.engineTimeoutMs
        bypassPending = false
        userText = ""
        botText = ""
        botSource = nil
        handledCalls.removeAll()
        lock.unlock()

        // Gemini's bidi socket authenticates with the access token in the
        // query string.  That is the protocol (the same URL the desktop
        // opens in src/lib/sts/gemini-live.ts).  A subprotocol header or a
        // setup field is not accepted, so the token stays here.  The
        // session below does not cache that URL or keep a cookie for it,
        // and the errors this file emits never include the request URL.
        var components = URLComponents(string: Self.endpoint)
        components?.queryItems = [URLQueryItem(name: "access_token", value: token)]
        guard let url = components?.url else {
            failStart()
            throw StsSessionError.startFailed("Could not open the Gemini live session.")
        }
        let session = Self.makeSocketSession()
        self.session = session
        let task = session.webSocketTask(with: URLRequest(url: url))
        self.task = task

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            self.setupContinuation = continuation
            let timer = DispatchWorkItem { [weak self] in
                self?.lock.lock()
                if let pending = self?.setupContinuation {
                    self?.setupContinuation = nil
                    self?.lock.unlock()
                    pending.resume(throwing: StsSessionError.startFailed("Gemini live did not finish its setup handshake in time."))
                } else {
                    self?.lock.unlock()
                }
            }
            self.setupTimer = timer
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.setupTimeout, execute: timer)

            task.resume()
            self.receive()
            self.send(buildSetup(options: options))
        }

        lock.lock()
        starting = false
        started = true
        ready = true
        lock.unlock()
    }

    public func sendAudio(_ pcm: Data) {
        lock.lock()
        let ready = ready && started && !stopped
        lock.unlock()
        guard ready, !pcm.isEmpty else { return }
        send([
            "realtimeInput": [
                "mediaChunks": [["mimeType": Self.inputMimeType, "data": pcm.base64EncodedString()]],
            ],
        ])
    }

    /// The caller pressed Interrupt.
    ///
    /// Gemini's interruption is server-owned: there is no client cancel frame,
    /// the vendor decides the turn is over and then says so with
    /// `serverContent.interrupted`.  What this side can do is everything that
    /// makes that instant land -- silence the speaker, which is usually still
    /// queued ahead of it, and close the transcript on the reply that was cut.
    /// Deliberately identical to the server-initiated path below: one barge-in,
    /// one behaviour, whichever side started it.
    public func interrupt() {
        // Silence first, transcript second.  The two used to be separate
        // tasks, so the cut-off line could land while audio was still queued.
        Task { @MainActor [weak self, playback] in
            playback.stopPlayback()
            self?.flushBotTurn(consumeBypass: false)
        }
    }

    public func stop() async {
        lock.lock()
        stopped = true
        starting = false
        started = false
        ready = false
        generation += 1
        setupTimer?.cancel()
        setupTimer = nil
        if let pending = setupContinuation {
            setupContinuation = nil
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

    private func buildSetup(options: StsStartOptions) -> [String: Any] {
        let instructions: String
        if options.engine != nil {
            instructions = "\(options.instructions)\n\n\(StsEngineInstructions.preamble)"
        } else {
            instructions = options.instructions
        }
        var setup: [String: Any] = [
            "model": "models/\(StsProviderKind.gemini.realtimeModel)",
            "responseModalities": ["AUDIO"],
            "systemInstruction": ["parts": [["text": instructions]]],
            "inputTranscription": [:] as [String: Any],
            "outputTranscription": [:] as [String: Any],
            "sessionResumption": [:] as [String: Any],
            "contextWindowCompression": [
                "triggerTokens": 30_000,
                "slidingWindow": ["targetTokens": 20_000],
            ],
        ]
        if let engine = options.engine {
            setup["tools"] = [
                ["functionDeclarations": [[
                    "name": engine.name,
                    "description": engine.description,
                    "parameters": engine.parameters.mapValues(\.jsonValue),
                ]]],
            ]
        }
        return ["setup": setup]
    }

    private func send(_ frame: [String: Any]) {
        guard let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { [weak self] error in
            if error != nil {
                self?.tearDown("The Gemini live connection failed while sending to the model.")
            }
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                if case let .string(text) = message {
                    self.onFrame(text)
                }
                self.lock.lock()
                let alive = !self.stopped
                self.lock.unlock()
                if alive { self.receive() }
            case .failure:
                self.lock.lock()
                let wasOurs = self.stopped
                self.lock.unlock()
                if !wasOurs {
                    self.tearDown("The Gemini live connection closed while the call was in progress.")
                }
            }
        }
    }

    private func onFrame(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            emitError(StsSessionError.transport("Gemini live sent a frame this build could not read."))
            return
        }
        lock.lock()
        let alive = !stopped
        lock.unlock()
        guard alive else { return }

        if json["setupComplete"] != nil {
            resolveSetup()
            return
        }
        if let goAway = json["goAway"] as? [String: Any] {
            let seconds: Int? = {
                guard let ms = goAway["timeLeftMs"] as? Double else { return nil }
                return max(0, Int((ms / 1000).rounded()))
            }()
            if let seconds {
                tearDown("Gemini is closing this live session in about \(seconds) second\(seconds == 1 ? "" : "s"); reconnect to continue the call.")
            } else {
                tearDown("Gemini is closing this live session; reconnect to continue the call.")
            }
            return
        }

        if let transcription = json["inputTranscription"] as? [String: Any],
           let text = transcription["text"] as? String, !text.isEmpty {
            lock.lock()
            userText += text
            let line = userText.trimmingCharacters(in: .whitespacesAndNewlines)
            lock.unlock()
            if !line.isEmpty {
                emitLine(StsTranscriptLine(text: line, from: .user, final: false))
            }
        }
        if let output = json["outputTranscription"] as? [String: Any],
           let text = output["text"] as? String, !text.isEmpty {
            appendBotText(text, source: "transcript")
        }

        if let content = json["serverContent"] as? [String: Any] {
            if content["interrupted"] as? Bool == true {
                // The caller talked over the bot.  Silence first, transcript
                // second: queued audio is what they are interrupting, and it
                // is often ahead of the speaker.  Same order as interrupt().
                Task { @MainActor [weak self, playback] in
                    playback.stopPlayback()
                    self?.flushBotTurn(consumeBypass: false)
                }
            }
            if let turn = content["modelTurn"] as? [String: Any] {
                for part in turn["parts"] as? [[String: Any]] ?? [] {
                    if let inline = part["inlineData"] as? [String: Any],
                       let b64 = inline["data"] as? String,
                       let bytes = Data(base64Encoded: b64) {
                        Task { @MainActor [playback] in
                            playback.enqueue(bytes)
                        }
                    }
                    if let text = part["text"] as? String, !text.isEmpty {
                        appendBotText(text, source: "text")
                    }
                }
                if turn["finished"] as? Bool == true {
                    flushBotTurn(consumeBypass: true)
                }
            }
            if content["turnComplete"] as? Bool == true {
                flushUserTurn()
            }
        }

        if let toolCall = json["toolCall"] as? [String: Any] {
            for call in toolCall["functionCalls"] as? [[String: Any]] ?? [] {
                runToolCall(
                    id: call["id"] as? String,
                    name: call["name"] as? String,
                    args: call["args"] as? [String: Any] ?? [:]
                )
            }
        }
    }

    // MARK: - Transcript assembly

    /// Bot text arrives on `text` or `outputTranscription`, never both for
    /// one turn.  Mixing the streams would count every word twice.
    private func appendBotText(_ text: String, source: String) {
        lock.lock()
        if let current = botSource, current != source {
            lock.unlock()
            return
        }
        botSource = source
        botText += text
        let bypassed = bypassPending
        let line = botText.trimmingCharacters(in: .whitespacesAndNewlines)
        lock.unlock()
        if !line.isEmpty {
            emitLine(StsTranscriptLine(text: line, from: .bot, final: false, engineBypassed: bypassed))
        }
    }

    private func flushBotTurn(consumeBypass: Bool) {
        lock.lock()
        let text = botText.trimmingCharacters(in: .whitespacesAndNewlines)
        botText = ""
        botSource = nil
        var bypassed = false
        if consumeBypass {
            bypassed = bypassPending
            bypassPending = false
        }
        lock.unlock()
        if !text.isEmpty {
            emitLine(StsTranscriptLine(text: text, from: .bot, final: true, engineBypassed: bypassed))
        }
    }

    private func flushUserTurn() {
        lock.lock()
        let text = userText.trimmingCharacters(in: .whitespacesAndNewlines)
        userText = ""
        lock.unlock()
        if !text.isEmpty {
            emitLine(StsTranscriptLine(text: text, from: .user, final: true))
        }
    }

    // MARK: - Engine tool

    private func runToolCall(id: String?, name: String?, args: [String: Any]) {
        lock.lock()
        let engine = self.engine
        let timeoutMs = self.engineTimeoutMs
        let gen = self.generation
        let key = id ?? UUID().uuidString
        let seen = handledCalls.contains(key)
        if !seen { handledCalls.insert(key) }
        lock.unlock()
        guard !seen, let engine else { return }
        _ = name
        let decoded: [String: AnyCodable]
        if let data = try? JSONSerialization.data(withJSONObject: args),
           let parsed = try? JSONDecoder().decode([String: AnyCodable].self, from: data) {
            decoded = parsed
        } else {
            decoded = [:]
        }
        Task {
            do {
                let reply = try await withThrowingTaskGroup(of: String.self) { group in
                    group.addTask { try await engine.run(decoded) }
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
                self.respondToTool(id: id, result: ["result": reply])
            } catch {
                self.lock.lock()
                let alive = !self.stopped && self.generation == gen
                if alive { self.bypassPending = true }
                self.lock.unlock()
                guard alive else { return }
                // Timeout or rejection: degrade this turn, keep the call up.
                // The bypass marker rides the next bot line, not this one.
            }
        }
    }

    private func respondToTool(id: String?, result: [String: String]) {
        send([
            "toolResponse": [
                "functionResponses": [[
                    "id": id as Any,
                    "name": StsEngineInstructions.toolName,
                    "response": result,
                ]],
            ],
        ])
    }

    // MARK: - Helpers

    /// Ephemeral, and also uncached.  The access token is in the URL
    /// because Gemini requires it there.  Nothing in this session should
    /// write that URL to a cookie jar or an HTTP cache.
    private static func makeSocketSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }

    private func resolveSetup() {
        lock.lock()
        guard let pending = setupContinuation else {
            lock.unlock()
            return
        }
        setupContinuation = nil
        setupTimer?.cancel()
        setupTimer = nil
        lock.unlock()
        pending.resume()
    }

    private func failStart() {
        lock.lock()
        starting = false
        lock.unlock()
    }

    private func tearDown(_ reason: String) {
        lock.lock()
        guard !stopped, !ended else {
            lock.unlock()
            return
        }
        ended = true
        generation += 1
        let handlers = Array(closedHandlers.values)
        lock.unlock()
        for handler in handlers { handler(reason) }
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
}

/// The engine-tool contract both providers share, in one place so the two
/// session files cannot drift on a name or a preamble.
public enum StsEngineInstructions {
    public static let toolName = "bot_engine"
    public static let preamble =
        "Before calling any tool, say one short line such as \"Let me check that.\" and call the tool immediately."
    public static let bypass =
        "The bot's engine is unavailable right now. Answer this turn yourself, from your own knowledge, without mentioning tools or the engine."
}
