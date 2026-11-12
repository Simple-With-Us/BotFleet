import SwiftUI
import CompanionCore

/// How full this conversation is, and the compact action when the engine allows it.
struct ContextMeterStrip: View {
    let bot: Bot
    let threadId: String
    var viewingOther = false

    @EnvironmentObject private var session: Session
    @State private var commands: [ContextMeterMath.Command]?
    @State private var pending = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                meter
                compactButton
                Spacer(minLength: 0)
            }
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .task(id: reloadKey) {
            let fresh = await session.contextCommands(botId: bot.id, threadId: threadId)
            if !Task.isCancelled {
                commands = fresh
            }
        }
    }

    private var reading: ContextMeterMath.Reading {
        let task = bot.tasks?.first { $0.threadId == threadId }
        let selection = task?.modelSelection ?? bot.modelSelection
        let catalog = session.cachedInstances
            .first { $0.instanceId == selection.instanceId }?
            .models.options.first { $0.id == selection.model }?
            .contextWindow
        return ContextMeterMath.meter(
            used: task?.usage?.lastInput,
            reportedWindow: task?.usage?.contextWindow,
            catalogWindow: catalog
        )
    }

    @ViewBuilder
    private var meter: some View {
        if let percent = reading.percent, let bar = reading.bar, let label = reading.percentLabel {
            HStack(spacing: 8) {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.secondary.opacity(0.2))
                        Capsule()
                            .fill(percent >= ContextMeterMath.notePercent ? Color.orange : Color.accentColor)
                            .frame(width: proxy.size.width * CGFloat(bar) / 100)
                    }
                }
                .frame(width: 64, height: 6)
                .accessibilityElement()
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
            .accessibilityHint(reading.detail)
        } else {
            Text(reading.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityHint(reading.detail)
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
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(pending)
        case let .disabled(reason):
            Button(ContextMeterMath.compactLabel) {}
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(true)
                .accessibilityHint(reason)
        }
    }

    private var offer: ContextMeterMath.CompactState {
        if viewingOther {
            return .disabled(reason: "Switch to this conversation before compacting it.")
        }
        let engine = ContextMeterMath.compact(commands)
        if bot.busy == true, case .ready = engine {
            return .disabled(reason: "Still working.\(ContextMeterMath.gap)Let this reply finish first.")
        }
        return engine
    }

    private var reloadKey: String {
        "\(bot.id)|\(threadId)|\(bot.busy == true)"
    }

    private func run(_ commandId: String) {
        guard !pending else { return }
        pending = true
        failure = nil
        Task {
            let reason = await session.compactSession(botId: bot.id, commandId: commandId, threadId: threadId)
            pending = false
            failure = reason
        }
    }
}

/// One note under the latest reply when the conversation is nearly full.
struct ContextNoteBanner: View {
    let bot: Bot
    let threadId: String
    var viewingOther = false

    @EnvironmentObject private var session: Session
    @State private var commands: [ContextMeterMath.Command]?
    @State private var memories: [String: ContextMeterMath.NoteMemory] = [:]
    @State private var pending = false

    var body: some View {
        Group {
            if decision.show {
                VStack(spacing: 4) {
                    Text(ContextMeterMath.noteText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    compactLink
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .accessibilityIdentifier("context-note-once")
            }
        }
        .task(id: reloadKey) {
            let fresh = await session.contextCommands(botId: bot.id, threadId: threadId)
            if !Task.isCancelled {
                commands = fresh
            }
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
        let catalog = session.cachedInstances
            .first { $0.instanceId == selection.instanceId }?
            .models.options.first { $0.id == selection.model }?
            .contextWindow
        return ContextMeterMath.meter(
            used: task?.usage?.lastInput,
            reportedWindow: task?.usage?.contextWindow,
            catalogWindow: catalog
        )
    }

    private var engineOffer: ContextMeterMath.CompactState {
        ContextMeterMath.compact(commands)
    }

    private var compactReady: Bool {
        guard !viewingOther else { return false }
        if case .ready = engineOffer { return true }
        return false
    }

    private var decision: ContextMeterMath.NoteDecision {
        ContextMeterMath.nextNote(
            used: reading.used,
            window: reading.window,
            compactReady: compactReady,
            memory: memories[threadId]
        )
    }

    private var disabledReason: String? {
        if viewingOther { return "Switch to this conversation before compacting it." }
        if bot.busy == true, case .ready = engineOffer {
            return "Still working.\(ContextMeterMath.gap)Let this reply finish first."
        }
        if case let .disabled(reason) = engineOffer { return reason }
        return nil
    }

    @ViewBuilder
    private var compactLink: some View {
        if let commandId = readyCommand {
            Button(ContextMeterMath.compactLabel) { run(commandId) }
                .font(.footnote.weight(.semibold))
                .disabled(pending || disabledReason != nil)
                .accessibilityHint(disabledReason ?? ContextMeterMath.compactLabel)
        }
    }

    private var readyCommand: String? {
        if case let .ready(commandId) = engineOffer { return commandId }
        return nil
    }

    private var reloadKey: String {
        "\(bot.id)|\(threadId)|\(bot.busy == true)"
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
