import SwiftUI
import CompanionCore

/// How full the open conversation is, and compact when this engine allows it.
struct MacContextMeterStrip: View {
    @EnvironmentObject private var session: MacSession
    let bot: Bot
    let threadId: String

    @State private var commands: [ContextMeterMath.Command]?
    @State private var pending = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                meter
                compactButton
                Spacer(minLength: 0)
            }
            if let failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .task(id: "\(bot.id)|\(threadId)|\(bot.busy == true)") {
            async let menu = session.contextCommands(botId: bot.id, threadId: threadId)
            await session.refreshModelWindows()
            commands = await menu
        }
    }

    private var reading: ContextMeterMath.Reading {
        let task = bot.tasks?.first { $0.threadId == threadId }
        let selection = task?.modelSelection ?? bot.modelSelection
        return ContextMeterMath.meter(
            used: task?.usage?.lastInput,
            reportedWindow: task?.usage?.contextWindow,
            catalogWindow: session.catalogWindow(instanceId: selection.instanceId, model: selection.model)
        )
    }

    @ViewBuilder
    private var meter: some View {
        if let percent = reading.percent, let bar = reading.bar, let label = reading.percentLabel {
            HStack(spacing: 8) {
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.2))
                    Capsule()
                        .fill(percent >= ContextMeterMath.notePercent ? Color.orange : Color.accentColor)
                        .frame(width: 64 * CGFloat(bar) / 100)
                }
                .frame(width: 64, height: 6)
                .help(reading.detail)
                .accessibilityLabel("Context used")
                .accessibilityValue(label)
                Text(label)
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                Text(reading.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        } else {
            Text(reading.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .help(reading.detail)
        }
    }

    @ViewBuilder
    private var compactButton: some View {
        switch offer {
        case .hidden:
            EmptyView()
        case let .ready(commandId):
            Button(pending ? "Compacting…" : ContextMeterMath.compactLabel) {
                run(commandId)
            }
            .controlSize(.small)
            .disabled(pending)
        case let .disabled(reason):
            Button(ContextMeterMath.compactLabel) {}
                .controlSize(.small)
                .disabled(true)
                .help(reason)
        }
    }

    private var offer: ContextMeterMath.CompactState {
        let engine = ContextMeterMath.compact(commands)
        if bot.busy == true, case .ready = engine {
            return .disabled(reason: "Still working.\(ContextMeterMath.gap)Let this reply finish first.")
        }
        return engine
    }

    private func run(_ commandId: String) {
        guard !pending else { return }
        pending = true
        failure = nil
        Task {
            failure = await session.compactSession(botId: bot.id, commandId: commandId, threadId: threadId)
            pending = false
        }
    }
}

struct MacContextNoteBanner: View {
    @EnvironmentObject private var session: MacSession
    let bot: Bot
    let threadId: String

    @State private var commands: [ContextMeterMath.Command]?
    @State private var memories: [String: ContextMeterMath.NoteMemory] = [:]
    @State private var pending = false

    var body: some View {
        Group {
            if decision.show, let commandId = readyCommand {
                VStack(spacing: 4) {
                    Text(ContextMeterMath.noteText)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button(ContextMeterMath.compactLabel) { run(commandId) }
                        .disabled(pending || disabledReason != nil)
                        .help(disabledReason ?? "")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
        }
        .task(id: "\(bot.id)|\(threadId)|\(bot.busy == true)") {
            commands = await session.contextCommands(botId: bot.id, threadId: threadId)
        }
        .task(id: noteStamp) {
            let next = ContextMeterMath.nextNote(
                used: reading.used,
                window: reading.window,
                compactReady: compactReady,
                memory: memories[threadId]
            )
            if memories[threadId] != next.memory {
                memories[threadId] = next.memory
            }
        }
    }

    private var reading: ContextMeterMath.Reading {
        let task = bot.tasks?.first { $0.threadId == threadId }
        let selection = task?.modelSelection ?? bot.modelSelection
        return ContextMeterMath.meter(
            used: task?.usage?.lastInput,
            reportedWindow: task?.usage?.contextWindow,
            catalogWindow: session.catalogWindow(instanceId: selection.instanceId, model: selection.model)
        )
    }

    private var engineOffer: ContextMeterMath.CompactState {
        ContextMeterMath.compact(commands)
    }

    private var compactReady: Bool {
        if case .ready = engineOffer { return true }
        return false
    }

    private var readyCommand: String? {
        if case let .ready(commandId) = engineOffer { return commandId }
        return nil
    }

    private var disabledReason: String? {
        if bot.busy == true, case .ready = engineOffer {
            return "Still working.\(ContextMeterMath.gap)Let this reply finish first."
        }
        return nil
    }

    private var decision: ContextMeterMath.NoteDecision {
        ContextMeterMath.nextNote(
            used: reading.used,
            window: reading.window,
            compactReady: compactReady,
            memory: memories[threadId]
        )
    }

    private var noteStamp: String {
        "\(threadId)|\(reading.used ?? -1)|\(reading.window ?? -1)|\(compactReady)"
    }

    private func run(_ commandId: String) {
        guard !pending, disabledReason == nil else { return }
        pending = true
        Task {
            _ = await session.compactSession(botId: bot.id, commandId: commandId, threadId: threadId)
            pending = false
        }
    }
}

enum MacContextFill {
    static func percent(for bot: Bot, windows: [String: Int]) -> String? {
        let task = bot.tasks?.first { $0.threadId == bot.threadId }
        let selection = task?.modelSelection ?? bot.modelSelection
        let catalog = windows["\(selection.instanceId)\u{1e}\(selection.model)"]
        return ContextMeterMath.badge(
            used: task?.usage?.lastInput,
            reportedWindow: task?.usage?.contextWindow,
            catalogWindow: catalog
        )
    }

    static func compactSettled(_ message: Message, in messages: [Message], at index: Int) -> Bool {
        guard message.role == .user, message.command?.name == "compact" else { return false }
        return messages.dropFirst(index + 1).contains { later in
            later.role == .bot && later.kind == .text && later.command?.name != "compact"
        }
    }
}

struct MacContextFillBadge: View {
    let percent: String

    var body: some View {
        Text(percent)
            .font(.caption2.weight(.medium))
            .monospacedDigit()
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color.secondary.opacity(0.15)))
            .accessibilityLabel("Context \(percent) used")
    }
}
