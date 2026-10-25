import SwiftUI
import CompanionCore

public struct MacRootView: View {
    @EnvironmentObject private var session: MacSession
    @State private var inputText: String = ""
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    public init() {}

    public var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            MacSidebarView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } content: {
            MacThreadListView()
                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 360)
        } detail: {
            HSplitView {
                MacDetailChatView(inputText: $inputText)
                    .frame(minWidth: 400)

                if session.showCuaViewer {
                    MacCuaInspectorView()
                        .frame(minWidth: 320, idealWidth: 380)
                }
            }
        }
        .navigationTitle(session.activeTitle)
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button(action: {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        session.showCuaViewer.toggle()
                    }
                }) {
                    Image(systemName: session.showCuaViewer ? "display.fill" : "display")
                }
                .help("Toggle Computer Use Agent (CUA) live viewer")
            }
            ToolbarItem(placement: .automatic) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(session.status.statusColor)
                        .frame(width: 8, height: 8)
                    Text(session.status.displayText)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button(action: { session.connect() }) {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Reconnect to local harness")
            }
        }
    }
}

// MARK: - Sidebar

struct MacSidebarView: View {
    @EnvironmentObject private var session: MacSession

    var body: some View {
        VStack(spacing: 0) {
            List(selection: $session.selection) {
                Section("Bots") {
                    if session.state.bots.isEmpty {
                        Text("No bots loaded")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .padding(.vertical, 8)
                    } else {
                        ForEach(session.state.bots) { bot in
                            MacBotRowView(bot: bot)
                                .tag(SidebarSelection.bot(bot.id))
                        }
                    }
                }

                if !session.state.rooms.isEmpty {
                    Section("Rooms") {
                        ForEach(session.state.rooms) { room in
                            HStack {
                                Image(systemName: "person.3.fill")
                                    .foregroundColor(.accentColor)
                                Text(room.name)
                                    .font(.body)
                            }
                            .tag(SidebarSelection.room(room.id))
                        }
                    }
                }
            }
            .listStyle(.sidebar)

            Divider()

            HStack {
                Button(action: {
                    // Open settings modal
                }) {
                    Label("Settings", systemImage: "gearshape")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

                Spacer()

                Button(action: {
                    // Quick add bot
                }) {
                    Image(systemName: "plus")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .background(Color(NSColor.windowBackgroundColor))
        }
    }
}

struct MacBotRowView: View {
    let bot: Bot

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Image(systemName: "cpu")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 24, height: 24)
                    .foregroundColor(.accentColor)
                    .padding(4)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                Circle()
                    .fill((bot.busy == true) ? Color.orange : Color.green)
                    .frame(width: 8, height: 8)
                    .overlay(Circle().stroke(Color(NSColor.windowBackgroundColor), lineWidth: 1.5))
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(bot.name)
                    .font(.body)
                    .fontWeight(.medium)
                    .lineLimit(1)

                Text(bot.modelSelection.model)
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Threads / Channels List

struct MacThreadListView: View {
    @EnvironmentObject private var session: MacSession

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if session.activeThreadId != nil {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.activeTitle)
                            .font(.headline)
                        if !session.activeSubtitle.isEmpty {
                            Text(session.activeSubtitle)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                    Spacer()
                }
                .padding(12)

                Divider()

                List {
                    Section("Conversations") {
                        NavigationLink(destination: EmptyView()) {
                            Label("Main Thread", systemImage: "bubble.left.and.bubble.right.fill")
                        }
                    }

                    if let threadId = session.activeThreadId, let jobs = session.state.jobsByThread[threadId], !jobs.isEmpty {
                        Section("Background Jobs") {
                            ForEach(jobs) { job in
                                HStack {
                                    Circle()
                                        .fill(job.status == .running ? Color.blue : Color.gray)
                                        .frame(width: 6, height: 6)
                                    Text(job.label)
                                        .font(.subheadline)
                                    Spacer()
                                }
                            }
                        }
                    }
                }
                .listStyle(.inset)
            } else {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: "sidebar.left")
                        .font(.largeTitle)
                        .foregroundColor(.secondary)
                    Text("Select a conversation")
                        .font(.title3)
                        .foregroundColor(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

// MARK: - Detail Chat View

struct MacDetailChatView: View {
    @EnvironmentObject private var session: MacSession
    @Binding var inputText: String

    var body: some View {
        VStack(spacing: 0) {
            if session.activeThreadId != nil {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(session.activeMessages) { message in
                                MacMessageBubbleView(message: message)
                                    .id(message.id)
                            }

                            if let reasoning = session.activeReasoningText, !reasoning.isEmpty {
                                MacReasoningChamberView(reasoning: reasoning)
                            }

                            if let streaming = session.activeStreamingText, !streaming.isEmpty {
                                MacStreamingBubbleView(botName: session.activeTitle, text: streaming)
                                    .id("streaming-anchor")
                            }
                        }
                        .padding(16)
                    }
                    .onChange(of: session.activeMessages.count) { _, _ in
                        if let last = session.activeMessages.last {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: session.activeStreamingText) { _, _ in
                        proxy.scrollTo("streaming-anchor", anchor: .bottom)
                    }
                }

                Divider()

                // Composer Bar
                MacComposerBar(inputText: $inputText)
            } else {
                VStack(spacing: 12) {
                    Spacer()
                    Image(systemName: "message")
                        .font(.system(size: 40))
                        .foregroundColor(.secondary)
                    Text("No Conversation Selected")
                        .font(.title2)
                        .foregroundColor(.secondary)
                    Text("Choose a bot or room from the sidebar to view transcripts and start a conversation.")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

struct MacMessageBubbleView: View {
    let message: Message

    var isUser: Bool {
        message.role == .user
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if isUser {
                Spacer(minLength: 48)
            } else {
                Image(systemName: "cpu")
                    .frame(width: 28, height: 28)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(Circle())
            }

            VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
                Text(message.role.rawValue.capitalized)
                    .font(.caption)
                    .foregroundColor(.secondary)

                MarkdownText(message.text ?? "")
                    .textSelection(.enabled)
                    .padding(12)
                    .background(isUser ? Color.accentColor.opacity(0.15) : Color(NSColor.controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            if isUser {
                Image(systemName: "person.crop.circle.fill")
                    .resizable()
                    .frame(width: 28, height: 28)
                    .foregroundColor(.secondary)
            } else {
                Spacer(minLength: 48)
            }
        }
    }
}

struct MacStreamingBubbleView: View {
    let botName: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "cpu")
                .frame(width: 28, height: 28)
                .background(Color.accentColor.opacity(0.12))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(botName)
                        .font(.caption)
                        .foregroundColor(.secondary)
                    ProgressView()
                        .scaleEffect(0.6)
                }

                MarkdownText(text)
                    .textSelection(.enabled)
                    .padding(12)
                    .background(Color(NSColor.controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            Spacer(minLength: 48)
        }
    }
}

struct MacReasoningChamberView: View {
    let reasoning: String
    @State private var isExpanded: Bool = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            Text(reasoning)
                .font(.system(.body, design: .monospaced))
                .foregroundColor(.secondary)
                .padding(.top, 4)
                .textSelection(.enabled)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "brain")
                    .foregroundColor(.purple)
                Text("Thought Process")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundColor(.secondary)
            }
        }
        .padding(10)
        .background(Color.purple.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct MacComposerBar: View {
    @EnvironmentObject private var session: MacSession
    @Binding var inputText: String

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextEditor(text: $inputText)
                .font(.body)
                .frame(minHeight: 38, maxHeight: 120)
                .padding(6)
                .background(Color(NSColor.textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                )

            if session.activeStreamingText != nil {
                Button(action: {
                    Task { await session.stopActiveTurn() }
                }) {
                    Image(systemName: "stop.circle.fill")
                        .resizable()
                        .frame(width: 28, height: 28)
                        .foregroundColor(.red)
                }
                .buttonStyle(.plain)
                .help("Stop turn")
            } else {
                Button(action: {
                    let text = inputText
                    Task {
                        let sent = await session.sendMessage(text)
                        if sent {
                            inputText = ""
                        }
                    }
                }) {
                    Image(systemName: "arrow.up.circle.fill")
                        .resizable()
                        .frame(width: 28, height: 28)
                        .foregroundColor(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .secondary : .accentColor)
                }
                .buttonStyle(.plain)
                .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.isSending)
                .keyboardShortcut(.return, modifiers: [.command])
                .help("Send turn (⌘Return)")
            }
        }
        .padding(12)
        .background(Color(NSColor.windowBackgroundColor))
    }
}

// MARK: - CUA Inspector View

struct MacCuaInspectorView: View {
    @EnvironmentObject private var session: MacSession

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Label("Computer Use", systemImage: "display")
                    .font(.headline)

                Spacer()

                if session.isCuaStreaming {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 6, height: 6)
                        Text("LIVE")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.red)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.red.opacity(0.12))
                    .cornerRadius(4)
                }

                Button(role: .destructive, action: { session.triggerCuaEmergencyStop() }) {
                    Image(systemName: "hand.raised.fill")
                }
                .help("Emergency Stop Desktop Control (⌘⇧Esc)")
                .accessibilityLabel("Emergency Stop Desktop Control")

                Button(action: { session.toggleCuaStreaming() }) {
                    Image(systemName: session.isCuaStreaming ? "stop.fill" : "play.fill")
                }
                .help(session.isCuaStreaming ? "Stop live capture" : "Start live capture")
                .accessibilityLabel(session.isCuaStreaming ? "Stop Live Capture" : "Start Live Capture")
            }
            .padding(12)
            .background(Color(NSColor.windowBackgroundColor))

            if let banner = session.cuaRevocationBanner {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.orange)
                    Text(banner)
                        .font(.caption)
                        .foregroundColor(.primary)
                    Spacer()
                }
                .padding(8)
                .background(Color.orange.opacity(0.15))
            }

            Divider()

            // Metal Surface
            ZStack {
                CuaMetalView(pixelBuffer: session.cuaPixelBuffer)
                    .background(Color.black)

                if session.cuaPixelBuffer == nil {
                    VStack(spacing: 8) {
                        Image(systemName: "display")
                            .font(.system(size: 32))
                            .foregroundColor(.secondary)
                        Text(session.isCuaStreaming ? "Waiting for the first frame…" : "CUA Standby")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                        if !session.isCuaStreaming {
                            Button("Start Live Capture") {
                                session.startCuaStreaming()
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .padding(.top, 4)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            // Status bar
            HStack {
                Text(session.cuaStatusMessage ?? (session.isCuaStreaming ? "Live" : "Idle"))
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding(8)
            .background(Color(NSColor.windowBackgroundColor))
        }
    }
}

