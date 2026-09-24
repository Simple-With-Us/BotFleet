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
            options.profilesSampleRate = 0.1
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.sessionReplay.sessionSampleRate = 0.1
            options.sessionReplay.onErrorSampleRate = 1.0
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
