// The provider-agnostic seam a voice call runs on.
//
// A port of `StsSession` in src/lib/sts/types.ts: the call flow never
// branches on vendor.  An STS provider replaces the whole chained loop --
// capture, understanding and speech are one duplex session with the model --
// so this is deliberately a different seam from dictation rather than a mode
// on it.
//
// Contract, same as the desktop:
//  * `start` resolves once the session can accept audio ("ready").
//  * Audio before ready is dropped, not buffered.
//  * `stop` is idempotent.
//  * Listeners attach before `start` so nothing is missed mid-handshake.
//  * The permanent provider key never comes near this file: the socket opens
//    with the short-lived token from `POST /api/sts/token`.
import Foundation
import CompanionCore

public enum StsProviderKind: String, Hashable, Sendable {
    case xai
    case gemini

    /// The realtime model each provider documents for this path.
    public var realtimeModel: String {
        switch self {
        case .xai: return "grok-voice-latest"
        case .gemini: return "gemini-3.8-live"
        }
    }
}

/// One duplex speech session with a provider.  Implementations own their
/// socket, their playback queue, and their engine-tool calls; the call
/// orchestrator owns capture, the transcript fold, and approvals.
public protocol StsSession: AnyObject, Sendable {
    var provider: StsProviderKind { get }
    /// Open the transport and complete the vendor handshake.
    func start(options: StsStartOptions) async throws
    /// One 16 kHz mono PCM16 chunk.  Dropped before ready; never throws into
    /// the capture loop.
    func sendAudio(_ pcm: Data)
    /// Cut the bot off mid-reply and hand the floor to the caller.
    ///
    /// The providers already do this by themselves when their voice activity
    /// detection reports speech; this is the same action, on the seam, for the
    /// call's Interrupt control and for any provider whose detection lags.  It
    /// lives here rather than on the call because only the session knows what
    /// to tell the vendor: how much of the reply was actually heard, and how to
    /// stop the turn it is still generating.  Silencing the speaker alone leaves
    /// the model finishing an utterance nobody hears, which is the failure the
    /// truncate exists to prevent.
    func interrupt()
    /// Tear everything down.  Safe to call twice and safe to call before
    /// start resolves.
    func stop() async
    /// A turn the transcript should show.  Provisional user lines arrive with
    /// `final == false` and are replaced, not stacked (see StsTranscript).
    func onLine(_ handler: @escaping @Sendable (StsTranscriptLine) -> Void) -> () -> Void
    func onError(_ handler: @escaping @Sendable (Error) -> Void) -> () -> Void
    /// The session is ending on its own (vendor go-away, token expiry).
    /// A stop() of ours never fires this.
    func onClosed(_ handler: @escaping @Sendable (String) -> Void) -> () -> Void
}

/// What a session starts with.  The engine tool is how the model does real
/// work: a coding agent with a workspace is not a persona, so the model is
/// handed the bot's own engine as a function and resolves with its reply.
public struct StsStartOptions: Sendable {
    /// Persona / system prompt, already composed by the caller.
    public var instructions: String
    /// The engine tool, if the bot has an engine on this call.
    public var engine: StsEngineTool?
    /// Milliseconds before the engine call is abandoned and the model
    /// answers alone (with the bypass marked on the line).
    public var engineTimeoutMs: Int
    public var language: String?

    public init(instructions: String, engine: StsEngineTool? = nil, engineTimeoutMs: Int = 10_000, language: String? = nil) {
        self.instructions = instructions
        self.engine = engine
        self.engineTimeoutMs = engineTimeoutMs
        self.language = language
    }
}

public struct StsEngineTool: Sendable {
    public var name: String
    public var description: String
    /// JSON Schema for the tool's parameters.
    public var parameters: [String: AnyCodable]
    public var run: @Sendable ([String: AnyCodable]) async throws -> String

    public init(
        name: String,
        description: String,
        parameters: [String: AnyCodable],
        run: @escaping @Sendable ([String: AnyCodable]) async throws -> String
    ) {
        self.name = name
        self.description = description
        self.parameters = parameters
        self.run = run
    }
}

/// A JSON value that survives the Sendable boundary for tool schemas and
/// arguments.  Schemas are authored by the harness; this is carriage, not
/// validation.
public enum AnyCodable: Hashable, Sendable, Codable {
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([AnyCodable])
    case object([String: AnyCodable])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let int = try? container.decode(Int.self) {
            self = .int(int)
        } else if let double = try? container.decode(Double.self) {
            self = .double(double)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([AnyCodable].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: AnyCodable].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .bool(value): try container.encode(value)
        case let .int(value): try container.encode(value)
        case let .double(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    /// Plain value for handing to JSONSerialization-based senders.
    public var jsonValue: Any {
        switch self {
        case let .bool(value): return value
        case let .int(value): return value
        case let .double(value): return value
        case let .string(value): return value
        case let .array(value): return value.map(\.jsonValue)
        case let .object(value): return value.mapValues(\.jsonValue)
        case .null: return NSNull()
        }
    }
}
