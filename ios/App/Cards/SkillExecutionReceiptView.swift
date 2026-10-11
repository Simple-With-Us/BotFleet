import SwiftUI

public struct SkillExecutionReceiptView: View {
    public let skillName: String
    public let status: String // "running", "success", "error"
    public let durationMs: Int
    public let parameters: String
    public let output: String
    
    @Environment(\.colorScheme) private var colorScheme
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
    
    public var body: some View {
        let isDark = colorScheme == .dark
        let hasDetails = !parameters.isEmpty || !output.isEmpty
        
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard hasDetails else { return }
                withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.75)) {
                    isExpanded.toggle()
                }
                Haptics.selection()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver.fill")
                        .font(.scaled(11, relativeTo: .caption2))
                        .foregroundColor(Color(hex: "#8B5CF6"))
                    
                    VStack(alignment: .leading, spacing: 1) {
                        Text(skillName)
                            .font(.caption2.weight(.bold))
                            .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                        if !parameters.isEmpty {
                            Text(parameters)
                                .font(.scaled(9.5, design: .monospaced, relativeTo: .caption2))
                                .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    
                    if durationMs > 0 {
                        Text("• \(durationMs)ms")
                            .font(.scaled(9.5, design: .monospaced, relativeTo: .caption2))
                            .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    }
                    
                    Spacer()
                    
                    statusBadge
                    
                    if hasDetails {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.scaled(9, weight: .bold, relativeTo: .caption2))
                            .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                .clipShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!hasDetails)
            // Nothing but the chevron said whether the receipt was open, and a
            // chevron is a picture. No value when there is nothing to open:
            // the button is disabled, so the state would only be noise.
            .accessibilityValue(hasDetails ? (isExpanded ? "Expanded" : "Collapsed") : "")
            
            if isExpanded && hasDetails {
                VStack(alignment: .leading, spacing: 6) {
                    if !parameters.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("COMMAND / INPUT")
                                .font(.scaled(8.5, weight: .heavy, design: .monospaced, relativeTo: .caption2))
                                .foregroundColor(Color(hex: "#8B5CF6"))
                            Text(parameters)
                                .font(.scaled(10, design: .monospaced, relativeTo: .caption2))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                                .textSelection(.enabled)
                        }
                    }
                    
                    if !output.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(status == "error" ? "ERROR" : "OUTPUT")
                                .font(.scaled(8.5, weight: .heavy, design: .monospaced, relativeTo: .caption2))
                                .foregroundColor(status == "error" ? Color.red : Color(hex: "#10B981"))
                            Text(output)
                                .font(.scaled(10, design: .monospaced, relativeTo: .caption2))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                                .lineLimit(16)
                                .textSelection(.enabled)
                        }
                    }
                }
                .padding(8)
                .background(isDark ? Color.black.opacity(0.35) : Color.white.opacity(0.85))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(6)
        // The one material the chrome is made of (Glass.swift), replacing a
        // gradient stacked under a second material. The purple stroke and the
        // shadow stay — they are the receipt's identity.
        .glassRounded(cornerRadius: 12, interactive: false)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(hex: "#8B5CF6").opacity(0.25), lineWidth: 0.65)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.20 : 0.04), radius: 3, y: 1)
    }
    
    @ViewBuilder
    private var statusBadge: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(status == "success" ? Color.green : (status == "running" ? Color.orange : Color.red))
                .frame(width: 5, height: 5)
            Text(status.capitalized)
                .font(.scaled(9, weight: .bold, relativeTo: .caption2))
                .foregroundColor(status == "success" ? Color.green : (status == "running" ? Color.orange : Color.red))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color.white.opacity(0.08))
        .clipShape(Capsule())
    }
}
