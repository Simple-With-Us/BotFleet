//
//  KaraokeDisplay.swift
//  CompanionCore
//
//  The words of a bot reply as the bubble draws them, for karaoke.
//
//  The bubble renders `Markdown.blocks` one by one and hands each block's
//  inline run to Foundation (`Markdown.inlineAttributed`).  The display text
//  karaoke aligns the voice against is those rendered runs, joined with a
//  line break, so a word's offsets point straight into the AttributedString
//  a block shows.  Fenced code is left out, the same as the desktop leaves
//  out `pre`: the voice names a code block instead of reading it, and the
//  highlight sweeps past it.  List markers are drawn beside the text, not in
//  it, so they are not words either (the desktop's are CSS markers).
//
//  Offsets are UTF-16, the unit KaraokeAlign uses.
//

import Foundation

extension Markdown {
    /// A block's inline run, rendered.  The one parse the bubble and the
    /// karaoke display text share, so their offsets cannot drift: inline
    /// markdown via Foundation, or the raw characters when it does not
    /// parse (a half-typed link mid-stream).
    public static func inlineAttributed(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }
}

extension MarkdownBlock {
    /// The inline markdown a block renders as running text, or nil for a
    /// block karaoke skips (fenced code, a rule).
    public var inlineText: String? {
        switch self {
        case let .paragraph(text), let .quote(text):
            return text
        case let .heading(_, text), let .bullet(_, text):
            return text
        case let .ordered(_, _, text):
            return text
        case .code, .rule:
            return nil
        }
    }
}

public struct KaraokeDisplay: Equatable, Sendable {
    public struct Block: Equatable, Sendable {
        /// Index in `Markdown.blocks(source)`, the bubble's ForEach offset.
        public let index: Int
        /// The block's inline markdown, as the bubble passes it on.
        public let markdown: String
        /// The rendered run.
        public let rendered: AttributedString
        /// Where the run starts in `text`, and its length (UTF-16).
        public let start: Int
        public let length: Int
    }

    /// One display word's place in a block: block position in `blocks`,
    /// UTF-16 offsets local to that block's rendered run.
    public struct Place: Equatable, Sendable {
        public let block: Int
        public let start: Int
        public let end: Int
    }

    /// The markdown the bubble renders.
    public let source: String
    /// The rendered runs, joined with "\n".
    public let text: String
    public let words: [KaraokeWord]
    public let blocks: [Block]
    /// For each word in `words`.
    public let places: [Place]

    public init(markdown source: String) {
        self.source = source
        var blocks: [Block] = []
        var text = ""
        var at = 0
        for (index, block) in Markdown.blocks(source).enumerated() {
            guard let inline = block.inlineText else { continue }
            let rendered = Markdown.inlineAttributed(inline)
            let plain = String(rendered.characters)
            if !blocks.isEmpty {
                text += "\n"
                at += 1
            }
            let length = plain.utf16.count
            blocks.append(Block(index: index, markdown: inline, rendered: rendered, start: at, length: length))
            text += plain
            at += length
        }
        self.text = text
        self.blocks = blocks
        let words = KaraokeAlign.tokenize(text)
        self.words = words
        var places: [Place] = []
        places.reserveCapacity(words.count)
        var b = 0
        for word in words {
            while b + 1 < blocks.count && blocks[b + 1].start <= word.start { b += 1 }
            let base = blocks.isEmpty ? 0 : blocks[b].start
            places.append(Place(block: b, start: word.start - base, end: word.end - base))
        }
        self.places = places
    }

    /// The markdown a bot reply's bubble renders: the stored text without
    /// its attachment markers, and without a leading "[to iMessage]" tag
    /// (the bubble shows that as a label).  TextBubble in ChatView.swift.
    public static func bubbleMarkdown(_ messageText: String) -> String {
        let display = ChatAttachments.split(messageText).display
        return ImessageMessageView.stripToImessagePrefix(display) ?? display
    }
}

/// What one block shows of the karaoke frame, in the block's own UTF-16
/// offsets.  Equatable, so a block whose paint did not change is left alone.
public struct KaraokeBlockPaint: Equatable, Sendable {
    /// The current word's part already spoken ("rolling in").
    public var lit: Range<Int>?
    /// Words just spoken, fading back to normal ink; level 0 is strongest.
    public var trail: [Trail] = []

    public struct Trail: Equatable, Sendable {
        public let range: Range<Int>
        public let level: Int
    }

    public init(lit: Range<Int>? = nil, trail: [Trail] = []) {
        self.lit = lit
        self.trail = trail
    }

    public var isEmpty: Bool { lit == nil && trail.isEmpty }
}

extension KaraokeDisplay {
    /// The frame, per block position in `blocks`.  Blocks with nothing
    /// painted are absent.
    public func paints(for frame: KaraokeFrame) -> [Int: KaraokeBlockPaint] {
        var out: [Int: KaraokeBlockPaint] = [:]
        if frame.current >= 0, frame.current < places.count, frame.lit > 0 {
            let place = places[frame.current]
            let end = min(place.end, place.start + frame.lit)
            out[place.block, default: KaraokeBlockPaint()].lit = place.start..<end
        }
        for trail in frame.trail where trail.index >= 0 && trail.index < places.count {
            let place = places[trail.index]
            out[place.block, default: KaraokeBlockPaint()].trail.append(
                KaraokeBlockPaint.Trail(range: place.start..<place.end, level: trail.level)
            )
        }
        return out
    }
}
