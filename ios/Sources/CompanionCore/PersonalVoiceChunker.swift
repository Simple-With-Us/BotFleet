//
//  PersonalVoiceChunker.swift
//  CompanionCore
//
//  Sentence and clause chunking for Apple Personal Voice synthesis.
//  Enforces utterance length boundaries (600-800 characters) across
//  macOS desktop and iOS companion speech paths to prevent synthesis
//  cancellations and buffer overruns on long bot replies.
//

import Foundation

public enum PersonalVoiceChunker {
    /// Default target maximum character length per chunk (600-800 character window).
    public static let defaultMaxCharacters = 750

    /// Absolute maximum character ceiling.
    public static let absoluteMaxCharacters = 900

    /// Minimum threshold before attempting clause/sub-sentence breaking.
    public static let minClauseBreakThreshold = 200

    /// Splits text into natural sentence- and clause-bounded chunks for speech synthesis.
    ///
    /// - Parameters:
    ///   - text: The input text to chunk.
    ///   - maxCharacters: The target maximum length per chunk (defaults to 750).
    /// - Returns: An array of trimmed chunk strings suitable for sequential `AVSpeechUtterance` playback.
    public static func chunk(
        text: String,
        maxCharacters: Int = defaultMaxCharacters
    ) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        guard trimmed.count > maxCharacters else { return [trimmed] }

        // 1. Tokenize into natural sentences using Foundation's linguistic tokenizer.
        var rawSentences: [String] = []
        trimmed.enumerateSubstrings(in: trimmed.startIndex..<trimmed.endIndex, options: [.bySentences, .localized]) { substring, _, _, _ in
            if let s = substring?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                rawSentences.append(s)
            }
        }
        if rawSentences.isEmpty {
            rawSentences = [trimmed]
        }

        // 2. Break down any individual sentence that exceeds maxCharacters.
        var atoms: [String] = []
        for sentence in rawSentences {
            if sentence.count <= maxCharacters {
                atoms.append(sentence)
            } else {
                atoms.append(contentsOf: breakOversizedSentence(sentence, maxCharacters: maxCharacters))
            }
        }

        // 3. Greedily pack atoms into chunks up to maxCharacters.
        var chunks: [String] = []
        var currentChunk = ""

        for atom in atoms {
            if currentChunk.isEmpty {
                currentChunk = atom
            } else if currentChunk.count + 1 + atom.count <= maxCharacters {
                currentChunk += " " + atom
            } else {
                chunks.append(currentChunk)
                currentChunk = atom
            }
        }
        if !currentChunk.isEmpty {
            chunks.append(currentChunk)
        }

        return chunks
    }

    /// Breaks an oversized sentence across clause delimiters, word boundaries, or character slices.
    private static func breakOversizedSentence(_ sentence: String, maxCharacters: Int) -> [String] {
        let delimiters: [Character] = [";", ":", "\n", "—", "–", ","]
        var clauseParts: [String] = []
        var current = ""

        for char in sentence {
            current.append(char)
            if delimiters.contains(char) && current.count >= min(minClauseBreakThreshold, maxCharacters / 3) {
                let trimmedClause = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedClause.isEmpty {
                    clauseParts.append(trimmedClause)
                }
                current = ""
            }
        }
        let remaining = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !remaining.isEmpty {
            clauseParts.append(remaining)
        }

        var result: [String] = []
        for part in clauseParts {
            if part.count <= maxCharacters {
                result.append(part)
            } else {
                // Break across word boundaries
                let words = part.split(separator: " ").map(String.init)
                var wordChunk = ""
                for word in words {
                    if word.count > maxCharacters {
                        if !wordChunk.isEmpty {
                            result.append(wordChunk)
                            wordChunk = ""
                        }
                        var sub = word
                        while sub.count > maxCharacters {
                            let idx = sub.index(sub.startIndex, offsetBy: maxCharacters)
                            result.append(String(sub[..<idx]))
                            sub = String(sub[idx...])
                        }
                        if !sub.isEmpty {
                            wordChunk = sub
                        }
                    } else if wordChunk.isEmpty {
                        wordChunk = word
                    } else if wordChunk.count + 1 + word.count <= maxCharacters {
                        wordChunk += " " + word
                    } else {
                        result.append(wordChunk)
                        wordChunk = word
                    }
                }
                if !wordChunk.isEmpty {
                    result.append(wordChunk)
                }
            }
        }

        return result.isEmpty ? [sentence] : result
    }
}
