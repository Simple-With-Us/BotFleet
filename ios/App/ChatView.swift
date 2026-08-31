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
    @State private var draft = ""
    @State private var showingTasks = false
    @State private var showingComputer = false
    @State private var showingPlus = false
    @State private var showingProfile = false
    @State private var showCommandHUD = false
    @State private var shareFile: ShareFile?
    @State private var stagedAttachments: [StagedAttachment] = []
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var showingPhotoPicker = false
    @State private var showingFileImporter = false
    @State private var isUploadingAttachments = false
    @State private var isDropTargeted = false
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = SpeechDictation()
    /// The opening beat: the island grows with the bot's face in it, then
    /// shrinks away as the face settles into the header. `facePhase` is 1
    /// with the face in the island, 0 with it home in the header.
    @State private var islandExpanded = false
    @State private var islandVisible = false
    @State private var facePhase: CGFloat = 0
    @State private var isAtBottom = true

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

    var body: some View {
        // Read the transcript once for this render. Pagination changes the
        // array as a unit; repeatedly reaching through ObservableObject for
        // every row only recomputes the same value.
        let transcript = messages
        // A VStack with the composer as a sibling, rather than a scroll view
        // with `.safeAreaInset`. The inset version sized itself to its
        // content, so a short transcript left the composer floating in the
        // middle of the screen with black beneath it. Here the scroll area is
        // explicitly told to take everything the composer does not.
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
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
                        // room for the floating face when scrolled to the top
                        Color.clear.frame(height: 72)

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

                        ForEach(Array(transcript.enumerated()), id: \.element.id) { index, message in
                            VStack(alignment: .leading, spacing: 6) {
                                // a gap in time is worth marking; a timestamp
                                // on every message is just noise
                                if startsANewStretch(at: index, in: transcript) {
                                    Text(RelativeStamp.separator(message.date))
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.secondary.opacity(0.7))
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, 10)
                                        .padding(.bottom, 4)
                                }
                                MessageRow(
                                    chat: current,
                                    message: message,
                                    endsRun: endsRun(at: index, in: transcript)
                                )
                            }
                            .id(message.id)
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
                            TypingIndicatorView(tintColor: MausPalette.color(current.color))
                                .id(Self.liveBubbleId)
                                .accessibilityLabel("\(current.name) is working")
                        }
                        Color.clear.frame(height: 1)
                            .id("bottom-marker")
                            .onAppear { isAtBottom = true }
                            .onDisappear { isAtBottom = false }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // The header lives in the scroll view's top safe area: the
                // transcript starts below it and scrolls under it — that is
                // what the glass is for. An inset rather than a content
                // margin, because `.defaultScrollAnchor(.bottom)` anchored
                // unreliably against a margin and opened chats mid-way.
                // The blur is only the top strip — back, computer — the way
                // a system bar is; the transcript starts on that line and
                // scrolls under the face and name, which float over it.
                .safeAreaInset(edge: .top, spacing: 0) { headerBar }
                .overlay(alignment: .top) { headerFace }
                .overlay(alignment: .top) {
                    // One face, in one layer, measured from the screen's top
                    // edge: it sits in the island while that is open and
                    // glides into its header slot when the island lets go.
                    let topInset = IslandGeometry.topInset
                    let hasIsland = IslandGeometry.hasIsland(topInset: topInset)
                    let islandSide: CGFloat = 220
                    // centred in the part of the square the hardware island does not cover
                    let islandFaceCentre = IslandGeometry.top + IslandGeometry.size.height + (islandSide - IslandGeometry.size.height) / 2
                    let headerFaceCentre = topInset + 26
                    let faceSize = 60 + 72 * facePhase
                    let faceCentre = headerFaceCentre + (islandFaceCentre - headerFaceCentre) * facePhase
                    ZStack(alignment: .top) {
                        if islandVisible {
                            IslandShell(expanded: islandExpanded, hasIsland: hasIsland, expandedSize: CGSize(width: islandSide, height: islandSide)) {
                                Color.clear
                            }
                        }
                        ChatAvatarView(chat: current, size: faceSize, state: MausState.forChat(current, in: session.state), animated: MausState.forChat(current, in: session.state).showsActivity || islandExpanded, comets: islandExpanded)
                            .offset(y: faceCentre - faceSize / 2)
                            .allowsHitTesting(false)
                    }
                    .frame(maxWidth: .infinity, alignment: .top)
                    .ignoresSafeArea(edges: .top)
                }
                .task {
                    // grow, hold a beat, shrink — the face rides along
                    guard !reduceMotion else { return }
                    islandVisible = true
                    try? await Task.sleep(for: .milliseconds(40))
                    withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) { islandExpanded = true; facePhase = 1 }
                    try? await Task.sleep(for: .milliseconds(1000))
                    withAnimation(.spring(response: 0.55, dampingFraction: 0.82)) { islandExpanded = false; facePhase = 0 }
                    try? await Task.sleep(for: .milliseconds(600))
                    islandVisible = false
                }
                // A conversation grows from the bottom: a transcript shorter
                // than the screen rests at the bottom, and opening a chat
                // starts on the newest message rather than the oldest.
                .defaultScrollAnchor(.bottom)
                .onChange(of: transcript.last?.id) { _, _ in
                    guard isAtBottom, let last = transcript.last else { return }
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                // Follow the text as it arrives. Keyed on length rather than
                // the string so this fires once per delta batch, and without
                // animation — animating every token turns a smooth stream
                // into a stutter, because each scroll interrupts the last.
                .onChange(of: session.state.streaming[threadId]?.count ?? 0) { _, length in
                    guard isAtBottom, length > 0 else { return }
                    proxy.scrollTo(Self.liveBubbleId, anchor: .bottom)
                }
                .onChange(of: session.focusedMessageId) { _, messageId in
                    guard let messageId else { return }
                    let contains = messages.contains(where: { $0.id == messageId })
                    if contains {
                        withAnimation { proxy.scrollTo(messageId, anchor: .center) }
                        session.consumeFocus(messageId)
                    }
                }
                .task {
                    if let messageId = session.focusedMessageId {
                        let contains = messages.contains(where: { $0.id == messageId })
                        if contains {
                            proxy.scrollTo(messageId, anchor: .center)
                            session.consumeFocus(messageId)
                        }
                    }
                }
            }
            .id(threadId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .overlay(alignment: .bottom) { plusSheet }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        .navigationDestination(isPresented: $showingComputer) {
            if case let .bot(bot) = current { ComputerView(bot: bot) }
        }
        .task(id: threadId) {
            // opening a chat is what marks it read, exactly as on the desktop
            if current.unread { await session.markRead(current) }
#if DEBUG
            // `-open-plus`: the + sheet up, for the screenshot harness
            if ProcessInfo.processInfo.arguments.contains("-open-plus") { showingPlus = true }
            // Profile parity screenshots without automating a tap through the
            // animated island/header transition.
            if ProcessInfo.processInfo.arguments.contains("-open-profile") { showingProfile = true }
#endif
        }
        .onChange(of: current.unread) { _, unread in
            // A message can arrive while this chat is already on screen. The
            // initial task above will not run again, so clear that new unread
            // bit here rather than leaving a badge on an open conversation.
            if unread { Task { await session.markRead(current) } }
        }
        .onDisappear { dictation.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { dictation.stop() }
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
            // Always join against the text frozen at capture start. A newer
            // partial then replaces the older partial instead of duplicating it.
            draft = Dictation.draft(base: dictation.base, transcript: spoken)
        }
        .onChange(of: dictation.isListening) { _, listening in
            if listening { composerFocused = false }
        }
        .sheet(isPresented: $showingTasks) {
            if current.supportsTasks { TaskManagerView(chat: current) }
        }
        .sheet(isPresented: $showingProfile) {
            switch current {
            case let .bot(bot): AgentProfileView(bot: bot)
            case let .room(room): GroupProfileView(room: room)
            }
        }
        .sheet(item: $shareFile) { file in
            ActivityShareSheet(items: [file.url])
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: 10,
            matching: .images
        )
        .onChange(of: selectedPhotoItems) { _, items in
            Task { await processPhotoItems(items) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            processImportedFiles(result)
        }
        .onDrop(of: [UTType.image.identifier, UTType.fileURL.identifier, UTType.data.identifier], isTargeted: $isDropTargeted) { providers in
            handleDrop(providers: providers)
        }
        .onAppear {
            if let initial = session.stagedAttachmentsByChatId[current.id], !initial.isEmpty {
                stagedAttachments.append(contentsOf: initial)
                session.stagedAttachmentsByChatId[current.id] = nil
            }
        }
    }

    // MARK: - Header

    /// Back on the left with the rest-of-app unread count, the bot's
    /// computer on the right — a blurred strip to the top edge.
    private var headerBar: some View {
        HStack(alignment: .top) {
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

            Spacer(minLength: 4)

            if case .bot = current {
                GlassButton(systemImage: "display", size: 44, weight: .medium) {
                    showingComputer = true
                }
                .accessibilityLabel("Watch \(current.name)'s computer")
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .background(
            Rectangle()
                .fill(.ultraThinMaterial)
                .mask(
                    VStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: 20)
                    }
                )
                .padding(.bottom, -20)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        )
    }

    /// The bot's face over its name pill, floating over the transcript
    /// between the two buttons.
    private var headerFace: some View {
        VStack(spacing: 6) {
            // Always here, following the island's face while that one is
            // the source: when the island lets go, this one flies home.
            // The face itself is drawn by the island layer above so there is
            // still only one animated avatar. This transparent seat becomes
            // its independent profile button once the opening transition has
            // settled.
            if case .bot = current {
                Button { showingProfile = true } label: {
                    Color.clear
                        .frame(width: 60, height: 60)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .allowsHitTesting(!islandVisible)
                .accessibilityHidden(islandVisible)
                .accessibilityLabel("Open \(current.name) profile")
                .accessibilityHint("Edits this agent's identity, avatar, notifications, and voice")
            } else {
                Color.clear.frame(width: 60, height: 60)
            }
            Button {
                showingProfile = true
            } label: {
                HStack(spacing: 6) {
                    Text(current.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    if !current.subtitle.isEmpty {
                        Text(current.subtitle)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                    }
                    Image(systemName: current.isBot ? "person.crop.circle" : "ellipsis")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color.secondary)
                }
                .padding(.leading, 12)
                .padding(.trailing, 10)
                .frame(height: 32)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .accessibilityLabel(current.isBot ? "Open \(current.name) profile" : "Open \(current.name) chat options")
        }
        .padding(.top, -4)
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
                .frame(maxWidth: .infinity, alignment: .leading)
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

    private var plusActions: [PlusAction] {
        var out: [PlusAction] = []
        if case let .bot(bot) = current {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New task",
                subtitle: "Start a fresh thread with \(bot.name)", disabled: bot.busy == true
            ) { Task { await session.createTask(for: bot, title: nil) } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Tasks",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
            out.append(PlusAction(
                id: "computer", systemImage: "display", title: "Watch computer",
                subtitle: "Live view of what \(bot.name) is doing"
            ) { showingComputer = true })
        }
        if case let .room(room) = current, room.dm != true {
            out.append(PlusAction(
                id: "task", systemImage: "plus.square.on.square", title: "New task",
                subtitle: "Start a fresh conversation in \(room.name)",
                disabled: current.busy || hasPendingApproval
            ) { Task { await session.createTask(for: room, title: nil) } })
            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Tasks",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
        }
        out.append(PlusAction(
            id: "photo", systemImage: "photo.badge.plus", title: "Attach photo",
            subtitle: "Choose from photo library"
        ) { showingPhotoPicker = true })
        out.append(PlusAction(
            id: "file", systemImage: "doc.badge.plus", title: "Attach file",
            subtitle: "Choose from Files or iCloud"
        ) { showingFileImporter = true })
        out.append(PlusAction(
            id: "paste", systemImage: "doc.on.clipboard", title: "Paste from clipboard",
            subtitle: "Photo, document or text"
        ) { pasteFromClipboard() })
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
        if current.busy, case let .bot(bot) = current {
            out.append(PlusAction(
                id: "stop", systemImage: "stop.fill", title: "Interrupt",
                subtitle: "Stop the current turn", destructive: true
            ) { Task { await session.interrupt(bot: bot) } })
        }
        return out
    }

    /// True when this message opens a fresh stretch of conversation — the
    /// first one, or one that follows a gap of half an hour or more.
    private func startsANewStretch(at index: Int, in messages: [Message]) -> Bool {
        guard index > 0 else { return true }
        return messages[index].at - messages[index - 1].at > 30 * 60 * 1000
    }

    /// True when the next message is from someone else (or there is none),
    /// which is where a run of bubbles gets its tail — one per run, like
    /// every messaging app, rather than one per bubble.
    private func endsRun(at index: Int, in messages: [Message]) -> Bool {
        guard index + 1 < messages.count else { return true }
        let this = messages[index], next = messages[index + 1]
        if this.role != next.role { return true }
        if this.from?.name != next.from?.name { return true }
        // a card or a tool chip between two texts breaks the run visually
        return next.kind != .text
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !stagedAttachments.isEmpty
    }

    private var hasPendingApproval: Bool {
        messages.contains { $0.card?.isPending == true }
    }

    private func submit(_ explicitText: String? = nil) {
        dictation.stop()
        let rawText = (explicitText ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawText.isEmpty || !stagedAttachments.isEmpty else { return }

        let pending = stagedAttachments
        stagedAttachments = []
        
        // Workaround: Vertical TextField sometimes fails to shrink when cleared directly to "".
        draft = " "
        DispatchQueue.main.async {
            self.draft = ""
        }
        
        showCommandHUD = false
        SoundEffects.playSent()
        Haptics.impact(.medium)

        Task {
            var parts: [String] = []
            if !rawText.isEmpty {
                parts.append(rawText)
            }
            if !pending.isEmpty {
                isUploadingAttachments = true
                for item in pending {
                    if let path = await session.uploadAttachment(data: item.data, mime: item.mime) {
                        if item.isImage {
                            parts.append("<attached-image path=\"\(path)\" />")
                        } else {
                            parts.append("<attached-file path=\"\(path)\" />")
                        }
                    }
                }
                isUploadingAttachments = false
            }
            let finalMessage = parts.joined(separator: "\n\n")
            if !finalMessage.isEmpty {
                await session.send(finalMessage, to: current)
            }
        }
    }

    private func pasteFromClipboard() {
        let pasteboard = UIPasteboard.general
        if let images = pasteboard.images, !images.isEmpty {
            for image in images {
                if let data = image.jpegData(compressionQuality: 0.85) {
                    stagedAttachments.append(StagedAttachment(
                        name: "Pasted Photo",
                        mime: "image/jpeg",
                        data: data,
                        previewImage: image,
                        isImage: true
                    ))
                }
            }
            Haptics.selection()
            return
        }
        if let urls = pasteboard.urls, !urls.isEmpty {
            for url in urls {
                if let data = try? Data(contentsOf: url) {
                    let name = url.lastPathComponent
                    let mime = mimeType(for: url)
                    let isImg = mime.hasPrefix("image/")
                    stagedAttachments.append(StagedAttachment(
                        name: name,
                        mime: mime,
                        data: data,
                        previewImage: isImg ? UIImage(data: data) : nil,
                        isImage: isImg
                    ))
                }
            }
            Haptics.selection()
            return
        }
        if let data = pasteboard.data(forPasteboardType: "public.png") ?? pasteboard.data(forPasteboardType: "public.jpeg") {
            let mime = pasteboard.contains(pasteboardTypes: ["public.png"]) ? "image/png" : "image/jpeg"
            let image = UIImage(data: data)
            stagedAttachments.append(StagedAttachment(
                name: "Pasted Photo",
                mime: mime,
                data: data,
                previewImage: image,
                isImage: true
            ))
            Haptics.selection()
            return
        }
        if let string = pasteboard.string, !string.isEmpty {
            if draft.isEmpty {
                draft = string
            } else {
                draft += "\n" + string
            }
            Haptics.selection()
        }
    }

    private func processPhotoItems(_ items: [PhotosPickerItem]) async {
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self) {
                let mime = imageMIME(data) ?? "image/jpeg"
                let image = UIImage(data: data)
                let attachment = StagedAttachment(
                    name: "Photo",
                    mime: mime,
                    data: data,
                    previewImage: image,
                    isImage: true
                )
                stagedAttachments.append(attachment)
            }
        }
        selectedPhotoItems = []
    }

    private func processImportedFiles(_ result: Result<[URL], Error>) {
        guard case let .success(urls) = result else { return }
        for url in urls {
            guard url.startAccessingSecurityScopedResource() else { continue }
            defer { url.stopAccessingSecurityScopedResource() }
            if let data = try? Data(contentsOf: url) {
                let name = url.lastPathComponent
                let mime = mimeType(for: url)
                let isImg = mime.hasPrefix("image/")
                let preview = isImg ? UIImage(data: data) : nil
                let attachment = StagedAttachment(
                    name: name,
                    mime: mime,
                    data: data,
                    previewImage: preview,
                    isImage: isImg
                )
                stagedAttachments.append(attachment)
            }
        }
    }

    private func handleDrop(providers: [NSItemProvider]) -> Bool {
        var handled = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                handled = true
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data, let image = UIImage(data: data) else { return }
                    let mime = self.imageMIME(data) ?? "image/jpeg"
                    DispatchQueue.main.async {
                        self.stagedAttachments.append(StagedAttachment(
                            name: "Dropped Photo",
                            mime: mime,
                            data: data,
                            previewImage: image,
                            isImage: true
                        ))
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                handled = true
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                    guard let url = item as? URL ?? (item as? Data).flatMap({ URL(dataRepresentation: $0, relativeTo: nil) }) else { return }
                    if let data = try? Data(contentsOf: url) {
                        let name = url.lastPathComponent
                        let mime = self.mimeType(for: url)
                        let isImg = mime.hasPrefix("image/")
                        let preview = isImg ? UIImage(data: data) : nil
                        DispatchQueue.main.async {
                            self.stagedAttachments.append(StagedAttachment(
                                name: name,
                                mime: mime,
                                data: data,
                                previewImage: preview,
                                isImage: isImg
                            ))
                        }
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
                handled = true
                provider.loadDataRepresentation(forTypeIdentifier: UTType.data.identifier) { data, _ in
                    guard let data else { return }
                    let mime = self.imageMIME(data) ?? "application/octet-stream"
                    let isImg = mime.hasPrefix("image/")
                    let preview = isImg ? UIImage(data: data) : nil
                    DispatchQueue.main.async {
                        self.stagedAttachments.append(StagedAttachment(
                            name: "Attachment",
                            mime: mime,
                            data: data,
                            previewImage: preview,
                            isImage: isImg
                        ))
                    }
                }
            }
        }
        return handled
    }

    private func imageMIME(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return "image/jpeg" }
        if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if bytes.count >= 12,
           String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        return nil
    }

    private func mimeType(for url: URL) -> String {
        if let type = UTType(filenameExtension: url.pathExtension) {
            return type.preferredMIMEType ?? "application/octet-stream"
        }
        return "application/octet-stream"
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
                        : CommandSkillHUDView.defaultCommands.filter {
                            $0.id != "computer" && (current.supportsTasks || $0.id != "tasks")
                        },
                    accentColor: MausPalette.color(current.color)
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
            } else if draft.isEmpty && !current.busy && !hasPendingApproval {
                PredictiveActionChipsView(accentColor: MausPalette.color(current.color)) { chip in
                    submit(chip.prompt)
                }
                .transition(.opacity)
            }

            if !stagedAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(stagedAttachments) { item in
                            HStack(spacing: 6) {
                                if let img = item.previewImage {
                                    Image(uiImage: img)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 32, height: 32)
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                } else {
                                    Image(systemName: item.isImage ? "photo.fill" : "doc.fill")
                                        .font(.system(size: 14))
                                        .foregroundStyle(Color.secondary)
                                        .frame(width: 32, height: 32)
                                }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.name)
                                        .font(.system(size: 12, weight: .medium))
                                        .lineLimit(1)
                                    Text(ByteCountFormatter.string(fromByteCount: Int64(item.data.count), countStyle: .file))
                                        .font(.system(size: 10))
                                        .foregroundStyle(Color.secondary)
                                }
                                Button {
                                    withAnimation(.snappy(duration: 0.2)) {
                                        stagedAttachments.removeAll { $0.id == item.id }
                                    }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 14))
                                        .foregroundStyle(Color.secondary)
                                }
                                .buttonStyle(.plain)
                                .padding(.leading, 2)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Color(uiColor: .secondarySystemBackground))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.1), lineWidth: 1))
                            )
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.bottom, 2)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if isUploadingAttachments {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Uploading attachments…")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 4)
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
                        Button {
                            dictation.stop()
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) {
                                showCommandHUD.toggle()
                            }
                            Haptics.selection()
                        } label: {
                            Image(systemName: "command")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(showCommandHUD ? Color.primary : Color.secondary)
                                .frame(width: 30, height: 32)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Slash commands")
                        .padding(.leading, 6)
                        .padding(.bottom, 6)

                        TextField(
                            dictation.isListening ? "Listening…" : "Ask \(current.name)",
                            text: $draft,
                            axis: .vertical
                        )
                            .lineLimit(1...5)
                            .font(.system(size: 17))
                            .padding(.vertical, 11)
                            .focused($composerFocused)
                                                        // Partial transcripts rebuild from a frozen base;
                            // prevent competing edits without dimming the text.
                            .allowsHitTesting(!dictation.isListening && !dictation.isStarting)
                            .onChange(of: draft) { _, value in
                                withAnimation(.easeInOut(duration: 0.15)) {
                                    showCommandHUD = value.hasPrefix("/")
                                }
                            }
                            .onKeyPress(.return, phases: .down) { press in
                                guard !press.modifiers.contains(.shift) else { return .ignored }
                                submit()
                                return .handled
                            }
                            .onSubmit { submit() }
                            .pasteDestination(for: PastedImage.self) { images in
                                for img in images {
                                    if let uiImage = UIImage(data: img.data),
                                       let jpeg = uiImage.jpegData(compressionQuality: 0.85) {
                                        stagedAttachments.append(StagedAttachment(
                                            name: "Pasted Photo",
                                            mime: "image/jpeg",
                                            data: jpeg,
                                            previewImage: uiImage,
                                            isImage: true
                                        ))
                                    }
                                }
                            }

                        Button {
                            composerFocused = false
                            dictation.toggle(capturing: draft)
                        } label: {
                            Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(dictation.isListening ? Color.red : Color.primary)
                                .frame(width: 32, height: 32)
                                .background(
                                    Circle().fill(
                                        dictation.isListening
                                            ? Color.red.opacity(0.2)
                                            : Color.secondary.opacity(0.12)
                                    )
                                )
                                .symbolEffect(.pulse, isActive: dictation.isListening)
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, 6)
                        .accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")

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
                    .glassCapsule(interactive: false)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
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

    @ViewBuilder
    private var avatarBadge: some View {
        if message.role != .user {
            if let bot = senderBot {
                if endsRun {
                    BotAvatarView(bot: bot, size: 28, state: .idle, animated: false)
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
                Label("Messaged \(comm.withName)", systemImage: "arrow.up.right.bubble")
                    .font(.system(size: 12))
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
        HStack(alignment: .bottom, spacing: 8) {
            avatarBadge
            messageContent
        }
        .contextMenu {
            ForEach(Self.reactionChoices, id: \.self) { emoji in
                Button(emoji) { Task { await session.react(to: message, in: chat.threadId, emoji: emoji) } }
            }
            if message.role == .user, message.kind == .text, case let .bot(bot) = chat {
                Divider()
                Button("Edit and retry", systemImage: "pencil") {
                    editingText = message.text ?? ""
                    showingEdit = true
                }
                .disabled(bot.busy == true)
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
            TextBubble(message: message, chat: chat, tailed: endsRun)
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

    private var splitMessage: (text: String, imagePaths: [String]) {
        let raw = message.text ?? ""
        var images: [String] = []
        let pattern = "<attached-image\\s+path=\"([^\"]*)\"\\s*\\/?>"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return (raw, [])
        }
        let nsString = raw as NSString
        let matches = regex.matches(in: raw, options: [], range: NSRange(location: 0, length: nsString.length))
        for match in matches {
            if match.numberOfRanges > 1 {
                let range = match.range(at: 1)
                let path = nsString.substring(with: range)
                images.append(path)
            }
        }
        let cleanText = regex.stringByReplacingMatches(in: raw, options: [], range: NSRange(location: 0, length: nsString.length), withTemplate: "").trimmingCharacters(in: .whitespacesAndNewlines)
        return (cleanText, images)
    }

    var body: some View {
        let mine = message.role == .user
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
                        .foregroundStyle(MausPalette.color(speaker.color))
                }

                if !splitMessage.imagePaths.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(splitMessage.imagePaths, id: \.self) { path in
                            AttachedImageView(path: path)
                        }
                    }
                    .padding(.bottom, splitMessage.text.isEmpty ? 0 : 4)
                }

                // Bots get markdown, you do not — the same split the desktop
                // makes. Markdown you did not intend is worse than markdown
                // you did: a message about `**` should show the asterisks.
                if let diff = parsedDiff {
                    GitPRDiffCardView(filename: diff.filename, diffText: diff.diff)
                } else if let table = parsedTable {
                    SQLResultTableView(columns: table.headers, rows: table.rows)
                } else if mine {
                    if !splitMessage.text.isEmpty {
                        Text(splitMessage.text)
                            .font(.system(size: 17))
                            .foregroundStyle(BubbleColor.mineText)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    if !splitMessage.text.isEmpty {
                        MarkdownText(source: splitMessage.text)
                            .foregroundStyle(Color.primary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.horizontal, customCard ? 0 : 15)
            .padding(.vertical, customCard ? 0 : 11)
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

struct AttachedImageView: View {
    let path: String
    @EnvironmentObject private var session: Session
    @State private var image: UIImage? = nil
    @State private var showingFullscreen = false

    private var filename: String {
        URL(fileURLWithPath: path).lastPathComponent
    }

    private var avatarUrl: String {
        "/api/attachments/\(filename)"
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 240, maxHeight: 200)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.12), lineWidth: 1))
                    .contentShape(Rectangle())
                    .onTapGesture { showingFullscreen = true }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Photo attachment")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06)))
            }
        }
        .task(id: avatarUrl) {
            if let data = await session.avatarData(forUrl: avatarUrl), let uiImage = UIImage(data: data) {
                image = uiImage
            }
        }
        .sheet(isPresented: $showingFullscreen) {
            if let image {
                NavigationStack {
                    ZStack {
                        Color.black.ignoresSafeArea()
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .padding()
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showingFullscreen = false }
                                .foregroundStyle(Color.white)
                        }
                    }
                }
            }
        }
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

/// An option card. When it still has a request behind it, this is the
/// screen the companion exists for — a bot stopped, and only a person can
/// let it continue.
struct CardView: View {
    let chat: Chat
    let message: Message
    @EnvironmentObject private var session: Session
    @State private var answering = false

    /// The option this card offers that means "go ahead".
    ///
    /// Deliberately not the literal string "Allow". `options` is whatever the
    /// harness sent, and it only falls back to ["Allow", "Deny"] when the
    /// provider event named no choices of its own (`server/index.ts`) — a card
    /// is free to say "Yes", "Approve", "Allow once". Answering with a string
    /// the card never offered writes the grant and then hands the harness a
    /// choice it can reject, so the bot stays stopped with nothing on screen
    /// to explain it. The conventional label wins when it is present, which
    /// keeps the ordinary permission card behaving exactly as before.
    private var allowChoice: String? {
        guard let options = message.card?.options else { return nil }
        return options.first { $0.caseInsensitiveCompare("Allow") == .orderedSame }
            ?? options.first { !Self.isRefusal($0) }
    }

    /// One definition of "the refusal", shared by the button tint and the
    /// choice above so the two cannot drift apart.
    private static func isRefusal(_ option: String) -> Bool { OptionCard.isRefusal(option) }

    private var tint: Color { MausPalette.color(chat.color) }

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
                                Text(option)
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

                    // The grant key comes from the card. The phone never
                    // derives its own, so it cannot permit something subtly
                    // wider than the computer would have. The same goes for
                    // the answer: it is one of the options the card offered,
                    // never a string invented here.
                    if card.allowKey != nil, let allow = allowChoice, case let .bot(bot) = chat {
                        Button("Always allow this tool") {
                            answering = true
                            Task {
                                await session.alwaysAllow(bot: bot, card: card)
                                await session.answer(
                                    chat: chat,
                                    card: card,
                                    choice: allow,
                                    rememberingPermission: false
                                )
                                answering = false
                            }
                        }
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                        .frame(maxWidth: .infinity)
                        .disabled(answering)
                    }
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
                        mascotColor: MausPalette.color(color),
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

struct PastedImage: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { data in
            PastedImage(data: data)
        }
    }
}
