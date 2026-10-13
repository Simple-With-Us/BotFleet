// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
// With --speak-personal-voice it speaks instead, and streams:
//   {"range":[location,length],"elapsedMs":n}  as each word is about to be
//                                 spoken (UTF-16 offsets into --text-file)
//   {"finished":true}             then exit 0
// Runs until the final result or a per-session stop marker. Launched by
// electron/speech.mjs as this background app bundle so macOS can resolve the
// microphone and speech purpose strings in its Info.plist.
//
// `--endpoint-ms N` ends the audio stream after N milliseconds without a
// transcript change. SFSpeechRecognizer does not finalize a buffer-backed
// request on silence by itself; it only produces `isFinal` after endAudio().
// Composer dictation omits this flag and keeps its existing press-to-stop
// behavior, while call mode opts into silence endpointing.
import AVFoundation
import Foundation
import Speech

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
    fflush(stdout)
  }
}

func fail(_ message: String) -> Never {
  emit(["error": message])
  exit(1)
}

let endpointMs: Int = {
  let args = CommandLine.arguments
  guard
    let index = args.firstIndex(of: "--endpoint-ms"),
    index + 1 < args.count,
    let value = Int(args[index + 1])
  else { return 0 }
  return min(5_000, max(250, value))
}()

let stopFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--stop-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

let finishFile: String? = {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: "--finish-file"), index + 1 < args.count else { return nil }
  return args[index + 1]
}()

// LaunchServices gives the helper the bundle identity TCC needs, but it also
// means the parent cannot terminate it by killing the `open -W` process. A
// per-session stop marker keeps intentional mute/hang-up deterministic.
var stopTimer: DispatchSourceTimer?
if let stopFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
  timer.setEventHandler {
    if FileManager.default.fileExists(atPath: stopFile) { exit(0) }
  }
  stopTimer = timer
  timer.resume()
}

// Push-to-talk release must finalize recognition rather than cancel it. The
// handler is installed once the audio engine exists; the timer keeps polling
// if an unusually fast key release beats authorization/setup.
var finishHandler: (() -> Void)?
var finishTimer: DispatchSourceTimer?
if let finishFile {
  let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
  timer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
  timer.setEventHandler {
    guard FileManager.default.fileExists(atPath: finishFile), let finish = finishHandler else { return }
    timer.cancel()
    finish()
  }
  finishTimer = timer
  timer.resume()
}

/// SFSpeechRecognizer can keep revising/re-emitting a partial transcript
/// after the user stops talking. Only a changed transcript resets the timer.
final class SilenceEndpointer {
  private let queue = DispatchQueue(label: "com.botfleet.speech.endpoint")
  private let gap: TimeInterval
  private let finish: () -> Void
  private var timer: DispatchSourceTimer?
  private var lastText = ""
  private var lastChange = DispatchTime.now()
  private var finished = false

  init(gapMs: Int, finish: @escaping () -> Void) {
    gap = Double(gapMs) / 1_000
    self.finish = finish
  }

  func start() {
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    source.setEventHandler { [weak self] in self?.tick() }
    timer = source
    source.resume()
  }

  func saw(_ text: String) {
    queue.async {
      guard !self.finished, !text.isEmpty, text != self.lastText else { return }
      self.lastText = text
      self.lastChange = .now()
    }
  }

  private func tick() {
    // Never terminate an empty turn: a call may be quiet for as long as the
    // user needs before they begin speaking.
    guard !finished, !lastText.isEmpty else { return }
    let silentFor = Double(DispatchTime.now().uptimeNanoseconds - lastChange.uptimeNanoseconds) / 1_000_000_000
    guard silentFor >= gap else { return }
    finished = true
    timer?.cancel()
    timer = nil
    finish()
  }
}

// ── Personal Voice listing and synthesis (macOS 14+) ──────────────────────
if CommandLine.arguments.contains("--list-personal-voices") {
  if #available(macOS 14.0, *) {
    let status = AVSpeechSynthesizer.personalVoiceAuthorizationStatus
    if status == .authorized {
      let voices = AVSpeechSynthesisVoice.speechVoices()
        .filter { $0.voiceTraits.contains(.isPersonalVoice) }
        .map { [
          "id": "personal:\($0.identifier)",
          "name": $0.name,
          "locale": $0.language
        ] }
      emit(["status": "authorized", "voices": voices])
      exit(0)
    } else if status == .notDetermined {
      AVSpeechSynthesizer.requestPersonalVoiceAuthorization { newStatus in
        if newStatus == .authorized {
          let voices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.voiceTraits.contains(.isPersonalVoice) }
            .map { [
              "id": "personal:\($0.identifier)",
              "name": $0.name,
              "locale": $0.language
            ] }
          emit(["status": "authorized", "voices": voices])
        } else {
          emit(["status": "denied", "voices": []])
        }
        exit(0)
      }
      RunLoop.main.run()
    } else {
      emit(["status": "denied", "voices": []])
      exit(0)
    }
  } else {
    emit(["status": "unsupported", "voices": []])
    exit(0)
  }
}

if CommandLine.arguments.contains("--speak-personal-voice") {
  guard #available(macOS 14.0, *) else {
    fail("unsupported-platform")
  }
  let args = CommandLine.arguments
  guard let voiceIdx = args.firstIndex(of: "--voice-id"), voiceIdx + 1 < args.count else {
    fail("missing-voice-id")
  }
  // The reply text arrives in a 0600 file rather than on argv: argv is
  // world-readable through `ps`, and this text is a voice summary of the
  // user's own messages.
  guard let textIdx = args.firstIndex(of: "--text-file"), textIdx + 1 < args.count else {
    fail("missing-text")
  }
  let requestedVoiceId = args[voiceIdx + 1]
  let textPath = args[textIdx + 1]
  guard let text = try? String(contentsOfFile: textPath, encoding: .utf8) else {
    fail("missing-text")
  }
  let rawId = requestedVoiceId
    .replacingOccurrences(of: "apple-personal:", with: "")
    .replacingOccurrences(of: "personal:", with: "")

  final class PersonalVoiceSpeaker: NSObject, @unchecked Sendable, AVSpeechSynthesizerDelegate {
    let synth = AVSpeechSynthesizer()
    var chunks: [String] = []
    /// UTF-16 offset of each chunk's first unit in the original text, so a
    /// range inside a chunk becomes a range inside the text the caller sent.
    var chunkBases: [Int] = []
    var currentChunkIndex = 0
    var attempts = 0
    var voice: AVSpeechSynthesisVoice?
    var isStopped = false
    /// UTF-16 index of the range AVSpeechSynthesizer is about to speak.
    /// Ranges before this have already been spoken.  A cancel retries from
    /// here instead of from the start of the chunk.
    var nextRangeUTF16 = 0
    var startedAt: DispatchTime?

    /// Chunk boundaries as UTF-16 ranges into the ORIGINAL text, so word
    /// ranges can be reported against it.  Sentences first, then clauses at
    /// punctuation, then words; atoms are packed greedily up to the limit and
    /// each chunk is the original text between its first and last atom.
    static func chunkRanges(_ text: String, maxCharacters: Int = 750) -> [NSRange] {
      let ns = text as NSString
      let blank = CharacterSet.whitespacesAndNewlines
      func isBlank(_ index: Int) -> Bool {
        let unit = ns.character(at: index)
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return blank.contains(scalar)
      }
      func trimmed(_ range: NSRange) -> NSRange {
        var start = range.location
        var end = range.location + range.length
        while start < end && isBlank(start) { start += 1 }
        while end > start && isBlank(end - 1) { end -= 1 }
        return NSRange(location: start, length: end - start)
      }
      let whole = trimmed(NSRange(location: 0, length: ns.length))
      guard whole.length > 0 else { return [] }
      guard whole.length > maxCharacters else { return [whole] }

      var sentences: [NSRange] = []
      ns.enumerateSubstrings(in: whole, options: [.bySentences, .localized]) { _, range, _, _ in
        let sentence = trimmed(range)
        if sentence.length > 0 { sentences.append(sentence) }
      }
      if sentences.isEmpty { sentences = [whole] }

      let delimiters: Set<unichar> = [59, 58, 10, 0x2014, 0x2013, 44] // ; : \n — – ,
      let clauseMinimum = min(200, maxCharacters / 3)
      var atoms: [NSRange] = []
      for sentence in sentences {
        if sentence.length <= maxCharacters {
          atoms.append(sentence)
          continue
        }
        var clauses: [NSRange] = []
        var clauseStart = sentence.location
        let sentenceEnd = sentence.location + sentence.length
        var i = sentence.location
        while i < sentenceEnd {
          if delimiters.contains(ns.character(at: i)) && i + 1 - clauseStart >= clauseMinimum {
            let clause = trimmed(NSRange(location: clauseStart, length: i + 1 - clauseStart))
            if clause.length > 0 { clauses.append(clause) }
            clauseStart = i + 1
          }
          i += 1
        }
        let rest = trimmed(NSRange(location: clauseStart, length: sentenceEnd - clauseStart))
        if rest.length > 0 { clauses.append(rest) }

        for clause in clauses {
          if clause.length <= maxCharacters {
            atoms.append(clause)
            continue
          }
          // Words: runs between spaces.  A word longer than the limit is cut
          // at composed-character boundaries.
          let clauseEnd = clause.location + clause.length
          var wordStart = clause.location
          var j = clause.location
          while j <= clauseEnd {
            if j == clauseEnd || ns.character(at: j) == 32 {
              if j > wordStart {
                var piece = wordStart
                while j - piece > maxCharacters {
                  var cut = piece + maxCharacters
                  cut = ns.rangeOfComposedCharacterSequence(at: cut).location
                  if cut <= piece { cut = piece + maxCharacters }
                  atoms.append(NSRange(location: piece, length: cut - piece))
                  piece = cut
                }
                atoms.append(NSRange(location: piece, length: j - piece))
              }
              wordStart = j + 1
            }
            j += 1
          }
        }
      }

      var result: [NSRange] = []
      var current: NSRange?
      for atom in atoms {
        guard let open = current else {
          current = atom
          continue
        }
        let merged = NSRange(location: open.location, length: atom.location + atom.length - open.location)
        if merged.length <= maxCharacters {
          current = merged
        } else {
          result.append(open)
          current = atom
        }
      }
      if let open = current { result.append(open) }
      return result
    }

    static func chunkText(_ text: String, maxCharacters: Int = 750) -> [String] {
      let ns = text as NSString
      return chunkRanges(text, maxCharacters: maxCharacters).map { ns.substring(with: $0) }
    }

    /// Retry text after didCancel.  `nextRangeLocation` is the UTF-16 start
    /// of the range that was about to be spoken.  Zero means nothing audible
    /// was committed, so the whole chunk is retried.  The in-progress range
    /// may be repeated once; ranges before it are not.
    static func remainderAfterCancel(chunk: String, nextRangeLocation: Int) -> String {
      let ns = chunk as NSString
      let location = min(max(nextRangeLocation, 0), ns.length)
      if location == 0 { return chunk }
      return ns.substring(from: location)
    }

    func speak(voice: AVSpeechSynthesisVoice, text: String) {
      synth.delegate = self
      self.voice = voice
      let ns = text as NSString
      let ranges = Self.chunkRanges(text)
      self.chunks = ranges.map { ns.substring(with: $0) }
      self.chunkBases = ranges.map { $0.location }
      self.startedAt = DispatchTime.now()
      guard !chunks.isEmpty else {
        emit(["finished": true])
        exit(0)
      }
      self.currentChunkIndex = 0
      self.attempts = 0
      self.isStopped = false
      self.nextRangeUTF16 = 0
      speakCurrentChunk()
    }

    func speakCurrentChunk() {
      guard !isStopped, let voice = self.voice, currentChunkIndex < chunks.count else {
        emit(["finished": true])
        exit(0)
      }
      nextRangeUTF16 = 0
      let utterance = AVSpeechUtterance(string: chunks[currentChunkIndex])
      utterance.voice = voice
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate
      utterance.postUtteranceDelay = 0.05
      synth.speak(utterance)
    }

    func speechSynthesizer(
      _ synthesizer: AVSpeechSynthesizer,
      willSpeakRangeOfSpeechString characterRange: NSRange,
      utterance: AVSpeechUtterance
    ) {
      nextRangeUTF16 = characterRange.location
      // One line per word, flushed by emit(): UTF-16 offsets into the text
      // the caller sent (the chunk's base plus the range inside the chunk),
      // and the helper's own clock so a reader can undo polling batches.
      guard currentChunkIndex < chunkBases.count else { return }
      let elapsedNs = DispatchTime.now().uptimeNanoseconds - (startedAt ?? DispatchTime.now()).uptimeNanoseconds
      emit([
        "range": [chunkBases[currentChunkIndex] + characterRange.location, characterRange.length],
        "elapsedMs": Int(elapsedNs / 1_000_000),
      ])
    }

    func advanceAfterChunk() {
      nextRangeUTF16 = 0
      currentChunkIndex += 1
      attempts = 0
      if currentChunkIndex >= chunks.count {
        emit(["finished": true])
        exit(0)
      } else {
        speakCurrentChunk()
      }
    }

    func stop() {
      isStopped = true
      synth.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
      advanceAfterChunk()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
      if isStopped {
        exit(0)
      }
      // Internal synthesis drop/error: retry once, but not from character 0
      // when part of this chunk was already spoken.
      attempts += 1
      if attempts < 2 {
        let chunk = chunks[currentChunkIndex]
        let remainder = Self.remainderAfterCancel(
          chunk: chunk,
          nextRangeLocation: nextRangeUTF16
        )
        // The retried utterance starts where the remainder starts, so its
        // ranges are offset by what was cut off the front.
        let cut = (chunk as NSString).length - (remainder as NSString).length
        nextRangeUTF16 = 0
        if remainder.isEmpty {
          advanceAfterChunk()
        } else {
          chunks[currentChunkIndex] = remainder
          chunkBases[currentChunkIndex] += cut
          speakCurrentChunk()
        }
      } else {
        advanceAfterChunk()
      }
    }
  }

  let speaker = PersonalVoiceSpeaker()

  let doSpeak = {
    // Match only Personal Voices.  Matching by identifier or name over every
    // installed voice let `personal:Samantha` select an ordinary system voice
    // and speak the user's words with it.
    let personalVoices = AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.voiceTraits.contains(.isPersonalVoice) }
    let matched = personalVoices.first(where: {
      $0.identifier == rawId || $0.name == rawId ||
      "personal:\($0.identifier)" == requestedVoiceId ||
      "apple-personal:\($0.identifier)" == requestedVoiceId
    })
    // Guess only when the caller named no voice at all. A named-but-absent
    // voice — one not synced to this Mac — must fail loudly rather than be
    // replaced by a different Personal Voice speaking the user's words.
    let voice = matched ?? (rawId.isEmpty ? personalVoices.first : nil)

    guard let selectedVoice = voice else {
      fail("voice-not-found")
    }

    speaker.speak(voice: selectedVoice, text: text)
  }

  let status = AVSpeechSynthesizer.personalVoiceAuthorizationStatus
  if status == .authorized {
    doSpeak()
  } else if status == .notDetermined {
    AVSpeechSynthesizer.requestPersonalVoiceAuthorization { newStatus in
      if newStatus == .authorized {
        DispatchQueue.main.async { doSpeak() }
      } else {
        fail("personal-voice-not-authorized")
      }
    }
  } else {
    fail("personal-voice-not-authorized")
  }

  RunLoop.main.run()
}

// ── Speech-to-text dictation (Speech framework) ──────────────────────────
SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { fail("speech-not-authorized") }
  // Recognize in the user's language: a hardcoded en-US recognizer
  // transcribes everyone else into nonsense. First preference that has an
  // available recognizer wins, with en-US as the last resort.
  let candidates =
    Locale.preferredLanguages.map { Locale(identifier: $0) }
    + [Locale.current, Locale(identifier: "en-US")]
  guard
    let recognizer = candidates.lazy.compactMap({ SFSpeechRecognizer(locale: $0) })
      .first(where: { $0.isAvailable })
  else { fail("recognizer-unavailable") }

  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let engine = AVAudioEngine()
  let node = engine.inputNode
  var audioFinished = false
  let finishAudio = {
    DispatchQueue.main.async {
      guard !audioFinished else { return }
      audioFinished = true
      engine.stop()
      node.removeTap(onBus: 0)
      request.endAudio()
    }
  }
  finishHandler = finishAudio
  var endpointer: SilenceEndpointer?
  if endpointMs > 0 {
    endpointer = SilenceEndpointer(gapMs: endpointMs) {
      // Stop capture before ending the request: appending another audio
      // buffer after endAudio() can make the recognition task fail instead
      // of delivering its final transcript.
      finishAudio()
    }
    endpointer?.start()
  }
  node.installTap(onBus: 0, bufferSize: 1024, format: node.outputFormat(forBus: 0)) { buffer, _ in
    request.append(buffer)
  }
  do {
    engine.prepare()
    try engine.start()
  } catch { fail("mic-failed") }

  recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
      let text = result.bestTranscription.formattedString
      endpointer?.saw(text)
      emit(["partial": !result.isFinal, "text": text])
      if result.isFinal { exit(0) }
    }
    if error != nil { fail("recognition-error") }
  }
}

RunLoop.main.run()
