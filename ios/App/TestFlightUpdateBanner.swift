// The "a newer TestFlight build exists" notice: on launch and on becoming
// active, rate-limited to once an hour, this phone checks the fleet's
// published manifest and offers to open TestFlight when it is behind.
//
// Deliberately separate from `Session`: this has nothing to do with the
// paired Mac and must work identically whether or not one is connected, so
// it owns its own tiny bit of `UserDefaults` state instead of borrowing
// Session's.
import CompanionCore
import SwiftUI
import UIKit

/// Drives the once-an-hour manifest check and remembers what has already
/// been dismissed, so relaunching the app does not resurface a banner the
/// person already closed for that exact build.
@MainActor
final class TestFlightUpdateMonitor: ObservableObject {
    @Published private(set) var available: AppBuildInfo?
    @Published private(set) var dismissed = false

    private let fetcher: VersionManifestFetcher
    private let running: AppBuildInfo
    private let defaults: UserDefaults

    private enum Keys {
        static let lastCheckedAt = "companion.testflight.lastCheckedAt"
        static let dismissedBuild = "companion.testflight.dismissedBuild"
        /// The last offer a check actually found.  Persisted for the same
        /// reason the dismissal is: the throttle stamp survives a relaunch,
        /// so without this an undismissed banner vanished for up to an hour
        /// after one — the fresh monitor started with `available == nil` and
        /// `checkIfDue` returned at the throttle guard before it could ever
        /// find out otherwise.
        static let candidateBuild = "companion.testflight.candidateBuild"
        static let candidateVersion = "companion.testflight.candidateVersion"
    }

    init(
        fetcher: VersionManifestFetcher = VersionManifestFetcher(),
        running: AppBuildInfo = TestFlightUpdateMonitor.runningBuild(),
        defaults: UserDefaults = .standard
    ) {
        self.fetcher = fetcher
        self.running = running
        self.defaults = defaults
    }

    var shouldShowBanner: Bool { available != nil && !dismissed }

    /// Reads the running app's own stamped version — real `Info.plist`
    /// values in production, and whatever a test constructs otherwise.
    ///
    /// `nonisolated` on purpose: it only reads `Bundle.infoDictionary`, which
    /// needs no actor, and it is called from `init`'s default-argument
    /// expression above — default argument generators are their own
    /// synchronous, nonisolated functions regardless of the enclosing type's
    /// actor, so a plain `@MainActor`-inferred member cannot be called from
    /// one without this.
    nonisolated static func runningBuild(bundle: Bundle = .main) -> AppBuildInfo {
        AppBuildInfo(
            marketingVersion: bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            build: bundle.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        )
    }

    /// Called on launch and every time the app becomes active.  Fails
    /// silently offline or on any other error — this must never be the
    /// reason someone sees an error dialog for a feature they did not ask
    /// about, and a failed check today does not block one at the next
    /// opportunity.
    func checkIfDue(now: Date = Date()) async {
        // Before the guard, not after: a throttled launch has to render the
        // offer it already knows about rather than silently showing nothing.
        restorePersistedCandidate()
        let last = defaults.object(forKey: Keys.lastCheckedAt) as? Date
        guard TestFlightCheckThrottle.isDue(lastCheckedAt: last, now: now) else { return }
        // Stamped before the fetch so launch plus the immediate
        // `.active` scene phase collapse to one request, and rolled back in
        // the catch below so a failure costs nothing.
        defaults.set(now, forKey: Keys.lastCheckedAt)
        do {
            let manifest = try await fetcher.fetch()
            guard let candidate = TestFlightUpdateCheck.availableUpdate(in: manifest, running: running) else {
                available = nil
                defaults.removeObject(forKey: Keys.candidateBuild)
                defaults.removeObject(forKey: Keys.candidateVersion)
                return
            }
            available = candidate
            defaults.set(candidate.build, forKey: Keys.candidateBuild)
            defaults.set(candidate.marketingVersion, forKey: Keys.candidateVersion)
            // Restore the persisted dismissal rather than only ever
            // clearing it: a fresh monitor (every relaunch) starts with
            // `dismissed == false` regardless of what was on record, so
            // only ever setting it back to `false` here left a dismissed
            // build's banner reappearing on the very next launch while it
            // was still current.  A build newer than the one on record
            // still correctly comes back false, which is what lets it
            // reopen the banner.
            dismissed = TestFlightUpdateCheck.isDismissed(
                candidateBuild: candidate.build,
                dismissedBuild: defaults.string(forKey: Keys.dismissedBuild)
            )
        } catch {
            // offline, DNS hiccup, GitHub Pages blip — none of it is worth
            // surfacing for a feature nobody asked to see right now.  It is
            // worth un-spending the hour, though: a check that learned
            // nothing must not be the reason the next foreground does not
            // try, which is what the comment above promises and what
            // stamping before the fetch would otherwise break.
            if let last {
                defaults.set(last, forKey: Keys.lastCheckedAt)
            } else {
                defaults.removeObject(forKey: Keys.lastCheckedAt)
            }
        }
    }

    /// Puts the last offer a check found back in `available`, so a relaunch
    /// inside the throttle window still shows it.
    ///
    /// Re-checked against the running build rather than trusted: this phone
    /// may have installed that very build since, in which case the record is
    /// stale and belongs gone.  The dismissal comparison runs here too, for
    /// the same reason it runs after a live fetch — a fresh monitor has no
    /// in-memory memory of what was closed.
    private func restorePersistedCandidate() {
        guard available == nil,
              let build = defaults.string(forKey: Keys.candidateBuild),
              let marketingVersion = defaults.string(forKey: Keys.candidateVersion)
        else { return }
        let candidate = AppBuildInfo(marketingVersion: marketingVersion, build: build)
        guard TestFlightUpdateCheck.isNewer(candidate, than: running) else {
            defaults.removeObject(forKey: Keys.candidateBuild)
            defaults.removeObject(forKey: Keys.candidateVersion)
            return
        }
        available = candidate
        dismissed = TestFlightUpdateCheck.isDismissed(
            candidateBuild: build,
            dismissedBuild: defaults.string(forKey: Keys.dismissedBuild)
        )
    }

    func dismiss() {
        guard let available else { return }
        dismissed = true
        defaults.set(available.build, forKey: Keys.dismissedBuild)
    }
}

/// The dismissible strip itself.  Placed as a `safeAreaInset` at the root so
/// it pushes content down rather than covering it, the way the rest of the
/// app's transient banners behave.
struct TestFlightUpdateBanner: View {
    @ObservedObject var monitor: TestFlightUpdateMonitor

    var body: some View {
        if let available = monitor.available, monitor.shouldShowBanner {
            HStack(spacing: 12) {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 1) {
                    Text("A newer TestFlight build (\(available.marketingVersion) (\(available.build))) is available")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("Open TestFlight") {
                    openTestFlight()
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                Button {
                    monitor.dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.thinMaterial)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// `itms-beta://` opens TestFlight directly when it is installed.  There
    /// is no reliable, undocumented-scheme-free way to deep link straight to
    /// this app's own beta page from just an App Store id — a proper
    /// `testflight.apple.com/join/...` link needs the invite code, which the
    /// manifest does not carry — so this opens TestFlight itself and falls
    /// back to TestFlight's own App Store page when it is not installed,
    /// exactly as the brief asks.
    ///
    /// Uses the `async` `open(_:)` overload rather than the completion-handler
    /// one, the same way `ConnectedAppsView.authorize(_:alias:)` and
    /// `Session.enableNotifications()` already do — one proven-to-compile
    /// shape for "open a URL and act on whether it worked" rather than a
    /// second one whose completion-closure actor isolation this file would
    /// otherwise have to get right on its own.
    private func openTestFlight() {
        Task {
            guard let testFlight = URL(string: "itms-beta://") else { return }
            let opened = await UIApplication.shared.open(testFlight)
            guard !opened, let appStore = URL(string: "https://apps.apple.com/app/testflight/id899247664") else { return }
            await UIApplication.shared.open(appStore)
        }
    }
}
