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

    private let lock = NSLock()
    private var opened: Opened?
    private let build: Build

    public init(build: @escaping Build) {
        self.build = build
    }

    /// The shared graph, opening it on the first call.
    public func open() throws -> Opened {
        lock.lock()
        defer { lock.unlock() }
        if let opened { return opened }
        let built = try build()
        let runtime = built.runtime
        let value = Opened(
            database: built.database,
            runtime: runtime,
            registration: Task { await runtime.registerStoredBots() }
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
    /// Registered bots that stayed fenced, with the reason.
    public let cutoverSkipped: [NativeDesktopCutoverSkip]
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
}
