// Type that grows with Dynamic Type without moving at its default size.
//
// `Font.system(size:)` pins the size: the text renders at that number of
// points at every accessibility size, which is why a bot reply stayed 17pt
// all the way up to AX5 while the rest of the app scaled around it.
// `Font.custom(_:relativeTo:)` scales the system font, but it cannot keep a
// weight or a monospaced design, and most of what needed scaling here is
// monospaced. `UIFontMetrics` keeps every attribute and scales only the size.
//
// Every initializer below returns exactly `size` while Dynamic Type is at its
// default — that is when a `UIFont.TextStyle` scale factor is 1.0 — so
// swapping one in is a visual no-op until the reader turns text size up.
import SwiftUI
import UIKit

extension Font {
    /// `size` points when Dynamic Type is at its default, growing with
    /// `relativeTo` past that.
    static func scaled(
        _ size: CGFloat,
        weight: Weight = .regular,
        design: Design = .default,
        relativeTo style: TextStyle
    ) -> Font {
        // `.systemFont(ofSize:weight:design:)` is gone in this SDK — its third
        // parameter is a width now — so the design is applied through the
        // descriptor. The plain case skips that round trip entirely.
        let base = UIFont.systemFont(ofSize: size, weight: weight.uiKitWeight)
        let font = design == .default ? base
            : base.fontDescriptor.withDesign(design.uiKitDesign).map { UIFont(descriptor: $0, size: size) } ?? base
        // Unlabeled: this SDK has no `Font(uiFont:)`, the UIFont goes in
        // directly.
        return Font(UIFontMetrics(forTextStyle: style.uiKitStyle).scaledFont(for: font))
    }
}

private extension Font.TextStyle {
    // SwiftUI folds `.title`/`.caption` into UIKit's `_1`/`_2` families.
    var uiKitStyle: UIFont.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .body: return .body
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        @unknown default: return .body
        }
    }
}

private extension Font.Weight {
    var uiKitWeight: UIFont.Weight {
        switch self {
        case .ultraLight: return .ultraLight
        case .thin: return .thin
        case .light: return .light
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        case .heavy: return .heavy
        case .black: return .black
        default: return .regular
        }
    }
}

private extension Font.Design {
    var uiKitDesign: UIFontDescriptor.SystemDesign {
        switch self {
        case .serif: return .serif
        case .rounded: return .rounded
        case .monospaced: return .monospaced
        default: return .default
        }
    }
}