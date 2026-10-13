import SwiftUI

/// One tool call: what it was, how it went, and — when you open it — what it
/// was given and what it said back.
///
/// Sizes are semantic styles, not bare `.system(size:)`. The fixed sizes this
/// replaced (8.5pt and 9.5pt for the labels and the command) did not move at
/// all when the reader changed their text size, so the one card that carries a
/// raw command was the one card they could not read larger. The base sizes are
/// also raised: even at the default setting, 9.5pt is below what iOS considers
/// a legible control label.
///
/// Colour is semantic throughout — `secondary`, `systemBackground`, and
/// state colours that carry their own meaning — so the card is correct in
/// light and dark without a second set of hand-picked hexes drifting apart
/// from the system palette.
public struct SkillExecutionReceiptView: View {
    public let skillName: String
    public let status: String // "running", "success", "error"
    public let durationMs: Int
    public let parameters: String
    public let output: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded: Bool = false

    public init(
        skillName: String,
        status: String = "success",
        durationMs: Int = 0,
        parameters: String = "",
        output: String = ""
    ) {
        self.skillName = skillName
        self.status = status
        self.durationMs = durationMs
        self.parameters = parameters
        self.output = output
    }

    /// The three states a tool call can be in, as one shape.  Derived from
    /// the same `status` string the transcript carries, so a card cannot say
    /// "Running" in its badge and draw itself as a failure.
    private enum State {
        case running, success, failure

        init(_ raw: String) {
            switch raw {
            case "running": self = .running
            case "error": self = .failure
            default: self = .success
            }
        }

        var label: String {
            switch self {
            case .running: return "Running"
            case .success: return "Done"
            case .failure: return "Failed"
            }
        }

        var tint: Color {
            switch self {
            case .running: return .accentColor
            case .success: return .green
            case .failure: return .red
            }
        }

        var systemImage: String {
            switch self {
            case .running: return "circle.dotted"
            case .success: return "checkmark.circle.fill"
            case .failure: return "exclamationmark.triangle.fill"
            }
        }
    }

    private var state: State { State(status) }
    private var hasDetails: Bool { !parameters.isEmpty || !output.isEmpty }

    /// One sentence for the whole row.  Without it VoiceOver read the tool
    /// name, the duration and the state as three unlabelled fragments, and
    /// the badge dot carried nothing at all.
    private var accessibilityText: String {
        var parts = [skillName, state.label]
        if durationMs > 0 { parts.append("\(durationMs) milliseconds") }
        parts.append(isExpanded ? "Details open" : "Details closed")
        return parts.joined(separator: ", ")
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard hasDetails else { return }
                withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.75)) {
                    isExpanded.toggle()
                }
                Haptics.selection()
            } label: {
                // Two shapes, and `ViewThatFits` takes the first that fits.
                // At a large text size the one-row shape squeezes the name
                // and then the status badge — and a badge reading "Fa…" is
                // not a status.  Neither the badge nor the duration is ever
                // allowed to compress; the second shape gives the name its
                // own line instead.
                ViewThatFits(in: .horizontal) {
                    receiptRow(compact: true)
                    receiptRow(compact: false)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(minHeight: 34)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemBackground))
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasDetails)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityHint(hasDetails ? "Double tap to \(isExpanded ? "hide" : "show") the command and its output" : "")

            if !parameters.isEmpty, !isExpanded {
                // The command is the reason a person opens this card, so it
                // shows without one — a card you have to expand to learn
                // what ran is a card most people never expand.
                Text(parameters)
                    .font(.scaled(12, design: .monospaced, relativeTo: .caption))
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 10)
            }

            if isExpanded && hasDetails {
                VStack(alignment: .leading, spacing: 10) {
                    if !parameters.isEmpty {
                        detailSection(title: "Input", value: parameters, tint: Color.secondary)
                    }
                    if !output.isEmpty {
                        detailSection(
                            title: state == .failure ? "Error" : "Output",
                            value: output,
                            tint: state == .failure ? .red : .primary
                        )
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color(uiColor: .tertiarySystemBackground))
                )
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(uiColor: .secondarySystemBackground).opacity(0.55))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(borderTint, lineWidth: 1)
        )
    }

    /// Only a failure earns a coloured edge.  A run that succeeded or is still
    /// running gets a neutral one, so a transcript full of completed tool
    /// calls does not read as a wall of alerts.
    private var borderTint: Color {
        switch state {
        case .failure: return .red.opacity(0.4)
        case .running: return .accentColor.opacity(0.35)
        case .success: return Color.secondary.opacity(0.18)
        }
    }

    private func detailSection(title: String, value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.scaled(11, weight: .bold, relativeTo: .caption2))
                .tracking(0.5)
                .foregroundStyle(Color.secondary)
            Text(value)
                .font(.scaled(13, design: .monospaced, relativeTo: .footnote))
                .foregroundStyle(tint)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// `compact` puts the state on the same line as the name; `false` gives the
/// name its own line and drops the state under it.
private func receiptRow(compact: Bool) -> some View {
    let name = Text(skillName)
        .font(.scaled(15, weight: .semibold, relativeTo: .subheadline))
        .foregroundStyle(Color.primary)
        .lineLimit(1)

    let duration = Text("\(durationMs)ms")
        .font(.scaled(12, design: .monospaced, relativeTo: .caption))
        .foregroundStyle(Color.secondary)
        .monospacedDigit()
        .fixedSize()

    let disclosure = Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
        .font(.scaled(10, weight: .bold, relativeTo: .caption2))
        .foregroundStyle(Color.secondary)

    return Group {
        if compact {
            HStack(spacing: 8) {
                wrench
                name
                Spacer(minLength: 4)
                if durationMs > 0 { duration }
                statusBadge.fixedSize()
                if hasDetails { disclosure }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    wrench
                    name
                    Spacer(minLength: 0)
                    if hasDetails { disclosure }
                }
                HStack(spacing: 8) {
                    if durationMs > 0 { duration }
                    Spacer(minLength: 0)
                    statusBadge.fixedSize()
                }
            }
        }
    }
}

private var wrench: some View {
    Image(systemName: "wrench.and.screwdriver.fill")
        .font(.scaled(12, weight: .semibold, relativeTo: .caption))
        .foregroundStyle(Color.secondary)
}

private var statusBadge: some View {
        HStack(spacing: 4) {
            if state == .running {
                ProgressView()
                    .controlSize(.mini)
                    .tint(state.tint)
            } else {
                Image(systemName: state.systemImage)
                    .font(.scaled(11, weight: .bold, relativeTo: .caption))
                    .foregroundStyle(state.tint)
            }
            Text(state.label)
                .font(.scaled(12, weight: .semibold, relativeTo: .caption))
                .foregroundStyle(state.tint)
        }
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(Capsule().fill(state.tint.opacity(0.14)))
        .accessibilityHidden(true)
    }
}