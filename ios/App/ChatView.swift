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
    @State private var composerFocusAfterPlusDismiss = false
    @FocusState private var composerFocused: Bool
    @StateObject private var dictation = SpeechDictation()
    /// Whether the transcript follows the newest message.  Off while the
    /// reader is scrolled up, so arriving text never moves what they are
    /// reading; `BottomFollow` holds the rules.
    @State private var follow = BottomFollow()
    @State private var scrollTracker = TranscriptScrollTracker()
    /// Bumped to ask the transcript for the newest message from outside the
    /// scroll reader, such as a send that never gets as far as a pending row.
    @State private var bottomScrollRequest = 0
    /// Older messages are loading above the reader.  The size-change anchor
    /// stays on the bottom while they land, which is what keeps the rows on
    /// screen in place.
    @State private var prepending = false

    /// The live bubble's scroll target. A constant because there is at most
    /// one per chat and it has no message id to borrow.
    static let liveBubbleId = "companion.live"

    /// A scroll target at the very end of the transcript, under the live
    /// row.  It is only ever scrolled to.  Nothing reads whether it is on
    /// screen: inside an eager `VStack` it always counts as appeared, which
    /// is why the old onAppear/onDisappear "at bottom" guard never worked.
    static let bottomId = "companion.bottom"

    /// iOS 17 lacks scroll phases and per-role anchors, so it follows with a
    /// drag gesture and a content probe instead.  The deployment floor is
    /// now iOS 27, so only the DEBUG `-legacy-follow` flag reaches that
    /// path.  It can check the opening position and the repin: from iOS 18
    /// on, a simultaneous drag gesture stops the scroll view itself from
    /// scrolling, so stopping follow and scrolling up were never checkable
    /// without a real iOS 17 runtime or device.
    private var useLegacyFollow: Bool {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-legacy-follow") { return true }
#endif
        if #available(iOS 18.0, *) { return false }
        return true
    }

    /// What sits after the last settled row while the bot works.
    private var liveRow: BottomFollow.LiveRow {
        if let live = session.state.streaming[threadId], !live.isEmpty { return .text }
        if let thinking = session.state.reasoning[threadId], !thinking.isEmpty { return .reasoning }
        return current.busy ? .typing : .none
    }

    /// The bot whose reply is streaming: the chat's bot, or in a room the
    /// member holding the turn.
    private var liveSender: Bot? {
        switch current {
        case let .bot(bot): return bot
        case let .room(room): return room.busyBotId.flatMap { session.state.bot($0) }
        }
    }

    /// Whether this is a shared room, where the jobs list names each member.
    private var isRoomChat: Bool {
        if case .room = current { return true }
        return false
    }

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

    private var mentionTrigger: (trigger: String, query: String, start: Int)? {
        guard !draft.isEmpty else { return nil }
        let validDelimiters: Set<Character> = [" ", "\n", "(", "[", "\"", "'", "“", "‘"]
        var lastAt = -1
        var lastHash = -1
        let chars = Array(draft)
        for i in 0..<chars.count {
            let c = chars[i]
            if c == "@" && (i == 0 || validDelimiters.contains(chars[i - 1])) {
                lastAt = i
            } else if c == "#" && (i == 0 || validDelimiters.contains(chars[i - 1])) {
                lastHash = i
            } else if c == " " || c == "\n" {
                if lastAt != -1 && i > lastAt { lastAt = -1 }
                if lastHash != -1 && i > lastHash { lastHash = -1 }
            }
        }
        let start = max(lastAt, lastHash)
        guard start != -1 else { return nil }
        let trigger = String(chars[start])
        let query = String(chars[(start + 1)...])
        guard query.count <= 30 else { return nil }
        return (trigger: trigger, query: query, start: start)
    }

    /// VoiceOver for the header identity button. The explicit button label
    /// replaces child accessibility content, so the provider mark and the
    /// connection state must be named here or they would become silent chrome.
    private var headerProfileAccessibilityLabel: String {
        let bypass = headerShowsBypass ? ", Bypass Permissions is on" : ""
        if let currentDriverKind {
            return "Open \(current.name) profile, \(ProviderMarkView.displayName(for: currentDriverKind, model: currentModelSelection?.model))\(bypass). \(headerConnectionStatus.text)"
        }
        return "Open \(current.name) profile\(bypass). \(headerConnectionStatus.text)"
    }

    /// A bot with Bypass Permissions on carries a mark beside its name.  A room
    /// has no switch of its own: each member keeps theirs.
    private var headerShowsBypass: Bool {
        if case let .bot(bot) = current { return bot.bypassPermissions == true }
        return false
    }

    /// Whether the phone is talking to the Mac, in the words a person would
    /// use.  The same vocabulary as the chat list's header, so the two never
    /// describe one connection two different ways.
    ///
    /// A lost connection outranks a working turn on purpose: "Working" claims
    /// a reply is still coming, which is exactly what a dropped connection
    /// denies, so showing it over a dead link is the one wrong answer here.
    private var headerConnectionStatus: (text: String, systemImage: String, tint: Color, settled: Bool) {
        switch session.status {
        case .live where current.busy:
            return ("Working", "ellipsis", BotPalette.color(current.color), true)
        case .live:
            return ("Connected", "checkmark.circle.fill", .green, true)
        case .connecting:
            return ("Connecting…", "arrow.triangle.2.circlepath", .orange, false)
        case .offline:
            return ("Reconnecting…", "wifi.exclamationmark", .orange, false)
        case .macOffline:
            return ("Mac offline", "desktopcomputer", .red, false)
        case .unauthorized:
            return ("Unpaired", "link.badge.plus", .red, false)
        case .unpaired:
            return ("Not paired", "link.badge.plus", .secondary, false)
        }
    }

    /// The header's connection mark, beside the bot's name.  A label, not a
    /// control: it lives inside the identity button, and a button inside a
    /// button never receives the tap — the outer one takes every one — while
    /// VoiceOver reads the pair as something neither of them is.  Recovery is
    /// the reconnect loop's job, and a dead link already raises the app's
    /// own error banner.
    private var headerConnectionMark: some View {
        let status = headerConnectionStatus
        return HStack(spacing: 4) {
            Image(systemName: status.systemImage)
                .font(.scaled(10, weight: .bold, relativeTo: .caption2))
                .symbolEffect(.pulse, options: .repeating, isActive: !status.settled)
            Text(status.text)
                .font(.scaled(12, weight: .medium, relativeTo: .caption))
                .lineLimit(1)
                .monospacedDigit()
        }
        .foregroundStyle(status.tint)
        // The identity button carries an explicit label that already names the
        // state, so letting this one speak too would read it out twice.
        .accessibilityHidden(true)
    }

    var body: some View {
        VStack(spacing: 0) {
            transcriptColumn
            // While the Mac holds new work for an update, a message sent now
            // is saved and runs after the restart; this says so.
            UpdateHoldNotice()
            // An Off bot refuses every new turn, so the input is replaced by
            // the way out of that state.  The transcript above stays as it was.
            if current.isOff, case let .bot(bot) = current {
                offComposer(for: bot)
            } else {
                composer
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .overlay(alignment: .bottom) { plusSheet }
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        // A transcript that stops growing at AX3 is unreadable for the
        // readers who turned Dynamic Type up in the first place, and bot
        // text used to be pinned outright.  AX5 is the last step; the
        // bubbles reflow rather than truncate.
        .dynamicTypeSize(...DynamicTypeSize.accessibility5)
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
            // Raises the keyboard on open, for checking that the composer
            // clears it: the transcript has to stay visible above the
            // keyboard rather than behind it.
            if ProcessInfo.processInfo.arguments.contains("-open-composer") { composerFocused = true }
#endif
        }
        .onChange(of: current.unread) { _, unread in
            if unread { Task { await session.markRead(current) } }
        }
        .onAppear { NotificationCoordinator.shared.viewingThreadId = threadId }
        .onChange(of: threadId) { _, newId in
            dictation.stop()
            NotificationCoordinator.shared.viewingThreadId = newId
            // `.id(threadId)` rebuilds the scroll view, but this state lives
            // on ChatView and would carry over to the new thread.
            follow = BottomFollow()
            scrollTracker.reset()
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
        .onChange(of: showingPlus) { wasShowing, shown in
            if shown { dictation.stop() }
            if ComposerSendRecovery.shouldReassertComposerFocusAfterPlusDismisses(
                wasShowingPlus: wasShowing,
                isShowingPlus: shown,
                focusAfterDismiss: composerFocusAfterPlusDismiss
            ) {
                composerFocusAfterPlusDismiss = false
                composerFocused = true
            }
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
            if case let .bot(bot) = current {
                TaskManagerView(bot: bot)
            } else if case let .room(room) = current {
                RoomTaskManagerView(room: room)
            }
        }
        .navigationDestination(isPresented: $showingRoutines) {
            TasksRoutinesView()
        }
        // Deleting the chat from its profile closes the sheet first; the
        // chat itself closes once the sheet is gone.
        .sheet(isPresented: $showingProfile, onDismiss: { closeIfGone() }) {
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
        .modifier(CloseWhenGone(isGone: chatIsGone, waiting: showingProfile, close: { closeIfGone() }))
    }

    /// Deleted or archived, here or on another device.  Read from the id the
    /// screen was opened with, because `current` falls back to that snapshot.
    private var chatIsGone: Bool { chat.isGone(in: session.state) }

    /// Back to the chat list once the chat is gone.  On iPad the chat is the
    /// detail column's root, with nothing to go back from, so the list lets go
    /// of it instead (ChatListView `selectedChatIsGone`).
    private func closeIfGone() {
        guard chatIsGone, sizeClass != .regular else { return }
        dismiss()
    }

    /// The pin, when it resolves to a loaded text message.  A pin whose
    /// message is gone or not on this page draws nothing, as on the desktop.
    private var pinnedMessage: Message? {
        BotOrganize.pinnedMessage(id: current.pinnedMessageId, in: messages)
    }

    private func pinnedBanner(_ message: Message) -> some View {
        PinnedMessageBanner(
            message: message,
            chatName: current.isBot ? current.name : nil,
            tint: BotPalette.color(current.color),
            onJump: { session.focus(message.id) },
            onUnpin: { Task { await session.pinMessage(nil, in: current) } }
        )
        .padding(.horizontal, 16)
    }

    /// Split out of `body` so the Swift compiler can type-check the chat
    /// chrome and the transcript independently.  The combined expression
    /// exceeded the type-check budget on CI.
    private var transcriptColumn: some View {
        let transcript = messages
        let items = groupActivityRuns(transcript)
        let live = liveRow
        let newestSettled = BottomFollow.newestSettledId(in: transcript)
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
                                // messages are prepended, sit back on the row
                                // that used to be at the top
                                let firstMessageId = transcript.first?.id
                                follow.leaveBottom(newestSettledId: newestSettled)
                                prepending = true
                                Task {
                                    await session.loadOlder(threadId: threadId)
                                    // Found again in the new rows: the old top
                                    // row may have joined a longer tool run
                                    // from the loaded page, under a new id.
                                    if let firstMessageId,
                                       let row = transcriptRowId(containing: firstMessageId, in: groupActivityRuns(messages)) {
                                        proxy.scrollTo(row, anchor: .top)
                                    }
                                    // Let the prepended rows lay out under the
                                    // bottom anchor before handing it back.
                                    try? await Task.sleep(for: .milliseconds(250))
                                    prepending = false
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
                                if transcriptRowStartsAStretch(at: index, in: items) {
                                    stretchSeparator(item.date)
                                }
                                switch item {
                                case let .message(message):
                                    MessageRow(
                                        chat: current,
                                        message: message,
                                        endsRun: endsRun(at: index, in: items, live: live)
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
                        liveRowView(live, after: items)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .bottom) {
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomId)
                            .accessibilityHidden(true)
                    }
                    .modifier(LegacyTranscriptProbe(
                        enabled: useLegacyFollow,
                        follow: $follow,
                        tracker: scrollTracker,
                        newestSettledId: newestSettled,
                        repin: { repinToBottom(proxy) }
                    ))
                }
                // Opaque header: the transcript starts below the tabs and
                // never shows through them.  Glass over the bubbles was
                // what made Monitor's thread leak into the tab strip.
                .safeAreaInset(edge: .top, spacing: 0) { chatHeader }
                // A conversation grows from the bottom: a transcript shorter
                // than the screen rests at the bottom, and opening a chat
                // starts on the newest message rather than the oldest.  While
                // the reader is scrolled up, growth leaves them where they
                // are (see TranscriptFollowModifier).
                .modifier(TranscriptFollowModifier(
                    follow: $follow,
                    tracker: scrollTracker,
                    newestSettledId: newestSettled,
                    legacy: useLegacyFollow,
                    prepending: prepending,
                    repin: { repinToBottom(proxy) }
                ))
                .overlay(alignment: .bottom) {
                    jumpToLatest(transcript: transcript, proxy: proxy)
                }
                // Follow a new message, a send, or the live row appearing —
                // only while following, and never animated: a glide on every
                // message is the movement this screen must not make.  Keyed
                // so a pending send's id swap does not count as new.
                .onChange(of: BottomFollow.followKey(for: transcript, live: live)) { _, _ in
                    guard follow.isFollowing else { return }
                    let now = TranscriptScrollTracker.now
                    if scrollTracker.holdsFollow(at: now) || scrollTracker.appScrollUntil > now {
                        // Something else is moving the transcript; follow
                        // once it has finished.
                        followStream(proxy)
                    } else {
                        scrollToBottom(proxy)
                    }
                }
                .onChange(of: bottomScrollRequest) { _, _ in
                    guard follow.isFollowing else { return }
                    scrollToBottom(proxy)
                }
                // Follow the text as it arrives, at most ten times a second
                // and without animation.  Animating every token turns a
                // smooth stream into a stutter, because each scroll
                // interrupts the last.
                .onChange(of: session.state.streaming[threadId]?.count ?? 0) { _, length in
                    guard length > 0, follow.isFollowing else { return }
                    followStream(proxy)
                }
                // A search hit: go to its row (a folded tool step is reached
                // through its run) and stop following, so the next token does
                // not pull the reader straight back to the bottom.
                .onChange(of: session.focusedMessageId) { _, messageId in
                    guard let messageId,
                          let row = transcriptRowId(containing: messageId, in: items)
                    else { return }
                    follow.leaveBottom(newestSettledId: newestSettled)
                    withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo(row, anchor: .center) }
                    session.consumeFocus(messageId)
                }
                .task(id: threadId) {
                    if let messageId = session.focusedMessageId,
                       let row = transcriptRowId(containing: messageId, in: items) {
                        follow.leaveBottom(newestSettledId: newestSettled)
                        proxy.scrollTo(row, anchor: .center)
                        session.consumeFocus(messageId)
                        return
                    }
                    follow.resume()
                    scrollToBottom(proxy)
                    try? await Task.sleep(nanoseconds: 60_000_000)
                    if follow.isFollowing {
                        scrollToBottom(proxy)
                    }
                }
                .onAppear {
                    if session.focusedMessageId == nil {
                        follow.resume()
                        scrollToBottom(proxy)
                    }
                }
            }
            .id(threadId)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// "Jump to Latest", while the reader is away from the bottom.
    private func jumpToLatest(transcript: [Message], proxy: ScrollViewProxy) -> some View {
        ZStack {
            if !follow.isFollowing {
                JumpToLatestPill(count: follow.unseenCount(in: transcript)) {
                    follow.resume()
                    // Follow scrolls wait for the glide rather than cutting
                    // it short with a jump.
                    if !reduceMotion { scrollTracker.appScrollStarted(duration: 0.45) }
                    withAnimation(reduceMotion ? nil : .snappy(duration: 0.3)) {
                        proxy.scrollTo(Self.bottomId, anchor: .bottom)
                    }
                    Haptics.selection()
                }
                .padding(.bottom, 10)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: follow.isFollowing)
    }

    /// Back to the newest message after layout left a following reader
    /// short of it.  Checked again here because the request was queued.
    /// While a reply streams the size anchor does not hold on every token,
    /// so this shares the streaming throttle rather than adding scrolls.
    private func repinToBottom(_ proxy: ScrollViewProxy) {
        guard follow.isFollowing else { return }
        followStream(proxy)
    }

    /// Straight to the end, with no animation.
    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            proxy.scrollTo(Self.bottomId, anchor: .bottom)
        }
    }

    /// One follow scroll per streaming interval, plus a trailing one so the
    /// last tokens of a burst are not left below the fold.
    ///
    /// Never while a finger, its coast, or an animated scroll is moving the
    /// transcript: the scroll waits, checking again each interval, so it
    /// neither pulls text out from under the reader nor cuts the glide to
    /// the newest message short.  The trailing scroll checks again when it
    /// fires, since a touch can begin after it was queued.
    private func followStream(_ proxy: ScrollViewProxy) {
        let now = TranscriptScrollTracker.now
        let notBefore: Double?
        if scrollTracker.holdsFollow(at: now) {
            notBefore = now + BottomFollow.streamingScrollInterval
        } else if scrollTracker.appScrollUntil > now {
            notBefore = scrollTracker.appScrollUntil
        } else {
            notBefore = nil
        }
        switch StreamingFollowThrottle.decide(
            now: now,
            lastScroll: scrollTracker.lastStreamingScroll,
            trailingScheduled: scrollTracker.trailingScrollScheduled,
            notBefore: notBefore
        ) {
        case .now:
            scrollTracker.lastStreamingScroll = now
            scrollToBottom(proxy)
        case let .after(delay):
            scrollTracker.trailingScrollScheduled = true
            let tracker = scrollTracker
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                tracker.trailingScrollScheduled = false
                guard follow.isFollowing else { return }
                followStream(proxy)
            }
        case .skip:
            break
        }
    }

    private func stretchSeparator(_ date: Date) -> some View {
        Text(RelativeStamp.separator(date))
            .font(.caption.weight(.medium))
            .foregroundStyle(Color.secondary.opacity(0.7))
            .frame(maxWidth: .infinity)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }

    /// The reply being typed, shaped like the row it settles into, or the
    /// typing indicator before any text exists.
    @ViewBuilder
    private func liveRowView(_ live: BottomFollow.LiveRow, after items: [TranscriptItem]) -> some View {
        switch live {
        case .text, .reasoning:
            VStack(alignment: .leading, spacing: 6) {
                // The settled message gets a stretch separator when it
                // follows a long gap; show it now so it is not added on
                // arrival.
                if liveReplyStartsAStretch(after: items, now: Date()) {
                    stretchSeparator(Date())
                }
                LiveReplyRow(
                    chat: current,
                    sender: liveSender,
                    text: live == .text ? session.state.streaming[threadId] : nil,
                    reasoning: live == .reasoning ? session.state.reasoning[threadId] : nil
                )
            }
            .id(Self.liveBubbleId)
        case .typing:
            TypingIndicatorView(tintColor: BotPalette.color(current.color))
                .id(Self.liveBubbleId)
                .accessibilityLabel("\(current.name) is working")
        case .none:
            EmptyView()
        }
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
                                    .font(.footnote.weight(.semibold))
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
                            HStack(spacing: 6) {
                                Text(current.name)
                                    .font(.headline.weight(.semibold))
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                                if headerShowsBypass { BypassBadge() }
                                // A label inside the identity button: the
                                // state reads as part of who you are talking
                                // to, and that button's own accessibility
                                // label already names it, so this one stays
                                // silent itself.
                                headerConnectionMark
                            }
                            if !current.subtitle.isEmpty {
                                Text(current.subtitle)
                                    .font(.caption)
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

            // Background jobs: draws nothing until a bot in this conversation
            // has one worth showing (running, or ended in the last half hour).
            JobsPill(threadId: threadId, showsBotNames: isRoomChat)

            if case let .bot(bot) = current,
               session.config?.allowsMultipleBotThreads == true {
                ThreadTabBar(bot: bot)
            }

            if let pinned = pinnedMessage {
                pinnedBanner(pinned)
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
                    .onTapGesture { withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { showingPlus = false } }

                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        ForEach(plusActions) { action in
                            Button {
                                withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { showingPlus = false }
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
                                            .font(.title3.weight(.medium))
                                            .foregroundStyle(action.destructive ? Color.red : Color.primary)
                                        Text(action.subtitle)
                                            .font(.footnote)
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
            subtitle: "Computer, tasks, and more"
        ) {
            withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.75)) {
                showCommandHUD = true
            }
            draft = ComposerSendRecovery.slashCommandDraft(from: draft)
            composerFocusAfterPlusDismiss = true
        })
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
        // A channel keeps separate conversations of its own.  A bot-to-bot DM
        // has exactly one, and a workspace on "one conversation per channel"
        // cannot add another, so each control appears only where it can work.
        if case let .room(room) = current, !room.isBotToBot {
            if session.config?.allowsMultipleBotThreads == true {
                out.append(PlusAction(
                    id: "room-task", systemImage: "plus.square.on.square", title: "New task",
                    subtitle: "Start a fresh thread in \(room.name)",
                    disabled: session.state.roomTaskChangesBlocked(room)
                ) { Task { await session.createRoomTask(for: room, title: nil) } })
            }
            if session.config?.allowsMultipleBotThreads == true || (room.tasks?.count ?? 0) > 1 {
                out.append(PlusAction(
                    id: "room-tasks", systemImage: "square.stack", title: "Tasks",
                    subtitle: "Switch, rename or remove one"
                ) { showingTasks = true })
            }
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

    /// Where a run of bubbles gets its tail; `transcriptRowEndsRun` holds
    /// the rule, including the reply being typed counting as the next
    /// message.
    private func endsRun(at index: Int, in items: [TranscriptItem], live: BottomFollow.LiveRow) -> Bool {
        // In a room the settled reply is attributed to the member holding
        // the turn; in a bot chat it carries no speaker.
        let liveSpeaker: String?
        if case .room = current { liveSpeaker = liveSender?.name } else { liveSpeaker = nil }
        return transcriptRowEndsRun(
            at: index,
            in: items,
            liveReply: live == .text || live == .reasoning,
            liveSpeaker: liveSpeaker
        )
    }

    private var canSend: Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return (!text.isEmpty || !pendingAttachments.isEmpty) && !sending && !(dictation.recordedWAV != nil && current.busy)
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


    /// Returns the task carrying the send, so a caller that has to act on
    /// the server's answer (Steer Now) can wait for it instead of guessing
    /// with a sleep.  Callers that do not care discard it.
    @discardableResult
    private func submit(_ explicitText: String? = nil) -> Task<Void, Never>? {
        // This also cancels an in-flight permission prompt before it can
        // open the microphone after the message has already been sent.
        dictation.stop()
        let text = (explicitText ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoing = pendingAttachments
        let recording: (data: Data, transcript: String)? = dictation.recordedWAV.flatMap { data in
            dictation.recordedTranscript.map { (data: data, transcript: $0) }
        }
        guard !text.isEmpty || !outgoing.isEmpty, !sending else { return nil }
        // The server intentionally refuses recorded sends while a bot is
        // steering; keep the capture locally rather than upload an orphan.
        guard recording == nil || !current.busy else { return nil }
        draft = ""
        pendingAttachments = []
        dictation.discardRecording()
        showCommandHUD = false
        // Sending is the reader asking to be at the newest message again,
        // like Messages: the pending row is followed into view.  The request
        // covers a send that fails before that row exists.
        follow.resume()
        bottomScrollRequest &+= 1
        SoundEffects.playSent()
        Haptics.impact(.medium)
        let threadId = current.threadId
        let priorUserMessageIDs = Set(
            session.state.transcript(forThread: threadId)
                .filter { $0.role == .user }
                .map(\.id)
        )
        let sentText = text
        sending = true
        let task = Task {
            let outcome = await session.send(sentText, to: current, attachments: outgoing, recording: recording)
            sending = false
            let transcript = session.state.transcript(forThread: threadId)
            guard ComposerSendRecovery.shouldRestoreClearedDraft(
                sendSucceeded: outcome.ok,
                clientNonce: outcome.clientNonce,
                sentText: sentText,
                priorUserMessageIDs: priorUserMessageIDs,
                transcript: transcript
            ) else { return }
            if draft.isEmpty { draft = sentText }
            if pendingAttachments.isEmpty { pendingAttachments = outgoing }
            if let recording, dictation.recordedWAV == nil {
                dictation.restoreRecording(recording.data, transcript: recording.transcript)
            }
        }
        return task
    }

    private func steerSend() {
        // Interrupt only once the harness has accepted the send.  A fixed
        // 300ms sleep was a guess at how long the POST takes: on a slower run
        // it elapsed first, the interrupt landed on the running turn, and the
        // message was interrupted into nothing.  Waiting for the send means
        // the queued message exists before anything cancels it.
        guard let sent = submit() else { return }
        Task {
            await sent.value
            guard current.busy else { return }
            switch current {
            case let .bot(bot): await session.interrupt(bot: bot)
            case let .room(room): await session.interrupt(room: room)
            }
        }
    }

    private func steerNow() {
        Task {
            switch current {
            case let .bot(bot): await session.interrupt(bot: bot)
            case let .room(room): await session.interrupt(room: room)
            }
        }
    }

    private func cancelQueuedMessage(_ queueId: String) {
        switch current {
        case let .bot(bot):
            // A bot's queued send lives on the harness, so the chip comes down
            // only once the server has taken it: Session.cancelQueued drops it
            // on success and leaves it up, with the reason, when the call
            // fails.  Dropping here first would strand a message that still
            // sends behind a row the person already believes is gone.
            Task { await session.cancelQueued(botId: bot.id, queueId: queueId) }
        case let .room(room):
            // A room's queued send is held client-side only, so there is no
            // server call to wait for and the chip is ours to remove.
            session.dropPendingQueued(threadId: room.threadId, queueId: queueId)
        }
    }

    private func editQueuedMessage(_ item: QueuedSend) {
        switch current {
        case let .bot(bot):
            Task {
                guard await session.cancelQueued(botId: bot.id, queueId: item.queueId) else { return }
                restoreQueuedDraft(from: item)
            }
        case let .room(room):
            session.dropPendingQueued(threadId: room.threadId, queueId: item.queueId)
            restoreQueuedDraft(from: item)
        }
    }

    private func restoreQueuedDraft(from item: QueuedSend) {
        if let rawText = item.rawText {
            draft = rawText
            pendingAttachments = item.attachments
        } else {
            // Legacy rows only stored composed wire text; re-applying chips would
            // duplicate markers already embedded in `text`.
            draft = item.text
            pendingAttachments = []
        }
        composerFocused = true
    }

    // MARK: - Composer

#if DEBUG
    private var composerKeyboardAccessoryAvailable: Bool {
        !ProcessInfo.processInfo.arguments.contains("-no-keyboard-accessory")
    }
#else
    private var composerKeyboardAccessoryAvailable: Bool { true }
#endif

    /// Leading `/` and trailing Hide when `inputAccessoryView` is unavailable.
    private var composerFallbackKeyboardBar: some View {
        HStack(spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.75)) {
                    showCommandHUD = true
                }
                draft = ComposerSendRecovery.slashCommandDraft(from: draft)
            } label: {
                Image(systemName: "command")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color.secondary.opacity(0.14)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Slash commands")

            Spacer(minLength: 0)

            Button {
                composerFocused = false
            } label: {
                Label(ComposerInputChrome.hideKeyboardTitle, systemImage: ComposerInputChrome.hideKeyboardSymbolName)
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(Color.secondary.opacity(0.14)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ComposerInputChrome.hideKeyboardTitle)
        }
        .padding(.horizontal, 4)
    }

    private var composerPrompt: String {
        dictation.isListening ? "Listening…" : "Ask \(current.name)"
    }

    /// A round + and a glass pill with dictation and send inside it.
    private var composer: some View {
        VStack(spacing: 6) {
            if dictation.recordedWAV != nil {
                HStack(spacing: 8) {
                    Label("Recording saved with this message", systemImage: "waveform")
                    Button("Discard audio") { dictation.discardRecording() }
                }
                .font(.caption)
                .foregroundStyle(Color.secondary)
            }
            if let error = dictation.error {
                Text(error)
                    .font(.footnote)
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
                        : CommandSkillHUDView.defaultCommands.filter { $0.id != "computer" && ($0.id != "tasks" || current.isBotToBot) },
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
            } else if let mention = mentionTrigger {
                MentionAutocompleteView(
                    text: $draft,
                    trigger: mention.trigger,
                    query: mention.query,
                    bots: session.state.bots,
                    rooms: session.state.rooms,
                    accentColor: BotPalette.color(current.color)
                ) { selected in
                    let prefix = String(draft.prefix(mention.start))
                    draft = "\(prefix)\(mention.trigger)\(selected.name) "
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if ComposerInputChrome.showsFallbackKeyboardBar(
                composerFocused: composerFocused,
                slashBarVisible: showCommandHUD,
                keyboardAccessoryAvailable: composerKeyboardAccessoryAvailable
            ) {
                composerFallbackKeyboardBar
                    .transition(.opacity)
            } else if draft.isEmpty && !hasPendingApproval && !current.busy {
                PredictiveActionChipsView(accentColor: BotPalette.color(current.color)) { chip in
                    draft = chip.prompt
                    composerFocused = true
                }
                .transition(.opacity)
            }

            let queuedSends = session.state.pendingQueued[current.threadId] ?? []
            if !queuedSends.isEmpty {
                VStack(spacing: 6) {
                    ForEach(queuedSends, id: \.queueId) { item in
                        HStack(spacing: 8) {
                            Image(systemName: "bubble.left")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Color.secondary)
                            Text(item.text)
                                .font(.footnote)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .foregroundStyle(Color.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            Button {
                                editQueuedMessage(item)
                            } label: {
                                Image(systemName: "pencil")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(Color.secondary)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Edit Queued Message")

                            Button {
                                steerNow()
                            } label: {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(BubbleColor.mine)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Steer Now")

                            Button {
                                cancelQueuedMessage(item.queueId)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(Color.red.opacity(0.85))
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Cancel Queued Message")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Color.secondary.opacity(0.12))
                        )
                    }
                }
                .padding(.horizontal, 4)
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
                        withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { showingPlus.toggle() }
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

                    ZStack(alignment: .topLeading) {
                        if draft.isEmpty {
                            Text(composerPrompt)
                                .font(.body)
                                .foregroundStyle(Color.secondary)
                                .padding(.leading, 14)
                                .padding(.trailing, 14)
                                .padding(.vertical, 11)
                                .allowsHitTesting(false)
                        }
                        ComposerMultilineField(
                            text: $draft,
                            isFocused: $composerFocused,
                            placeholder: composerPrompt,
                            isEditable: !dictation.isListening && !dictation.isStarting,
                            usesKeyboardAccessory: composerKeyboardAccessoryAvailable,
                            onHideKeyboard: { composerFocused = false }
                        )
                        .frame(minHeight: 44)
                        .onChange(of: draft) { _, value in
                            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.15)) {
                                showCommandHUD = ComposerInputChrome.showsSlashCommandBar(draft: value)
                            }
                        }
                    }
                    .glassRounded(cornerRadius: 18, interactive: false)

                    // Mic, Stop and Send live outside the text pill.  Inside
                    // it, a draft that grows past a few lines pushed them
                    // toward the edge and a Stop you cannot see is the same
                    // as no Stop at all.
                    HStack(spacing: 0) {
                        composerMicButton
                        if current.busy { composerStopButton }
                        composerSendButton
                    }
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

    /// The microphone, always on screen.  It used to appear only once
    /// dictation was already running, which left the only way to start
    /// talking buried two taps deep in the + sheet — a control you had to go
    /// looking for, on the one input where typing is the slower option.
    private var composerMicButton: some View {
        Button {
            if dictation.isListening {
                dictation.stop()
            } else {
                composerFocused = false
                dictation.toggle(capturing: draft)
            }
            Haptics.selection()
        } label: {
            Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(dictation.isListening ? Color.red : Color.secondary)
                .frame(width: 34, height: 34)
                .background(
                    Circle().fill(dictation.isListening ? Color.red.opacity(0.18) : Color.clear)
                )
                .contentShape(Circle())
                .symbolEffect(.pulse, isActive: dictation.isListening)
        }
        .buttonStyle(.plain)
        .disabled(dictation.isStarting)
        // The glyph is 34pt; the target a thumb lands on is not.  This is the
        // control a person reaches for one-handed while holding the phone.
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(dictation.isListening ? "Stop dictation" : "Dictate")
        .accessibilityHint(dictation.isListening
                           ? "Stops listening and keeps the words already spoken"
                           : "Speak instead of typing")
    }

    /// Stop, for while the bot holds the turn.  It used to live only in the +
    /// sheet as "Interrupt", so the control that ends a run was further away
    /// than anything else in the composer.  It sits beside Send rather than
    /// replacing it, because sending during a turn is a real action (queue,
    /// or steer) and must not become unreachable.
    private var composerStopButton: some View {
        Button {
            steerNow()
            Haptics.impact(.medium)
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Color(uiColor: .systemBackground))
                .frame(width: 34, height: 34)
                .background(Circle().fill(Color(uiColor: .label)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("Stop")
        .accessibilityHint("Stops \(current.name)'s current turn")
    }

    /// Send.  The long-press menu (Steer Now, Queue) rides along unchanged.
    private var composerSendButton: some View {
        Button { submit() } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(canSend ? Color.white : Color.secondary)
                .frame(width: 34, height: 34)
                .background(
                    Circle().fill(canSend ? BubbleColor.mine : Color.secondary.opacity(0.18))
                )
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .animation(.easeOut(duration: 0.15), value: canSend)
        .contextMenu {
            if canSend {
                Button {
                    steerSend()
                } label: {
                    Label("Steer Now", systemImage: "bolt.fill")
                }
                Button {
                    submit()
                } label: {
                    Label("Queue Message", systemImage: "clock")
                }
            }
        }
        .accessibilityLabel("Send")
    }

    /// What replaces the composer while the bot is Off (`shared/bot-power.ts`):
    /// the disabled notice and one button, Turn On.  The two-space gap is a
    /// non-breaking space plus a space so the layout cannot collapse it.
    private func offComposer(for bot: Bot) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "power")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.secondary)
                .accessibilityHidden(true)
            Text("This bot is off.\u{00A0} Turn it on to chat.")
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task { _ = await session.updateProfile(BotProfilePatch(off: false), for: bot) }
            } label: {
                Text("Turn On")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(BubbleColor.mine))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Turn on \(bot.name)")
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 52)
        .glassRounded(cornerRadius: 18, interactive: false)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
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
    @State private var showingRecordingReview = false
    @State private var recordingCorrection = ""
    @State private var recordingComment = ""

    private static let reactionChoices = ["👍", "❤️", "😂", "🎉", "👀"]

    private var versions: [Message] {
        session.state.versions(of: message, inThread: chat.threadId)
    }

    /// This message is the chat's pinned one.
    private var isPinned: Bool {
        chat.pinnedMessageId == message.id
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
        senderBot.flatMap { Self.modelSelection(of: $0, inThread: chat.threadId) }
    }

    /// The model a bot is answering with in this thread, for the provider
    /// mark on its avatar.  Shared with the live reply row so the mark is
    /// already there while the reply is typed.
    static func modelSelection(of bot: Bot, inThread threadId: String) -> ModelSelection? {
        if let currentTask = bot.tasks?.first(where: { $0.threadId == threadId }) {
            if let taskSelection = currentTask.modelSelection {
                return currentTask.activeModelSelection ?? taskSelection
            }
            return currentTask.activeModelSelection ?? bot.activeModelSelection ?? bot.modelSelection
        }
        return bot.activeModelSelection ?? bot.modelSelection
    }

    /// Whether a settled reply from `bot` carries the Read Aloud capsule.
    /// The live reply reserves the same space, so the row does not grow on
    /// arrival; one condition keeps the two from drifting apart.
    static func offersVoice(from bot: Bot?, hasAudio: Bool, config: ConfigStatus?) -> Bool {
        guard let bot else { return false }
        // Read Aloud is offered by this iPhone's voice, not the Mac's.
        let voice = bot.voice(for: .iphone)
        return hasAudio
            || PersonalVoiceContract.isPersonalVoice(voice)
            || config?.canSpeak(agentVoice: voice) == true
    }

    private var senderDriverKind: String? {
        guard let selection = senderModelSelection else { return nil }
        // A cold registry cannot tell whether a named instance runs this model's
        // native driver or a different one. Do not mislabel the sender's mark.
        return session.instanceDriverKinds[selection.instanceId]
    }

    /// Who this message reads as coming from, in the reader's own words.  The
    /// avatar says it on screen, but an avatar is a picture, so VoiceOver said
    /// nothing at all about who had spoken.
    private var accessibilitySender: String {
        if message.role == .user { return "You" }
        if message.role == .system {
            let body = message.text ?? ""
            if WebhookMessageView.parse(message.text) != nil { return "Webhook" }
            if ImessageMessageView.parse(message.text) != nil { return "iMessage" }
            if let delegation = DelegationMessageView.parse(
                message.text,
                role: message.role,
                fromName: message.from?.name,
                automationSource: message.automationSource
            ) {
                return delegation.headline
            }
            return Self.automationSourceLabel(message.automationSource, body: body)
        }
        if let from = message.from?.name, !from.isEmpty { return from }
        if let name = senderBot?.name { return name }
        if case let .room(room) = chat { return room.name }
        return "Bot"
    }

    /// "3 minutes ago", from the same formatter the push diagnostics use, so
    /// the row says when it arrived without the reader leaving the transcript
    /// to find out.
    private var accessibilityTime: String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(
            for: Date(timeIntervalSince1970: message.at / 1_000),
            relativeTo: Date()
        )
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
            if message.queued == true {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                    Text("Queued — sends when this turn finishes")
                }
                .font(.caption2)
                .foregroundStyle(Color.secondary)
            } else if message.steered == true {
                Text("Sent mid-turn")
                    .font(.caption2)
                    .foregroundStyle(Color.secondary)
            }

            if let recording = message.recording, message.role == .user {
                VStack(alignment: .leading, spacing: 4) {
                    Button {
                        session.playRecording(message, threadId: chat.threadId)
                    } label: {
                        Label(session.speakingMessageId == message.id ? "Stop recording" : "Replay recording",
                              systemImage: session.speakingMessageId == message.id ? "stop.fill" : "waveform")
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    Text("Original transcript: \(recording.transcript.isEmpty ? "(no speech recognized)" : recording.transcript)")
                        .font(.caption)
                    if let correction = message.recordingReview?.correction, !correction.isEmpty {
                        Text("Correction: \(correction)").font(.caption)
                    }
                    if let comment = message.recordingReview?.comment, !comment.isEmpty {
                        Text("Note: \(comment)").font(.caption)
                    }
                    Button("Correct or add a note") {
                        recordingCorrection = message.recordingReview?.correction ?? ""
                        recordingComment = message.recordingReview?.comment ?? ""
                        showingRecordingReview = true
                    }
                    .font(.caption)
                    if let translation = message.translation {
                        Text("Translation (\(translation.language)): \(translation.text)").font(.caption)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if message.role == .bot, message.kind == .text,
               Self.offersVoice(from: senderBot, hasAudio: message.audio?.isEmpty == false, config: session.config) {
                Button {
                    session.playVoice(message, threadId: chat.threadId)
                } label: {
                    Label(session.speakingMessageId == message.id ? "Stop Voice" : (message.audio?.isEmpty == false ? "Replay Voice" : "Read Aloud"),
                          systemImage: session.speakingMessageId == message.id ? "stop.fill" : "speaker.wave.2")
                }
                .font(.system(size: 12, weight: .medium))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
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
        // `.contain`, not `.combine`: the row names itself, then its buttons
        // stay reachable.  Combining would fold the approval card, the
        // reaction chips and the version switcher into one blob of prose and
        // take every one of them out of the reach of VoiceOver.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(accessibilitySender), \(accessibilityTime)")
        .contextMenu {
            // `at` is epoch milliseconds on the wire, like every other timestamp
            // the harness sends; SwiftUI's time style wants a Date.
            Text(Date(timeIntervalSince1970: message.at / 1_000), style: .time)
            if let text = message.text, !text.isEmpty {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = text
                }
            }
            // One pin per chat, shown above the transcript.  Pinning another
            // message replaces it, as on the desktop.
            if BotOrganize.canPin(message) {
                Button(isPinned ? "Unpin Message" : "Pin Message", systemImage: isPinned ? "pin.slash" : "pin") {
                    let messageId: String? = isPinned ? nil : message.id
                    Task { await session.pinMessage(messageId, in: chat) }
                }
            }
            Divider()
            ForEach(Self.reactionChoices, id: \.self) { emoji in
                Button(emoji) { Task { await session.react(to: message, in: chat.threadId, emoji: emoji) } }
            }
            if (message.role == .user ||
                (message.role == .system && message.automationSource == "delegation")),
               message.kind == .text, message.recording == nil,
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
        .sheet(isPresented: $showingRecordingReview) {
            NavigationStack {
                Form {
                    Section("Original transcript") {
                        Text(message.recording?.transcript ?? "")
                    }
                    Section("Correction (keeps the original)") {
                        TextEditor(text: $recordingCorrection).frame(minHeight: 90)
                    }
                    Section("Note") {
                        TextEditor(text: $recordingComment).frame(minHeight: 90)
                    }
                    Section {
                        Text("Translation is not configured yet.")
                            .foregroundStyle(Color.secondary)
                    }
                }
                .navigationTitle("Recording review")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showingRecordingReview = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            Task { await session.saveRecordingReview(message, threadId: chat.threadId,
                                                                      correction: recordingCorrection, comment: recordingComment) }
                            showingRecordingReview = false
                        }
                    }
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
                        .font(.footnote.weight(.semibold))
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
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                        MarkdownText(source: toImessage ?? split.display)
                            .foregroundStyle(Color.primary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            // Keep Markdown links independently reachable by
                            // VoiceOver.  MessageRow already supplies the
                            // speaker/time summary for this container.
                            // While this reply is read aloud, its words
                            // follow the voice (Karaoke.swift).  Only this
                            // bubble's blocks observe the per-word paint.
                            .environment(\.messageKaraoke, KaraokeCenter.shared.karaoke(for: message.id))
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded = false

    var body: some View {
        let isDark = colorScheme == .dark
        let expandable = payload != nil
        VStack(alignment: .leading, spacing: 0) {
            Group {
                if expandable {
                    Button {
                        withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.76)) {
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
                        .font(.system(.caption2, design: .monospaced))
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
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(isDark ? Color.white : Color.primary)
                    .lineLimit(isExpanded ? 4 : 2)
                    .truncationMode(.tail)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }

            Spacer(minLength: 8)

            if payload != nil {
                HStack(spacing: 4) {
                    Text(isExpanded ? "Collapse" : "Details")
                        .font(.caption.weight(.semibold))
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
                status: tool.ok.map { $0 ? "success" : "error" } ?? "running",
                durationMs: tool.durationMs ?? 0,
                parameters: tool.target ?? "",
                output: tool.detail ?? ""
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
    // No colorScheme environment here: this body uses semantic colors
    // throughout, so every appearance is correct without branching on the
    // scheme.  An unused environment property would warn.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded: Bool = false

    private var hasFailure: Bool {
        messages.contains { $0.tool?.ok == false }
    }

    /// One sentence for the whole header.  The row carries a headline, a
    /// tool-name summary, a state and a disclosure, which VoiceOver read as
    /// four unlabelled fragments with no indication that tapping did anything.
    private var accessibilityText: String {
        let desc = describeActivityRun(messages)
        var parts = [desc.headline, desc.summary]
        if isRunning {
            parts.append("Still running")
        } else if hasFailure {
            parts.append("\(desc.failedCount) failed")
        } else {
            parts.append("Complete")
        }
        return parts.joined(separator: ", ")
    }

    private var isRunning: Bool {
        messages.contains { $0.tool?.ok == nil }
    }

    private var tint: Color {
        BotPalette.color(chat.color)
    }

    /// The round badge beside the headline wears the bot's own colour, so a
    /// reader can tell whose run this is at a glance.  A failure overrides it
    /// with red, because a failed step is the one state that matters more
    /// than whose it was.
    private var badgeTint: Color {
        hasFailure ? .red : tint
    }

    var body: some View {
        let desc = describeActivityRun(messages)

        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.76)) {
                    isExpanded.toggle()
                }
                Haptics.selection()
            } label: {
                HStack(alignment: .center, spacing: 10) {
                    ZStack {
                        Circle()
                            .fill(badgeTint.opacity(0.18))
                            .frame(width: 26, height: 26)

                        if isRunning {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(badgeTint)
                        } else if hasFailure {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.scaled(12, weight: .bold, relativeTo: .footnote))
                                .foregroundStyle(Color.red)
                        } else {
                            Image(systemName: "wrench.and.screwdriver.fill")
                                .font(.scaled(12, weight: .semibold, relativeTo: .footnote))
                                .foregroundStyle(badgeTint)
                        }
                    }
                    .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(desc.headline)
                                .font(.scaled(15, weight: .semibold, relativeTo: .subheadline))
                                .foregroundStyle(Color.primary)
                                .lineLimit(1)

                            if hasFailure {
                                Text("• \(desc.failedCount) failed")
                                    .font(.scaled(12, weight: .medium, relativeTo: .caption))
                                    .foregroundStyle(Color.red)
                                    .lineLimit(1)
                            } else if !isRunning {
                                Text("• Complete")
                                    .font(.scaled(12, weight: .medium, relativeTo: .caption))
                                    .foregroundStyle(Color.green)
                                    .lineLimit(1)
                            }
                        }

                        Text(desc.summary)
                            .font(.scaled(13, relativeTo: .footnote))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    Spacer(minLength: 4)

                    // The word, not only the chevron: a chevron is a shape a
                    // VoiceOver rotor user never reaches and a glance-reader
                    // has to decode.  It stays inside the tap target and is
                    // hidden from VoiceOver, which gets the whole row instead.
                    HStack(spacing: 4) {
                        Text(isExpanded ? "Collapse" : "Details")
                            .font(.scaled(13, weight: .medium, relativeTo: .footnote))
                            .foregroundStyle(tint)

                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.scaled(10, weight: .bold, relativeTo: .caption2))
                            .foregroundStyle(tint)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(tint.opacity(0.12)))
                    .accessibilityHidden(true)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(minHeight: 44)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemBackground).opacity(0.6))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(hasFailure ? Color.red.opacity(0.35) : Color.secondary.opacity(0.18), lineWidth: 1)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityHint("Double tap to \(isExpanded ? "collapse" : "show") each tool call")

            if isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(messages) { msg in
                        if let tool = msg.tool {
                            SkillExecutionReceiptView(
                                skillName: tool.name,
                                status: tool.ok.map { $0 ? "success" : "error" } ?? "running",
                                durationMs: tool.durationMs ?? 0,
                                parameters: tool.target ?? "",
                                output: tool.detail ?? ""
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
    @State private var approvingAll = false

    /// One definition of "the refusal", shared by the button tint and the
    /// choice above so the two cannot drift apart.
    private static func isRefusal(_ option: String) -> Bool { OptionCard.isRefusal(option) }

    private var tint: Color { BotPalette.color(chat.color) }

    /// How many waiting permission requests "Approve All" would allow, when
    /// this is the card that carries the button.  One card per conversation
    /// carries it — the newest, beside the composer — and only once there are
    /// two or more, as on the desktop.
    private var approveAllCount: Int? {
        guard message.card?.isPending == true, message.card?.isPermission == true else { return nil }
        let offer = ApproveAll.offer(in: session.state.visibleTranscript(forThread: chat.threadId))
        guard let offer, offer.messageId == message.id else { return nil }
        return offer.count
    }

    @ViewBuilder
    private func approveAllButton(count: Int) -> some View {
        Button {
            answering = true
            approvingAll = true
            Task {
                await session.approveAll(chat: chat)
                approvingAll = false
                answering = false
            }
        } label: {
            Text(ApproveAll.label(count: count))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(Capsule().strokeBorder(tint, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .disabled(answering || approvingAll)
        .accessibilityHint(ApproveAll.hint)
    }

    var body: some View {
        if let card = message.card {
            VStack(alignment: .leading, spacing: 10) {
                if card.isPending {
                    Label("\(chat.name) is waiting on you", systemImage: "hand.raised.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint)
                }
                Text(card.title)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(.subheadline)
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
                                    .font(.subheadline.weight(.semibold))
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

                    if let count = approveAllCount {
                        approveAllButton(count: count)
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

/// The live reply as a transcript row, shaped like the `MessageRow` it
/// settles into: the 28pt avatar column and 8pt gap, the bubble, and the
/// Read Aloud capsule's space held open underneath.  Any difference is the
/// message jumping on arrival — text rewrapping when the column narrows by
/// 36pt, or the row growing when the capsule appears.
struct LiveReplyRow: View {
    let chat: Chat
    /// The bot typing: the chat's bot, or the room member holding the turn.
    let sender: Bot?
    let text: String?
    let reasoning: String?
    @EnvironmentObject private var session: Session

    /// The settled reply ends its run, so it shows the sender's face with
    /// the provider mark; a room with no known speaker shows the room's.
    @ViewBuilder
    private var avatar: some View {
        if let sender {
            BotAvatarView(bot: sender, size: 28, state: .idle, animated: false)
                .overlay(alignment: .bottomTrailing) {
                    if let selection = MessageRow.modelSelection(of: sender, inThread: chat.threadId),
                       let driverKind = session.instanceDriverKinds[selection.instanceId] {
                        ProviderMarkView(driverKind: driverKind, model: selection.model, size: 16)
                            .offset(x: 3, y: 3)
                    }
                }
        } else if case let .room(room) = chat {
            RoomAvatarView(room: room, size: 28, state: .idle, animated: false)
        }
    }

    /// Rooms attribute each reply to the member who said it.
    private var speaker: (name: String, color: String)? {
        guard case .room = chat, let sender else { return nil }
        return (sender.name, sender.color)
    }

    /// Who is typing, for the row's single announcement.  There is no
    /// timestamp to give: the message has not landed yet.
    private var accessibilitySender: String {
        if let name = sender?.name { return name }
        if case let .room(room) = chat { return room.name }
        return "Bot"
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            avatar
            VStack(alignment: .leading, spacing: 6) {
                StreamingBubble(
                    text: text,
                    reasoning: reasoning,
                    color: sender?.color ?? chat.color,
                    speaker: speaker
                )
                if MessageRow.offersVoice(from: sender, hasAudio: false, config: session.config) {
                    // Held open, not shown: the settled reply puts the real
                    // capsule here, and reserving it means the row does not
                    // grow when it does.
                    Button {} label: {
                        Label("Read Aloud", systemImage: "speaker.wave.2")
                    }
                    .font(.system(size: 12, weight: .medium))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .hidden()
                    .disabled(true)
                    .accessibilityHidden(true)
                }
            }
        }
        // One label, and one that does not change. The streaming subtree is
        // hidden, so nothing here is re-announced as tokens land; the settled
        // reply replaces this row and carries its own label.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(accessibilitySender) is replying")
    }
}

/// The reply as it is being typed, styled to match the settled bubble it is
/// about to become — the handover should be invisible, and any difference in
/// padding, width or corner radius reads as the message jumping on arrival.
/// The modifiers below mirror `TextBubble` one for one; change them together.
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
    /// The room member speaking, shown above the text as the settled
    /// bubble will show it.  `nil` in a bot chat.
    var speaker: (name: String, color: String)?
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                if let speaker {
                    Text(speaker.name)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(BotPalette.color(speaker.color))
                }
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
                        .fixedSize(horizontal: false, vertical: true)
                        // Hidden while it streams, not combined: this subtree
                        // is rebuilt on every token frame, so VoiceOver would
                        // re-announce the whole reply as it grows and drown out
                        // everything else. The settled bubble that replaces
                        // this row announces the finished text instead, and the
                        // row around it says who is replying.
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 11)
            .frame(maxWidth: sizeClass == .regular ? 560 : .infinity, alignment: .leading)
            .background(SpeechBubble(tail: .leading).fill(BubbleColor.theirs))
            .padding(.bottom, SpeechBubble.tailDrop())
            Spacer(minLength: 44)
        }
        // No `.textSelection` on purpose: selecting text that is still growing
        // fights the reader, and the settled bubble a frame later is
        // selectable anyway.
    }
}
