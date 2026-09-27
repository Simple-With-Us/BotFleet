// The widget extension: the bot's Live Activity, in the Dynamic Island and
// on the lock screen. The face is the mascot engine's resting face for the
// state — the system renders a snapshot, so it cannot move here, but it
// changes with every update.
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct BotFleetWidgets: WidgetBundle {
    var body: some Widget {
        BotActivityWidget()
    }
}

struct BotActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BotActivityAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(chatURL(context))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    OrbitingFace(context: context, size: 68)
                        .padding(.leading, 2)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.headline)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                        Text(context.state.line)
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.7))
                            .lineLimit(2)
                        // the one clock iOS keeps ticking for us
                        Text(timerInterval: context.state.since...context.state.since.addingTimeInterval(86_400), countsDown: false)
                            .font(.system(size: 12, weight: .medium).monospacedDigit())
                            .foregroundStyle(.white.opacity(0.5))
                    }
                    .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if context.state.kind == "needsYou", let requestId = context.state.requestId, !context.state.options.isEmpty {
                        AnswerButtons(context: context, requestId: requestId)
                            .padding(.top, 4)
                    }
                }
            } compactLeading: {
                OrbitingFace(context: context, size: 22)
            } compactTrailing: {
                compactTrailing(context)
            } minimal: {
                OrbitingFace(context: context, size: 20)
            }
            .keylineTint(BotPalette.color(context.attributes.color))
            .widgetURL(chatURL(context))
        }
    }

    private func chatURL(_ context: ActivityViewContext<BotActivityAttributes>) -> URL? {
        var components = URLComponents()
        components.scheme = "botfleet"
        components.host = "chat"
        components.queryItems = [
            URLQueryItem(name: "bot", value: context.attributes.botId),
            URLQueryItem(name: "thread", value: context.attributes.threadId),
        ]
        return components.url
    }

    @ViewBuilder
    private func compactTrailing(_ context: ActivityViewContext<BotActivityAttributes>) -> some View {
        switch context.state.kind {
        case "needsYou":
            Image(systemName: "hand.raised.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(BotPalette.color(context.attributes.color))
        case "working":
            Image(systemName: "circle.dotted")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.8))
        case "toReview":
            Circle()
                .fill(BotPalette.color(context.attributes.color))
                .frame(width: 8, height: 8)
        default:
            Circle().fill(BotPalette.color(context.attributes.color)).frame(width: 8, height: 8)
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<BotActivityAttributes>

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            OrbitingFace(context: context, size: 60)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if context.state.kind == "needsYou" {
                        Image(systemName: "hand.raised.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(BotPalette.color(context.attributes.color))
                    }
                    Text(context.state.headline)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                }
                Text(context.state.line)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(2)
                if context.state.kind == "needsYou", let requestId = context.state.requestId, !context.state.options.isEmpty {
                    AnswerButtons(context: context, requestId: requestId)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }
}

/// The card's options, as pills — exactly the options the card offered.
private struct AnswerButtons: View {
    let context: ActivityViewContext<BotActivityAttributes>
    let requestId: String

    var body: some View {
        HStack(spacing: 8) {
            ForEach(context.state.options, id: \.self) { option in
                Button(intent: AnswerApprovalIntent(
                    threadId: context.attributes.threadId,
                    requestId: requestId,
                    choice: option,
                    isPermission: context.state.isPermission
                )) {
                    Text(option)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .background(
                            Capsule().fill(
                                option.caseInsensitiveCompare("Deny") == .orderedSame
                                    ? Color.white.opacity(0.16)
                                    : BotPalette.color(context.attributes.color)
                            )
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// The face with comets around it and a rainbow ring filling up behind it.
/// The system renders a snapshot, so the comets are a frame — a different
/// one each update — and the ring is a timer-driven `ProgressView`, which is
/// the one kind of motion iOS keeps animating in a Live Activity on its own.
private struct OrbitingFace: View {
    let context: ActivityViewContext<BotActivityAttributes>
    let size: CGFloat

    var body: some View {
        ZStack {
            ProgressView(timerInterval: context.state.since...context.state.since.addingTimeInterval(60), countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
                .progressViewStyle(.circular)
                .tint(AngularGradient(colors: [
                    Color(hex: "#A855F7"), Color(hex: "#38BDF8"), Color(hex: "#34D399"),
                    Color(hex: "#FACC15"), Color(hex: "#FB923C"), Color(hex: "#F43F5E"), Color(hex: "#A855F7"),
                ], center: .center))
                .frame(width: size + 4, height: size + 4)
            BotFaceStill(color: context.attributes.color, state: BotState(rawValue: context.state.face) ?? .idle, size: size, comets: true, at: Date())
        }
    }
}
