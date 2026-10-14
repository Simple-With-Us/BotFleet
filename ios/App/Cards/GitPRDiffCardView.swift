import SwiftUI

public struct GitPRDiffCardView: View {
    public let filename: String
    public let diffText: String
    public let additions: Int
    public let deletions: Int
    
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showDiff: Bool = true
    @State private var showAllLines: Bool = false

    private var lines: [String] { diffText.components(separatedBy: "\n") }
    private var visibleLines: ArraySlice<String> {
        lines.prefix(showAllLines ? lines.count : 80)
    }
    
    public init(
        filename: String = "Changes",
        diffText: String,
        additions: Int = 0,
        deletions: Int = 0
    ) {
        self.filename = filename
        self.diffText = diffText
        
        if additions == 0 && deletions == 0 {
            let lines = diffText.components(separatedBy: "\n")
            self.additions = lines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
            self.deletions = lines.filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
        } else {
            self.additions = additions
            self.deletions = deletions
        }
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.pull")
                    .font(.scaled(12, weight: .bold, relativeTo: .caption))
                    .foregroundColor(Color(hex: "#22C55E"))
                
                Text(filename)
                    .font(.caption.weight(.bold))
                    .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                    .lineLimit(1)
                
                Spacer()
                
                // Diff Delta (+ / -)
                HStack(spacing: 4) {
                    Text("+\(additions)")
                        .font(.scaled(10.5, weight: .bold, design: .monospaced, relativeTo: .caption))
                        .foregroundColor(Color(hex: "#22C55E"))
                    Text("-\(deletions)")
                        .font(.scaled(10.5, weight: .bold, design: .monospaced, relativeTo: .caption))
                        .foregroundColor(Color(hex: "#EF4444"))
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2.5)
                .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                .clipShape(Capsule())
            }
            
            // Diff Content
            if !diffText.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.7)) {
                            showDiff.toggle()
                        }
                        Haptics.selection()
                    } label: {
                        HStack {
                            Image(systemName: showDiff ? "chevron.down" : "chevron.right")
                                .font(.scaled(9, weight: .bold, relativeTo: .caption2))
                            Text(showDiff ? "Hide Diff" : "View Diff")
                                .font(.caption2.weight(.semibold))
                            Spacer()
                        }
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                        .padding(.vertical, 2)
                    }
                    .buttonStyle(.plain)
                    // "View Diff" says nothing about the state it put the card
                    // in; the arrow beside it is a picture, not an answer.
                    .accessibilityValue(showDiff ? "Expanded" : "Collapsed")
                    
                    if showDiff {
                        ScrollView(.horizontal, showsIndicators: false) {
                            VStack(alignment: .leading, spacing: 1) {
                                ForEach(Array(visibleLines.enumerated()), id: \.offset) { _, line in
                                    diffLineView(line, isDark: isDark)
                                }
                            }
                            .padding(6)
                        }
                        .background(isDark ? Color.black.opacity(0.55) : Color(hex: "#0F172A"))
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .transition(.opacity.combined(with: .move(edge: .top)))

                        if lines.count > 80 {
                            Button(showAllLines ? "Show first 80 lines" : "Show all \(lines.count) lines") {
                                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { showAllLines.toggle() }
                                Haptics.selection()
                            }
                            .font(.caption2.weight(.semibold))
                            .buttonStyle(.plain)
                            .accessibilityHint("The copied diff always includes every line")
                        }
                    }
                }
            }
            
            Divider().background(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08))
            
            // Footer Actions
            HStack(spacing: 8) {
                Button {
                    PlatformBridge.copyToPasteboard(diffText)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "doc.on.doc")
                        Text("Copy Diff")
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                }
                .buttonStyle(.plain)
                
                Spacer()
            }
        }
        .padding(10)
        // The one material the chrome is made of (Glass.swift), replacing a
        // gradient stacked under a second material. The hairline stroke and
        // the shadow stay, because the diff panel underneath is dark in both
        // appearances and needs that edge to read as a well.
        .glassRounded(cornerRadius: 12, interactive: false)
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08), lineWidth: 0.75)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.20 : 0.04), radius: 4, y: 1.5)
    }
    
    @ViewBuilder
    private func diffLineView(_ line: String, isDark: Bool) -> some View {
        let isAddition = line.hasPrefix("+") && !line.hasPrefix("+++")
        let isDeletion = line.hasPrefix("-") && !line.hasPrefix("---")
        let isHeader = line.hasPrefix("@@") || line.hasPrefix("diff")
        
        Text(line)
            .font(.scaled(10, design: .monospaced, relativeTo: .caption2))
            .foregroundColor(
                isAddition ? Color(hex: "#4ADE80") :
                isDeletion ? Color(hex: "#F87171") :
                isHeader ? Color(hex: "#38BDF8") :
                Color(hex: "#E2E8F0")
            )
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(
                isAddition ? Color(hex: "#22C55E").opacity(0.15) :
                isDeletion ? Color(hex: "#EF4444").opacity(0.15) :
                Color.clear
            )
            .clipShape(RoundedRectangle(cornerRadius: 2))
    }
}
