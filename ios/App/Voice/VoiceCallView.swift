// The voice conversation screen: one call, its states, its controls.
//
// The phase enum drives everything -- the status line, which controls are
// live, and what VoiceOver announces.  A call is always in exactly one
// phase, so there is no combination of flags for the screen to misread.
//
// Controls and what they mean (they are different actions, not one button
// with moods):
//  * Mute -- the mic stops sending.  Capture keeps running so unmuting is
//    instant.  Playback is untouched.
//  * Stop -- playback stops now.  The call continues; the mic stays open.
//    For when the bot is reading something long.
//  * Interrupt -- cut playback AND hand the floor to the caller (barge-in).
//  * End -- the call is over: socket, capture and playback torn down, final
//    lines written to the chat as text continuity.
import SwiftUI
import CompanionCore

struct VoiceCallView: View {
    @ObservedObject var call: VoiceCall
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            statusHeader
            transcriptList
            controls
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(call.botName).font(.headline)
            }
        }
        .onAppear {
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-voice-fixture") {
                call.startFixture()
            } else {
                call.start()
            }
#else
            call.start()
#endif
        }
        .onDisappear { call.end() }
        .onChange(of: call.phase) { _, phase in
            if case .ended = phase {
                // A beat to read the closing line, then back to text.
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(1))
                    dismiss()
                }
            }
        }
    }

    // MARK: - Status

    private var statusHeader: some View {
        VStack(spacing: 6) {
            phaseIcon
            Text(phaseText)
                .font(.scaled(17, weight: .semibold, relativeTo: .body))
                .foregroundStyle(phaseTint)
                .accessibilityAddTraits(.isHeader)
            if let provider = call.provider {
                Text(provider == .xai ? "xAI voice" : "Gemini live")
                    .font(.scaled(13, relativeTo: .footnote))
                    .foregroundStyle(Color.secondary)
            }
        }
        .padding(.top, 24)
        .padding(.bottom, 12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Call status: \(phaseText)")
    }

    @ViewBuilder
    private var phaseIcon: some View {
        let image: some View = Image(systemName: phaseSystemImage)
            .font(.system(size: 44, weight: .regular))
            .foregroundStyle(phaseTint)
            .frame(width: 88, height: 88)
            .background(Circle().fill(phaseTint.opacity(0.12)))
        if case .thinking = call.phase, !reduceMotion {
            image.symbolEffect(.pulse, options: .repeating)
        } else if case .speaking = call.phase, !reduceMotion {
            image.symbolEffect(.variableColor.iterative)
        } else {
            image
        }
    }

    private var phaseText: String {
        switch call.phase {
        case .connecting:
            return "Connecting…"
        case .listening:
            return call.muted ? "Muted — tap to unmute" : "Listening"
        case .thinking:
            return "Thinking…"
        case .speaking:
            return "Speaking"
        case let .reconnecting(attempt):
            return "Reconnecting… (try \(attempt))"
        case let .ended(reason):
            return reason ?? "Call ended"
        case let .failed(reason, _):
            return reason
        }
    }

    private var phaseSystemImage: String {
        switch call.phase {
        case .connecting:
            return "phone.arrow.up.right"
        case .listening:
            return call.muted ? "mic.slash.fill" : "mic.fill"
        case .thinking:
            return "brain.head.profile"
        case .speaking:
            return "speaker.wave.3.fill"
        case .reconnecting:
            return "arrow.triangle.2.circlepath"
        case .ended:
            return "phone.down.fill"
        case .failed:
            return "exclamationmark.triangle.fill"
        }
    }

    private var phaseTint: Color {
        switch call.phase {
        case .connecting, .reconnecting:
            return .orange
        case .listening:
            return .green
        case .thinking:
            return .accentColor
        case .speaking:
            return .blue
        case .ended:
            return .secondary
        case .failed:
            return .red
        }
    }

    // MARK: - Transcript

    private var transcriptList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(call.lines) { line in
                        VoiceLineRow(line: line)
                            .id(line.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .onChange(of: call.lines.count) { _, _ in
                guard let last = call.lines.last else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 12) {
            if case let .failed(_, recovery) = call.phase {
                recoveryButton(recovery)
            }
            HStack(spacing: 20) {
                callButton(
                    systemImage: call.muted ? "mic.slash.fill" : "mic.fill",
                    label: call.muted ? "Unmute" : "Mute",
                    tint: call.muted ? .orange : .secondary,
                    enabled: isLive
                ) {
                    call.setMuted(!call.muted)
                }
                callButton(
                    systemImage: "stop.fill",
                    label: "Stop",
                    tint: .secondary,
                    enabled: isLive
                ) {
                    call.stopPlayback()
                }
                callButton(
                    systemImage: "phone.down.fill",
                    label: "End",
                    tint: .red,
                    prominent: true,
                    enabled: true
                ) {
                    call.end()
                }
            }
            .padding(.bottom, 8)
            Text("Interrupt: just start talking — or tap Stop, then speak.")
                .font(.scaled(12, relativeTo: .caption))
                .foregroundStyle(Color.secondary)
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 20)
        .background(Color(uiColor: .secondarySystemBackground).opacity(0.5))
    }

    private var isLive: Bool {
        switch call.phase {
        case .listening, .thinking, .speaking, .reconnecting:
            return true
        case .connecting, .ended, .failed:
            return false
        }
    }

    private func callButton(
        systemImage: String,
        label: String,
        tint: Color,
        prominent: Bool = false,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(prominent ? Color.white : tint)
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(prominent ? tint : tint.opacity(0.14)))
                Text(label)
                    .font(.scaled(12, weight: .medium, relativeTo: .caption))
                    .foregroundStyle(Color.primary)
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func recoveryButton(_ recovery: VoiceCallRecovery) -> some View {
        switch recovery {
        case .retry:
            Button("Try Again") { call.start() }
                .buttonStyle(.borderedProminent)
        case .openSettings:
            Link("Open Settings", destination: URL(string: UIApplication.openSettingsURLString)!)
                .buttonStyle(.borderedProminent)
        case .backToText:
            Button("Back to Text Chat") { dismiss() }
                .buttonStyle(.borderedProminent)
        }
    }
}

/// One transcript line: who said it, provisional lines dimmed until final.
struct VoiceLineRow: View {
    let line: StsLineView

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: line.from == .bot ? "cpu" : "person.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(line.from == .bot ? Color.accentColor : Color.secondary)
                .frame(width: 22)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(line.from == .bot ? "Bot" : "You")
                    .font(.scaled(12, weight: .semibold, relativeTo: .caption))
                    .foregroundStyle(Color.secondary)
                Text(line.text)
                    .font(.scaled(16, relativeTo: .body))
                    .foregroundStyle(Color.primary)
                    .opacity(line.final ? 1 : 0.6)
                if line.engineBypassed {
                    Text("Answered without the bot's engine")
                        .font(.scaled(12, relativeTo: .caption))
                        .foregroundStyle(Color.orange)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(uiColor: .tertiarySystemBackground))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(line.from == .bot ? "Bot" : "You")\(line.final ? "" : ", still speaking"): \(line.text)")
    }
}
