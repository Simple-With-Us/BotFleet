// One conversation: the transcript, the approval cards, and the composer.
//
// The transcript is whatever the harness folded — settled text, tool chips,
// option cards, screenshots. This renders those and nothing else; it does
// not re-derive anything from provider events, because the server already
// did that and having two folds is how two clients start disagreeing.
import SwiftUI
import CompanionCore
// Unconditional, because the uses below are: `Color(uiColor:)` and
// `UIImage(data:)` are reached on every path through this file. A
// `canImport` guard around the import alone does not make the file portable
// — it only moves the failure from "no such module" to "no such type", and
// hides that this view is iOS-only behind something that looks like it
// isn't. The App target is iOS; CompanionCore is where the portable half
// lives.
import UIKit
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers

struct ChatView: View {
    let chat: Chat
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var draft = ""
    @State private var pendingAttachments: [PendingChatAttachment] = []
    @State private var showingTasks = false
    @State private var showingRoutines = false
    @State private var showingComputer = false
    @State private var showingPlus = false
    @State private var showingCompose = false
    @State private var showingProfile = false
    @State private var showCommandHUD = false
    @State private var pickingPhoto = false
    @State private var photoItem: PhotosPickerItem?
    @State private var pickingFile = false
    @State private var sending = false
    @State private var shareFile: ShareFile?
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = SpeechDictation()

    /// The live bubble's scroll target. A constant because there is at most
    /// one per chat and it has no message id to borrow.
    static let liveBubbleId = "companion.live"

    /// The live chat record, so busy/unread stay current as frames land.
    private var current: Chat {
        switch chat {
        case let .bot(bot): return session.state.bot(bot.id).map(Chat.bot) ?? chat
        case let .room(room):
            return session.state.rooms.first { $0.id == room.id }.map(Chat.room) ?? chat
        }
    }

    /// A bot receives a new thread when its task changes. Navigation keeps
    /// the original Chat value, so every transcript lookup must follow the
    /// live record instead of the snapshot that opened this screen.
    private var threadId: String { current.threadId }

    private var messages: [Message] {
        session.state.visibleTranscript(forThread: threadId)
    }

    /// Unread elsewhere — what the back pill's badge counts, like Messages.
    private var unreadElsewhere: Int {
        let mine = current.unread ? 1 : 0
        return max(0, session.state.unreadCount - mine)
    }

    /// The provider driving this chat's current model, for the header's
    /// logo badge.  Rooms have many bots and no single current model, so
    /// this is `nil` (and the badge renders nothing) for anything but a
    /// single bot chat.  Prefers the active task's override when present —
    /// matching `task.modelSelection ?? bot.modelSelection` on the server —
    /// then joins through the cached instanceId -> driverKind map on
    /// `Session` rather than parsing `instanceId`, which is operator-named
    private var currentModelSelection: ModelSelection? {
        guard case let .bot(bot) = current else { return nil }
        guard let currentTask = bot.tasks?.first(where: { $0.threadId == bot.threadId }) else {
            // Older harnesses send no task list; the bot-level record is all
            // there is.
            return bot.activeModelSelection ?? bot.modelSelection
        }
        if let taskSelection = currentTask.modelSelection {
            return currentTask.activeModelSelection ?? taskSelection
        }
        // An inheriting task reads its own last-turn selection, never
        // `bot.activeModelSelection`: that is the bot's latest turn across
        // every task, so a fallback on another task would leak into this
        // header.  The server clears an inheriting task's
        // `activeModelSelection` when the bot's model changes (`patchBot`
        // in server/store.ts), so a stale fallback does not outlive it.
        return currentTask.activeModelSelection ?? bot.modelSelection
    }

    private var currentDriverKind: String? {
        guard let selection = currentModelSelection else { return nil }
        // Instance IDs are caller-chosen labels, not provider kinds. If the
        // registry is cold, omit the mark rather than guessing a provider.
        return session.instanceDriverKinds[selection.instanceId]
    }

    /// VoiceOver for the header identity button. The explicit button label
    /// replaces child accessibility content, so the provider mark must be
    /// named here or it would become silent chrome.
    private var headerProfileAccessibilityLabel: String {
        if let currentDriverKind {
            return "Open \(current.name) profile, \(ProviderMarkView.displayName(for: currentDriverKind, model: currentModelSelection?.model))"
        }
        return "Open \(current.name) profile"
    }

    var body: some View {
        VStack(spacing: 0) {
            transcriptColumn
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .overlay(alignment: .bottom) { plusSheet }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .photosPicker(isPresented: $pickingPhoto, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await addPhoto(item); photoItem = nil }
        }
        .fileImporter(
            isPresented: $pickingFile,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case let .success(urls) = result {
                Task { await addFiles(urls) }
            }
        }
        .navigationDestination(isPresented: $showingComputer) {
            if case let .bot(bot) = current { ComputerView(bot: bot) }
        }
        .task(id: threadId) {
            if current.unread { await session.markRead(current) }
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-open-plus") { showingPlus = true }
            if ProcessInfo.processInfo.arguments.contains("-open-profile") { showingProfile = true }
#endif
        }
        .onChange(of: current.unread) { _, unread in
            if unread { Task { await session.markRead(current) } }
        }
        .onAppear { NotificationCoordinator.shared.viewingThreadId = threadId }
        .onChange(of: threadId) { _, newId in
            NotificationCoordinator.shared.viewingThreadId = newId
        }
        .onDisappear {
            dictation.stop()
            if NotificationCoordinator.shared.viewingThreadId == threadId {
                NotificationCoordinator.shared.viewingThreadId = nil
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                dictation.stop()
                // ChatView stays mounted while backgrounded, so onDisappear
                // never clears this — without clearing, same-thread APNs/SSE
                // banners are suppressed for the linger window.
                if NotificationCoordinator.shared.viewingThreadId == threadId {
                    NotificationCoordinator.shared.viewingThreadId = nil
                }
            } else {
                NotificationCoordinator.shared.viewingThreadId = threadId
            }
        }
        .onChange(of: showingComputer) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingTasks) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingProfile) { _, shown in
            if shown { dictation.stop() }
        }
        .onChange(of: showingPlus) { _, shown in
            if shown { dictation.stop() }
        }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey]
            let value = (raw as? NSNumber)?.uintValue ?? (raw as? UInt)
            if value == AVAudioSession.InterruptionType.began.rawValue {
                dictation.stop()
            }
        }
        .onChange(of: dictation.transcript) { _, spoken in
            draft = Dictation.draft(base: dictation.base, transcript: spoken)
        }
        .onChange(of: dictation.isListening) { _, listening in
            if listening { composerFocused = false }
        }
        .sheet(isPresented: $showingTasks) {
            if case let .bot(bot) = current { TaskManagerView(bot: bot) }
        }
        .navigationDestination(isPresented: $showingRoutines) {
            TasksRoutinesView()
        }
        .sheet(isPresented: $showingProfile) {
            if case let .bot(bot) = current {
                AgentProfileView(bot: bot)
            } else if case let .room(room) = current {
                GroupProfileView(room: room)
            }
        }
        .sheet(item: $shareFile) { file in
            ActivityShareSheet(items: [file.url])
        }
        .confirmationDialog("New", isPresented: $showingCompose, titleVisibility: .visible) {
            if case let .bot(bot) = current {
                Button("New Task") {
                    Task { await session.createTask(for: bot, title: nil) }
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    /// Split out of `body` so the Swift compiler can type-check the chat
    /// chrome and the transcript independently.  The combined expression
    /// exceeded the type-check budget on CI.
    private var transcriptColumn: some View {
        let transcript = messages
        let items = groupActivityRuns(transcript)
        return ScrollViewReader { proxy in
                ScrollView {
                    // VStack, not LazyVStack. A lazy stack does not know how
                    // tall it is until its rows have been built, so
                    // `.defaultScrollAnchor(.bottom)` anchors against an
                    // estimate and the chat opens somewhere in the middle of
                    // the conversation. Building all of it up front makes the
                    // height exact and the anchor land on the newest message.
                    // A thread holds 50 messages until you ask for more, so
                    // there is nothing here worth being lazy about.
                    VStack(alignment: .leading, spacing: 6) {
                        if session.state.hasMore[threadId] == true {
                            Button("Load earlier messages") {
                                // keep the reader where they were: after older
                                // messages are prepended, sit back on the one
                                // that used to be at the top
                                let anchor = transcript.first?.id
                                Task {
                                    await session.loadOlder(threadId: threadId)
                                    if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            }
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }

                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            VStack(alignment: .leading, spacing: 6) {
                                // a gap in time is worth marking; a timestamp
                                // on every message is just noise
                                if startsANewStretch(at: index, in: items) {
                                    Text(RelativeStamp.separator(item.date))
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.secondary.opacity(0.7))
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, 10)
                                        .padding(.bottom, 4)
                                }
                                switch item {
                                case let .message(message):
                                    MessageRow(
                                        chat: current,
                                        message: message,
                                        endsRun: endsRun(at: index, in: items)
                                    )
                                case let .run(_, runMessages):
                                    ActivityRunView(
                                        chat: current,
                                        messages: runMessages
                                    )
                                }
                            }
                            .id(item.id)
                        }

                        // The reply as it is typed. It sits after the last
                        // settled message and disappears the moment the real
                        // one arrives — the store clears it on the same frame
                        // that appends the message, so there is never a beat
                        // where both are on screen.
                        if let live = session.state.streaming[threadId], !live.isEmpty {
                            StreamingBubble(text: live, reasoning: nil, color: current.color)
                                .id(Self.liveBubbleId)
                        } else if let thinking = session.state.reasoning[threadId], !thinking.isEmpty {
                            // Only while there is no answer yet. Once tokens
                            // of the reply exist, the reasoning is behind us
                            // and showing both is just noise.
                            StreamingBubble(text: nil, reasoning: thinking, color: current.color)
                                .id(Self.liveBubbleId)
                        } else if current.busy {
                            TypingIndicatorView(tintColor: BotPalette.color(current.color))
                                .id(Self.liveBubbleId)
                                .accessibilityLabel("\(current.name) is working")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // Opaque header: the transcript starts below the tabs and
                // never shows through them.  Glass over the bubbles was
                // what made Monitor's thread leak into the tab strip.
                .safeAreaInset(edge: .top, spacing: 0) { chatHeader }
                // A conversation grows from the bottom: a transcript shorter
                // than the screen rests at the bottom, and opening a chat
                // starts on the newest message rather than the oldest.
                .defaultScrollAnchor(.bottom)
                .onChange(of: transcript.last?.id) { _, _ in
                    guard let last = transcript.last else { return }
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                // Follow the text as it arrives. Keyed on length rather than
                // the string so this fires once per delta batch, and without
                // animation — animating every token turns a smooth stream
                // into a stutter, because each scroll interrupts the last.
                .onChange(of: session.state.streaming[threadId]?.count ?? 0) { _, length in
                    guard length > 0 else { return }
                    proxy.scrollTo(Self.liveBubbleId, anchor: .bottom)
                }
                .onChange(of: session.focusedMessageId) { _, messageId in
                    guard let messageId,
                          messages.contains(where: { $0.id == messageId })
                    else { return }
                    withAnimation { proxy.scrollTo(messageId, anchor: .center) }
                    session.consumeFocus(messageId)
                }
                .task {
                    guard let messageId = session.focusedMessageId,
                          messages.contains(where: { $0.id == messageId })
                    else { return }
                    proxy.scrollTo(messageId, anchor: .center)
                    session.consumeFocus(messageId)
                }
            }
            .id(threadId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Header

    /// Solid chrome: back, identity, computer, and (in Projects) compose
    /// plus opaque thread tabs.  The transcript starts below this block.
    private var chatHeader: some View {
        VStack(spacing: 8) {
            HStack(alignment: .center) {
                if sizeClass != .regular {
                    Button { dismiss() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 17, weight: .semibold))
                            if unreadElsewhere > 0 {
                                Text("\(unreadElsewhere)")
                                    .font(.system(size: 13, weight: .semibold))
                                    .padding(.horizontal, 7)
                                    .frame(minWidth: 22, minHeight: 22)
                                    .background(Capsule().fill(Color.secondary.opacity(0.22)))
                            }
                        }
                        .foregroundStyle(Color.primary)
                        .padding(.leading, 12)
                        .padding(.trailing, unreadElsewhere > 0 ? 8 : 12)
                        .frame(height: 44)
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .glassCapsule()
                    .accessibilityLabel("Back")
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }

                Spacer(minLength: 4)

                Button { showingProfile = true } label: {
                    HStack(spacing: 8) {
                        ChatAvatarView(
                            chat: current,
                            size: 36,
                            state: BotState.forChat(current, in: session.state),
                            animated: BotState.forChat(current, in: session.state).showsActivity
                        )
                        .overlay(alignment: .bottomTrailing) {
                            if let currentDriverKind {
                                ProviderMarkView(driverKind: currentDriverKind, model: currentModelSelection?.model, size: 21)
                                    .offset(x: 3, y: 3)
                            }
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(current.name)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Color.primary)
                                .lineLimit(1)
                            if !current.subtitle.isEmpty {
                                Text(current.subtitle)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(headerProfileAccessibilityLabel)

                Spacer(minLength: 4)

                if case .bot = current {
                    HStack(spacing: 8) {
                        if session.config?.allowsMultipleBotThreads == true {
                            GlassButton(systemImage: "square.and.pencil", size: 44, weight: .medium) {
                                showingCompose = true
                            }
                            .accessibilityLabel("New task")
                        }
                        GlassButton(systemImage: "display", size: 44, weight: .medium) {
                            showingComputer = true
                        }
                        .accessibilityLabel("Watch \(current.name)'s computer")
                    }
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }
            }
            .padding(.horizontal, 16)

            if case let .bot(bot) = current,
               session.config?.allowsMultipleBotThreads == true {
                ThreadTabBar(bot: bot)
            }
        }
        .padding(.top, 4)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .systemBackground), ignoresSafeAreaEdges: .top)
    }

    // MARK: - The + sheet

    /// What the composer's + opens: a glass sheet of the things you can do
    /// here, each with a line saying what it does. Rises above the composer;
    /// tapping anywhere else, or the × the + became, puts it away.
    @ViewBuilder
    private var plusSheet: some View {
        if showingPlus {
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .onTapGesture { withAnimation(.snappy(duration: 0.28)) { showingPlus = false } }

                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        ForEach(plusActions) { action in
                            Button {
                                withAnimation(.snappy(duration: 0.28)) { showingPlus = false }
                                action.run()
                            } label: {
                                HStack(spacing: 16) {
                                    Image(systemName: action.systemImage)
                                        .font(.system(size: 20, weight: .medium))
                                        .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                        .frame(width: 44, height: 44)
                                        .background(Circle().fill(Color.primary.opacity(0.10)))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(action.title)
                                            .font(.system(size: 19, weight: .medium))
                                            .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                        Text(action.subtitle)
                                            .font(.system(size: 13))
                                            .foregroundStyle(Color.secondary)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 18)
                                .frame(height: 64)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(action.disabled)
                            .opacity(action.disabled ? 0.45 : 1)
                        }
                    }
                    .padding(.vertical, 10)
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(maxHeight: 480)
                .glassSheet(cornerRadius: 30)
                .padding(.leading, 12)
                .padding(.trailing, 44)
                .padding(.bottom, 70)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            .transition(.opacity)
        }
    }

    private struct PlusAction: Identifiable {
        let id: String
        let systemImage: String
        let title: String
        let subtitle: String
        var destructive = false
        var disabled = false
        let run: () -> Void
    }

    private static let steerPrompt = "Pause and explain your current plan"

    private var plusActions: [PlusAction] {
        var out: [PlusAction] = []
        out.append(PlusAction(
            id: "photo", systemImage: "photo", title: "Photo",
            subtitle: "Attach a photo from your library"
        ) { pickingPhoto = true })
        out.append(PlusAction(
            id: "file", systemImage: "doc", title: "File",
            subtitle: "Attach any file from Files"
        ) { pickingFile = true })
        out.append(PlusAction(
            id: "dictate",
            systemImage: dictation.isListening ? "mic.fill" : "mic",
            title: dictation.isListening ? "Stop dictation" : "Dictate",
            subtitle: dictation.isListening ? "Stop listening and keep the text" : "Talk instead of typing"
        ) {
            dictation.toggle(capturing: draft)
        })
        out.append(PlusAction(
            id: "commands", systemImage: "command", title: "Slash commands",
            subtitle: "Computer, tasks, steer, and more"
        ) {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) {
                showCommandHUD = true
            }
            if !draft.hasPrefix("/") { draft = "/" }
            composerFocused = true
        })
        if current.busy, case .bot = current {
            out.append(PlusAction(
                id: "steer", systemImage: "steeringwheel", title: "Steer",
                subtitle: canSend
                    ? "Send this into the running turn"
                    : "Redirect what this bot is doing now"
            ) { steer() })
        }
        if clipboardHasAttachment {
            out.append(PlusAction(
                id: "paste", systemImage: "doc.on.clipboard", title: "Paste from clipboard",
                subtitle: "Add the copied image or file"
            ) { pasteFromClipboard() })
        }
        if case let .bot(bot) = current, session.config?.allowsMultipleBotThreads == true {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New task",
                subtitle: "Start a fresh thread with \(bot.name)", disabled: bot.busy == true
            ) { Task { await session.createTask(for: bot, title: nil) } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Tasks",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
            out.append(PlusAction(
                id: "routines", systemImage: "calendar.badge.clock", title: "Tasks & Routines",
                subtitle: "Automate tasks on a schedule"
            ) { showingRoutines = true })
            out.append(PlusAction(
                id: "computer", systemImage: "display", title: "Watch computer",
                subtitle: "Live view of what \(bot.name) is doing"
            ) { showingComputer = true })
        }
        out.append(PlusAction(
            id: "share", systemImage: "doc.plaintext", title: "Share transcript",
            subtitle: "This chat as Markdown"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "markdown") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        out.append(PlusAction(
            id: "share-json", systemImage: "curlybraces", title: "Share as JSON",
            subtitle: "Structured transcript data"
        ) {
            Task {
                if let url = await session.export(threadId: current.threadId, format: "json") {
                    shareFile = ShareFile(url: url)
                }
            }
        })
        if current.busy {
            out.append(PlusAction(
                id: "stop", systemImage: "stop.fill", title: "Interrupt",
                subtitle: "Stop the current turn", destructive: true
            ) {
                Task {
                    switch current {
                    case let .bot(bot): await session.interrupt(bot: bot)
                    case let .room(room): await session.interrupt(room: room)
                    }
                }
            })
        }
        return out
    }

    /// True when this message opens a fresh stretch of conversation — the
    /// first one, or one that follows a gap of half an hour or more.
    private func startsANewStretch(at index: Int, in items: [TranscriptItem]) -> Bool {
        guard index > 0 else { return true }
        return items[index].date.timeIntervalSince(items[index - 1].date) > 30 * 60
    }

    /// True when the next message is from someone else (or there is none),
    /// which is where a run of bubbles gets its tail — one per run, like
    /// every messaging app, rather than one per bubble.
    private func endsRun(at index: Int, in items: [TranscriptItem]) -> Bool {
        guard index + 1 < items.count else { return true }
        guard case let .message(this) = items[index],
              case let .message(next) = items[index + 1] else {
            return true
        }
        if this.role != next.role { return true }
        if this.from?.name != next.from?.name { return true }
        // a card or a tool chip between two texts breaks the run visually
        return next.kind != .text
    }

    private var canSend: Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return (!text.isEmpty || !pendingAttachments.isEmpty) && !sending
    }

    private var hasPendingApproval: Bool {
        messages.contains { $0.card?.isPending == true }
    }

    private var clipboardHasAttachment: Bool {
        let board = UIPasteboard.general
        if board.hasImages { return true }
        if !(board.urls ?? []).isEmpty { return true }
        return board.contains(pasteboardTypes: [
            UTType.pdf.identifier,
            "com.adobe.pdf",
            UTType.fileURL.identifier,
            UTType.data.identifier,
        ])
    }

    private func steer() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        submit(text.isEmpty ? Self.steerPrompt : nil)
    }

    private func submit(_ explicitText: String? = nil) {
        // This also cancels an in-flight permission prompt before it can
        // open the microphone after the message has already been sent.
        dictation.stop()
        let text = (explicitText ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoing = pendingAttachments
        guard !text.isEmpty || !outgoing.isEmpty, !sending else { return }
        draft = ""
        pendingAttachments = []
        showCommandHUD = false
        SoundEffects.playSent()
        Haptics.impact(.medium)
        sending = true
        Task {
            let ok = await session.send(text, to: current, attachments: outgoing)
            sending = false
            if !ok {
                if draft.isEmpty { draft = text }
                if pendingAttachments.isEmpty { pendingAttachments = outgoing }
            }
        }
    }

    // MARK: - Composer

    /// A round + and a glass pill with dictation and send inside it.
    private var composer: some View {
        VStack(spacing: 6) {
            if let error = dictation.error {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }

            if showCommandHUD {
                CommandSkillHUDView(
                    text: $draft,
                    isVisible: $showCommandHUD,
                    commands: current.isBot
                        ? CommandSkillHUDView.defaultCommands
                        : CommandSkillHUDView.defaultCommands.filter { $0.id != "computer" && $0.id != "tasks" },
                    accentColor: BotPalette.color(current.color)
                ) { command in
                    switch command.id {
                    case "computer":
                        draft = ""
                        showingComputer = true
                    case "tasks":
                        draft = ""
                        showingTasks = true
                    default: submit(command.command)
                    }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if current.busy, case .bot = current {
                HStack(spacing: 8) {
                    Button(action: steer) {
                        HStack(spacing: 5) {
                            Image(systemName: "steeringwheel")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Steer")
                                .font(.caption.weight(.semibold))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Color.secondary.opacity(0.14)))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Steer the running turn")
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 4)
                .transition(.opacity)
            } else if draft.isEmpty && !hasPendingApproval {
                PredictiveActionChipsView(accentColor: BotPalette.color(current.color)) { chip in
                    draft = chip.prompt
                    composerFocused = true
                }
                .transition(.opacity)
            }

            if !pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(pendingAttachments) { item in
                            HStack(spacing: 6) {
                                Image(systemName: item.kind == .image ? "photo" : "doc")
                                    .font(.system(size: 13, weight: .semibold))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.name)
                                        .font(.subheadline.weight(.medium))
                                        .lineLimit(1)
                                    Text(ChatAttachments.formatSize(item.size))
                                        .font(.caption2)
                                        .foregroundStyle(Color.secondary)
                                }
                                Button {
                                    pendingAttachments.removeAll { $0.id == item.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundStyle(Color.secondary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove \(item.name)")
                            }
                            .padding(.leading, 10)
                            .padding(.trailing, 8)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(Color.secondary.opacity(0.14)))
                        }
                    }
                    .padding(.horizontal, 4)
                }
                .frame(minHeight: 44)
            }

            GlassGroup(spacing: 10) {
                HStack(alignment: .bottom, spacing: 10) {
                    Button {
                        dictation.stop()
                        composerFocused = false
                        withAnimation(.snappy(duration: 0.28)) { showingPlus.toggle() }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 20, weight: .medium))
                            .foregroundStyle(showingPlus ? Color(uiColor: .systemBackground) : Color.primary)
                            .rotationEffect(.degrees(showingPlus ? 45 : 0))
                            .frame(width: 44, height: 44)
                            .background(Circle().fill(showingPlus ? Color.primary : Color.clear))
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .glassCapsule()
                    .accessibilityLabel(showingPlus ? "Close" : "More")

                    HStack(alignment: .bottom, spacing: 6) {
                        TextField(
                            dictation.isListening ? "Listening…" : "Ask \(current.name)",
                            text: $draft,
                            axis: .vertical
                        )
                            .lineLimit(1...8)
                            .font(.body)
                            .padding(.leading, 14)
                            .padding(.vertical, 11)
                            .focused($composerFocused)
                            .submitLabel(.return)
                            // Partial transcripts rebuild from a frozen base;
                            // prevent competing edits without dimming the text.
                            .allowsHitTesting(!dictation.isListening && !dictation.isStarting)
                            .onChange(of: draft) { _, value in
                                withAnimation(.easeInOut(duration: 0.15)) {
                                    showCommandHUD = value.hasPrefix("/")
                                }
                            }

                        if dictation.isListening {
                            Button {
                                dictation.toggle(capturing: draft)
                            } label: {
                                Image(systemName: "mic.fill")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(Color.red)
                                    .frame(width: 32, height: 32)
                                    .background(Circle().fill(Color.red.opacity(0.2)))
                                    .symbolEffect(.pulse, isActive: true)
                            }
                            .buttonStyle(.plain)
                            .padding(.bottom, 6)
                            .accessibilityLabel("Stop dictation")
                        }

                        Button { submit() } label: {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? Color.white : Color.secondary)
                                .frame(width: 32, height: 32)
                                .background(
                                    Circle().fill(canSend ? BubbleColor.mine : Color.secondary.opacity(0.18))
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSend)
                        .padding(.trailing, 6)
                        .padding(.bottom, 6)
                        .animation(.easeOut(duration: 0.15), value: canSend)
                    }
                    .frame(minHeight: 44)
                    .glassRounded(cornerRadius: 18, interactive: false)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .onDrop(of: [.image, .fileURL, .pdf, .data], isTargeted: nil) { providers in
            Task { await addDropItems(providers) }
            return true
        }
    }

    private func pasteFromClipboard() {
        let board = UIPasteboard.general
        if board.hasImages, let image = board.image {
            addUIImage(image, name: "pasted-image.jpg")
            return
        }
        if let urls = board.urls, !urls.isEmpty {
            Task { await addFiles(urls) }
            return
        }
        if let data = board.data(forPasteboardType: UTType.pdf.identifier)
            ?? board.data(forPasteboardType: "com.adobe.pdf") {
            enqueue(name: "pasted.pdf", mime: "application/pdf", data: data)
            return
        }
        for item in board.items {
            for (type, value) in item {
                if type.hasPrefix("public.text") || type.hasPrefix("public.utf8-plain-text") {
                    continue
                }
                guard let data = value as? Data, !data.isEmpty else { continue }
                let ut = UTType(type)
                let mime = ChatAttachments.sniffImageMIME(data)
                    ?? ChatAttachments.mime(forExtension: ut?.preferredFilenameExtension ?? "")
                let ext = ut?.preferredFilenameExtension.map { ".\($0)" } ?? ""
                enqueue(name: "pasted-file\(ext)", mime: mime, data: data)
                return
            }
        }
        session.actionError = "The clipboard has no image or file to attach."
    }

    private func addPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            session.actionError = "That photo could not be read."
            return
        }
        if let mime = ChatAttachments.sniffImageMIME(data) {
            enqueue(name: suggestedPhotoName(mime: mime), mime: mime, data: data)
            return
        }
        if let image = UIImage(data: data) {
            addUIImage(image, name: "photo.jpg")
            return
        }
        session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
    }

    private func suggestedPhotoName(mime: String) -> String {
        switch ChatAttachments.normalizeMIME(mime) {
        case "image/png": return "photo.png"
        case "image/gif": return "photo.gif"
        case "image/webp": return "photo.webp"
        default: return "photo.jpg"
        }
    }

    private func addUIImage(_ image: UIImage, name: String) {
        guard let data = image.jpegData(compressionQuality: 0.9) else {
            session.actionError = "That image could not be attached."
            return
        }
        enqueue(name: name, mime: "image/jpeg", data: data)
    }

    private func addFiles(_ urls: [URL]) async {
        for url in urls {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                let mime = ChatAttachments.sniffImageMIME(data)
                    ?? ChatAttachments.mime(forExtension: url.pathExtension)
                enqueue(name: url.lastPathComponent, mime: mime, data: data)
            } catch {
                session.actionError = "Could not read \(url.lastPathComponent)."
            }
        }
    }

    private func addDropItems(_ providers: [NSItemProvider]) async {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                if let url = await loadFileURL(from: provider) {
                    await addFiles([url])
                }
                continue
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                if let data = try? await loadData(from: provider, type: UTType.image) {
                    if let mime = ChatAttachments.sniffImageMIME(data) {
                        enqueue(name: "dropped-image", mime: mime, data: data)
                    } else if let image = UIImage(data: data) {
                        addUIImage(image, name: "dropped-image.jpg")
                    }
                }
                continue
            }
            if let data = try? await loadData(from: provider, type: UTType.data) {
                enqueue(name: "dropped-file", mime: "application/octet-stream", data: data)
            }
        }
    }

    private func loadFileURL(from provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else if let data = item as? Data,
                          let url = URL(dataRepresentation: data, relativeTo: nil) {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private func loadData(from provider: NSItemProvider, type: UTType) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? APIError.transport("That drop could not be read."))
                }
            }
        }
    }

    private func enqueue(name: String, mime: String, data: Data) {
        let normalized = ChatAttachments.normalizeMIME(mime)
        let resolved = ChatAttachments.isAllowedMIME(normalized) ? normalized : "application/octet-stream"
        let ceiling = ChatAttachments.maxBytes(forMIME: resolved)
        if data.isEmpty {
            session.actionError = "\(name) is empty."
            return
        }
        if data.count > ceiling {
            session.actionError = "\(name) is larger than \(ceiling / (1_024 * 1_024)) MB."
            return
        }
        if pendingAttachments.count >= 8 {
            session.actionError = "Remove an attachment before adding another."
            return
        }
        // Sidecar GET and the transcript renderer share four display formats.
        // Convert any other decodable image before upload so a successful send
        // cannot leave behind an attachment the phone cannot read back.
        if ChatAttachments.isImageMIME(resolved), !ChatAttachments.isDisplayImageMIME(resolved) {
            guard let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.9)
            else {
                session.actionError = "\(name) could not be converted to PNG, JPEG, GIF, or WebP."
                return
            }
            let jpegName = (name as NSString).deletingPathExtension + ".jpg"
            pendingAttachments.append(PendingChatAttachment(name: jpegName, mime: "image/jpeg", data: jpeg))
            return
        }
        pendingAttachments.append(PendingChatAttachment(name: name, mime: resolved, data: data))
    }
}

struct MessageRow: View {
    let chat: Chat
    let message: Message
    /// Last bubble of a run from the same side: the one that gets the tail.
    var endsRun = true
    @EnvironmentObject private var session: Session
    @State private var editingText = ""
    @State private var showingEdit = false

    private static let reactionChoices = ["👍", "❤️", "😂", "🎉", "👀"]

    private var versions: [Message] {
        session.state.versions(of: message, inThread: chat.threadId)
    }

    private var senderBot: Bot? {
        if message.role == .user { return nil }
        if let botId = message.from?.botId {
            return session.state.bot(botId)
        }
        if case let .bot(bot) = chat {
            return bot
        }
        return nil
    }

    private var senderModelSelection: ModelSelection? {
        guard let bot = senderBot else { return nil }
        if let currentTask = bot.tasks?.first(where: { $0.threadId == chat.threadId }) {
            if let taskSelection = currentTask.modelSelection {
                return currentTask.activeModelSelection ?? taskSelection
            }
            return currentTask.activeModelSelection ?? bot.activeModelSelection ?? bot.modelSelection
        }
        return bot.activeModelSelection ?? bot.modelSelection
    }

    private var senderDriverKind: String? {
        guard let selection = senderModelSelection else { return nil }
        // A cold registry cannot tell whether a named instance runs this model's
        // native driver or a different one. Do not mislabel the sender's mark.
        return session.instanceDriverKinds[selection.instanceId]
    }

    @ViewBuilder
    private var avatarBadge: some View {
        // A `.system` row is an auto-delivered routine/webhook/resource
        // instruction, not something the bot said — it renders its own
        // ChannelEventCard below and must not borrow the bot's (or room's)
        // avatar, matching the desktop rendering.
        if message.role == .system {
            EmptyView()
        } else if message.role != .user {
            if let bot = senderBot {
                if endsRun {
                    BotAvatarView(bot: bot, size: 28, state: .idle, animated: false)
                        .overlay(alignment: .bottomTrailing) {
                            if let senderDriverKind {
                                ProviderMarkView(driverKind: senderDriverKind, model: senderModelSelection?.model, size: 16)
                                    .offset(x: 3, y: 3)
                            }
                        }
                } else {
                    Color.clear.frame(width: 28, height: 28)
                }
            } else if case let .room(room) = chat {
                if endsRun {
                    RoomAvatarView(room: room, size: 28, state: .idle, animated: false)
                } else {
                    Color.clear.frame(width: 28, height: 28)
                }
            }
        }
    }

    @ViewBuilder
    private var messageContent: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
            content

            if let comm = message.comm {
                if message.automationSource == "delegation" {
                    Label("From @\(comm.withName)", systemImage: "arrow.down.left.bubble")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                } else {
                    Label("Messaged \(comm.withName)", systemImage: "arrow.up.right.bubble")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
            }

            // Stay up while `message.queued` is true, even after `bot.busy`
            // flips false.  Gating on busy made the chip vanish in the gap
            // between turn-end and the drain frame (Sentry on #224).
            if message.queued == true, case let .bot(bot) = chat {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                    Text("Queued — sends when this turn finishes")
                    Button("Steer Now") {
                        Task { await session.interrupt(bot: bot) }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    Button {
                        Task { await session.cancelQueued(botId: bot.id, queueId: message.queueId ?? message.id) }
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Cancel queued message")
                }
                .font(.system(size: 11))
                .foregroundStyle(Color.secondary)
            } else if message.steered == true {
                Text("Sent mid-turn")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.secondary)
            }

            if let reactions = message.reactions, !reactions.isEmpty {
                HStack(spacing: 6) {
                    ForEach(reactionGroups(reactions), id: \.emoji) { group in
                        Button("\(group.emoji) \(group.count)") {
                            Task { await session.react(to: message, in: chat.threadId, emoji: group.emoji) }
                        }
                        .font(.system(size: 13))
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(group.mine ? Color.accentColor : Color.secondary)
                    }
                }
            }

            if versions.count > 1, let index = versions.firstIndex(where: { $0.id == message.id }),
               case let .bot(bot) = chat {
                HStack(spacing: 8) {
                    Button {
                        Task { await session.switchVersion(to: versions[index - 1], for: bot) }
                    } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0 || bot.busy == true)
                    Text("\(index + 1) of \(versions.count)")
                    Button {
                        Task { await session.switchVersion(to: versions[index + 1], for: bot) }
                    } label: { Image(systemName: "chevron.right") }
                    .disabled(index + 1 >= versions.count || bot.busy == true)
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondary)
            }
        }
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: message.role == .system ? 0 : 8) {
            avatarBadge
            messageContent
        }
        .contextMenu {
            // `at` is epoch milliseconds on the wire, like every other timestamp
            // the harness sends; SwiftUI's time style wants a Date.
            Text(Date(timeIntervalSince1970: message.at / 1_000), style: .time)
            if let text = message.text, !text.isEmpty {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = text
                }
            }
            Divider()
            ForEach(Self.reactionChoices, id: \.self) { emoji in
                Button(emoji) { Task { await session.react(to: message, in: chat.threadId, emoji: emoji) } }
            }
            if (message.role == .user ||
                (message.role == .system && message.automationSource == "delegation")),
               message.kind == .text,
               WebhookMessageView.parse(message.text) == nil,
               ImessageMessageView.parse(message.text) == nil,
               case let .bot(bot) = chat {
                Divider()
                Button("Edit and retry", systemImage: "pencil") {
                    editingText = message.text ?? ""
                    showingEdit = true
                }
                .disabled(bot.busy == true)
            }

            if let reqId = message.card?.requestId {
                Divider()
                Button("Copy Request ID", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = reqId
                }
            }
        }
        .alert("Edit and retry", isPresented: $showingEdit) {
            TextField("Message", text: $editingText)
            Button("Cancel", role: .cancel) {}
            if case let .bot(bot) = chat {
                Button("Send") {
                    let text = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    Task { await session.edit(message, for: bot, text: text) }
                }
            }
        } message: {
            Text("This creates a new version and continues from there.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch message.kind {
        case .text:
            if let delegation = DelegationMessageView.parse(message.text, role: message.role, fromName: message.from?.name, automationSource: message.automationSource) {
                ChannelEventCard(
                    headline: delegation.headline,
                    subtitle: delegation.subtitle,
                    payload: delegation.payload,
                    systemImage: "arrow.triangle.branch",
                    accessibilityName: delegation.headline
                )
            } else if message.role == .system {
                if let webhook = WebhookMessageView.parse(message.text) {
                    WebhookEventCard(view: webhook)
                } else if let imessage = ImessageMessageView.parse(message.text) {
                    ImessageEventCard(view: imessage)
                } else {
                    let body = message.text ?? ""
                    // Headline names what actually fired this — accurate per
                    // message.automationSource (falls back to sniffing the
                    // resource marker for rows persisted before that field
                    // existed), not the hardcoded "Scheduled Run" a manual
                    // Run Now or a resource alert would otherwise wear.
                    // Subtitle is the instruction's own first non-blank line.
                    let first = body.split(whereSeparator: \.isNewline).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }).map(String.init) ?? ""
                    let headline = Self.automationSourceLabel(message.automationSource, body: body)
                    ChannelEventCard(
                        headline: headline,
                        subtitle: first.isEmpty || first == "Scheduled Run" ? nil : String(first.prefix(80)),
                        payload: body.isEmpty ? nil : body,
                        systemImage: headline == "Resource Alert" ? "gauge.with.dots.needle.67percent" : "clock.arrow.2.circlepath",
                        // Headline is already the specific "Scheduled Run" /
                        // "Run Now" / "Resource Alert" label, so VoiceOver
                        // should say that — not a generic "Automated Instruction".
                        accessibilityName: headline
                    )
                }
            } else if message.role == .user, let webhook = WebhookMessageView.parse(message.text) {
                WebhookEventCard(view: webhook)
            } else if message.role == .user, let imessage = ImessageMessageView.parse(message.text) {
                ImessageEventCard(view: imessage)
            } else {
                TextBubble(message: message, chat: chat, tailed: endsRun)
            }
        case .options:
            CardView(chat: chat, message: message)
        case .activity:
            ActivityChip(tool: message.tool)
        case .screen:
            ScreenShot(threadId: chat.threadId, message: message)
        case .unknown:
            // A message kind from a newer computer. Almost everything the
            // harness sends carries `text`, so showing it is usually the
            // whole message and always better than a gap in the transcript.
            // When there is nothing to show, show nothing — a placeholder
            // saying "unsupported" is a worse gap than the gap.
            if let text = message.text, !text.isEmpty {
                TextBubble(message: message, chat: chat, tailed: endsRun)
            }
        }
    }

    private func reactionGroups(_ reactions: [Reaction]) -> [(emoji: String, count: Int, mine: Bool)] {
        Dictionary(grouping: reactions, by: \.emoji)
            .map { (emoji: $0.key, count: $0.value.count, mine: $0.value.contains { $0.by == "user" }) }
            .sorted { $0.emoji < $1.emoji }
    }

    /// The headline on a generic (non-webhook, non-iMessage) auto-delivered
    /// instruction card. Mirrors the TypeScript `automationSourceLabel`
    /// (`src/lib/replies.ts`) exactly, including its wording — prefers the
    /// persisted `automationSource`; a row from before that field existed
    /// falls back to sniffing the resource-trigger marker in the stored
    /// text, and otherwise reads as "Scheduled Run" (a real schedule fire,
    /// the only case that label was ever accurate for).
    static func automationSourceLabel(_ source: String?, body: String) -> String {
        switch source {
        case "resource":
            return "Resource Alert"
        case "manual":
            return "Run Now"
        case "webhook":
            return "Webhook"
        case "schedule":
            return "Scheduled Run"
        case "delegation":
            return "Delegated Task"
        default:
            if DelegationMessageView.isDelegation(body, role: .system) {
                return "Delegated Task"
            }
            return body.contains("[UNTRUSTED RESOURCE SAMPLE]") ? "Resource Alert" : "Scheduled Run"
        }
    }
}

private struct ShareFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct TextBubble: View {
    let message: Message
    let chat: Chat
    var tailed = true
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var parsedDiff: (filename: String, diff: String)? {
        guard message.role != .user, let source = message.text else { return nil }
        let text = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let diff: String
        if text.hasPrefix("```diff"), text.hasSuffix("```") {
            diff = String(text.dropFirst("```diff".count).dropLast(3))
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } else if text.hasPrefix("diff --git ") {
            diff = text
        } else {
            return nil
        }
        let firstLine = diff.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        let filename = firstLine.split(separator: " ").last.map(String.init)?
            .replacingOccurrences(of: "b/", with: "") ?? "Git patch"
        return (filename, diff)
    }

    private var parsedTable: (headers: [String], rows: [[String]])? {
        guard message.role != .user, let source = message.text else { return nil }
        let lines = source.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard lines.count >= 3, lines.allSatisfy({ $0.hasPrefix("|") && $0.hasSuffix("|") }) else {
            return nil
        }
        let headers = Self.tableCells(lines[0])
        let separators = Self.tableCells(lines[1])
        guard !headers.isEmpty, separators.count == headers.count,
              separators.allSatisfy(Self.isTableSeparator) else { return nil }
        let rows = lines.dropFirst(2).map(Self.tableCells)
        guard rows.allSatisfy({ $0.count == headers.count }) else { return nil }
        return (headers, rows)
    }

    private static func tableCells(_ line: String) -> [String] {
        var body = line
        if body.first == "|" { body.removeFirst() }
        if body.last == "|" { body.removeLast() }

        var cells: [String] = []
        var cell = ""
        var escaped = false
        for character in body {
            if escaped {
                if character == "|" {
                    cell.append(character)
                } else {
                    cell.append("\\")
                    cell.append(character)
                }
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func isTableSeparator(_ cell: String) -> Bool {
        let compact = cell.replacingOccurrences(of: " ", with: "")
        let core = compact.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
        return core.count >= 3 && core.allSatisfy { $0 == "-" }
    }

    var body: some View {
        let mine = message.role == .user && !DelegationMessageView.isDelegation(message.text, role: message.role, automationSource: message.automationSource)
        let customCard = parsedDiff != nil || parsedTable != nil
        // rooms attribute each line to the member who said it
        let speaker = message.from
        // No face beside the bubble: the bot's face is in the header, and in
        // a room the name line says who spoke. The bubble sits at the edge.
        HStack(alignment: .bottom, spacing: 0) {
            if mine { Spacer(minLength: 56) }

            VStack(alignment: .leading, spacing: 4) {
                if let speaker, !mine {
                    Text(speaker.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(BotPalette.color(speaker.color))
                }
                // Bots get markdown, you do not — the same split the desktop
                // makes. Markdown you did not intend is worse than markdown
                // you did: a message about `**` should show the asterisks.
                if let diff = parsedDiff {
                    GitPRDiffCardView(filename: diff.filename, diffText: diff.diff)
                } else if let table = parsedTable {
                    SQLResultTableView(columns: table.headers, rows: table.rows)
                } else {
                    let split = ChatAttachments.split(message.text ?? "")
                    if mine {
                        if !split.display.isEmpty {
                            Text(split.display)
                                .font(.body)
                                .foregroundStyle(BubbleColor.mineText)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else if !split.display.isEmpty {
                        let toImessage = ImessageMessageView.stripToImessagePrefix(split.display)
                        if toImessage != nil {
                            Text("To iMessage")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                        MarkdownText(source: toImessage ?? split.display)
                            .foregroundStyle(Color.primary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(Array(split.images.enumerated()), id: \.offset) { _, path in
                        AttachedImageView(path: path)
                    }
                    ForEach(Array(split.files.enumerated()), id: \.offset) { _, path in
                        Label(ChatAttachments.attachmentBasename(path), systemImage: "doc")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(mine ? BubbleColor.mineText.opacity(0.9) : Color.secondary)
                    }
                }
            }
            .padding(.horizontal, customCard ? 0 : 15)
            .padding(.vertical, customCard ? 0 : 11)
            .frame(maxWidth: sizeClass == .regular ? 560 : .infinity, alignment: .leading)
            .background(
                Group {
                    if !customCard {
                        SpeechBubble(tail: tailed ? (mine ? .trailing : .leading) : .none)
                            .fill(mine ? BubbleColor.mine : BubbleColor.theirs)
                    }
                }
            )
            // leave room for the tail below, so the next row does not sit on it
            .padding(.bottom, !customCard && tailed ? SpeechBubble.tailDrop() : 0)

            if !mine { Spacer(minLength: 44) }
        }
    }
}

/// Incoming webhook as a collapsible work card, not a blue user bubble.
/// Auto-delivered instructions are stored as role=system so the model still
/// sees them as the turn prompt.  Older rows used role=user; the card still
/// catches those.  That does not mean a person typed it.
struct WebhookEventCard: View {
    let view: WebhookMessageView

    var body: some View {
        ChannelEventCard(
            headline: view.headline,
            subtitle: view.subtitle,
            payload: view.payload,
            systemImage: "bolt.horizontal.circle.fill",
            accessibilityName: "Webhook"
        )
    }
}

/// Incoming iMessage as the same left-edge work card as a webhook trigger.
struct ImessageEventCard: View {
    let view: ImessageMessageView

    var body: some View {
        ChannelEventCard(
            headline: view.headline,
            subtitle: view.subtitle,
            payload: view.payload,
            systemImage: "message.fill",
            accessibilityName: "iMessage"
        )
    }
}

struct ChannelEventCard: View {
    let headline: String
    let subtitle: String?
    let payload: String?
    let systemImage: String
    let accessibilityName: String
    @Environment(\.colorScheme) private var colorScheme
    @State private var isExpanded = false

    var body: some View {
        let isDark = colorScheme == .dark
        let expandable = payload != nil
        VStack(alignment: .leading, spacing: 0) {
            Group {
                if expandable {
                    Button {
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.76)) {
                            isExpanded.toggle()
                        }
                        Haptics.selection()
                    } label: {
                        headerRow
                    }
                    .buttonStyle(.plain)
                } else {
                    headerRow
                }
            }

            if isExpanded, let payload {
                Divider()
                    .overlay(Color.primary.opacity(isDark ? 0.12 : 0.08))
                ScrollView {
                    Text(payload)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(isDark ? Color.white.opacity(0.04) : Color(uiColor: .tertiarySystemBackground))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(isDark ? Color.white.opacity(0.06) : Color(uiColor: .secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.primary.opacity(isDark ? 0.12 : 0.08), lineWidth: 0.75)
        )
        .shadow(color: Color.black.opacity(isDark ? 0 : 0.04), radius: 0, y: 1)
        .frame(maxWidth: 580, alignment: .leading)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(expandable ? .isButton : [])
        .accessibilityLabel(accessibilityName == headline ? headline : "\(accessibilityName).  \(headline)")
        .accessibilityHint(payload == nil ? "" : (isExpanded ? "Hides the details" : "Shows the details"))
    }

    private var headerRow: some View {
        let isDark = colorScheme == .dark
        return HStack(alignment: .center, spacing: 10) {
            ZStack {
                Circle()
                    .fill(Color.secondary.opacity(0.12))
                    .frame(width: 26, height: 26)
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(headline)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isDark ? Color.white : Color.primary)
                    .lineLimit(isExpanded ? 4 : 2)
                    .truncationMode(.tail)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 11.5))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }

            Spacer(minLength: 8)

            if payload != nil {
                HStack(spacing: 4) {
                    Text(isExpanded ? "Collapse" : "Details")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// A tool the bot ran. Deliberately quiet — these are the bulk of a busy
/// transcript and they are context, not content.
struct ActivityChip: View {
    let tool: ToolActivity?

    var body: some View {
        if let tool {
            SkillExecutionReceiptView(
                skillName: tool.name,
                status: tool.ok.map { $0 ? "success" : "error" } ?? "running"
            )
            .padding(.leading, 2)
        }
    }
}

/// An interactive folded summary card for a run of tool calls.
/// Shows a live summary statement (e.g. "14 tool calls • run_command ×10, view_file, call_mcp_tool")
/// and expands on tap to display the full individual skill execution receipts.
struct ActivityRunView: View {
    let chat: Chat
    let messages: [Message]
    @Environment(\.colorScheme) private var colorScheme
    @State private var isExpanded: Bool = false

    private var hasFailure: Bool {
        messages.contains { $0.tool?.ok == false }
    }

    private var isRunning: Bool {
        messages.contains { $0.tool?.ok == nil }
    }

    private var tint: Color {
        BotPalette.color(chat.color)
    }

    var body: some View {
        let isDark = colorScheme == .dark
        let desc = describeActivityRun(messages)

        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.76)) {
                    isExpanded.toggle()
                }
                Haptics.selection()
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    ZStack {
                        Circle()
                            .fill(hasFailure ? Color.red.opacity(0.18) : (isRunning ? tint.opacity(0.18) : Color.purple.opacity(0.14)))
                            .frame(width: 26, height: 26)

                        if isRunning {
                            ProgressView()
                                .scaleEffect(0.65)
                        } else if hasFailure {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(Color.red)
                        } else {
                            Image(systemName: "wrench.and.screwdriver.fill")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(Color.purple)
                        }
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(desc.headline)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(isDark ? Color.white : Color.primary)

                            if hasFailure {
                                Text("• \(desc.failedCount) failed")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Color.red)
                            } else if !isRunning {
                                Text("• Complete")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(Color.green)
                            }
                        }

                        Text(desc.summary)
                            .font(.system(size: 11.5))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    Spacer()

                    HStack(spacing: 4) {
                        Text(isExpanded ? "Collapse" : "Details")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(tint)

                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(tint)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(tint.opacity(0.1))
                    .clipShape(Capsule())
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(isDark ? Color.white.opacity(0.06) : Color.black.opacity(0.03))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(hasFailure ? Color.red.opacity(0.3) : Color.secondary.opacity(0.15), lineWidth: 0.75)
                )
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(messages) { msg in
                        if let tool = msg.tool {
                            SkillExecutionReceiptView(
                                skillName: tool.name,
                                status: tool.ok.map { $0 ? "success" : "error" } ?? "running"
                            )
                        }
                    }
                }
                .padding(.leading, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.vertical, 2)
        .onAppear {
            if hasFailure {
                isExpanded = true
            }
        }
    }
}

/// An option card. When it still has a request behind it, this is the
/// screen the companion exists for — a bot stopped, and only a person can
/// let it continue.
struct CardView: View {
    let chat: Chat
    let message: Message
    @EnvironmentObject private var session: Session
    @State private var answering = false

    /// One definition of "the refusal", shared by the button tint and the
    /// choice above so the two cannot drift apart.
    private static func isRefusal(_ option: String) -> Bool { OptionCard.isRefusal(option) }

    private var tint: Color { BotPalette.color(chat.color) }

    var body: some View {
        if let card = message.card {
            VStack(alignment: .leading, spacing: 10) {
                if card.isPending {
                    Label("\(chat.name) is waiting on you", systemImage: "hand.raised.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint)
                }
                Text(card.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(.system(size: 15))
                        .foregroundStyle(Color.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let held = card.held {
                    Label(held, systemImage: "exclamationmark.shield")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                }

                if card.isPending {
                    HStack(spacing: 8) {
                        ForEach(card.options, id: \.self) { option in
                            Button {
                                answering = true
                                Task {
                                    await session.answer(chat: chat, card: card, choice: option)
                                    answering = false
                                }
                            } label: {
                                Text(card.displayChoice(for: option))
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(Self.isRefusal(option) ? Color.primary : .white)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 40)
                                    .background(
                                        Capsule().fill(Self.isRefusal(option) ? Color.secondary.opacity(0.18) : tint)
                                    )
                            }
                            .buttonStyle(.plain)
                            .disabled(answering)
                        }
                    }
                    .padding(.top, 2)

                } else if let answered = card.answered {
                    Label(answered, systemImage: "checkmark.circle")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(card.isPending ? tint.opacity(0.12) : Color.secondary.opacity(0.13))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(card.isPending ? tint : .clear, lineWidth: 1.5)
            }
        }
    }
}

/// A frame of the bot's computer. In the paged shape the pixels are not in
/// the transcript — they are fetched here, once, when the row appears.
/// A transcript image fetched with the pairing token, never as a bare URL.
struct AttachedImageView: View {
    let path: String
    @EnvironmentObject private var session: Session
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
                    .frame(height: 140)
                    .overlay { ProgressView() }
            }
        }
        .frame(maxWidth: 280)
        .task {
            guard image == nil, let fetch = ChatAttachments.fetchPath(forDiskPath: path) else { return }
            let data = await session.avatarData(forPath: fetch)
            image = data.flatMap(UIImage.init(data:))
        }
    }
}

struct ScreenShot: View {
    let threadId: String
    let message: Message
    @EnvironmentObject private var session: Session
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.secondary.opacity(0.13))
                    .frame(height: 160)
                    .overlay { ProgressView() }
            }
        }
        .task {
            guard image == nil else { return }
            let data: Data?
            if let inline = message.png, let decoded = Data(base64Encoded: inline) {
                data = decoded
            } else if message.hasImage == true {
                data = await session.image(threadId: threadId, messageId: message.id)
            } else {
                data = nil
            }
            image = data.flatMap(UIImage.init(data:))
        }
    }
}

/// The reply as it is being typed, styled to match the settled bubble it is
/// about to become — the handover should be invisible, and any difference in
/// padding or corner radius reads as the message jumping on arrival.
///
/// A caret rather than a spinner: a spinner says "something is happening
/// somewhere", which the reader already knows. A caret at the end of real
/// text says how far along it is.
///
/// The caret does not blink, deliberately. The obvious way to blink it —
/// `withAnimation(.repeatForever) { flag.toggle() }` in `onAppear` — animates
/// the change once and then sits still, and a caret that blinks twice and
/// stops looks more broken than one that never blinks. A correct version
/// animates opacity on a separate view, which needs a device to get right;
/// static is honest until then.
struct StreamingBubble: View {
    let text: String?
    let reasoning: String?
    var color: String = "blue"

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                if let reasoning, !reasoning.isEmpty, text?.isEmpty != false {
                    AgentThoughtChamberView(
                        reasoning: String(reasoning.suffix(2_000)),
                        botName: "Bot",
                        mascotColor: BotPalette.color(color),
                        isStreaming: true
                    )
                }
                if let text, !text.isEmpty {
                    // Same renderer as the settled bubble, for the same
                    // reason as the padding: a live reply showing `**bold**`
                    // that snaps to bold on arrival is the message jumping,
                    // just in a different dimension. The parser tolerates the
                    // half-finished markdown this is always holding — an
                    // unclosed fence renders as code, an unclosed link as the
                    // characters typed so far.
                    MarkdownText(source: text, caret: true)
                        .foregroundStyle(Color.primary)
                }
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .background(SpeechBubble(tail: .leading).fill(BubbleColor.theirs))
            .padding(.bottom, SpeechBubble.tailDrop())
            Spacer(minLength: 44)
        }
        // No `.textSelection` on purpose: selecting text that is still growing
        // fights the reader, and the settled bubble a frame later is
        // selectable anyway.
    }
}
