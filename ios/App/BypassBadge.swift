import SwiftUI

/// The small, persistent mark on a bot that has Bypass Permissions on, so a bot
/// that will not stop to ask is never one you have forgotten about.  The desktop
/// shows its "Bypass Active" pill on the pending approval; the phone has no such
/// panel to hang it on, so it sits beside the name in the chat header.
///
/// Decoration for the eye only: the header's identity button carries the words
/// for VoiceOver (`ChatView.headerProfileAccessibilityLabel`), so this hides
/// itself from the accessibility tree rather than being read twice.
struct BypassBadge: View {
    var body: some View {
        Text("Bypass")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(Color.orange)
            .lineLimit(1)
            // One short word.  Squeezed next to a bot name it used to wrap to
            // "Bypa / ss" in two lines, which read as a rendering fault rather
            // than a permission state.  fixedSize keeps it whole and lets the
            // name next to it absorb the squeeze instead.
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(Color.orange.opacity(0.16)))
            .accessibilityHidden(true)
    }
}
