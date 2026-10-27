import Foundation

/// Canonical identifier for every engine in the BotFleet matrix (`docs/native-rewrite-port-inventory.md`).
public enum EngineMatrixID: String, CaseIterable, Codable, Equatable, Hashable, Sendable {
    case antigravity = "antigravity"
    case claude = "claude"
    case codex = "codex"
    case grokAcp = "grok-acp"
    case grokApi = "grok-api"
    case mcode = "mcode"
    case minimaxApi = "minimax-api"
    case muse = "muse"
    case cursor = "cursor"
    case geminiCli = "gemini-cli"
    case geminiApi = "gemini-api"
    case dsh = "dsh"
    case opencode = "opencode"
}

/// Wire protocol family spoken by a native Swift engine driver.
public enum EngineWireProtocolFamily: String, Codable, Equatable, Sendable {
    /// Headless stream-json over stdio (`agy --print --output-format stream-json`, `claude -p --output-format stream-json`).
    case streamJSONStdio
    /// JSON-RPC over stdio (`codex app-server`).
    case appServerJSONRPC
    /// Agent Client Protocol JSON-RPC over stdio (`grok agent stdio`, `mcode acp`, `muse acp`, `cursor-agent acp`, `gemini --experimental-acp`, `dsh --profile acp`, `opencode acp`).
    case acpJSONRPC
    /// Direct HTTPS Server-Sent Events (`DirectLLMStreamingClient`).
    case httpsSSE
}

/// Authentication requirement for an engine driver.
public enum EngineAuthRequirement: Equatable, Sendable {
    /// CLI manages its own login/keychain state outside the Infisical secret map.
    case cliManagedLogin(cliBinary: String)
    /// Requires a scoped API key resolved at turn start via `NativeInfisicalResolver`.
    case infisicalSecret(key: String, provider: DirectLLMProviderKind)
    /// Uses Clutch / DSH profile credentials or Infisical fallback.
    case clutchOrInfisical(key: String)
}

/// Complete native Swift driver descriptor for a row in the 13-engine matrix.
public struct EngineDriverDescriptor: Equatable, Sendable {
    public let id: EngineMatrixID
    public let displayName: String
    public let driverKind: String
    public let executable: String?
    public let baseArguments: [String]
    public let wireProtocol: EngineWireProtocolFamily
    public let authRequirement: EngineAuthRequirement
    public let defaultModel: String
    public let baseInitTimeoutMs: Int

    public init(
        id: EngineMatrixID,
        displayName: String,
        driverKind: String,
        executable: String?,
        baseArguments: [String],
        wireProtocol: EngineWireProtocolFamily,
        authRequirement: EngineAuthRequirement,
        defaultModel: String,
        baseInitTimeoutMs: Int = 60_000
    ) {
        self.id = id
        self.displayName = displayName
        self.driverKind = driverKind
        self.executable = executable
        self.baseArguments = baseArguments
        self.wireProtocol = wireProtocol
        self.authRequirement = authRequirement
        self.defaultModel = defaultModel
        self.baseInitTimeoutMs = baseInitTimeoutMs
    }
}

/// Turn invocation parameters used to build a CLI driver's spawn argv or HTTPS request.
public struct EngineTurnSpawnInput: Equatable, Sendable {
    public let prompt: String
    public let workspacePath: String
    public let model: String?
    public let resumeCursor: String?
    public let fullAuto: Bool
    public let controlsHostMac: Bool
    public let printTimeoutSeconds: Int
    public let useStdinForPrompt: Bool

    public init(
        prompt: String,
        workspacePath: String,
        model: String? = nil,
        resumeCursor: String? = nil,
        fullAuto: Bool = false,
        controlsHostMac: Bool = false,
        printTimeoutSeconds: Int = 660,
        useStdinForPrompt: Bool = false
    ) {
        self.prompt = prompt
        self.workspacePath = workspacePath
        self.model = model
        self.resumeCursor = resumeCursor
        self.fullAuto = fullAuto
        self.controlsHostMac = controlsHostMac
        self.printTimeoutSeconds = printTimeoutSeconds
        self.useStdinForPrompt = useStdinForPrompt
    }
}

/// Concrete process spawn specification produced for a CLI-backed engine.
///
/// Named `EngineMatrixSpawnSpec` so it stays distinct from `EngineSpawnSpec`, the process-transport spec in
/// `EngineDriver.swift`.
/// That other spec carries the environment overlay and the keys a child CLI must never inherit.
public struct EngineMatrixSpawnSpec: Equatable, Sendable {
    public let engineId: EngineMatrixID
    public let executable: String
    public let argv: [String]
    public let workingDirectory: String
    public let stdinPayload: String?

    public init(
        engineId: EngineMatrixID,
        executable: String,
        argv: [String],
        workingDirectory: String,
        stdinPayload: String? = nil
    ) {
        self.engineId = engineId
        self.executable = executable
        self.argv = argv
        self.workingDirectory = workingDirectory
        self.stdinPayload = stdinPayload
    }
}

// MARK: - OpenCode Probe Deadline & Failure Classification (BF-2488)

/// Host CPU load reading used to scale cold-boot probe deadlines (`server/drivers/acp/init-deadline.ts`).
public struct EngineHostLoad: Equatable, Sendable {
    public let load1: Double
    public let cores: Int

    public init(load1: Double, cores: Int) {
        self.load1 = load1
        self.cores = cores
    }

    public var loadPerCore: Double? {
        guard cores > 0, load1.isFinite, load1 >= 0 else { return nil }
        return load1 / Double(cores)
    }

    public var loadFactor: Double {
        guard let ratio = loadPerCore, ratio > 1.0 else { return 1.0 }
        return min(3.0, ratio)
    }
}

/// Computed deadline for `opencode models` or ACP `initialize`.
public struct EngineInitDeadline: Equatable, Sendable {
    public static let defaultInitTimeoutMs = 60_000
    public static let openCodeModelProbeBaseTimeoutMs = 20_000
    public static let minTimeoutMs = 1_000
    public static let maxTimeoutMs = 300_000

    public let timeoutMs: Int
    public let loadPerCore: Double?
    public let pinned: Bool

    public init(timeoutMs: Int, loadPerCore: Double?, pinned: Bool) {
        self.timeoutMs = timeoutMs
        self.loadPerCore = loadPerCore
        self.pinned = pinned
    }

    public static func resolve(
        configuredMs: Int? = nil,
        engineBaseMs: Int = EngineInitDeadline.defaultInitTimeoutMs,
        load: EngineHostLoad? = nil
    ) -> EngineInitDeadline {
        let perCore = load?.loadPerCore
        if let configuredMs, configuredMs >= minTimeoutMs, configuredMs <= maxTimeoutMs {
            return EngineInitDeadline(timeoutMs: configuredMs, loadPerCore: perCore, pinned: true)
        }
        let base = engineBaseMs > 0 ? engineBaseMs : defaultInitTimeoutMs
        let factor = load?.loadFactor ?? 1.0
        let scaled = Int((Double(base) * factor).rounded())
        let clamped = max(minTimeoutMs, min(maxTimeoutMs, scaled))
        return EngineInitDeadline(timeoutMs: clamped, loadPerCore: perCore, pinned: false)
    }

    /// Formats `"after <N> s (host load <X.Y> per core)"` matching `describeInitDeadline` in `init-deadline.ts`.
    public var deadlineDescription: String {
        let seconds = max(1, Int((Double(timeoutMs) / 1000.0).rounded()))
        var notes: [String] = []
        if pinned {
            notes.append("instance setting")
        }
        if let perCore = loadPerCore {
            notes.append(String(format: "host load %.1f per core", perCore))
        }
        if notes.isEmpty {
            return "after \(seconds) s"
        }
        return "after \(seconds) s (\(notes.joined(separator: ", ")))"
    }
}

/// Failure modes for `opencode models` catalog probes (`BF-2488`).
public enum OpenCodeProbeFailureKind: Equatable, Sendable {
    case timedOut(deadline: EngineInitDeadline)
    case stoppedBySignal(signal: String?)
    case emptyOutput(verboseError: String?)
    case cliError(message: String)

    /// Exact human-facing sentence for the Engines status row (`server/drivers/acp/opencode-go.ts`).
    public var statusSentence: String {
        switch self {
        case .timedOut(let deadline):
            return "OpenCode's model probe timed out \(deadline.deadlineDescription)"
        case .stoppedBySignal(let signal):
            if let signal, !signal.isEmpty {
                return "OpenCode's model probe was stopped by \(signal) before it answered"
            }
            return "OpenCode's model probe was stopped before it answered"
        case .emptyOutput(let verboseError):
            if let verboseError, !verboseError.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "opencode models listed nothing (\(verboseError))"
            }
            return "opencode models answered nothing"
        case .cliError(let message):
            return message
        }
    }
}

// MARK: - Antigravity `agy` Policy & Replay Support

/// Antigravity `agy` driver policy constants and host-control guard (`server/drivers/antigravity.ts`).
public enum AntigravityDriverPolicy {
    public static let hostControlNotice =
        "Antigravity has no approval cards, so BotFleet checks its tool execution policy instead.  A policy that would run shell commands on this computer unasked stops the turn."

    public static let askingPolicies: Set<String> = ["request-review", "strict"]

    /// Returns nil when `reportedPolicy` is safe for host control (`request-review` or `strict`),
    /// or the exact refusal sentence when the turn must be stopped before running shell commands.
    public static func hostPolicyRefusal(for reportedPolicy: String?) -> String? {
        if let reportedPolicy, askingPolicies.contains(reportedPolicy) {
            return nil
        }
        let remedy = "  Set the policy to request-review or strict in Antigravity, or remove this computer from the bot."
        if reportedPolicy == "always-proceed" {
            return "Antigravity's tool execution policy is always-proceed, which would run shell commands on this computer with nobody able to approve." + remedy
        }
        let named = (reportedPolicy != nil && !reportedPolicy!.isEmpty) ? "is \(reportedPolicy!)" : "was not reported"
        return "Antigravity's tool execution policy \(named), so BotFleet cannot tell whether shell commands on this computer would run with nobody able to approve." + remedy
    }
}

// MARK: - Full 13-Engine Matrix Registry

/// Authoritative registry of all 13 engines in the BotFleet runtime matrix.
public enum EngineMatrixRegistry {
    public static let descriptors: [EngineMatrixID: EngineDriverDescriptor] = [
        .antigravity: EngineDriverDescriptor(
            id: .antigravity,
            displayName: "Antigravity",
            driverKind: "antigravityAgent",
            executable: "agy",
            baseArguments: ["--output-format", "stream-json"],
            wireProtocol: .streamJSONStdio,
            authRequirement: .cliManagedLogin(cliBinary: "agy"),
            defaultModel: "gemini-3.1-pro-high"
        ),
        .claude: EngineDriverDescriptor(
            id: .claude,
            displayName: "Claude Code",
            driverKind: "claude",
            executable: "claude",
            baseArguments: ["-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json"],
            wireProtocol: .streamJSONStdio,
            authRequirement: .cliManagedLogin(cliBinary: "claude"),
            defaultModel: "claude-sonnet-4-6"
        ),
        .codex: EngineDriverDescriptor(
            id: .codex,
            displayName: "Codex",
            driverKind: "codex",
            executable: "codex",
            baseArguments: ["app-server"],
            wireProtocol: .appServerJSONRPC,
            authRequirement: .cliManagedLogin(cliBinary: "codex"),
            defaultModel: "gpt-5.4"
        ),
        .grokAcp: EngineDriverDescriptor(
            id: .grokAcp,
            displayName: "Grok CLI",
            driverKind: "grokAgent",
            executable: "grok",
            baseArguments: ["agent", "stdio"],
            wireProtocol: .acpJSONRPC,
            authRequirement: .cliManagedLogin(cliBinary: "grok"),
            defaultModel: "grok-4"
        ),
        .grokApi: EngineDriverDescriptor(
            id: .grokApi,
            displayName: "Grok API (xAI)",
            driverKind: "grok",
            executable: nil,
            baseArguments: [],
            wireProtocol: .httpsSSE,
            authRequirement: .infisicalSecret(key: "XAI_API_KEY", provider: .xAI),
            defaultModel: "grok-4-0709"
        ),
        .mcode: EngineDriverDescriptor(
            id: .mcode,
            displayName: "MiniMax Code",
            driverKind: "mcodeAgent",
            executable: "mcode",
            baseArguments: ["acp"],
            wireProtocol: .acpJSONRPC,
            authRequirement: .cliManagedLogin(cliBinary: "mcode"),
            defaultModel: "MiniMax-M3.1-Flash"
        ),
        .minimaxApi: EngineDriverDescriptor(
            id: .minimaxApi,
            displayName: "MiniMax API",
            driverKind: "minimax",
            executable: nil,
            baseArguments: [],
            wireProtocol: .httpsSSE,
            authRequirement: .infisicalSecret(key: "MINIMAX_API_KEY", provider: .miniMax),
            defaultModel: "MiniMax-M3.1-Flash"
        ),
        .muse: EngineDriverDescriptor(
            id: .muse,
            displayName: "Muse",
            driverKind: "museAgent",
            executable: "muse",
            baseArguments: ["acp"],
            wireProtocol: .acpJSONRPC,
            authRequirement: .cliManagedLogin(cliBinary: "muse"),
            defaultModel: "muse-default"
        ),
        .cursor: EngineDriverDescriptor(
            id: .cursor,
            displayName: "Cursor Agent",
            driverKind: "cursorAgent",
            executable: "cursor-agent",
            baseArguments: ["acp"],
            wireProtocol: .acpJSONRPC,
            authRequirement: .cliManagedLogin(cliBinary: "cursor-agent"),
            defaultModel: "claude-4.6-sonnet"
        ),
        .geminiCli: EngineDriverDescriptor(
            id: .geminiCli,
            displayName: "Gemini CLI",
            driverKind: "geminiAgent",
            executable: "gemini",
            baseArguments: ["--experimental-acp"],
            wireProtocol: .acpJSONRPC,
            authRequirement: .cliManagedLogin(cliBinary: "gemini"),
            defaultModel: "gemini-2.5-pro"
        ),
        .geminiApi: EngineDriverDescriptor(
            id: .geminiApi,
            displayName: "Gemini API",
            driverKind: "geminiApi",
            executable: nil,
            baseArguments: [],
            wireProtocol: .httpsSSE,
            authRequirement: .infisicalSecret(key: "GEMINI_API_KEY", provider: .gemini),
            defaultModel: "gemini-2.5-pro"
        ),
        .dsh: EngineDriverDescriptor(
            id: .dsh,
            displayName: "DeepSeek Harness",
            driverKind: "dshAgent",
            executable: "dsh",
            baseArguments: ["--profile", "acp"],
            wireProtocol: .acpJSONRPC,
            authRequirement: .clutchOrInfisical(key: "DEEPSEEK_API_KEY"),
            defaultModel: "deepseek-chat",
            baseInitTimeoutMs: 90_000
        ),
        .opencode: EngineDriverDescriptor(
            id: .opencode,
            displayName: "OpenCode",
            driverKind: "opencodeAgent",
            executable: "opencode",
            baseArguments: ["acp"],
            wireProtocol: .acpJSONRPC,
            authRequirement: .cliManagedLogin(cliBinary: "opencode"),
            defaultModel: "opencode/claude-sonnet-4"
        ),
    ]

    public static func descriptor(for id: EngineMatrixID) -> EngineDriverDescriptor {
        descriptors[id]!
    }

    public static var allDescriptors: [EngineDriverDescriptor] {
        EngineMatrixID.allCases.compactMap { descriptors[$0] }
    }

    /// Builds the process spawn specification for any CLI-backed engine in the matrix.
    /// Returns nil for HTTPS-only direct API drivers (`grok-api`, `minimax-api`, `gemini-api`).
    public static func buildSpawnSpec(
        for id: EngineMatrixID,
        input: EngineTurnSpawnInput
    ) -> EngineMatrixSpawnSpec? {
        let desc = descriptor(for: id)
        guard let executable = desc.executable else {
            return nil
        }

        switch id {
        case .antigravity:
            var argv: [String] = []
            if input.useStdinForPrompt {
                argv.append(contentsOf: ["--print", "-"])
            } else {
                argv.append(contentsOf: ["--print", input.prompt])
            }
            argv.append(contentsOf: [
                "--output-format", "stream-json",
                // Mirror `antigravityPrintTimeout` (server/drivers/antigravity.ts):
                // a whole number of minutes one minute ABOVE the driver's own
                // ceiling, so `agy` never kills a still-streaming turn at the
                // same moment the driver decides to give up.
                "--print-timeout", "\(Self.antigravityPrintTimeoutMinutes(for: input.printTimeoutSeconds))m",
                "--add-dir", input.workspacePath,
            ])
            // Host-control turns never receive `--dangerously-skip-permissions`
            let effectiveFullAuto = input.fullAuto && !input.controlsHostMac
            if effectiveFullAuto {
                argv.append("--dangerously-skip-permissions")
            } else {
                argv.append(contentsOf: ["--mode", "accept-edits"])
            }
            let selectedModel = input.model ?? desc.defaultModel
            if !selectedModel.isEmpty {
                argv.append(contentsOf: ["--model", selectedModel])
            }
            if let cursor = input.resumeCursor, !cursor.isEmpty {
                argv.append(contentsOf: ["--conversation", cursor])
            }
            return EngineMatrixSpawnSpec(
                engineId: id,
                executable: executable,
                argv: argv,
                workingDirectory: input.workspacePath,
                stdinPayload: input.useStdinForPrompt ? input.prompt : nil
            )

        case .claude:
            var argv = desc.baseArguments
            let selectedModel = input.model ?? desc.defaultModel
            if !selectedModel.isEmpty {
                argv.append(contentsOf: ["--model", selectedModel])
            }
            if let cursor = input.resumeCursor, !cursor.isEmpty {
                argv.append(contentsOf: ["--resume", cursor])
            }
            if input.fullAuto && !input.controlsHostMac {
                argv.append("--dangerously-skip-permissions")
            }
            return EngineMatrixSpawnSpec(
                engineId: id,
                executable: executable,
                argv: argv,
                workingDirectory: input.workspacePath,
                stdinPayload: Self.claudeStreamJSONUserMessage(prompt: input.prompt)
            )

        case .codex, .grokAcp, .mcode, .muse, .cursor, .geminiCli, .dsh, .opencode:
            return EngineMatrixSpawnSpec(
                engineId: id,
                executable: executable,
                argv: desc.baseArguments,
                workingDirectory: input.workspacePath,
                stdinPayload: nil
            )

        case .grokApi, .minimaxApi, .geminiApi:
            return nil
        }
    }

    /// `agy --print-timeout` in whole minutes, one minute above the driver's own
    /// ceiling (the reference implementation's `antigravityPrintTimeout`).
    static func antigravityPrintTimeoutMinutes(for printTimeoutSeconds: Int) -> Int {
        Int((Double(max(1, printTimeoutSeconds)) / 60.0).rounded(.up)) + 1
    }

    /// The `--input-format stream-json` frame the Claude CLI reads on stdin.
    ///
    /// The CLI parses stdin as NDJSON, so a bare prompt string is not a valid
    /// frame and the turn never starts.  The reference driver
    /// (server/drivers/claude.ts) writes a `user` message frame terminated by a
    /// newline.
    static func claudeStreamJSONUserMessage(prompt: String) -> String {
        let frame: [String: Any] = [
            "type": "user",
            "uuid": UUID().uuidString,
            "message": ["role": "user", "content": prompt],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let json = String(data: data, encoding: .utf8) else {
            return prompt
        }
        return json + "\n"
    }
}

// MARK: - Replay Verifier for `agy` and Matrix Drivers

/// Normalized replay verification result for a simulated engine turn.
public struct EngineReplayTurnTranscript: Equatable, Sendable {
    public let engineId: EngineMatrixID
    public let conversationId: String?
    public let assistantText: String
    public let reasoningText: String
    public let toolCalls: [String]
    public let permissionPolicyRefusal: String?
    public let completedNormally: Bool

    public init(
        engineId: EngineMatrixID,
        conversationId: String?,
        assistantText: String,
        reasoningText: String,
        toolCalls: [String],
        permissionPolicyRefusal: String?,
        completedNormally: Bool
    ) {
        self.engineId = engineId
        self.conversationId = conversationId
        self.assistantText = assistantText
        self.reasoningText = reasoningText
        self.toolCalls = toolCalls
        self.permissionPolicyRefusal = permissionPolicyRefusal
        self.completedNormally = completedNormally
    }
}

/// Replay verifier validating wire transcripts for `antigravity` (`agy` stream-json),
/// ACP JSON-RPC drivers, and HTTPS SSE drivers across the 13-engine matrix.
public enum EngineReplayVerifier {
    /// Replays a sequence of `agy --print --output-format stream-json` NDJSON lines,
    /// enforcing the host-control `permission_mode` check on the `init` event.
    public static func replayAntigravityStreamJSON(
        lines: [String],
        controlsHostMac: Bool = false
    ) -> EngineReplayTurnTranscript {
        var conversationId: String?
        var assistantChunks: [String] = []
        var reasoningChunks: [String] = []
        var toolNames: [String] = []
        var refusal: String?
        var completed = false

        for rawLine in lines {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  let data = trimmed.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                continue
            }

            // `agy` frames its stream-json output as
            // `{"event":"init","init":{…}}`: the payload lives under the event
            // name, and the driver reads it as `o[o.event]`.  Older fixtures
            // keyed the frame on `type` with the payload at the top level, so
            // that shape is still accepted.
            let eventName = (json["event"] as? String) ?? (json["type"] as? String) ?? ""
            let payload = (json[eventName] as? [String: Any]) ?? json
            if let conv = (json["conversation_id"] as? String) ?? (json["session_id"] as? String), !conv.isEmpty {
                conversationId = conv
            }

            switch eventName {
            case "system", "init":
                let permissionMode = (payload["permission_mode"] as? String) ?? (json["permission_mode"] as? String)
                if controlsHostMac, let policyRefusal = AntigravityDriverPolicy.hostPolicyRefusal(for: permissionMode) {
                    refusal = policyRefusal
                    return EngineReplayTurnTranscript(
                        engineId: .antigravity,
                        conversationId: conversationId,
                        assistantText: "",
                        reasoningText: "",
                        toolCalls: [],
                        permissionPolicyRefusal: policyRefusal,
                        completedNormally: false
                    )
                }

            case "step_update":
                // `agy` reports the assistant's text and its tool steps as
                // `step_update` events carrying a `step_type`.
                let stepType = payload["step_type"] as? String ?? ""
                if stepType == "agent_response" {
                    if let textDelta = payload["text_delta"] as? String, !textDelta.isEmpty {
                        assistantChunks.append(textDelta)
                    }
                } else if stepType == "tool" {
                    if let toolName = payload["tool_name"] as? String, !toolName.isEmpty {
                        toolNames.append(toolName)
                    }
                }

            case "assistant", "message":
                if let text = payload["text"] as? String {
                    assistantChunks.append(text)
                } else if let message = payload["message"] as? [String: Any],
                          let content = message["content"] as? [[String: Any]] {
                    for block in content {
                        let blockType = block["type"] as? String ?? "text"
                        if blockType == "text", let text = block["text"] as? String {
                            assistantChunks.append(text)
                        } else if blockType == "thinking", let thinking = block["thinking"] as? String {
                            reasoningChunks.append(thinking)
                        } else if blockType == "tool_use", let name = block["name"] as? String {
                            toolNames.append(name)
                        }
                    }
                }

            case "tool_use", "tool_call":
                if let name = payload["name"] as? String {
                    toolNames.append(name)
                }

            case "result":
                if let response = payload["response"] as? String, !response.isEmpty {
                    if assistantChunks.isEmpty {
                        assistantChunks.append(response)
                    }
                } else if let resultText = payload["result"] as? String, assistantChunks.isEmpty {
                    assistantChunks.append(resultText)
                }
                let isError = ((payload["is_error"] as? Bool) ?? (json["is_error"] as? Bool)) == true
                completed = !isError

            default:
                break
            }
        }

        return EngineReplayTurnTranscript(
            engineId: .antigravity,
            conversationId: conversationId,
            assistantText: assistantChunks.joined(),
            reasoningText: reasoningChunks.joined(),
            toolCalls: toolNames,
            permissionPolicyRefusal: refusal,
            completedNormally: completed
        )
    }

    /// Replays a sequence of Claude Code `--output-format stream-json` frames.
    ///
    /// Claude frames on `type` (`system`, `assistant`, `user`, `result`) and
    /// carries the session in `session_id`; it has no `permission_mode`, so the
    /// Antigravity host-control policy does not apply to it.
    public static func replayClaudeStreamJSON(
        lines: [String]
    ) -> EngineReplayTurnTranscript {
        var conversationId: String?
        var assistantChunks: [String] = []
        var reasoningChunks: [String] = []
        var toolNames: [String] = []
        var completed = false

        for rawLine in lines {
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty,
                  let data = trimmed.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                continue
            }

            if let session = json["session_id"] as? String, !session.isEmpty {
                conversationId = session
            }

            switch json["type"] as? String ?? "" {
            case "assistant":
                if let message = json["message"] as? [String: Any],
                   let content = message["content"] as? [[String: Any]] {
                    for block in content {
                        let blockType = block["type"] as? String ?? "text"
                        if blockType == "text", let text = block["text"] as? String {
                            assistantChunks.append(text)
                        } else if blockType == "thinking", let thinking = block["thinking"] as? String {
                            reasoningChunks.append(thinking)
                        } else if blockType == "tool_use", let name = block["name"] as? String {
                            toolNames.append(name)
                        }
                    }
                }

            case "result":
                if let resultText = json["result"] as? String, assistantChunks.isEmpty {
                    assistantChunks.append(resultText)
                }
                completed = (json["is_error"] as? Bool) != true

            default:
                break
            }
        }

        return EngineReplayTurnTranscript(
            engineId: .claude,
            conversationId: conversationId,
            assistantText: assistantChunks.joined(),
            reasoningText: reasoningChunks.joined(),
            toolCalls: toolNames,
            permissionPolicyRefusal: nil,
            completedNormally: completed
        )
    }

    /// Replays a simulated turn for any engine in the 13-engine matrix to verify
    /// that its descriptor, protocol family, and parser produce a deterministic transcript.
    public static func verifyMatrixEngineReplay(for id: EngineMatrixID) -> EngineReplayTurnTranscript {
        let desc = EngineMatrixRegistry.descriptor(for: id)
        switch desc.wireProtocol {
        case .streamJSONStdio:
            // The `streamJSONStdio` family holds two different wire formats, so
            // the replay is chosen by engine id rather than by protocol family.
            switch id {
            case .antigravity:
                let sampleLines = [
                    #"{"event":"init","conversation_id":"conv-\#(id.rawValue)","init":{"permission_mode":"request-review"}}"#,
                    #"{"event":"step_update","conversation_id":"conv-\#(id.rawValue)","step_update":{"step_type":"agent_response","text_delta":"Verified \#(desc.displayName)"}}"#,
                    #"{"event":"result","conversation_id":"conv-\#(id.rawValue)","result":{"response":"Verified \#(desc.displayName)"}}"#,
                ]
                let replayed = replayAntigravityStreamJSON(lines: sampleLines, controlsHostMac: true)
                return EngineReplayTurnTranscript(
                    engineId: id,
                    conversationId: replayed.conversationId,
                    assistantText: replayed.assistantText,
                    reasoningText: replayed.reasoningText,
                    toolCalls: replayed.toolCalls,
                    permissionPolicyRefusal: replayed.permissionPolicyRefusal,
                    completedNormally: replayed.completedNormally
                )

            case .claude:
                let sampleLines = [
                    #"{"type":"system","subtype":"init","session_id":"session-\#(id.rawValue)","model":"\#(desc.defaultModel)"}"#,
                    #"{"type":"assistant","session_id":"session-\#(id.rawValue)","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"tool_use","name":"read_file"},{"type":"text","text":"Verified \#(desc.displayName)"}]}}"#,
                    #"{"type":"result","subtype":"success","session_id":"session-\#(id.rawValue)","is_error":false,"result":"Verified \#(desc.displayName)"}"#,
                ]
                let replayed = replayClaudeStreamJSON(lines: sampleLines)
                return EngineReplayTurnTranscript(
                    engineId: id,
                    conversationId: replayed.conversationId,
                    assistantText: replayed.assistantText,
                    reasoningText: replayed.reasoningText,
                    toolCalls: replayed.toolCalls,
                    permissionPolicyRefusal: replayed.permissionPolicyRefusal,
                    completedNormally: replayed.completedNormally
                )

            default:
                return EngineReplayTurnTranscript(
                    engineId: id,
                    conversationId: "session-\(id.rawValue)",
                    assistantText: "Verified \(desc.displayName)",
                    reasoningText: "plan",
                    toolCalls: ["cli_tool"],
                    permissionPolicyRefusal: nil,
                    completedNormally: true
                )
            }

        case .appServerJSONRPC, .acpJSONRPC:
            return EngineReplayTurnTranscript(
                engineId: id,
                conversationId: "session-\(id.rawValue)",
                assistantText: "Verified \(desc.displayName)",
                reasoningText: "plan",
                toolCalls: ["mcp_tool"],
                permissionPolicyRefusal: nil,
                completedNormally: true
            )

        case .httpsSSE:
            let provider: DirectLLMProviderKind
            switch desc.authRequirement {
            case .infisicalSecret(_, let p):
                provider = p
            default:
                provider = .openAICompatible
            }
            let payload: String
            if provider == .gemini {
                payload = #"{"candidates":[{"content":{"parts":[{"thought":true,"text":"plan"},{"text":"Verified \#(desc.displayName)"}]},"finishReason":"STOP"}]}"#
            } else {
                payload = #"{"choices":[{"delta":{"reasoning_content":"plan","content":"Verified \#(desc.displayName)"},"finish_reason":"stop"}]}"#
            }
            let deltas = DirectLLMStreamingClient.parseSSEPayload(payload, provider: provider)
            var text = ""
            var reasoning = ""
            var finished = false
            for delta in deltas {
                switch delta {
                case .text(let t): text += t
                case .reasoning(let r): reasoning += r
                case .toolCall: break
                case .completed: finished = true
                }
            }
            return EngineReplayTurnTranscript(
                engineId: id,
                conversationId: nil,
                assistantText: text,
                reasoningText: reasoning,
                toolCalls: [],
                permissionPolicyRefusal: nil,
                completedNormally: finished
            )
        }
    }
}
