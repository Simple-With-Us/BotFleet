// Times the code-block string SwiftUI actually measures.
//
// BOTFLEET-Y hangs in StyledTextLayoutEngine.sizeThatFits → boundingRect
// on one fence.  This probe measures that cost for a 3,000-line mixed-script
// block and for the single page CodeBlockWindow hands to Text.
//
// Run on a Mac, from the repo root:
//
//   swift run --package-path ios CodeBlockLayoutProbe
//
// The package build links macOS SwiftUI (AppKit).  That is a proxy for the
// iOS engine on the Sentry stack.  The numbers are still the right shape:
// the capped page must stay well under the 2s App Hang threshold, and it
// must be cheaper than the full fence when the full fence is slow enough
// to time.  A Linux host cannot link SwiftUI and exits 2.
import Foundation
import CompanionCore
#if canImport(Glibc)
import Glibc
#endif

#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
#endif

@main
enum CodeBlockLayoutProbe {
    static func main() {
        #if canImport(SwiftUI) && os(macOS)
        MacProbe.run()
        #else
        fputs(
            "CodeBlockLayoutProbe measures SwiftUI Text on macOS.  This host cannot link SwiftUI.\n",
            stderr
        )
        exit(2)
        #endif
    }
}

#if canImport(SwiftUI) && os(macOS)
enum MacProbe {
    static func run() {
        let full = mixedScriptBlock(lines: 3_000)
        let page = CodeBlockWindow.preview(full, anchorToEnd: false)
        guard page.text.count <= CodeBlockWindow.maxCharacters else {
            fputs("capped page exceeded the character budget\n", stderr)
            exit(1)
        }
        guard renderedLines(page.text) <= CodeBlockWindow.maxLines else {
            fputs("capped page exceeded the line budget\n", stderr)
            exit(1)
        }

        let fullBounds = sample { boundingRectMillis(full) }
        let pageBounds = sample { boundingRectMillis(page.text) }
        let fullHost = sample { hostingMillis(full) }
        let pageHost = sample { hostingMillis(page.text) }

        print("fixture: 3000 mixed-script lines, \(full.count) characters")
        print("page: lines \(page.startLine)–\(page.endLine) of \(page.totalLines), \(page.text.count) characters")
        print(String(format: "NSAttributedString.boundingRect full median %.1f ms", fullBounds))
        print(String(format: "NSAttributedString.boundingRect page median %.1f ms", pageBounds))
        print(String(format: "SwiftUI Text hosting full median %.1f ms", fullHost))
        print(String(format: "SwiftUI Text hosting page median %.1f ms", pageHost))
        print("host: macOS AppKit SwiftUI.  iOS StyledTextLayoutEngine is the hang; this is the same Text, font, and horizontal ScrollView on the Mac SDK.")

        // 250 ms is far under the 2s App Hang and above the #626 per-line
        // extrapolation (200/3000 of a 0.89s mixed block is about 60 ms).
        if pageBounds > 250 || pageHost > 250 {
            fputs("capped page layout exceeded 250 ms\n", stderr)
            exit(1)
        }
        if fullBounds > 150, pageBounds * 3 >= fullBounds {
            fputs("capped page was not at least 3x faster than the full fence\n", stderr)
            exit(1)
        }
    }

    static func sample(_ measure: () -> Double) -> Double {
        _ = measure()
        let values = (0..<5).map { _ in measure() }.sorted()
        return values[values.count / 2]
    }

    static func boundingRectMillis(_ string: String) -> Double {
        let font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        let attributed = NSAttributedString(string: string, attributes: [.font: font])
        let size = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        let started = CFAbsoluteTimeGetCurrent()
        _ = attributed.boundingRect(with: size, options: [.usesLineFragmentOrigin])
        return (CFAbsoluteTimeGetCurrent() - started) * 1_000
    }

    static func hostingMillis(_ string: String) -> Double {
        let root = ScrollView(.horizontal, showsIndicators: false) {
            Text(string)
                .font(.system(size: 14, design: .monospaced))
                .textSelection(.enabled)
        }
        .frame(width: 390)
        let host = NSHostingView(rootView: root)
        host.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        let started = CFAbsoluteTimeGetCurrent()
        _ = host.fittingSize
        return (CFAbsoluteTimeGetCurrent() - started) * 1_000
    }

    static func mixedScriptBlock(lines: Int) -> String {
        (1...lines).map { index in
            "func 值\(index)() -> String { \"مرحبا \(index)\" } // 😀 ┃"
        }.joined(separator: "\n")
    }

    static func renderedLines(_ text: String) -> Int {
        if text.isEmpty { return 0 }
        var count = 1
        for character in text where character == "\n" { count += 1 }
        if text.hasSuffix("\n") { count -= 1 }
        return max(count, 1)
    }
}
#endif
