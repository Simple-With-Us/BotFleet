import CompanionCore
import SwiftUI

public struct ActionChipItem: Identifiable {
    public let id = UUID()
    public let title: String
    public let icon: String
    public let prompt: String
    
    public init(title: String, icon: String, prompt: String) {
        self.title = title
        self.icon = icon
        self.prompt = prompt
    }
}

public struct PredictiveActionChipsView: View {
    public let chips: [ActionChipItem]
    public let accentColor: Color
    public let onSelectChip: (ActionChipItem) -> Void
    
    @Environment(\.colorScheme) private var colorScheme
    
    /// Empty on purpose.  Chips that only paste a sentence are not offered.
    /// A real command belongs on the slash list, not here.
    public static let defaultChips: [ActionChipItem] = []
    
    public init(
        chips: [ActionChipItem] = PredictiveActionChipsView.defaultChips,
        accentColor: Color = .purple,
        onSelectChip: @escaping (ActionChipItem) -> Void
    ) {
        self.chips = chips
        self.accentColor = accentColor
        self.onSelectChip = onSelectChip
    }
    
    /// Drops a chip that would only paste a canned sentence, even if a caller
    /// still passes one of the old defaults.
    private var offeredChips: [ActionChipItem] {
        chips.filter { !ComposerPromptChips.isCannedSnippet(title: $0.title, prompt: $0.prompt) }
    }

    @ViewBuilder
    public var body: some View {
        let offered = offeredChips
        if offered.isEmpty {
            EmptyView()
        } else {
            chipRow(offered)
        }
    }

    private func chipRow(_ offered: [ActionChipItem]) -> some View {
        let isDark = colorScheme == .dark

        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(offered) { chip in
                    Button {
                        onSelectChip(chip)
                        Haptics.selection()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: chip.icon)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(accentColor)
                            
                            Text(chip.title)
                                .font(.caption2.weight(.semibold))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#334155"))
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4.5)
                        .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.05))
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.06), lineWidth: 0.5)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 3)
        }
    }
}
