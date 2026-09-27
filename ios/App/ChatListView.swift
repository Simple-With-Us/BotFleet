// The roster.
//
// Messages-shaped: a glass header, collapsible room, bot, and Bot Chats
// sections.  Bot-to-bot DMs stay out of user rooms, matching the Mac sidebar.
// Unread dots in each bot's own colour at the left edge,
// and a glass bar floating at the bottom. The bar's pill is Updates — only
// the chats that need you, are working, or have something you have not
// read — beside round search and new-bot buttons. Everything scrolls under
// the glass, which is the whole point of the glass.
import SwiftUI
import CompanionCore

struct ChatListView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var query = ""
    /// Driven so that making a bot can open it. Value-based navigation alone
    /// cannot push without a tap, and a new bot appearing silently at the
    /// bottom of the roster is a poor answer to pressing +.
    @State private var path = NavigationPath()
    /// iPad split view selection. Phone keeps `path` and a pushed ChatView.
    @State private var selectedChat: Chat?
    @State private var searchHits: [SearchHit] = []
    @State private var searching = false
    @State private var searchOpen = false
    @State private var showingUpdates = false
    @State private var showingNewGroup = false
    @State private var showingCompose = false
    @AppStorage("companion.chats.roomsExpanded") private var roomsExpanded = true
    @AppStorage("companion.chats.botsExpanded") private var botsExpanded = true
    /// Mac Bot Chats is default-collapsed.  Same first-open on the phone.
    @AppStorage("companion.chats.botChatsExpanded") private var botChatsExpanded = false
    @AppStorage("companion.chats.collapsedSections") private var collapsedSectionsStr = ""
    @FocusState private var searchFocused: Bool
    /// Drives the live-session "Open BotFleet on Mac" header control.
    @State private var isOpeningMacApp = false

    /// Room for the floating bar, so the last row can scroll clear of it.
    private static let barClearance: CGFloat = 96

    /// Regular width (iPad, some landscape) gets a sidebar + detail. Compact
    /// (phone, Slide Over) keeps the existing stack so phone layout is unchanged.
    private var usesSplitView: Bool { sizeClass == .regular }

    /// True while the SSE stream is live — keys the instance-map warm so a
    /// reconnect after backgrounding refreshes newly added providers.
    private var sessionIsLive: Bool {
        if case .live = session.status { return true }
        return false
    }

    var body: some View {
        Group {
            if usesSplitView {
                NavigationSplitView {
                    NavigationStack {
                        roster
                    }
                    .navigationSplitViewColumnWidth(min: 280, ideal: 360, max: 480)
                } detail: {
                    NavigationStack {
                        if let selectedChat {
                            ChatView(chat: selectedChat)
                                .id(selectedChat.id)
                        } else {
                            ContentUnavailableView(
                                "Select a chat",
                                systemImage: "bubble.left.and.bubble.right",
                                description: Text("Pick a bot or \(roomTerms.singular.lowercased()) from the sidebar.")
                            )
                        }
                    }
                }
            } else {
                NavigationStack(path: $path) {
                    roster
                        .navigationDestination(for: Chat.self) { ChatView(chat: $0) }
                }
            }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .onAppear { migrateLegacyCollapsedSections() }
        .onChange(of: session.notificationChat) { _, chat in
            guard let chat else { return }
            open(chat)
            session.consumeNotificationChat()
        }
        .task {
            if let chat = session.notificationChat {
                open(chat)
                session.consumeNotificationChat()
            }
        }
#if DEBUG
        // `-store-preview -open-first`: land on the first chat, for the
        // screenshot harness and for looking at the chat screen without
        // a pairing.
        .task {
            if ProcessInfo.processInfo.arguments.contains("-open-first"),
               let first = chats.first {
                open(first.chat)
            }
        }
#endif
        .task { _ = await session.configStatus() }
        // Warms `session.instanceDriverKinds` before any chat is opened, so
        // the chat header's provider mark resolves synchronously instead of
        // firing a network call per render. Quiet path — offline/cancel must
        // not surface as the global action-error alert. Keyed on live so a
        // foreground reconnect refreshes the map after providers change.
        .task(id: sessionIsLive) {
            guard sessionIsLive else { return }
            await session.warmInstanceDriverKinds()
        }
        .sheet(isPresented: $showingUpdates) {
            UpdatesSheet { chat in
                showingUpdates = false
                open(chat)
            }
        }
        .sheet(isPresented: $showingNewGroup) {
            NewGroupSheet { room in
                showingNewGroup = false
                open(Chat.room(room))
            }
        }
        .confirmationDialog("New", isPresented: $showingCompose, titleVisibility: .visible) {
            Button(session.config?.newPrimaryLabel ?? "New Bot") {
                Task {
                    if let bot = await session.createBot() { open(Chat.bot(bot)) }
                }
            }
            Button(roomTerms.newLabel) {
                showingNewGroup = true
            }
            Button("Cancel", role: .cancel) {}
        }
        .task(id: query) {
            let expected = query
            guard expected.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2 else {
                searchHits = []
                searching = false
                return
            }
            searching = true
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, query == expected else { return }
            searchHits = await session.search(expected)
            searching = false
        }
    }

    private func open(_ chat: Chat) {
        if usesSplitView {
            selectedChat = chat
        } else {
            path.append(chat)
        }
    }

    /// The roster column, shared by the phone stack and the iPad sidebar.
    private var roster: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                header
                StatusBanner()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if query.isEmpty {
                            sectionToggle(
                                title: roomTerms.plural,
                                count: roomSummaries.count,
                                expanded: $roomsExpanded
                            )
                            .padding(.top, 2)
                            if roomsExpanded {
                                ForEach(Array(roomSummaries.enumerated()), id: \.element.id) { index, summary in
                                    chatOpener(for: summary.chat) {
                                        ChatRow(
                                            chat: summary.chat,
                                            preview: summary.preview,
                                            at: summary.lastActivity,
                                            state: BotState.forChat(summary.chat, in: session.state),
                                            waiting: waitingChats.contains(summary.chat.id),
                                            last: index == roomSummaries.count - 1 && !botsExpanded && customSectionNames.isEmpty && !showingBotChats
                                        )
                                    }
                                }
                                Button {
                                    showingNewGroup = true
                                } label: {
                                    NewRoomRow(label: roomTerms.newLabel)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(roomTerms.newLabel)
                            }

                            sectionToggle(
                                title: session.config?.primaryPlural ?? "Bots",
                                count: botSummaries.count,
                                expanded: $botsExpanded
                            )
                            .padding(.top, 14)
                        }

                        if !query.isEmpty, !searchHits.isEmpty {
                            HStack {
                                sectionLabel("Messages")
                                Spacer()
                                if searching { ProgressView().controlSize(.small) }
                            }
                            .padding(.top, 10)
                            .padding(.bottom, 4)

                            ForEach(searchHits) { hit in
                                Button {
                                    Task {
                                        if let chat = await session.open(hit) { open(chat) }
                                    }
                                } label: {
                                    SearchHitRow(hit: hit)
                                }
                                .buttonStyle(.plain)
                                .padding(.horizontal, 16)
                            }
                            sectionLabel("Chats")
                                .padding(.top, 14)
                                .padding(.bottom, 4)
                        }

                        let rows = query.isEmpty ? (botsExpanded ? botSummaries : []) : chats
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, summary in
                            chatOpener(for: summary.chat) {
                                ChatRow(
                                    chat: summary.chat,
                                    preview: summary.preview,
                                    at: summary.lastActivity,
                                    state: BotState.forChat(summary.chat, in: session.state),
                                    waiting: waitingChats.contains(summary.chat.id),
                                    last: index == rows.count - 1 && nestedTasks(for: summary.chat).isEmpty && (query.isEmpty ? customSectionNames.isEmpty && !showingBotChats : true)
                                )
                            }
                            if session.config?.allowsMultipleBotThreads == true {
                                ForEach(nestedTasks(for: summary.chat), id: \.threadId) { task in
                                    Button {
                                        Task { await openTask(task, in: summary.chat) }
                                    } label: {
                                        ThreadRow(task: task, active: summary.chat.threadId == task.threadId)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }

                        if query.isEmpty {
                            ForEach(customSectionNames, id: \.self) { section in
                                let sectionRows = summaries(forSection: section)
                                if !sectionRows.isEmpty {
                                    let isExpanded = sectionBinding(for: section)
                                    sectionToggle(
                                        title: section,
                                        count: sectionRows.count,
                                        expanded: isExpanded
                                    )
                                    .padding(.top, 14)

                                    if isExpanded.wrappedValue {
                                        ForEach(Array(sectionRows.enumerated()), id: \.element.id) { index, summary in
                                            chatOpener(for: summary.chat) {
                                                ChatRow(
                                                    chat: summary.chat,
                                                    preview: summary.preview,
                                                    at: summary.lastActivity,
                                                    state: BotState.forChat(summary.chat, in: session.state),
                                                    waiting: waitingChats.contains(summary.chat.id),
                                                    last: index == sectionRows.count - 1 && nestedTasks(for: summary.chat).isEmpty && (section == customSectionNames.last ? !showingBotChats : false)
                                                )
                                            }
                                            if session.config?.allowsMultipleBotThreads == true {
                                                ForEach(nestedTasks(for: summary.chat), id: \.threadId) { task in
                                                    Button {
                                                        Task { await openTask(task, in: summary.chat) }
                                                    } label: {
                                                        ThreadRow(task: task, active: summary.chat.threadId == task.threadId)
                                                    }
                                                    .buttonStyle(.plain)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if query.isEmpty, !botChatSummaries.isEmpty {
                            sectionToggle(
                                title: "Bot Chats",
                                count: botChatSummaries.count,
                                expanded: $botChatsExpanded
                            )
                            .padding(.top, 14)
                            if botChatsExpanded {
                                ForEach(Array(botChatSummaries.enumerated()), id: \.element.id) { index, summary in
                                    chatOpener(for: summary.chat) {
                                        ChatRow(
                                            chat: summary.chat,
                                            preview: summary.preview,
                                            at: summary.lastActivity,
                                            state: BotState.forChat(summary.chat, in: session.state),
                                            waiting: waitingChats.contains(summary.chat.id),
                                            last: index == botChatSummaries.count - 1
                                        )
                                    }
                                }
                            }
                        }
                    }
                    .padding(.bottom, Self.barClearance)
                }
                .refreshable { await session.refresh() }
                .overlay {
                    if query.isEmpty
                        ? botSummaries.isEmpty && roomSummaries.isEmpty && botChatSummaries.isEmpty && searchHits.isEmpty
                        : chats.isEmpty && searchHits.isEmpty
                    {
                        ContentUnavailableView(
                            query.isEmpty ? "No chats yet" : "Nothing matches",
                            systemImage: query.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass",
                            description: Text(
                                query.isEmpty
                                    ? "Bots and \(roomTerms.plural.lowercased()) you create on your computer show up here."
                                    : "No chat matches \u{201C}\(query)\u{201D}."
                            )
                        )
                    }
                }
            }
            // top-aligned: the roster fills downward from the header
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .overlay(alignment: .bottom) { bottomBar }
            // a bot that stopped for you grows out of the island
            .overlay(alignment: .top) {
                NeedsYouIsland(
                    update: session.state.updates.first { $0.kind == .needsYou },
                    hasIsland: IslandGeometry.hasIsland(topInset: geo.safeAreaInsets.top)
                ) { chat in open(chat) }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    @ViewBuilder
    private func chatOpener<Label: View>(for chat: Chat, @ViewBuilder label: () -> Label) -> some View {
        if usesSplitView {
            Button { open(chat) } label: { label() }
                .buttonStyle(.plain)
                .background(selectedChat == chat ? Color.primary.opacity(0.06) : Color.clear)
        } else {
            NavigationLink(value: chat) { label() }
                .buttonStyle(.plain)
        }
    }

    // MARK: - Header

    /// Title and connection status, with Settings on the right. The old
    /// green initial was identity of the paired computer but read as a
    /// tappable button, so it is gone.
    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Chats")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.primary)
                Text(headerSubtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            // Wake or unhide the Mac desktop app while connected.  Closing
            // every BotFleet window leaves the Electron process and sidecar
            // running, so the phone stays .live and the offline status banner
            // — the action's other home — is hidden.  A live session needs
            // its own entry point.
            if sessionIsLive, session.connection != nil {
                Button {
                    Task { await openMacApp() }
                } label: {
                    Group {
                        if isOpeningMacApp {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "macwindow")
                                .font(.system(size: 18, weight: .medium))
                        }
                    }
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .glassCapsule()
                .accessibilityLabel("Open BotFleet on Mac")
                .disabled(isOpeningMacApp)
            }

            NavigationLink { SettingsView() } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .glassCapsule()
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 12)
    }

    private var headerSubtitle: String {
        let name = session.connection?.name ?? "Not paired"
        switch session.status {
        case .live: return "\(name) · connected"
        case .connecting: return "\(name) · connecting…"
        case .offline: return "\(name) · offline"
        case .macOffline: return "\(name) · Mac offline"
        case .unauthorized: return "\(name) · unpaired"
        case .unpaired: return "Not paired"
        }
    }

    /// Ask the paired Mac to open or unhide BotFleet.  Failures become human
    /// copy on the global action-error alert — never raw transport errors.
    @MainActor
    private func openMacApp() async {
        isOpeningMacApp = true
        defer { isOpeningMacApp = false }
        do {
            try await session.openDesktopApp()
        } catch {
            // An unauthorized failure already flips the session to
            // .unauthorized, whose banner explains itself — don't also alert.
            if case .live = session.status {
                session.actionError = "Could not open BotFleet on Mac.  Check that your Mac is awake and reachable."
            }
        }
    }

    // MARK: - Sections

    private var roomTerms: (singular: String, plural: String, newLabel: String) {
        let singular = session.config?.roomTerminologyLabel ?? "Channel"
        let plural = session.config?.roomTerminologyPlural ?? "Channels"
        return (singular, plural, "New \(singular.lowercased())")
    }

    private func sectionToggle(title: String, count: Int, expanded: Binding<Bool>) -> some View {
        Button {
            withAnimation(.snappy(duration: 0.22)) { expanded.wrappedValue.toggle() }
        } label: {
            HStack(spacing: 8) {
                Text(title.uppercased())
                    .font(.system(size: 13, weight: .semibold))
                    .tracking(0.4)
                    .foregroundStyle(Color.secondary)
                Image(systemName: expanded.wrappedValue ? "chevron.down" : "chevron.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.secondary)
                Spacer(minLength: 0)
                Text("\(count)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(count)")
        .accessibilityHint(expanded.wrappedValue ? "Collapse" : "Expand")
        .accessibilityAddTraits(.isHeader)
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        GlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                if searchOpen {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.secondary)
                        TextField("Search chats", text: $query)
                            .font(.body)
                            .submitLabel(.search)
                            .autocorrectionDisabled()
                            .focused($searchFocused)
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(Color.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .glassCapsule()

                    Button("Cancel") {
                        query = ""
                        searchOpen = false
                        searchFocused = false
                    }
                    .font(.system(size: 17))
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .glassCapsule()
                } else {
                    UpdatesPill(updates: session.state.updates) { showingUpdates = true }
                        .frame(height: 52)

                    GlassButton(systemImage: "magnifyingglass", size: 48, weight: .semibold) {
                        searchOpen = true
                        searchFocused = true
                    }
                    .accessibilityLabel("Search")

                    GlassButton(systemImage: "square.and.pencil", size: 48, weight: .medium) {
                        showingCompose = true
                    }
                    .accessibilityLabel("New")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .animation(.snappy(duration: 0.25), value: searchOpen)
    }

    // MARK: - Data

    private var chats: [ChatSummary] {
        let all = session.state.chatSummaries
        guard !query.isEmpty else { return botSummaries }
        return all.filter {
            $0.chat.name.localizedCaseInsensitiveContains(query)
                || $0.chat.subtitle.localizedCaseInsensitiveContains(query)
                || $0.preview.localizedCaseInsensitiveContains(query)
        }
    }

    private func isUnsectioned(_ chat: Chat) -> Bool {
        let section = chat.section?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return section.isEmpty
    }

    private var botSummaries: [ChatSummary] {
        session.state.chatSummaries.filter { 
            if case .bot = $0.chat { return isUnsectioned($0.chat) }
            return false 
        }
    }

    /// User rooms only.  Bot-to-bot DMs sit in Bot Chats, like the Mac sidebar.
    private var roomSummaries: [ChatSummary] {
        session.state.chatSummaries.filter {
            if case .room = $0.chat { return !$0.chat.isBotToBot && isUnsectioned($0.chat) }
            return false
        }
    }

    private var customSectionNames: [String] {
        var names = Set<String>()
        for summary in session.state.chatSummaries {
            if !summary.chat.isBotToBot, let section = summary.chat.section?.trimmingCharacters(in: .whitespacesAndNewlines), !section.isEmpty {
                names.insert(section)
            }
        }
        
        let sorted = Array(names).sorted()
        // If the user has a manually ordered list of sections (from Mac), respect it.
        // Sections present in customSectionNames but missing from order go to the end.
        let order = session.config?.sidebarSectionOrder ?? []
        var result = [String]()
        for name in order {
            if names.contains(name) {
                result.append(name)
                names.remove(name)
            }
        }
        result.append(contentsOf: names.sorted())
        return result
    }

    private func summaries(forSection section: String) -> [ChatSummary] {
        session.state.chatSummaries.filter {
            !$0.chat.isBotToBot && $0.chat.section?.trimmingCharacters(in: .whitespacesAndNewlines) == section
        }
    }

    /// Stored as a JSON array rather than a comma-joined string, because a section
    /// name may itself contain a comma.  See `CollapsedSections`.
    private var collapsedSections: Set<String> {
        get { CollapsedSections.decode(collapsedSectionsStr) }
        set { collapsedSectionsStr = CollapsedSections.encode(newValue) }
    }

    /// Pre-rename stored key.  Move it onto "Bot Chats" so a collapsed preference survives.
    private func migrateLegacyCollapsedSections() {
        let legacy = "Bot ↔ Bot"
        let current = "Bot Chats"
        var set = collapsedSections
        guard set.contains(legacy) else { return }
        set.remove(legacy)
        set.insert(current)
        collapsedSectionsStr = CollapsedSections.encode(set)
    }

    private func sectionBinding(for section: String) -> Binding<Bool> {
        Binding(
            get: { !collapsedSections.contains(section) },
            set: { expanded in
                var set = collapsedSections
                if expanded {
                    set.remove(section)
                } else {
                    set.insert(section)
                }
                collapsedSectionsStr = CollapsedSections.encode(set)
            }
        )
    }

    private var botChatSummaries: [ChatSummary] {
        session.state.chatSummaries.filter(\.chat.isBotToBot)
    }

    private var showingBotChats: Bool {
        query.isEmpty && botChatsExpanded && !botChatSummaries.isEmpty
    }

    private func nestedTasks(for chat: Chat) -> [BotTask] {
        guard session.config?.allowsMultipleBotThreads == true else { return [] }
        guard case let .bot(bot) = chat else { return [] }
        let tasks = bot.tasks ?? []
        guard tasks.count >= 2 else { return [] }
        return tasks.sorted { ($0.lastActivity ?? $0.createdAt) > ($1.lastActivity ?? $1.createdAt) }
    }

    private func openTask(_ task: BotTask, in chat: Chat) async {
        guard case let .bot(bot) = chat else { return }
        await session.switchTask(task, for: bot)
        if let live = session.state.bot(bot.id) { open(Chat.bot(live)) }
    }

    private var waitingChats: Set<String> {
        Set(session.state.pendingApprovals.compactMap { session.state.chat(forThread: $0.threadId)?.id })
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 13, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(Color.secondary)
            .padding(.horizontal, 20)
    }
}

// MARK: - Rows and tiles

/// List-row control that creates a room using the configured terminology.
struct NewRoomRow: View {
    let label: String

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Color.secondary)
            }
            .frame(width: 52, height: 52)
            Text(label)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.secondary)
            Spacer(minLength: 0)
        }
        .padding(.leading, 28)
        .padding(.trailing, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// A room as a round tile: the first two members' mascots stacked, its name
/// beneath. `nil` is the "make one" tile.
struct GroupTile: View {
    let room: Room?
    @EnvironmentObject private var session: Session

    var body: some View {
        VStack(spacing: 7) {
            ZStack {
                if let room {
                    Circle().fill(Color.secondary.opacity(0.14))
                    let bots = memberBots(room)
                    if let first = bots.first {
                        BotAvatarView(bot: first, size: 34, state: .happy, animated: false)
                            .offset(x: -9, y: -6)
                    }
                    if bots.count > 1 {
                        BotAvatarView(bot: bots[1], size: 30, state: .happy, animated: false)
                            .padding(2)
                            .background(Circle().fill(Color(uiColor: .systemBackground)))
                            .offset(x: 11, y: 9)
                    }
                    if room.unread {
                        Circle()
                            .fill(BotPalette.color("blue"))
                            .frame(width: 10, height: 10)
                            .overlay(Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2))
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                            .padding(3)
                    }
                } else {
                    Circle()
                        .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                    Image(systemName: "plus")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(Color.secondary)
                }
            }
            .frame(width: 64, height: 64)

            Text(room?.name ?? "New")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(room == nil ? Color.secondary : Color.primary)
                .lineLimit(1)
        }
        .frame(width: 76)
        .contentShape(Rectangle())
    }

    private func memberBots(_ room: Room) -> [Bot] {
        room.memberIds.compactMap { session.state.bot($0) }
    }
}

struct ThreadRow: View {
    let task: BotTask
    var active = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "text.bubble")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(task.title.isEmpty ? "Untitled" : task.title)
                    .font(.system(size: 15, weight: active ? .semibold : .regular))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text(RelativeStamp.list(task.lastActivity ?? task.createdAt))
                    .font(.system(size: 12))
                    .foregroundStyle(Color.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 44)
        .padding(.trailing, 16)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .accessibilityLabel(task.title.isEmpty ? "Untitled thread" : task.title)
    }
}

struct ChatRow: View {
    let chat: Chat
    let preview: String
    let at: Double
    var state: BotState = .idle
    var waiting = false
    var last = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // the unread dot, in the bot's own colour, at the very edge
            ZStack {
                if chat.unread && !chat.busy {
                    Circle()
                        .fill(BotPalette.color(chat.color))
                        .frame(width: 10, height: 10)
                }
            }
            .frame(width: 22)
            .frame(maxHeight: .infinity)

            HStack(alignment: .top, spacing: 14) {
                ChatAvatarView(chat: chat, size: 52, state: state, animated: state.showsActivity)
                    .padding(.top, 12)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(chat.name)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                            .layoutPriority(1)

                        // the bot's job, the way the desktop shows it
                        if !chat.subtitle.isEmpty {
                            Text(chat.subtitle)
                                .font(.system(size: 13))
                                .foregroundStyle(Color.secondary)
                                .lineLimit(1)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(Color.secondary.opacity(0.15)))
                        }

                        Spacer(minLength: 4)

                        Text(RelativeStamp.list(at))
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .fixedSize()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.secondary.opacity(0.5))
                    }

                    HStack(alignment: .top, spacing: 8) {
                        // one line for every bot, so the rows keep one rhythm
                        Text(preview.isEmpty ? " " : preview)
                            .font(.system(size: 15))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)

                        Spacer(minLength: 0)

                        if chat.busy {
                            ProgressView().controlSize(.mini).padding(.top, 3)
                        }
                    }

                    if waiting {
                        Label("Waiting on you", systemImage: "hand.raised.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(Capsule().fill(BotPalette.color(chat.color)))
                            .padding(.top, 4)
                    }
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .bottom) {
                    if !last { Divider() }
                }
            }
            .padding(.trailing, 16)
        }
        .padding(.leading, 6)
        .contentShape(Rectangle())
    }
}

/// The floating pill: who is doing what right now, at a glance.
struct UpdatesPill: View {
    let updates: [ChatUpdate]
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if !updates.isEmpty {
                    MascotStack(colors: Array(updates.prefix(3).map(\.chat.color)))
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if let first = updates.first {
                            switch first.kind {
                            case .needsYou:
                                Image(systemName: "hand.raised.fill")
                                    .font(.system(size: 11, weight: .bold))
                                    .foregroundStyle(BotPalette.color(first.chat.color))
                                Text("\(first.chat.name) needs you")
                            case .working:
                                Text("\(first.chat.name) is working")
                            case .toReview:
                                Text("\(first.chat.name) has an update")
                            }
                        } else {
                            Text("All quiet")
                        }
                    }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(updates.isEmpty ? Color.secondary : Color.primary)
                    .lineLimit(1)

                    Text(subline)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color.secondary)
            }
            .padding(.leading, updates.isEmpty ? 16 : 7)
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassCapsule()
        .accessibilityLabel("Updates")
    }

    private var subline: String {
        guard let first = updates.first else { return "Nothing needs you" }
        let rest = updates.count - 1
        if rest == 0 { return first.line.isEmpty ? " " : first.line }
        return rest == 1 ? "1 more update" : "\(rest) more updates"
    }
}

/// Up to three mascots overlapping, the way a group of faces reads at a glance.
struct MascotStack: View {
    let colors: [String]
    var size: CGFloat = 28
    var overlap: CGFloat = 12

    var body: some View {
        HStack(spacing: -overlap) {
            ForEach(Array(colors.enumerated()), id: \.offset) { _, color in
                BotMascot(color: color, size: size, state: .idle, animated: false)
                    .padding(2)
                    .background(Circle().fill(Color(uiColor: .systemBackground)))
            }
        }
    }
}

/// Connection state, shown only when it is not "fine".
struct StatusBanner: View {
    @EnvironmentObject private var session: Session
    @State private var isOpening = false
    @State private var openError: String?

    var body: some View {
        Group {
            switch session.status {
            case .live, .unpaired:
                EmptyView()
            case .connecting:
                if isOpening {
                    banner("Opening BotFleet on Mac…", systemImage: "arrow.triangle.2.circlepath", tint: .secondary)
                } else {
                    banner("Connecting…", systemImage: "arrow.triangle.2.circlepath", tint: .secondary)
                }
            case let .offline(reason):
                VStack(spacing: 6) {
                    banner(reason, systemImage: "wifi.slash", tint: .orange)

                    if session.connection != nil {
                        if isOpening {
                            banner("Opening BotFleet on Mac…", systemImage: "arrow.triangle.2.circlepath", tint: .secondary)
                        } else if let openError {
                            banner(openError, systemImage: "exclamationmark.triangle", tint: .red) {
                                Task { await openMacApp() }
                            }
                        } else {
                            banner("Open BotFleet on Mac", systemImage: "macwindow", tint: .secondary) {
                                Task { await openMacApp() }
                            }
                        }
                    }
                }
            case .macOffline:
                // No `openMacApp` follow-up here on purpose: that call goes
                // through the same paired route that has been failing with
                // gateway errors, so it would just fail the same way.  The
                // banner's default tap already retries via `session.refresh()`.
                banner("Your Mac is not running BotFleet", systemImage: "wifi.slash", tint: .orange)
            case .unauthorized:
                banner("This phone was unpaired on the computer.", systemImage: "lock.slash", tint: .red)
            }
        }
        .animation(.default, value: session.status)
        .animation(.default, value: isOpening)
        .animation(.default, value: openError)
        .onChange(of: session.status) { _ in
            openError = nil
        }
    }

    private func banner(_ text: String, systemImage: String, tint: Color, action: (() -> Void)? = nil) -> some View {
        Button {
            if let action {
                action()
            } else {
                Task { await session.refresh() }
            }
        } label: {
            Label(text, systemImage: systemImage)
                .font(.footnote)
                .foregroundStyle(tint)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .glassCapsule(interactive: true)
                .padding(.bottom, 4)
        }
        .buttonStyle(.plain)
        .disabled(isOpening)
    }

    @MainActor
    private func openMacApp() async {
        isOpening = true
        openError = nil
        do {
            try await session.openDesktopApp()
            await session.refresh()
        } catch {
            openError = "Could not open BotFleet on Mac.  Check that your Mac is awake and reachable."
        }
        isOpening = false
    }
}

struct SearchHitRow: View {
    let hit: SearchHit

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: hit.role == .user ? "person.fill" : "bubble.left.fill")
                .foregroundStyle(Color.secondary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.secondary.opacity(0.13)))

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(hit.from ?? hit.name).font(.system(size: 15, weight: .semibold))
                    if let task = hit.task, !task.isEmpty {
                        Text(task).font(.system(size: 12)).foregroundStyle(Color.secondary)
                    }
                    Spacer()
                    Text(RelativeStamp.list(hit.at))
                        .font(.system(size: 12))
                        .foregroundStyle(Color.secondary)
                }
                Text(hit.snippet)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// Timestamps the way a messaging app writes them.
enum RelativeStamp {
    /// Roster: time today, weekday this week, date beyond that.
    static func list(_ at: Double) -> String {
        guard at > 0 else { return "" }
        let date = Date(timeIntervalSince1970: at / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let week = calendar.date(byAdding: .day, value: -6, to: Date()), date > week {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }

    /// In a transcript: enough to place a gap in the conversation.
    static func separator(_ date: Date) -> String {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "Today \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
        return "\(date.formatted(.dateTime.day().month(.abbreviated))) \(time)"
    }
}
