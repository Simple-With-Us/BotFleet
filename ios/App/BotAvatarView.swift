import SwiftUI
import UIKit
import CompanionCore

/// An agent identity image fetched from the paired computer with the device
/// bearer token. The mascot is deterministic fallback for missing, stale, or
/// undecodable attachments, so identity never becomes an empty placeholder.
/// Bot identity image with the model-provider mark at the lower-right corner.
/// Use this anywhere a lone `BotAvatarView` would need `.providerBadge` so
/// position, scale, and the unknown-engine empty state stay consistent.
struct BotAvatarWithProviderBadge: View {
    let bot: Bot
    /// When the avatar sits in a task (or other) thread, pass that thread id
    /// so the mark follows the task override instead of the bot's primary id.
    var conversationThreadId: String? = nil
    let size: CGFloat
    var state: BotState = .idle
    var animated = false
    var comets = false

    var body: some View {
        BotAvatarView(bot: bot, size: size, state: state, animated: animated, comets: comets)
            .providerBadge(for: bot, inThread: conversationThreadId, avatarSize: size)
    }
}

struct BotAvatarView: View {
    let bot: Bot
    let size: CGFloat
    var state: BotState = .idle
    /// Opt-in, mirroring BotMascot: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    @EnvironmentObject private var session: Session
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { bot.avatarCrop ?? .mascot }
    private var usesImage: Bool { crop != .mascot && crop != .tvface && bot.avatarUrl != nil && !failed }
    private var usesTVFace: Bool { crop == .tvface }

    var body: some View {
        Group {
            if usesTVFace {
                TVFaceAvatar(color: bot.color, state: state, size: size, animated: animated)
            } else if usesImage, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(mask)
            } else {
                BotMascot(color: bot.color, size: size, state: state, animated: animated, comets: comets)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(bot.name) avatar")
        .task(id: "\(bot.avatarUrl ?? "")|\(crop.rawValue)") {
            image = nil
            failed = false
            guard crop != .mascot, crop != .tvface, bot.avatarUrl != nil else { return }
            let data = await session.avatarData(forPath: bot.avatarUrl)
            guard !Task.isCancelled else { return }
            guard let data, let decoded = BotAvatarView.cachedImage(for: data) else {
                failed = true
                return
            }
            guard !Task.isCancelled else { return }
            image = decoded
        }
    }

    private static let avatarImageCache = NSCache<NSData, UIImage>()

    /// Cached decoded UIImage lookup to prevent synchronous PNG re-decoding on @MainActor.  Avoids repeated main-thread decompression across SwiftUI view body updates.
    static func cachedImage(for data: Data) -> UIImage? {
        let key = data as NSData
        if let cached = avatarImageCache.object(forKey: key) {
            return cached
        }
        guard let decoded = UIImage(data: data) else { return nil }
        avatarImageCache.setObject(decoded, forKey: key)
        return decoded
    }

    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .mascot, .tvface: AnyShape(Rectangle())
        }
    }
}

struct RoomAvatarView: View {
    let room: Room
    let size: CGFloat
    var state: BotState = .idle
    var animated = false
    var comets = false

    @EnvironmentObject private var session: Session
    @State private var image: UIImage?
    @State private var failed = false

    private var crop: AvatarCrop { room.avatarCrop ?? .rounded }
    
    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .mascot, .tvface: AnyShape(Rectangle())
        }
    }

    var body: some View {
        Group {
            if room.avatarUrl != nil, !failed, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(mask)
            } else {
                BotMascot(color: "blue", size: size, state: state, animated: animated, comets: comets)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(room.name) avatar")
        .task(id: "\(room.avatarUrl ?? "")|\(crop.rawValue)") {
            image = nil
            failed = false
            guard room.avatarUrl != nil else { return }
            let data = await session.avatarData(forPath: room.avatarUrl)
            guard !Task.isCancelled else { return }
            guard let data, let decoded = BotAvatarView.cachedImage(for: data) else {
                failed = true
                return
            }
            guard !Task.isCancelled else { return }
            image = decoded
        }
    }
}

struct ChatAvatarView: View {
    let chat: Chat
    let size: CGFloat
    var state: BotState = .idle
    /// Opt-in, mirroring BotMascot: an animated face is a 30fps canvas.
    var animated = false
    var comets = false

    var body: some View {
        switch chat {
        case let .bot(bot):
            BotAvatarView(bot: bot, size: size, state: state, animated: animated, comets: comets)
        case let .room(room):
            RoomAvatarView(room: room, size: size, state: state, animated: animated, comets: comets)
        }
    }
}
