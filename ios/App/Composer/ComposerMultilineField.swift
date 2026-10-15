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
        Coordinator(parent: self)
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
        context.coordinator.applyAccessory(to: view)
        return view
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.applyAccessory(to: uiView)
        if uiView.text != text {
            uiView.text = text
        }
        uiView.isEditable = isEditable
        uiView.isSelectable = isEditable
        if isEditable {
            if isFocused, !uiView.isFirstResponder {
                uiView.becomeFirstResponder()
            } else if !isFocused, uiView.isFirstResponder {
                uiView.resignFirstResponder()
            }
        }
        context.coordinator.refreshPlaceholder(on: uiView)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerMultilineField
        weak var textView: UITextView?
        private var accessoryView: ComposerKeyboardAccessoryView?

        init(parent: ComposerMultilineField) {
            self.parent = parent
        }

        func applyAccessory(to textView: UITextView) {
            if parent.usesKeyboardAccessory {
                if accessoryView == nil {
                    let bar = ComposerKeyboardAccessoryView()
                    bar.onHide = { [weak self] in
                        self?.parent.onHideKeyboard()
                    }
                    accessoryView = bar
                }
                textView.inputAccessoryView = accessoryView
            } else {
                textView.inputAccessoryView = nil
            }
        }

        func refreshPlaceholder(on textView: UITextView) {
            // UITextView has no placeholder; SwiftUI overlay handles empty state.
        }

        func textViewDidChange(_ textView: UITextView) {
            let value = textView.text ?? ""
            if parent.text != value {
                parent.text = value
            }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.isFocused {
                parent.isFocused = false
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
        backgroundColor = .secondarySystemGroupedBackground

        let hide = UIButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: ComposerInputChrome.hideKeyboardSymbolName)
        config.title = ComposerInputChrome.hideKeyboardTitle
        config.imagePadding = 4
        config.baseForegroundColor = .secondaryLabel
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
