// Native macOS speech-to-text helper. Streams NDJSON lines to stdout:
//   {"partial":true,"text":"…"}   while recognizing
//   {"partial":false,"text":"…"}  final result, then exit 0
//   {"error":"…"}                 then exit 1
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
    var currentChunkIndex = 0
    var attempts = 0
    var voice: AVSpeechSynthesisVoice?
    var isStopped = false

    static func chunkText(_ text: String, maxCharacters: Int = 750) -> [String] {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return [] }
      guard trimmed.count > maxCharacters else { return [trimmed] }

      var rawSentences: [String] = []
      trimmed.enumerateSubstrings(in: trimmed.startIndex..<trimmed.endIndex, options: [.bySentences, .localized]) { substring, _, _, _ in
        if let s = substring?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
          rawSentences.append(s)
        }
      }
      if rawSentences.isEmpty { rawSentences = [trimmed] }

      let delimiters: [Character] = [";", ":", "\n", "—", "–", ","]
      var atoms: [String] = []
      for sentence in rawSentences {
        if sentence.count <= maxCharacters {
          atoms.append(sentence)
        } else {
          var clauseParts: [String] = []
          var cur = ""
          for char in sentence {
            cur.append(char)
            if delimiters.contains(char) && cur.count >= min(200, maxCharacters / 3) {
              let cl = cur.trimmingCharacters(in: .whitespacesAndNewlines)
              if !cl.isEmpty { clauseParts.append(cl) }
              cur = ""
            }
          }
          let rem = cur.trimmingCharacters(in: .whitespacesAndNewlines)
          if !rem.isEmpty { clauseParts.append(rem) }

          for part in clauseParts {
            if part.count <= maxCharacters {
              atoms.append(part)
            } else {
              let words = part.split(separator: " ").map(String.init)
              var wChunk = ""
              for word in words {
                if word.count > maxCharacters {
                  if !wChunk.isEmpty { atoms.append(wChunk); wChunk = "" }
                  var sub = word
                  while sub.count > maxCharacters {
                    let idx = sub.index(sub.startIndex, offsetBy: maxCharacters)
                    atoms.append(String(sub[..<idx]))
                    sub = String(sub[idx...])
                  }
                  if !sub.isEmpty { wChunk = sub }
                } else if wChunk.isEmpty {
                  wChunk = word
                } else if wChunk.count + 1 + word.count <= maxCharacters {
                  wChunk += " " + word
                } else {
                  atoms.append(wChunk)
                  wChunk = word
                }
              }
              if !wChunk.isEmpty { atoms.append(wChunk) }
            }
          }
        }
      }

      var result: [String] = []
      var current = ""
      for atom in atoms {
        if current.isEmpty {
          current = atom
        } else if current.count + 1 + atom.count <= maxCharacters {
          current += " " + atom
        } else {
          result.append(current)
          current = atom
        }
      }
      if !current.isEmpty { result.append(current) }
      return result
    }

    func speak(voice: AVSpeechSynthesisVoice, text: String) {
      synth.delegate = self
      self.voice = voice
      self.chunks = Self.chunkText(text)
      guard !chunks.isEmpty else {
        emit(["finished": true])
        exit(0)
      }
      self.currentChunkIndex = 0
      self.attempts = 0
      self.isStopped = false
      speakCurrentChunk()
    }

    func speakCurrentChunk() {
      guard !isStopped, let voice = self.voice, currentChunkIndex < chunks.count else {
        emit(["finished": true])
        exit(0)
      }
      let utterance = AVSpeechUtterance(string: chunks[currentChunkIndex])
      utterance.voice = voice
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate
      utterance.postUtteranceDelay = 0.05
      synth.speak(utterance)
    }

    func stop() {
      isStopped = true
      synth.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
      currentChunkIndex += 1
      attempts = 0
      if currentChunkIndex >= chunks.count {
        emit(["finished": true])
        exit(0)
      } else {
        speakCurrentChunk()
      }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
      if isStopped {
        exit(0)
      }
      // Internal synthesis drop/error: retry chunk once before skipping.
      attempts += 1
      if attempts < 2 {
        speakCurrentChunk()
      } else {
        currentChunkIndex += 1
        attempts = 0
        if currentChunkIndex >= chunks.count {
          emit(["finished": true])
          exit(0)
        } else {
          speakCurrentChunk()
        }
      }
    }
  }

  let speaker = PersonalVoiceSpeaker()

  let doSpeak = {
    let allVoices = AVSpeechSynthesisVoice.speechVoices()
    let matched = allVoices.first(where: {
      $0.identifier == rawId || $0.name == rawId ||
      "personal:\($0.identifier)" == requestedVoiceId ||
      "apple-personal:\($0.identifier)" == requestedVoiceId
    })
    // Guess only when the caller named no voice at all. A named-but-absent
    // voice — one not synced to this Mac — must fail loudly rather than be
    // replaced by a different Personal Voice speaking the user's words.
    let voice = matched ?? (rawId.isEmpty
      ? allVoices.first(where: { $0.voiceTraits.contains(.isPersonalVoice) })
      : nil)

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
