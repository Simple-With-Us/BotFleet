import Foundation
import Sentry
import CompanionCore

/// Native Sentry startup for the macOS desktop app.
///
/// This is the thin half of BF-2541:  every decision (may Sentry activate,
/// which release stamp, which restrictive contract) lives in
/// `MacSentryPolicy` in CompanionCore where the unit tests cover it, and
/// this starter only reads the bundle keys and hands the assembled contract
/// to the SDK.  The policy mirrors Electron's `initDesktopSentry`:  no
/// default PII, no screenshots, no view hierarchies, request headers
/// stripped, and query tokens redacted before anything leaves the Mac.
///
/// The app stays inert unless the build stamps an HTTPS `SENTRY_DSN` into
/// the Info.plist (declared as `$(SENTRY_DSN)` for the BotFleetMac target
/// in project.yml, empty by default), and `shouldActivateSentry` keeps test
/// runners from ever activating.
enum MacSentryTelemetry {
    static func start() {
        let dsn = (Bundle.main.object(forInfoDictionaryKey: "SENTRY_DSN") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bundleCommit = Bundle.main.object(forInfoDictionaryKey: "SOURCE_COMMIT") as? String
        guard let contract = MacSentryPolicy.desktopOptions(dsn: dsn, bundleCommit: bundleCommit) else {
            return
        }

        SentrySDK.start { options in
            options.dsn = contract.dsn
            options.environment = contract.environment
            if let release = contract.release {
                options.releaseName = release
            }
            options.sendDefaultPii = contract.sendDefaultPii
            #if !os(macOS)
            // The macOS SDK has no screenshot or view-hierarchy capture
            // options; the contract's false is already the only possible
            // value there.
            options.attachScreenshot = contract.attachScreenshot
            options.attachViewHierarchy = contract.attachViewHierarchy
            #endif
            #if !os(macOS)
            // Session replay is not part of the macOS SDK surface in
            // sentry-cocoa 9, so there is nothing to mask there yet; the
            // contract fields stay the record of what must be set if a
            // replay capture ever reaches the Mac.
            options.sessionReplay.maskAllText = contract.sessionReplayMaskAllText
            options.sessionReplay.maskAllImages = contract.sessionReplayMaskAllImages
            #endif
            options.beforeSend = { event in
                if let request = event.request {
                    let scrubbed = MacSentryPolicy.scrubRequest(
                        url: request.url.flatMap(URL.init(string:)),
                        headers: request.headers
                    )
                    request.url = scrubbed.sanitizedURL?.absoluteString
                    request.headers = scrubbed.scrubbedHeaders
                }
                return event
            }
            options.beforeBreadcrumb = { breadcrumb in
                if let url = breadcrumb.data?["url"] as? String {
                    breadcrumb.data?["url"] = MacSentryPolicy.scrubBreadcrumbURL(url)
                }
                return breadcrumb
            }
        }
    }
}
