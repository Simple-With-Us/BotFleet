import Foundation

/// Why a desktop chat message could not start a native turn.  Every case is
/// a gate the message stopped at, named so the window can say which one.
public enum NativeDesktopChatError: LocalizedError, Equatable, Sendable {
    /// The message was empty once whitespace was trimmed.
    case emptyMessage
    /// No native execution profile is registered for the bot, so it has no
    /// engine on this Mac yet.
    case botNotRegistered(botId: String)
    /// The thread is missing from the native store or belongs to another bot.
    case threadNotOwned(threadId: String)
    /// The execution context held the turn (no credentials, no workspace, or
    /// the thread is not the bot's registered thread).
    case held(NativeWorkHoldReason)
    /// The bot's runtime owner is still the Node harness, so the native
    /// runtime is fenced from answering it.
    case runtimeNotNative(botId: String)
    /// The bot's runtime owner is changing right now; the message can be
    /// sent again once the switch settles.
    case runtimeSwitchInProgress(botId: String)
    /// A turn is already running on this thread.
    case turnAlreadyActive(threadId: String)

    public var errorDescription: String? {
        switch self {
        case .emptyMessage:
            return "Type a message first."
        case .botNotRegistered(let botId):
            return "Bot \(botId) has no native engine on this Mac yet."
        case .threadNotOwned(let threadId):
            return "Thread \(threadId) does not belong to this bot in the native store."
        case .held(.waitingForLogin):
            return "This bot is waiting for its engine login on this Mac."
        case .held(.credentialsUnavailable):
            return "This bot's engine credentials or workspace are not available on this Mac."
        case .runtimeNotNative(let botId):
            return "Bot \(botId) still answers through the Node harness, so this Mac cannot run its turn."
        case .runtimeSwitchInProgress(let botId):
            return "Bot \(botId) is switching runtimes right now.  Send the message again in a moment."
        case .turnAlreadyActive(let threadId):
            return "A turn is already running on thread \(threadId)."
        }
    }
}

/// Runs one message from the Mac app's chat window as a native engine turn
/// (`BF-2705`, slice 1), without the retired Node harness.
///
/// It follows the same sequence a satisfied wait follows in
/// `NativeCoordinatorEventWaitQueue`: the execution context prepares the
/// `TurnInput`, the engine switch admits the native runtime, the coordinator
/// runs the turn, and the switch is released when the stream ends.  The
/// coordinator's dispatcher already persists the user prompt and the
/// assistant reply in the native store, so this service writes nothing
/// itself.
///
/// It never changes a bot's runtime owner: a bot the Node harness still owns
/// is refused with `.runtimeNotNative`, not switched.
public actor NativeDesktopChatService {
    private let database: DatabaseService
    private let executionContext: MacExecutionContext
    private let engineCoordinator: EngineCoordinatorActor
    private let engineSwitch: BotNativeEngineSwitchActor

    public init(
        database: DatabaseService,
        executionContext: MacExecutionContext,
        engineCoordinator: EngineCoordinatorActor,
        engineSwitch: BotNativeEngineSwitchActor
    ) {
        self.database = database
        self.executionContext = executionContext
        self.engineCoordinator = engineCoordinator
        self.engineSwitch = engineSwitch
    }

    /// Starts a native turn for `text` on the bot's thread and returns its
    /// events.  Throws `NativeDesktopChatError` when a gate refuses the
    /// message before any engine runs.  Cancelling the returned stream
    /// cancels the turn.
    public func send(botId: String, threadId: String, text: String) async throws -> AsyncStream<TurnEvent> {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { throw NativeDesktopChatError.emptyMessage }
        guard await executionContext.registeredProfile(forBotId: botId) != nil else {
            throw NativeDesktopChatError.botNotRegistered(botId: botId)
        }
        guard let thread = try await database.loadThread(id: threadId), thread.botId == botId else {
            throw NativeDesktopChatError.threadNotOwned(threadId: threadId)
        }

        let input: TurnInput
        switch try await executionContext.resolveTurn(botId: botId, threadId: threadId, prompt: prompt) {
        case .held(let reason):
            throw NativeDesktopChatError.held(reason)
        case .ready(let prepared):
            guard prepared.botId == botId, prepared.threadId == threadId else {
                throw NativeDesktopChatError.held(.credentialsUnavailable)
            }
            input = prepared
        }

        let turnId = "desktop_\(UUID().uuidString.lowercased())"
        do {
            try await engineSwitch.beginTurn(botId: botId, callerRuntime: .nativeSwift, turnId: turnId)
        } catch BotEngineSwitchError.runtimeFenced {
            throw NativeDesktopChatError.runtimeNotNative(botId: botId)
        } catch BotEngineSwitchError.transitionInProgress {
            throw NativeDesktopChatError.runtimeSwitchInProgress(botId: botId)
        }

        let upstream: AsyncStream<TurnEvent>
        do {
            upstream = try await engineCoordinator.sendTurn(input: input)
        } catch EngineDriverError.turnAlreadyActive {
            await engineSwitch.endTurn(botId: botId, turnId: turnId)
            throw NativeDesktopChatError.turnAlreadyActive(threadId: threadId)
        } catch {
            await engineSwitch.endTurn(botId: botId, turnId: turnId)
            throw error
        }

        let engineSwitch = self.engineSwitch
        let engineCoordinator = self.engineCoordinator
        return AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let relay = Task {
                for await event in upstream {
                    continuation.yield(event)
                }
                await engineSwitch.endTurn(botId: botId, turnId: turnId)
                continuation.finish()
            }
            // A window that goes away stops the engine at once: the turn is
            // cancelled through the coordinator (which cancels the driver)
            // instead of waiting for the relay to notice, and the relay is
            // cancelled so it releases the switch admission and finishes.
            continuation.onTermination = { termination in
                guard case .cancelled = termination else { return }
                relay.cancel()
                Task { await engineCoordinator.cancelTurn(threadId: threadId) }
            }
        }
    }
}
