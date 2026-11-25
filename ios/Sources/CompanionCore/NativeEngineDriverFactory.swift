import Foundation

/// Errors from building a native engine driver out of the 13-engine matrix (`BF-2689`).
public enum NativeEngineDriverFactoryError: LocalizedError, Equatable, Sendable {
    /// The engine has no native Swift driver yet (HTTPS API engines and ACP engines other than grok, mcode and muse).
    case noNativeDriver(engineId: String)
    /// The matrix row names no executable to launch.
    case missingExecutable(engineId: String)
    /// The engine has a native driver, but this host has no owned-process
    /// launcher to run it with (off macOS).  Distinct from `noNativeDriver`
    /// so callers can tell an unsupported engine from a missing platform
    /// launcher.
    case missingLauncher(engineId: String)

    public var errorDescription: String? {
        switch self {
        case .noNativeDriver(let engineId):
            return "Engine '\(engineId)' has no native Swift driver yet."
        case .missingExecutable(let engineId):
            return "Engine '\(engineId)' names no executable."
        case .missingLauncher(let engineId):
            return "Engine '\(engineId)' has a native driver, but this host has no process launcher for it."
        }
    }
}

/// Builds the real native `EngineDriver` for a matrix row, so the Mac composition can register
/// drivers by engine id instead of hand-constructing each runner (`BF-2689` Slice 2).
public enum NativeEngineDriverFactory {
    /// Engines that have a native driver today.
    public static let supportedEngines: [EngineMatrixID] = [
        .antigravity, .claude, .codex, .grokAcp, .mcode, .muse,
    ]

    public static func supports(_ id: EngineMatrixID) -> Bool {
        supportedEngines.contains(id)
    }

    /// Creates the driver for `id`.  `launcher` must be the runtime's owned-process launcher
    /// so its processes are visible to `processFinished` waits.
    public static func makeDriver(
        for id: EngineMatrixID,
        launcher: any EngineProcessLauncher,
        executableOverride: String? = nil
    ) throws -> any EngineDriver {
        let descriptor = EngineMatrixRegistry.descriptor(for: id)
        guard supports(id) else {
            throw NativeEngineDriverFactoryError.noNativeDriver(engineId: id.rawValue)
        }
        guard let executable = executableOverride ?? descriptor.executable,
              !executable.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw NativeEngineDriverFactoryError.missingExecutable(engineId: id.rawValue)
        }
        switch id {
        case .antigravity:
            return AntigravityStreamRunner(engineId: id.rawValue, executable: executable, launcher: launcher)
        case .claude:
            return ClaudeStreamRunner(engineId: id.rawValue, executable: executable, launcher: launcher)
        case .codex:
            return CodexAppServerRunner(engineId: id.rawValue, executable: executable, launcher: launcher)
        case .grokAcp:
            return AcpProcessRunner(harnessKind: .grok, engineId: id.rawValue, executable: executable, launcher: launcher)
        case .mcode:
            return AcpProcessRunner(harnessKind: .mcode, engineId: id.rawValue, executable: executable, launcher: launcher)
        case .muse:
            return AcpProcessRunner(harnessKind: .muse, engineId: id.rawValue, executable: executable, launcher: launcher)
        default:
            throw NativeEngineDriverFactoryError.noNativeDriver(engineId: id.rawValue)
        }
    }
}

extension NativeMacCompanionRuntime {
    /// Registers a bot on a matrix engine with its real native driver, on the runtime's own
    /// owned-process launcher.  Fails closed when the engine has no native driver or no launcher exists
    /// (off macOS).
    public func registerBot(
        _ profile: MacBotExecutionProfile,
        matrixEngine id: EngineMatrixID
    ) async throws {
        guard let launcher = ownedProcessLauncher else {
            throw NativeEngineDriverFactoryError.missingLauncher(engineId: id.rawValue)
        }
        let driver = try NativeEngineDriverFactory.makeDriver(for: id, launcher: launcher)
        let resolved = MacBotExecutionProfile(
            id: profile.id,
            threadId: profile.threadId,
            engineId: driver.engineId,
            modelId: profile.modelId ?? EngineMatrixRegistry.descriptor(for: id).defaultModel
        )
        try await registerBot(resolved, driver: driver)
    }
}
