// One spoken turn on a voice call, and how turns fold into lines.
//
// A user turn arrives twice -- a running transcript and then the final one --
// so the view keeps one open user line rather than stacking a second copy of
// the same sentence.  This is a port of `appendStsLine` in
// src/lib/sts/call-session.ts; the two must agree, because a bot turn that
// renders differently on the phone than on the desktop is a transcript that
// disagrees with itself.
import Foundation

/// A single spoken turn.  Mirrors `StsTranscriptLine` on the desktop.
public struct StsTranscriptLine: Hashable, Sendable {
    public var text: String
    public var from: StsSpeaker
    public var final: Bool
    /// True when the bot answered this turn without its configured engine,
    /// because the engine call failed or hit the deadline.  Surfaced in the
    /// transcript rather than swallowed: a silent swap to a weaker answer is
    /// worse than a visible one.
    public var engineBypassed: Bool

    public init(text: String, from: StsSpeaker, final: Bool, engineBypassed: Bool = false) {
        self.text = text
        self.from = from
        self.final = final
        self.engineBypassed = engineBypassed
    }
}

public enum StsSpeaker: String, Hashable, Sendable {
    case bot
    case user
}

/// A line as the call screen shows it, with a stable key for SwiftUI identity.
public struct StsLineView: Hashable, Sendable, Identifiable {
    public var id: String { key }
    public var key: String
    public var from: StsSpeaker
    public var text: String
    public var final: Bool
    public var engineBypassed: Bool

    public init(key: String, from: StsSpeaker, text: String, final: Bool, engineBypassed: Bool = false) {
        self.key = key
        self.from = from
        self.text = text
        self.final = final
        self.engineBypassed = engineBypassed
    }
}

/// Fold one incoming turn into the visible lines.
///
/// An open (non-final) user line is replaced in place, never stacked: the
/// provider emits the running transcript on every frame, and each frame would
/// otherwise become its own bubble.  Bot lines always append -- the provider
/// sends one final bot turn per reply.
public func appendStsLine(_ lines: [StsLineView], line: StsTranscriptLine, key: String) -> [StsLineView] {
    var next = lines
    let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return next }
    if line.from == .user {
        for index in next.indices.reversed() {
            if next[index].from == .user, !next[index].final {
                next[index] = StsLineView(
                    key: next[index].key,
                    from: .user,
                    text: text,
                    final: line.final,
                    engineBypassed: line.engineBypassed
                )
                return next
            }
        }
    }
    next.append(StsLineView(key: key, from: line.from, text: text, final: line.final, engineBypassed: line.engineBypassed))
    return next
}

/// The spoken form of a line for the transcript record.  A bot line is its
/// own text; a user line is attributed, because the record outlives the call
/// screen that made the speaker obvious.
public func stsLineText(_ line: StsLineView) -> String {
    let spoken = line.from == .bot ? line.text : "You: \(line.text)"
    return line.engineBypassed ? "\(spoken) (answered without the bot's engine)" : spoken
}
