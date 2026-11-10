import SwiftUI
import UIKit
import CompanionCore

/// Multi-line composer field with a keyboard `inputAccessoryView` Hide control.
/// Grows from one line up to the 8-line cap instead of scrolling internally,
/// matching the TextField with `lineLimit(1...8)` it replaced.
struct ComposerMultilineField: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var placeholder: String
    var isEditable: Bool
    var usesKeyboardAccessory: Bool
    var onHideKeyboard: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            text: $text,
            isFocused: $isFocused,
            onHideKeyboard: onHideKeyboard
        )
    }

    func makeUIView(context: Context) -> UITextView {
        let view = ComposerTextView()
        view.backgroundColor = .clear
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textContainerInset = UIEdgeInsets(top: 11, left: 10, bottom: 11, right: 10)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        // The viewport grows to eight lines, but TextKit must lay out the
        // whole draft so overflow can actually scroll rather than truncate.
        view.textContainer.maximumNumberOfLines = 0
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        context.coordinator.textView = view
        context.coordinator.applyAccessory(to: view, enabled: usesKeyboardAccessory)
        return view
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let view = uiView as? ComposerTextView,
              let width = proposal.width, width > 0 else { return nil }
        let naturalHeight = view.fittedHeight(width: width)
        return CGSize(width: width, height: min(naturalHeight, proposal.height ?? naturalHeight))
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        context.coordinator.onHideKeyboard = onHideKeyboard
        let accessoryChanged = context.coordinator.accessoryEnabled != usesKeyboardAccessory
        context.coordinator.applyAccessory(to: uiView, enabled: usesKeyboardAccessory)
        if uiView.text != text {
            let selectedRange = uiView.selectedRange
            let contentOffset = uiView.contentOffset
            uiView.text = text
            // Reassigning text discards the selection and the scroll position,
            // so restore both (clamped to the new length) to keep the cursor
            // where the user left it during programmatic draft edits.
            let length = (text as NSString).length
            let location = min(selectedRange.location, length)
            let rangeLength = min(selectedRange.length, length - location)
            uiView.selectedRange = NSRange(location: location, length: rangeLength)
            (uiView as? ComposerTextView)?.reconcileScrollState()
            uiView.contentOffset = uiView.isScrollEnabled ? contentOffset : .zero
            (uiView as? ComposerTextView)?.ensureSelectionVisible()
        }
        // A typed edit already matches the binding. It must still reconcile
        // growth and shrinkage, independently of programmatic text assignment.
        (uiView as? ComposerTextView)?.reconcileScrollState()
        uiView.isEditable = isEditable
        uiView.isSelectable = isEditable
        // Announce the placeholder only while the draft is empty; once there is
        // typed content, a nil label lets VoiceOver read the text itself.
        uiView.accessibilityLabel = text.isEmpty ? placeholder : nil
        // Reconcile first-responder state unconditionally: when editing is
        // disabled (dictation hand-off), a lingering first responder would
        // leave a stale isFocused binding behind.
        if isFocused, isEditable, !uiView.isFirstResponder {
            uiView.becomeFirstResponder()
        } else if !isFocused || !isEditable, uiView.isFirstResponder {
            uiView.resignFirstResponder()
        }
        if accessoryChanged, uiView.isFirstResponder {
            // Assigning inputAccessoryView does not refresh a visible keyboard;
            // reload so the Hide bar appears or disappears immediately.
            uiView.reloadInputViews()
        }
    }
}

/// UITextView whose intrinsic height grows with the draft, capped at the
/// 8-line maximum so a long draft expands the composer instead of scrolling
/// inside a one-line strip.
private final class ComposerTextView: UITextView {
    private var measuredText: String?
    private var measuredWidth: CGFloat = 0
    private var measuredFont: UIFont?
    private var measuredInsets: UIEdgeInsets = .zero
    private var measuredHeight: CGFloat = 44

    override func layoutSubviews() {
        super.layoutSubviews()
        // Rotation and parent resizing can cross the cap without a text edit.
        reconcileScrollState()
        // Height-only viewport changes do not require remeasurement, but can
        // hide the caret even when text and width are unchanged.
        ensureSelectionVisible()
    }

    func reconcileScrollState(width proposedWidth: CGFloat? = nil) {
        let width = proposedWidth ?? (bounds.width > 0 ? bounds.width : frame.width)
        guard width > 0, let font else { return }
        let currentText = text ?? ""
        let maxLines = 8
        guard measuredText != currentText || measuredWidth != width
            || measuredFont != font || measuredInsets != textContainerInset else { return }
        // Cache before toggling, since UIKit may request layout synchronously.
        measuredText = currentText
        measuredWidth = width
        measuredFont = font
        measuredInsets = textContainerInset
        let insets = textContainerInset.top + textContainerInset.bottom
        let minHeight = ceil(font.lineHeight + insets)
        let maxHeight = ceil(font.lineHeight * CGFloat(maxLines) + insets)
        // UITextView's scrolling fit can use the current viewport. Measure the
        // full draft independently, then restore the final scroll mode/offset.
        let savedOffset = contentOffset
        let wasScrolling = isScrollEnabled
        if wasScrolling { isScrollEnabled = false }
        let contentHeight = ceil(sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
        if wasScrolling { isScrollEnabled = true }
        contentOffset = savedOffset
        let previousHeight = measuredHeight
        measuredHeight = min(max(contentHeight, minHeight), maxHeight)
        let shouldScroll = contentHeight > maxHeight
        if isScrollEnabled != shouldScroll {
            let savedOffset = contentOffset
            isScrollEnabled = shouldScroll
            contentOffset = shouldScroll ? savedOffset : .zero
            ensureSelectionVisible()
        }
        if previousHeight != measuredHeight {
            invalidateIntrinsicContentSize()
        }
    }

    func ensureSelectionVisible() {
        guard isScrollEnabled, let selectedTextRange else { return }
        let selectionRect = selectedTextRange.isEmpty
            ? caretRect(for: selectedTextRange.start)
            : firstRect(for: selectedTextRange)
        let visibleRect = CGRect(origin: contentOffset, size: bounds.size)
        guard bounds.height > 0, !visibleRect.contains(selectionRect) else { return }
        // scrollRangeToVisible can defer to UIKit's responder/animation state.
        // Reconcile immediately, including a programmatic edit in an unfocused
        // field, using the actual laid-out caret rect and viewport.
        let top = selectionRect.minY - textContainerInset.top
        let bottom = selectionRect.maxY + textContainerInset.bottom - bounds.height
        let desiredY = selectionRect.minY < visibleRect.minY ? top : bottom
        let maxY = max(0, contentSize.height - bounds.height)
        setContentOffset(CGPoint(x: contentOffset.x, y: min(max(0, desiredY), maxY)), animated: false)
    }

    func fittedHeight(width: CGFloat) -> CGFloat {
        reconcileScrollState(width: width)
        return measuredHeight
    }

    override var intrinsicContentSize: CGSize {
        reconcileScrollState()
        return CGSize(width: UIView.noIntrinsicMetric, height: measuredHeight)
    }
}

final class Coordinator: NSObject, UITextViewDelegate {
    var text: Binding<String>
    var isFocused: Binding<Bool>
    var onHideKeyboard: () -> Void
    weak var textView: UITextView?
    private var accessoryView: ComposerKeyboardAccessoryView?
    private(set) var accessoryEnabled = false

    init(text: Binding<String>, isFocused: Binding<Bool>, onHideKeyboard: @escaping () -> Void) {
        self.text = text
        self.isFocused = isFocused
        self.onHideKeyboard = onHideKeyboard
    }

    func applyAccessory(to textView: UITextView, enabled: Bool) {
        if enabled {
            if accessoryView == nil {
                let bar = ComposerKeyboardAccessoryView()
                bar.onHide = { [weak self] in
                    guard let self else { return }
                    self.isFocused.wrappedValue = false
                    self.textView?.resignFirstResponder()
                    self.onHideKeyboard()
                }
                accessoryView = bar
            }
            textView.inputAccessoryView = accessoryView
        } else {
            textView.inputAccessoryView = nil
        }
        accessoryEnabled = enabled
    }

    func textViewDidChange(_ textView: UITextView) {
        (textView as? ComposerTextView)?.reconcileScrollState()
        let value = textView.text ?? ""
        if text.wrappedValue != value {
            text.wrappedValue = value
        }
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
        if !isFocused.wrappedValue {
            isFocused.wrappedValue = true
        }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        if isFocused.wrappedValue {
            isFocused.wrappedValue = false
        }
    }
}

// MARK: - Keyboard accessory

private final class ComposerKeyboardAccessoryView: UIView {
    var onHide: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        autoresizingMask = .flexibleHeight
        backgroundColor = UIColor.secondarySystemGroupedBackground

        let hide = UIButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: ComposerInputChrome.hideKeyboardSymbolName)
        config.title = ComposerInputChrome.hideKeyboardTitle
        config.imagePadding = 4
        config.imagePlacement = .leading
        config.baseForegroundColor = UIColor.secondaryLabel
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var out = incoming
            out.font = UIFont.preferredFont(forTextStyle: .subheadline)
            return out
        }
        hide.configuration = config
        hide.addAction(UIAction { [weak self] _ in
            self?.onHide?()
        }, for: .touchUpInside)
        hide.accessibilityLabel = ComposerInputChrome.hideKeyboardTitle

        addSubview(hide)
        hide.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 44),
            hide.centerXAnchor.constraint(equalTo: centerXAnchor),
            hide.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 44)
    }
}

#if DEBUG
/// Synthetic simulator-only regression surface, embedded in the existing CI
/// preview. It uses the real representable, coordinator and text view.
struct ComposerScrollRegressionPreview: View {
    @State private var draft = ""
    @State private var focused = false
    @State private var fieldWidth: CGFloat = 320
    @State private var fieldHeight: CGFloat?
    @State private var summary = "Composer regression running"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(summary).font(.caption)
            ComposerMultilineField(
                text: $draft, isFocused: $focused, placeholder: "Synthetic draft",
                isEditable: true, usesKeyboardAccessory: false, onHideKeyboard: {}
            )
            .frame(width: fieldWidth, height: fieldHeight)
            .frame(minHeight: 44)
            .border(.secondary)
        }
        .task { await exerciseComposer() }
    }

    @MainActor
    private func exerciseComposer() async {
        var checks: [String: Bool] = [:]
        var captures: [(String, UIImage)] = []
        func settle() async {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        func find(_ root: UIView) -> ComposerTextView? {
            if let field = root as? ComposerTextView { return field }
            for child in root.subviews {
                if let field = find(child) { return field }
            }
            return nil
        }
        await settle()
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let field = windows.compactMap({ find($0) }).first else {
            writeResult(["real composer located": false], captures: [])
            summary = "FAIL: composer absent"
            return
        }
        func capture(_ title: String) {
            field.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: field.bounds).image { _ in
                field.drawHierarchy(in: field.bounds, afterScreenUpdates: true)
            }
            captures.append((title, image))
        }
        checks["initial short draft does not scroll"] = !field.isScrollEnabled
        // UIKit input plus the real coordinator path, before SwiftUI's binding
        // update. This reproduces the equality-guard bug rather than assigning
        // only the SwiftUI draft programmatically.
        field.insertText((1...14).map { "Typed synthetic line \($0)" }.joined(separator: "\n"))
        field.delegate?.textViewDidChange?(field)
        await settle()
        checks["typed growth enables scrolling"] = field.isScrollEnabled
        let cap = ceil((field.font?.lineHeight ?? 0) * 8 + field.textContainerInset.top + field.textContainerInset.bottom)
        checks["typed growth viewport is capped at eight lines"] = field.bounds.height <= cap + 1 && field.bounds.height >= cap - 1
        checks["typed input reached the binding"] = draft == field.text
        capture("Typed growth: fourteen lines, scrolling enabled")
        field.selectedRange = NSRange(location: 0, length: (field.text as NSString).length)
        field.deleteBackward()
        field.insertText("Short typed draft")
        field.delegate?.textViewDidChange?(field)
        await settle()
        checks["typed shrink disables scrolling"] = !field.isScrollEnabled
        capture("Typed shrink: one line, scrolling disabled")
        draft = String(repeating: "wrap ", count: 16)
        fieldWidth = 80
        await settle()
        checks["narrow width enables overflow scrolling"] = field.isScrollEnabled
        fieldWidth = 320
        await settle()
        checks["wider width disables overflow scrolling"] = !field.isScrollEnabled
        capture("Resize: same draft at wider width, scrolling disabled")
        draft = (1...20).map { "Programmatic synthetic line \($0)" }.joined(separator: "\n")
        await settle()
        field.selectedRange = NSRange(location: (field.text as NSString).length, length: 0)
        field.contentOffset = .zero
        draft = (1...12).map { "Shortened synthetic line \($0)" }.joined(separator: "\n")
        await settle()
        let expectedEnd = (field.text as NSString).length
        checks["programmatic edit clamps the selection"] = field.selectedRange.location == expectedEnd
        if let selection = field.selectedTextRange {
            let caret = field.caretRect(for: selection.start)
            checks["programmatic cursor remains visible"] = CGRect(origin: field.contentOffset, size: field.bounds.size).contains(caret)
        } else {
            checks["programmatic cursor remains visible"] = false
        }
        capture("Programmatic shortening: twelve lines, end selection")
        field.insertText("\nAnother typed line while scrolling")
        field.delegate?.textViewDidChange?(field)
        await settle()
        checks["editing while scrolling preserves capped height"] = field.isScrollEnabled && abs(field.bounds.height - cap) <= 1
        fieldHeight = 70
        await settle()
        checks["height-only resize uses the smaller viewport"] = abs(field.bounds.height - 70) <= 1
        if let selection = field.selectedTextRange {
            checks["height-only resize keeps the cursor visible"] = CGRect(origin: field.contentOffset, size: field.bounds.size).contains(field.caretRect(for: selection.start))
        } else {
            checks["height-only resize keeps the cursor visible"] = false
        }
        capture("Height-only resize: seventy-point viewport, end selection")
        writeResult(checks, captures: captures)
        summary = checks.values.allSatisfy { $0 } ? "PASS: composer regression" : "FAIL: composer regression"
    }

    private func writeResult(_ checks: [String: Bool], captures: [(String, UIImage)]) {
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let width: CGFloat = 360
        let height = captures.reduce(CGFloat(70)) { $0 + 36 + $1.1.size.height * 336 / max($1.1.size.width, 1) }
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height)).image { context in
            UIColor.systemBackground.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            let passed = checks.values.allSatisfy { $0 }
            let title = passed ? "PASS: real composer regression" : "FAIL: real composer regression"
            (title as NSString).draw(at: CGPoint(x: 12, y: 12), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 16), .foregroundColor: passed ? UIColor.systemGreen : UIColor.systemRed])
            var y: CGFloat = 60
            for (label, snapshot) in captures {
                (label as NSString).draw(in: CGRect(x: 12, y: y, width: 336, height: 30), withAttributes: [.font: UIFont.systemFont(ofSize: 11), .foregroundColor: UIColor.label])
                y += 36
                let h = snapshot.size.height * 336 / max(snapshot.size.width, 1)
                snapshot.draw(in: CGRect(x: 12, y: y, width: 336, height: h))
                y += h
            }
        }
        do {
            try image.pngData()?.write(to: directory.appendingPathComponent("composer-regression.png"), options: .atomic)
            let report = try JSONSerialization.data(withJSONObject: ["checks": checks, "passed": !checks.isEmpty && checks.values.allSatisfy { $0 }], options: [.sortedKeys])
            try report.write(to: directory.appendingPathComponent("composer-regression.json"), options: .atomic)
        } catch {
            summary = "FAIL: regression capture unavailable"
        }
    }
}
#endif
