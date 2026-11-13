import SwiftUI
import CompanionCore

public struct AgentThoughtChamberView: View {
    public let reasoning: String
    public let botName: String
    public let mascotColor: Color
    public let isStreaming: Bool
    
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isExpanded: Bool = false
    
    public init(
        reasoning: String,
        botName: String = "Bot",
        mascotColor: Color = .purple,
        isStreaming: Bool = false
    ) {
        self.reasoning = reasoning
        self.botName = botName
        self.mascotColor = mascotColor
        self.isStreaming = isStreaming
    }
    
    private var steps: [String] {
        reasoning.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        VStack(alignment: .leading, spacing: 6) {
            headerButton(isDark: isDark)
            
            if isExpanded {
                expandedContent(isDark: isDark)
            }
        }
        .padding(6)
        // The one material the chrome is made of (Glass.swift). The card used
        // to stack a gradient under a second material, and two translucent
        // layers over each other read as mud. The accent stroke and the
        // shadow stay — they are what make this a thought card rather than a
        // pane of glass.
        .glassRounded(cornerRadius: 12, interactive: false)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isDark ? mascotColor.opacity(0.3) : Color.black.opacity(0.08), lineWidth: 0.65)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.25 : 0.04), radius: 3, y: 1)
    }
    
    @ViewBuilder
    private func headerButton(isDark: Bool) -> some View {
        Button {
            withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.72)) {
                isExpanded.toggle()
            }
            Haptics.selection()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "brain.head.profile")
                    .font(.scaled(11, weight: .bold, relativeTo: .caption2))
                    .foregroundColor(mascotColor)

                Text(isStreaming ? "Thinking…" : "Thought Process")
                    .font(.caption2.weight(.bold))
                    .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#334155"))

                if isStreaming {
                    Circle()
                        .fill(mascotColor)
                        .frame(width: 6, height: 6)
                        // The pulse repeats forever while a thought streams,
                        // and never stopping is exactly what Reduce Motion is
                        // for. The dot still appears; it just holds still.
                        .symbolEffect(.pulse, options: .repeating, isActive: isStreaming && !reduceMotion)
                }

                Spacer()

                Text("\(steps.count) \(steps.count == 1 ? "step" : "steps")")
                    .font(.scaled(9.5, weight: .medium, design: .monospaced, relativeTo: .caption2))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))

                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.scaled(9, weight: .bold, relativeTo: .caption2))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        // The chevron is the only thing that says whether the steps are
        // showing, and a picture of a chevron is not an announcement.
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }
    
    @ViewBuilder
    private func expandedContent(isDark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                        stepRow(index: idx, step: step, isDark: isDark)
                    }
                }
            }
            .frame(maxHeight: 160)
        }
        .padding(10)
        .background(isDark ? Color.black.opacity(0.35) : Color.white.opacity(0.85))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(isDark ? Color.white.opacity(0.06) : Color.black.opacity(0.06), lineWidth: 0.5)
        )
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
    
    @ViewBuilder
    private func stepRow(index: Int, step: String, isDark: Bool) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(String(index + 1) + ".")
                .font(.scaled(10, weight: .bold, design: .monospaced, relativeTo: .caption2))
                .foregroundColor(mascotColor)
            
            Text(step)
                .font(.caption2)
                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
