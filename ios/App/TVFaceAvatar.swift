// TV-Face avatar for iOS — same enter/hold/return player as the web
// `TVFaceAvatar.tsx`. Assets load from FleetLink by default (transparent
// GIF packs); a custom baseURL can point at a paired computer or bundled pack.
import SwiftUI
import Combine

/// Where TV-Face stills + GIFs are fetched from.
public enum TVFaceAssetSource: Sendable {
    /// Public FleetLink CDN packs.
    case fleetLink
    /// Custom base, e.g. "https://host/tv-face/skins" or a file URL.
    case custom(URL)

    var baseURL: URL {
        switch self {
        case .fleetLink:
            return URL(string: "https://fleetlink.online/TV-Face/botfleet-skins")!
        case .custom(let url):
            return url
        }
    }

    /// Where a color's pack lives, most current first. FleetLink publishes
    /// every color under `botfleet-skins/{color}/` (the "app-ready" layout)
    /// and still serves the older `botfleet/{color}/` tree, so the legacy
    /// shape is kept as a retry rather than the primary: the phone resolved
    /// the two the other way round from the web demo, and a color whose pack
    /// has not been mirrored into `botfleet-skins/` was unreachable.
    func roots(color: String) -> [URL] {
        let skin = TVFaceManifest.skinDir(color)
        switch self {
        case .custom(let url):
            return [url.appendingPathComponent(skin)]
        case .fleetLink:
            if skin == "default" { return [baseURL] }
            return [
                baseURL.appendingPathComponent(skin),
                URL(string: "https://fleetlink.online/TV-Face/botfleet")!.appendingPathComponent(skin),
            ]
        }
    }

    /// One asset inside a pack root. `TVFaceExpression.rawValue` is a closed
    /// `[a-z_]` vocabulary and `TVFaceManifest.skinDir` a closed color set,
    /// so nothing interpolated here can escape the pack directory.
    func url(root: URL, expression: TVFaceExpression, kind: TVFaceFrameKind) -> URL {
        switch kind {
        case .still:
            return root.appendingPathComponent("stills/\(expression.rawValue).png")
        case .enter, .hold, .return:
            return root.appendingPathComponent("gifs/\(expression.rawValue)_\(kind.rawValue).gif")
        }
    }
}

@MainActor
final class TVFacePlayer: ObservableObject {
    @Published var imageData: Data?
    @Published var expressionLabel: String = "resting"

    private var previous: TVFaceExpression = .resting
    private var color: String
    private var source: TVFaceAssetSource
    private var task: Task<Void, Never>?

    /// Pack bytes, shared by every avatar on screen and bounded by a byte
    /// ceiling. `TVFacePlayer` is created per `TVFaceAvatar` through
    /// `@StateObject`, so a per-player cache pinned one copy of every pack per
    /// visible row and re-fetched each pack once per row. Oldest insertion is
    /// evicted first, so a long session cannot pin everything it has seen.
    private static var sharedCache: [URL: Data] = [:]
    private static var sharedCacheOrder: [URL] = []
    private static var sharedCacheBytes = 0
    private static let sharedCacheByteCeiling = 16 * 1024 * 1024

    private static func cache(_ url: URL, _ data: Data) {
        guard sharedCache[url] == nil else { return }
        sharedCache[url] = data
        sharedCacheOrder.append(url)
        sharedCacheBytes += data.count
        while sharedCacheBytes > sharedCacheByteCeiling, let oldest = sharedCacheOrder.first {
            sharedCacheOrder.removeFirst()
            if let dropped = sharedCache.removeValue(forKey: oldest) {
                sharedCacheBytes -= dropped.count
            }
        }
    }

    init(color: String, source: TVFaceAssetSource = .fleetLink) {
        self.color = color
        self.source = source
    }

    /// Swap the skin and replay the current expression under it. `previous` is
    /// reset so the planner emits the enter step again — the caller used to
    /// follow this with a second `play`, whose `task?.cancel()` killed the
    /// enter this had just scheduled and cut straight to the hold.
    func setColor(_ color: String, replaying expression: TVFaceExpression, animated: Bool) {
        guard color != self.color else { return }
        self.color = color
        previous = .resting
        play(expression: expression, animated: animated)
    }

    func play(state: BotState, animated: Bool) {
        play(expression: TVFaceManifest.expression(for: state), animated: animated)
    }

    func play(expression next: TVFaceExpression, animated: Bool) {
        task?.cancel()
        if !animated {
            previous = next
            expressionLabel = next.rawValue
            task = Task { await show(expression: next, kind: .still) }
            return
        }
        let steps = TVFacePlanner.plan(from: previous, to: next)
        previous = next
        task = Task { [weak self] in
            guard let self else { return }
            for step in steps {
                if Task.isCancelled { return }
                await self.show(expression: step.expression, kind: step.kind)
                self.expressionLabel = step.expression.rawValue
                if step.delayAfterMs > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(step.delayAfterMs) * 1_000_000)
                }
            }
        }
    }

    private func show(expression: TVFaceExpression, kind: TVFaceFrameKind) async {
        // Same order as the web demo: the requested frame, then the same
        // expression's still, then resting — each across every pack root,
        // most current first.
        var frames: [(TVFaceExpression, TVFaceFrameKind)] = [(expression, kind)]
        if kind != .still { frames.append((expression, .still)) }
        frames.append((.resting, .still))
        let urls = frames.flatMap { frame in
            source.roots(color: color).map { source.url(root: $0, expression: frame.0, kind: frame.1) }
        }
        for (index, url) in urls.enumerated() {
            let data: Data
            if let cached = Self.sharedCache[url] {
                data = cached
            } else if let fetched = await fetch(url) {
                Self.cache(url, fetched)
                data = fetched
            } else {
                continue
            }
            // Every earlier candidate missed, so it resolves to these bytes
            // too.  The packs ship a hold GIF for only a dozen faces, and a
            // still-only face used to re-issue its guaranteed 404 on every
            // state change for the life of the player.
            for missed in urls[..<index] { Self.cache(missed, data) }
            imageData = data
            return
        }
    }

    private func fetch(_ url: URL) async -> Data? {
        if url.isFileURL {
            return try? Data(contentsOf: url)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("GrokBot-iOS-TVFace/1.0", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return nil
            }
            return data
        } catch {
            return nil
        }
    }
}

/// Drop-in TV-Face avatar. Pass `animated: true` for enter/hold/return; false
/// for a resting still (lists, widgets).
struct TVFaceAvatar: View {
    let color: String
    var state: BotState = .idle
    var size: CGFloat = 52
    var animated: Bool = false
    var source: TVFaceAssetSource = .fleetLink

    @StateObject private var player: TVFacePlayer

    init(
        color: String,
        state: BotState = .idle,
        size: CGFloat = 52,
        animated: Bool = false,
        source: TVFaceAssetSource = .fleetLink
    ) {
        self.color = color
        self.state = state
        self.size = size
        self.animated = animated
        self.source = source
        _player = StateObject(wrappedValue: TVFacePlayer(color: color, source: source))
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.001) // hit target
            if let data = player.imageData {
                AnimatedGIFView(data: data)
                    .frame(width: size, height: size)
            } else {
                ProgressView()
                    .frame(width: size, height: size)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onAppear { player.play(state: state, animated: animated) }
        .onChange(of: state) { _, new in player.play(state: new, animated: animated) }
        .onChange(of: color) { _, new in
            player.setColor(new, replaying: TVFaceManifest.expression(for: state), animated: animated)
        }
        .onChange(of: animated) { _, new in player.play(state: state, animated: new) }
    }
}
