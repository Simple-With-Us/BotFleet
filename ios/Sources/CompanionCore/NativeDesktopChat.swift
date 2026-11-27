import Foundation

/// The Mac app's one native runtime, shared by the chat window and the
/// companion listener (`BF-2705`, slice 2b).
///
/// The store and runtime open on the first `open()`, from whichever of the
/// two asks first, and every later call returns the same graph: one database
/// connection, one engine coordinator and one engine switch.  A chat turn and
/// a phone's wait follow-up are then admitted by the same rules and counted by
/// the same quit-time drain.  The stored bots are registered once, when the
/// runtime opens.  A build that throws opens nothing, and the next call tries
/// again.
///
/// An optional `prepare` step runs on the opened store before that
/// registration (`BF-2710`): the Mac app passes the first-launch import of its
/// legacy Node stores, so imported bots register in the same pass.
public final class NativeMacRuntimeHost: @unchecked Sendable {
    /// The opened graph.
    public struct Opened: Sendable {
        public let database: DatabaseService
        public let runtime: NativeMacCompanionRuntime
        /// The one registration of the stored bots, started when the
        /// runtime opened.  Await its value to know which bots have a
        /// native profile and driver.
        public let registration: Task<MacBotRegistrationReport, Never>
    }

    /// Opens the store and builds the runtime over it.  Runs at most once
    /// successfully.
    public typealias Build = @Sendable () throws -> (database: DatabaseService, runtime: NativeMacCompanionRuntime)

    /// Runs once on the opened store, before the stored bots register.
    public typealias Prepare = @Sendable (DatabaseService) async -> Void

    private let lock = NSLock()
    private var opened: Opened?
    private let build: Build
    private let prepare: Prepare?

    public init(prepare: Prepare? = nil, build: @escaping Build) {
        self.prepare = prepare
        self.build = build
    }

    /// The shared graph, opening it on the first call.
    public func open() throws -> Opened {
        lock.lock()
        defer { lock.unlock() }
        if let opened { return opened }
        let built = try build()
        let runtime = built.runtime
        let database = built.database
        let prepare = self.prepare
        let value = Opened(
            database: database,
            runtime: runtime,
            registration: Task {
                await prepare?(database)
                return await runtime.registerStoredBots()
            }
        )
        opened = value
        return value
    }

    /// The opened graph, or nil while nothing has opened it.  An empty host
    /// honestly reads as nothing to drain.
    public var current: Opened? {
        lock.lock()
        defer { lock.unlock() }
        return opened
    }
}

/// A registered bot the chat window could not move onto the native runtime,
/// and why.  It stays fenced: a message to it is refused as
/// `.runtimeNotNative`, never answered by a guess.
public struct NativeDesktopCutoverSkip: Equatable, Sendable {
    public let botId: String
    public let reason: String

    public init(botId: String, reason: String) {
        self.botId = botId
        self.reason = reason
    }
}

/// What opening the chat window on the native engine found.
public struct NativeDesktopChatStart: Sendable {
    /// The fleet the window hydrates from, and the stored bots left out.
    public let snapshot: NativeDesktopFleetSnapshot
    /// Which stored bots registered a native profile and driver.
    public let registration: MacBotRegistrationReport
    /// Bots the native runtime now answers.
    public let nativeBots: [String]
    /// A registered bot that stayed fenced on the Node runtime, with the reason.
    public let cutoverSkipped: [NativeDesktopCutoverSkip]
}

/// Errors raised when creating a native bot for a standalone desktop install
/// without the Node harness (`BF-2689`).
public enum NativeDesktopCreateBotError: LocalizedError, Equatable, Sendable {
    case unsupportedEngine(String)
    case encodingFailed

    public var errorDescription: String? {
        switch self {
        case .unsupportedEngine(let engineId):
            return "Engine '\(engineId)' has no native driver on this Mac yet."
        case .encodingFailed:
            return "The new bot record could not be encoded."
        }
    }
}

/// The Mac app's chat window on the native engine (`BF-2705`, slice 2b), for
/// a Mac whose Node harness is no longer installed.
///
/// `start()` moves every registered bot onto the native runtime and reads
/// the fleet from the native store.  `send` runs one message as a native turn
/// and returns the frames the window folds into `CompanionState`, the same
/// fold the harness's event stream feeds.
///
/// Moving a bot onto the native runtime lifts the fence that keeps two
/// runtimes from answering one bot.  That is only right when the Node harness
/// cannot answer it, so the caller starts this only when the harness's
/// LaunchAgent is not installed, never beside a running harness.  Bots are
/// moved with their main thread only: the history is already in the native
/// store, and the switch's parity check confirms the thread is there.
public struct NativeDesktopChat: Sendable {
    private let database: DatabaseService
    private let runtime: NativeMacCompanionRuntime
    private let registration: @Sendable () async -> MacBotRegistrationReport
    private let service: NativeDesktopChatService
    private let source: NativeDesktopFleetSource

    public init(opened: NativeMacRuntimeHost.Opened) {
        let task = opened.registration
        self.init(database: opened.database, runtime: opened.runtime, registration: { await task.value })
    }

    init(
        database: DatabaseService,
        runtime: NativeMacCompanionRuntime,
        registration: @escaping @Sendable () async -> MacBotRegistrationReport
    ) {
        self.database = database
        self.runtime = runtime
        self.registration = registration
        self.service = runtime.makeDesktopChatService()
        self.source = NativeDesktopFleetSource(database: database)
    }

    /// Waits for the stored bots to register, moves each registered bot onto
    /// the native runtime, then reads the fleet.  A bot that cannot move is
    /// named in `cutoverSkipped` and costs no other bot its move.  Throws only
    /// when the store's bot table cannot be read at all.
    public func start() async throws -> NativeDesktopChatStart {
        let report = await registration()
        let engineSwitch = runtime.runtime.engineSwitch
        var nativeBots: [String] = []
        var skipped: [NativeDesktopCutoverSkip] = []
        for botId in report.registered {
            if await engineSwitch.owner(for: botId) == .nativeSwift {
                nativeBots.append(botId)
                continue
            }
            guard let profile = await runtime.macExecutionContext.registeredProfile(forBotId: botId) else {
                skipped.append(NativeDesktopCutoverSkip(botId: botId, reason: "no native profile is registered for it"))
                continue
            }
            do {
                guard let thread = try await database.loadThread(id: profile.threadId), thread.botId == botId else {
                    skipped.append(NativeDesktopCutoverSkip(botId: botId, reason: "its thread is not in the native store"))
                    continue
                }
                try await engineSwitch.switchToNativeSwift(
                    botId: botId,
                    historySnapshot: BotHistoryImportSnapshot(botId: botId, threads: [thread], messagesByThread: [:])
                )
                nativeBots.append(botId)
            } catch {
                skipped.append(NativeDesktopCutoverSkip(botId: botId, reason: String(describing: error)))
            }
        }
        let snapshot = try await source.snapshot()
        return NativeDesktopChatStart(
            snapshot: snapshot,
            registration: report,
            nativeBots: nativeBots,
            cutoverSkipped: skipped
        )
    }

    /// Runs `text` on the bot's thread as a native turn and returns the
    /// window's frames: the live reply as it streams, then the stored
    /// transcript, then the turn's end.  Throws `NativeDesktopChatError` when
    /// a gate refuses the message before any engine runs.  Cancelling the
    /// returned stream cancels the turn; the window then clears its own live
    /// bubble with `CompanionState.clearStream`.
    public func send(botId: String, threadId: String, text: String) async throws -> AsyncStream<Frame> {
        let events = try await service.send(botId: botId, threadId: threadId, text: text)
        let source = self.source
        return NativeDesktopChatFrames.frames(
            from: events,
            threadId: threadId,
            settled: { await source.settledFrames(threadId: threadId) }
        )
    }

    /// The thread's newest stored messages as frames, for showing the
    /// person's own message as soon as the turn has stored it.
    public func settledFrames(threadId: String) async -> [Frame] {
        await source.settledFrames(threadId: threadId)
    }

    /// Creates a new bot directly in the native store, registers its native
    /// execution profile/driver, and moves it onto `.nativeSwift` (`BF-2689`),
    /// so a fresh standalone Mac install with no Node harness can create its
    /// first bot and send a turn immediately without `CompanionClient`.
    public func createBot(
        name: String? = nil,
        engineInstanceId: String = "claude",
        model: String = ""
    ) async throws -> Bot {
        try await createBot(name: name, engineInstanceId: engineInstanceId, model: model, driver: nil)
    }

    func createBot(
        name: String? = nil,
        engineInstanceId: String = "claude",
        model: String = "",
        driver: (any EngineDriver)?
    ) async throws -> Bot {
        let normalizedInstanceId = engineInstanceId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let engine = MacBotProfileDerivation.matrixEngine(forInstanceId: normalizedInstanceId),
              NativeEngineDriverFactory.supports(engine) else {
            throw NativeDesktopCreateBotError.unsupportedEngine(engineInstanceId)
        }
        let existingBots = try await database.loadBots()
        let resolvedName = Self.resolveBotName(requested: name, existing: existingBots)
        let palette = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"]
        let resolvedColor = palette[existingBots.count % palette.count]
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedModel = trimmedModel.isEmpty
            ? EngineMatrixRegistry.descriptor(for: engine).defaultModel
            : trimmedModel

        let botId = "bot-\(UUID().uuidString.lowercased())"
        let threadId = "thread-\(UUID().uuidString.lowercased())"
        let nowSeconds = Date().timeIntervalSince1970
        let bot = Bot(
            id: botId,
            threadId: threadId,
            name: resolvedName,
            title: "",
            description: "",
            notifications: true,
            color: resolvedColor,
            avatarUrl: nil,
            avatarCrop: nil,
            unread: false,
            modelSelection: ModelSelection(instanceId: normalizedInstanceId, model: resolvedModel),
            activeModelSelection: nil,
            maxToolRounds: nil,
            createdAt: nowSeconds * 1000,
            busy: false,
            pinned: false,
            hidden: false,
            off: false,
            chiefOfStaff: nil,
            approvePeerComms: nil,
            section: nil,
            autoApprove: nil,
            autoReview: nil,
            bypassPermissions: nil,
            bypassLocalComputer: nil,
            alwaysAllow: nil,
            composio: nil,
            computers: nil,
            cloudBackend: nil,
            effectiveCloudBackend: nil,
            autoStartVps: nil,
            cwd: nil,
            extraCwds: nil,
            userNotes: nil,
            speakReplies: nil,
            speechDevices: nil,
            voice: nil,
            voices: nil,
            mascotExpression: nil,
            tasks: nil,
            roomUsageByInstance: nil,
            messages: [],
            activeLeafId: nil,
            hasMore: false,
            pinnedMessageId: nil
        )
        let rawData = try JSONEncoder().encode(bot)
        guard let rawJSON = String(data: rawData, encoding: .utf8) else {
            throw NativeDesktopCreateBotError.encodingFailed
        }
        let botRecord = StoredBotRecord(
            id: botId,
            name: resolvedName,
            threadId: threadId,
            createdAt: nowSeconds,
            snoozedUntil: nil,
            rawJSON: rawJSON
        )
        let threadRecord = ThreadRecord(
            id: threadId,
            title: resolvedName,
            botId: botId,
            createdAt: nowSeconds,
            updatedAt: nowSeconds
        )

        let derivedProfile = MacBotProfileDerivation.derive(from: botRecord)?.profile
            ?? MacBotExecutionProfile(id: botId, threadId: threadId, engineId: engine.rawValue, modelId: resolvedModel)
        // Register the profile and driver before persisting rows so a runtime or
        // driver failure never leaves an unregistered bot stranded in SQLite.
        if let driver {
            let profile = MacBotExecutionProfile(
                id: derivedProfile.id,
                threadId: derivedProfile.threadId,
                engineId: driver.engineId,
                modelId: derivedProfile.modelId
            )
            try await runtime.registerBot(profile, driver: driver)
        } else {
            try await runtime.registerBot(derivedProfile, matrixEngine: engine)
        }

        do {
            try await database.upsertThread(threadRecord)
            try await database.upsertBot(botRecord)
            await runtime.macExecutionContext.invalidateCredentialsCache()
            try await runtime.runtime.engineSwitch.switchToNativeSwift(
                botId: botId,
                historySnapshot: BotHistoryImportSnapshot(botId: botId, threads: [threadRecord], messagesByThread: [:])
            )
        } catch {
            try? await database.deleteBot(id: botId)
            try? await database.deleteThread(id: threadId)
            await runtime.macExecutionContext.unregister(botId: botId)
            throw error
        }
        return bot
    }

    private static func resolveBotName(requested: String?, existing: [StoredBotRecord]) -> String {
        let trimmed = requested?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        let taken = Set(existing.map { $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
        var index = 1
        while taken.contains("bot \(index)") {
            index += 1
        }
        return "Bot \(index)"
    }
}
