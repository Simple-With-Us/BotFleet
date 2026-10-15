import SwiftUI
import UIKit
import CompanionCore

/// Multi-line composer field with a keyboard `inputAccessoryView` Hide control.
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
        let view = UITextView()
        view.backgroundColor = .clear
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.textContainerInset = UIEdgeInsets(top: 11, left: 10, bottom: 11, right: 10)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = true
        view.textContainer.maximumNumberOfLines = 8
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityLabel = placeholder
        context.coordinator.textView = view
        context.coordinator.applyAccessory(to: view, enabled: usesKeyboardAccessory)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        context.coordinator.onHideKeyboard = onHideKeyboard
        context.coordinator.applyAccessory(to: uiView, enabled: usesKeyboardAccessory)
        if uiView.text != text {
            uiView.text = text
        }
        uiView.isEditable = isEditable
        uiView.isSelectable = isEditable
        uiView.accessibilityLabel = placeholder
        if isEditable {
            if isFocused, !uiView.isFirstResponder {
                uiView.becomeFirstResponder()
            } else if !isFocused, uiView.isFirstResponder {
                uiView.resignFirstResponder()
            }
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        var isFocused: Binding<Bool>
        var onHideKeyboard: () -> Void
        weak var textView: UITextView?
        private var accessoryView: ComposerKeyboardAccessoryView?

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
