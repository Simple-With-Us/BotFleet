import Foundation
import Sentry
import CompanionCore

/// Native Sentry crash reporting and telemetry for BotFleet iOS Companion.
enum SentryTelemetry {
    static func start() {
        let dsn = (Bundle.main.object(forInfoDictionaryKey: "SENTRY_DSN") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard dsn.hasPrefix("https://") else { return }

        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = "production"
            options.tracesSampleRate = 0.2
            // sentry-cocoa 9 removed transaction-based profilesSampleRate.
            options.configureProfiling = {
                $0.sessionSampleRate = 0.1
                $0.lifecycle = .trace
            }
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.sessionReplay.sessionSampleRate = 0.1
            // A Mac-offline window means Cloudflare answers every companion
            // request with a 502/503/530-family status, and the old value
            // (1.0) armed a full session-replay upload for every one of
            // those — on top of the events `beforeSend` below already
            // drops. 10% still catches a real crash without paying for a
            // gateway-outage storm. See IO10.
            options.sessionReplay.onErrorSampleRate = 0.1
            options.sessionReplay.maskAllText = true
            options.sessionReplay.maskAllImages = true
            options.beforeSend = { event in
                if Self.isExpectedPairedGatewayOfflineResponse(event) {
                    return nil
                }
                if let request = event.request, let url = request.url {
                    var sanitized = url
                    for param in ["token", "key", "secret", "auth", "password"] {
                        sanitized = sanitized.replacingOccurrences(
                            of: "([?&]\(param)=)[^&#\\s]+",
                            with: "$1[REDACTED]",
                            options: .regularExpression
                        )
                    }
                    request.url = sanitized
                }
                return event
            }
        }
    }

    private static func isExpectedPairedGatewayOfflineResponse(_ event: Event) -> Bool {
        guard event.exceptions?.contains(where: { $0.type == "HTTPClientError" }) == true,
              let response = event.context?["response"],
              let statusCode = (response["status_code"] as? NSNumber)?.intValue
        else { return false }

        let pairedConnection = UserDefaults.standard.data(forKey: Session.connectionKey)
            .flatMap { try? JSONDecoder().decode(Connection.self, from: $0) }
        // sentry-cocoa's failed-request context has status_code, sanitized
        // headers, and body_size; the body itself is never captured.
        return CompanionGatewayFailurePolicy.shouldSuppress(
            statusCode: statusCode,
            responseHeaders: response["headers"] as? [String: String],
            requestURL: event.request?.url,
            pairedConnection: pairedConnection
        )
    }
}

/// Voice failures as non-fatal Sentry events.
///
/// Failed-request capture above records 5xx only, so a 413 "reply exceeds
/// voice clip limit", a 409 credential wait, and everything the on-device
/// synthesizer does were invisible.  These events carry counts, status
/// codes, and the harness's fixed error strings, never message text,
/// utterances, voice summaries, or Personal Voice names (which people
/// choose themselves).
enum VoiceTelemetry {
    enum Engine: String {
        case personal
        case hosted
    }

    /// A 4xx from POST /audio or a clip GET.  5xx is already captured as a
    /// failed request; cancellation and transport failures are not voice
    /// problems.
    static func audioRequestFailed(_ error: Error, stage: String, engine: Engine) {
        guard let api = error as? APIError, let code = api.statusCode, (400..<500).contains(code) else { return }
        capture("Voice: audio request rejected", kind: "audio-\(stage)", extraTags: [
            "voice.engine": engine.rawValue,
            "voice.status": String(code),
        ], extras: [
            "error": api.errorDescription ?? "",
        ])
    }

    /// An utterance that kept cancelling was skipped so the read could go on.
    static func synthesizerGaveUp(characters: Int, attempts: Int) {
        capture("Voice: Personal Voice gave up on an utterance", kind: "synthesizer-gave-up", extraTags: [
            "voice.engine": Engine.personal.rawValue,
        ], extras: [
            "characters": characters,
            "attempts": attempts,
        ])
    }

    /// The synthesizer stopped reporting progress and the watchdog ended
    /// the utterance.
    static func watchdogTripped(characters: Int, attempt: Int, sawWordProgress: Bool) {
        capture("Voice: Personal Voice stalled", kind: "watchdog", extraTags: [
            "voice.engine": Engine.personal.rawValue,
            "voice.word_progress": sawWordProgress ? "yes" : "no",
        ], extras: [
            "characters": characters,
            "attempt": attempt,
        ])
    }

    /// The bot's iPhone voice is a Personal Voice this iPhone does not have.
    static func personalVoiceMissing() {
        capture("Voice: Personal Voice not on this device", kind: "voice-missing", level: .info, extraTags: [
            "voice.engine": Engine.personal.rawValue,
        ], extras: [:])
    }

    /// Any other failure that ended a read (a playback error, a thrown
    /// synthesizer error).  Only the error's type and status are kept.
    static func playbackFailed(_ error: Error, engine: Engine) {
        if let api = error as? APIError, api.statusCode != nil { return }
        capture("Voice: playback failed", kind: "playback", extraTags: [
            "voice.engine": engine.rawValue,
        ], extras: [
            "error_type": String(describing: type(of: error)),
        ])
    }

    private static func capture(
        _ message: String,
        kind: String,
        level: SentryLevel = .warning,
        extraTags: [String: String],
        extras: [String: Any]
    ) {
        SentrySDK.capture(message: message) { scope in
            scope.setLevel(level)
            scope.setTag(value: kind, key: "voice.kind")
            for (key, value) in extraTags { scope.setTag(value: value, key: key) }
            for (key, value) in extras { scope.setExtra(value: value, key: key) }
            scope.setFingerprint(["voice", kind, extraTags["voice.status"] ?? ""])
        }
    }
}
