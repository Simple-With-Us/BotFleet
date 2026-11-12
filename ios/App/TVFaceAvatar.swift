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
            return URL(string: "https://fleetlink.online/TV-Face/botfleet")!
        case .custom(let url):
            return url
        }
    }

    /// Non-default packs live under the skins CDN; the pack root above is
    /// the orange/default pack (and the legacy fallback some clients use).
    private static let skinsBase = URL(string: "https://fleetlink.online/TV-Face/botfleet-skins")!

    func url(color: String, expression: TVFaceExpression, kind: TVFaceFrameKind) -> URL {
        let skin = TVFaceManifest.skinDir(color)
        // FleetLink layout: orange at pack root; other colors under
        // /TV-Face/botfleet-skins/{color} (mirrors the demo pages' packBase).
        // Local/app layout would use /skins/{skin}/ — we support both:
        // FleetLink uses color name (or root for orange/default).
        let root: URL
        if case .fleetLink = self {
            if skin == "default" {
                root = baseURL
            } else {
                root = Self.skinsBase.appendingPathComponent(skin)
            }
        } else {
            root = baseURL.appendingPathComponent(skin)
        }
        switch kind {
        case .still:
            return root.appendingPathComponent("stills/\(expression.rawValue).png")
        case .enter, .hold, .return:
            return root.appendingPathComponent("gifs/\(expression.rawValue)_\(kind.rawValue).gif")
        }
    }
}

private enum TVFaceFetchResult: Sendable {
    case hit(Data)
    case missing
    case failed
}

@MainActor
final class TVFacePlayer: ObservableObject {
    @Published var imageData: Data?
    @Published var expressionLabel: String = "resting"
    /// True when every asset in the fallback chain failed (offline, CDN
    /// unreachable): the view renders the deterministic mascot instead of
    /// an endless spinner.  Cleared on the next play().
    @Published private(set) var failed = false

    private var previous: TVFaceExpression = .resting
    private var color: String
    private var source: TVFaceAssetSource
    private var task: Task<Void, Never>?
    /// One bounded cache for every player: each row used to hold its own copy
    /// of the same packs (N× the bytes, N× the fetches in a fleet list).
    private static let sharedCache: NSCache<NSURL, NSData> = {
        let cache = NSCache<NSURL, NSData>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()

    init(color: String, source: TVFaceAssetSource = .fleetLink) {
        self.color = color
        self.source = source
    }

    func setColor(_ color: String, animated: Bool) {
        guard color != self.color else { return }
        self.color = color
        // Force replay of current expression under the new skin.  This is the
        // only replay: the view must not call play again after this, or the
        // second call cancels the enter step just scheduled.
        let expr = previous
        previous = .resting
        play(expression: expr, animated: animated)
    }

    func play(state: BotState, animated: Bool) {
        play(expression: TVFaceManifest.expression(for: state), animated: animated)
    }

    func play(expression next: TVFaceExpression, animated: Bool) {
        task?.cancel()
        failed = false
        if !animated {
            expressionLabel = next.rawValue
            task = Task { await show(expression: next, kind: .still) }
            return
        }
        // `previous` is the last expression actually RENDERED (advanced in
        // show() on success), not merely planned: recording a face whose
        // fetch never completed would plan the next transition from a state
        // the user never saw.
        let steps = TVFacePlanner.plan(from: previous, to: next)
        task = Task { [weak self] in
            guard let self else { return }
            for step in steps {
                if Task.isCancelled { return }
                await self.show(expression: step.expression, kind: step.kind)
                if Task.isCancelled { return }
                self.expressionLabel = step.expression.rawValue
                if step.delayAfterMs > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(step.delayAfterMs) * 1_000_000)
                }
            }
        }
    }

    private func cachedData(for url: URL) -> Data? {
        Self.sharedCache.object(forKey: url as NSURL) as Data?
    }

    /// Recently-missed URLs (true 404s).  Transient failures are never
    /// negative-cached, and entries expire so regenerated packs are retried.
    private static let negativeCache = NSCache<NSURL, NSDate>()
    private static let negativeCacheTTL: TimeInterval = 300

    private func recentlyMissed(_ url: URL) -> Bool {
        guard let when = Self.negativeCache.object(forKey: url as NSURL) as Date? else { return false }
        return Date().timeIntervalSince(when) < Self.negativeCacheTTL
    }

    private func markMissed(_ url: URL) {
        Self.negativeCache.setObject(NSDate(), forKey: url as NSURL)
    }

    private func storeCache(url: URL, data: Data) {
        Self.sharedCache.setObject(data as NSData, forKey: url as NSURL, cost: data.count)
    }

    /// Puts frame bytes on screen.  Any successful frame clears `failed`, so
    /// one bad fetch can never pin the fallback mascot over a good image.
    /// `rendered` advances `previous`; nil leaves it as it was.
    private func render(_ data: Data, as rendered: TVFaceExpression?) {
        imageData = data
        failed = false
        if let rendered { previous = rendered }
    }

    private func show(expression: TVFaceExpression, kind: TVFaceFrameKind) async {
        let url = source.url(color: color, expression: expression, kind: kind == .still ? .still : kind)
        if let cached = cachedData(for: url) {
            render(cached, as: nil)
            return
        }
        // Fallback chain: requested → still of same expression → resting still.
        // A negative entry means the pack has no such asset (or it failed
        // recently): go straight to the fallback instead of re-issuing a
        // guaranteed 404, and never alias fallback bytes under the missing
        // GIF URL (a 5xx/timeout while the small still succeeds would
        // otherwise pin the wrong bytes process-wide).
        var primaryFailed = false
        if !recentlyMissed(url) {
            let result = await fetch(url)
            // A play() that superseded this one cancelled us: its task owns
            // the view now, so a late result (or URLSession's cancellation
            // error) must not touch imageData, previous or failed.
            if Task.isCancelled { return }
            switch result {
            case .hit(let data):
                storeCache(url: url, data: data)
                render(data, as: expression)
                return
            case .missing:
                markMissed(url)
            case .failed:
                primaryFailed = true
            }
        }
        let still = source.url(color: color, expression: expression, kind: .still)
        if let cached = cachedData(for: still) {
            render(cached, as: expression)
            return
        }
        var stillFailed = false
        if !recentlyMissed(still) {
            let result = await fetch(still)
            if Task.isCancelled { return }
            switch result {
            case .hit(let data):
                storeCache(url: still, data: data)
                render(data, as: expression)
                return
            case .missing:
                markMissed(still)
            case .failed:
                stillFailed = true
            }
        }
        // Both fetches failing means we are offline or the CDN is down;
        // trying the resting still would just burn another timeout.
        if primaryFailed && stillFailed {
            if Task.isCancelled { return }
            failed = true
            return
        }
        let rest = source.url(color: color, expression: .resting, kind: .still)
        if let cached = cachedData(for: rest) {
            render(cached, as: .resting)
            return
        }
        if !recentlyMissed(rest) {
            let result = await fetch(rest)
            if Task.isCancelled { return }
            if case .hit(let data) = result {
                storeCache(url: rest, data: data)
                render(data, as: .resting)
                return
            }
        }
        // Every fallback exhausted: surface the failure so the view can
        // render the deterministic mascot instead of spinning forever.
        failed = true
    }

    private func fetch(_ url: URL) async -> TVFaceFetchResult {
        if url.isFileURL {
            if let data = try? Data(contentsOf: url) { return .hit(data) }
            return .missing
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("GrokBot-iOS-TVFace/1.0", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failed }
            if http.statusCode == 404 { return .missing }
            guard (200..<300).contains(http.statusCode) else { return .failed }
            return .hit(data)
        } catch {
            return .failed
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
            if player.failed {
                // The deterministic mascot is the documented fallback for
                // undeliverable identity art (offline, CDN unreachable):
                // "identity never becomes an empty placeholder".
                BotMascot(color: color, size: size, state: state, animated: animated)
            } else if let data = player.imageData {
                // Avatars render well under 200pt; decode thumbnails at the
                // actual display size (@3x) instead of every 480x480 frame.
                AnimatedGIFView(data: data, maxPixelSize: max(1, Int(size * 3)))
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
        .onChange(of: color) { _, new in player.setColor(new, animated: animated) }
        .onChange(of: animated) { _, new in player.play(state: state, animated: new) }
    }
}
