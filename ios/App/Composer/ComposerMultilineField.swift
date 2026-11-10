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
        view.textContainer.maximumNumberOfLines = 8
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        context.coordinator.textView = view
        context.coordinator.applyAccessory(to: view, enabled: usesKeyboardAccessory)
        return view
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
            uiView.contentOffset = contentOffset
        }
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
        // Scroll only once the draft passes the 8-line cap, so longer content
        // stays reachable instead of clipping under the fixed height.
        let insets = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let lineHeight = uiView.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
        let maxLines = max(uiView.textContainer.maximumNumberOfLines, 1)
        let maxHeight = ceil(lineHeight * CGFloat(maxLines) + insets)
        let contentHeight = uiView.sizeThatFits(CGSize(width: uiView.bounds.width, height: .greatestFiniteMagnitude)).height
        uiView.isScrollEnabled = uiView.bounds.width > 0 && contentHeight > maxHeight
        uiView.invalidateIntrinsicContentSize()
    }
}

/// UITextView whose intrinsic height grows with the draft, capped at the
/// 8-line maximum so a long draft expands the composer instead of scrolling
/// inside a one-line strip.
private final class ComposerTextView: UITextView {
    override var intrinsicContentSize: CGSize {
        let width = bounds.width > 0 ? bounds.width : frame.width
        guard width > 0, let font else {
            return CGSize(width: UIView.noIntrinsicMetric, height: 44)
        }
        let contentHeight = sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let insets = textContainerInset.top + textContainerInset.bottom
        let lineHeight = font.lineHeight
        let minHeight = ceil(lineHeight + insets)
        let maxLines = max(textContainer.maximumNumberOfLines, 1)
        let maxHeight = ceil(lineHeight * CGFloat(maxLines) + insets)
        let height = min(max(contentHeight, minHeight), maxHeight)
        return CGSize(width: UIView.noIntrinsicMetric, height: height)
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
