#if DEBUG
// Deterministic simulator screenshot surface for TV-Face crop wiring.
// Launched with `-tvface-preview`; CI captures via scripts/ios-tvface-screenshot.sh.
import SwiftUI
import CompanionCore

struct TVFacePreviewHarness: View {
    var body: some View {
        NavigationStack {
            List {
                Section("TV-Face · white") {
                    HStack(spacing: 16) {
                        TVFaceAvatar(color: "white", state: .fleet, size: 72, animated: false)
                        Text("fleet still")
                    }
                }
                Section("TV-Face · black") {
                    HStack(spacing: 16) {
                        TVFaceAvatar(color: "black", state: .git, size: 72, animated: false)
                        Text("git still")
                    }
                }
            }
            .navigationTitle("TV-Face Preview")
        }
    }
}
#endif
