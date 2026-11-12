import Foundation
import Combine
import Sparkle
import CompanionCore

/// Retain one instance for the app lifetime; lifecycle and termination remain owned by the app.
@MainActor
final class NativeMacUpdater {
    let service: NativeUpdateService

    init(defaults: UserDefaults = .standard) {
        let bundle = Bundle.main
        let configuration = try? NativeUpdateConfiguration(
            feedURL: bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
            publicKey: bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String)
        service = NativeUpdateService(configuration: configuration,
            store: NativeUpdateDefaultsStore(defaults: defaults),
            fingerprint: {
                // Version alone misses replacement of a locally rebuilt bundle.
                let info = bundle.infoDictionary ?? [:]
                let modified = bundle.executableURL.flatMap { try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate }
                return [info["CFBundleVersion"] as? String ?? "", info["SOURCE_COMMIT"] as? String ?? "",
                        String(modified?.timeIntervalSince1970 ?? 0)].joined(separator: ":")
            }, makeDriver: { SparkleNativeUpdateDriver(configuration: $0) })
    }
}

/// Sparkle's standard user driver performs download, signature verification and installation.
@MainActor
private final class SparkleNativeUpdateDriver: NSObject, NativeUpdateDriver, SPUUpdaterDelegate {
    var onEvent: ((NativeUpdateEvent) -> Void)?
    var mayPerformCheck: ((Bool) -> Bool)?
    private var controller: SPUStandardUpdaterController!
    private var observations: [NSKeyValueObservation] = []
    private let configuration: NativeUpdateConfiguration
    private static let policyDomain = "app.botfleet.native-update-policy"

    init(configuration: NativeUpdateConfiguration) {
        self.configuration = configuration
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    }

    var canCheckForUpdates: Bool { controller.updater.canCheckForUpdates }
    var automaticChecksEnabled: Bool {
        get { controller.updater.automaticallyChecksForUpdates }
        set { controller.updater.automaticallyChecksForUpdates = newValue }
    }
    var checkInterval: TimeInterval {
        get { controller.updater.updateCheckInterval }
        set { controller.updater.updateCheckInterval = newValue }
    }
    func start() throws {
        // Clear Sparkle's legacy feed override; the reviewed bundle metadata is authoritative.
        controller.updater.clearFeedURLFromUserDefaults()
        observations = [controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
            Task { @MainActor [weak self] in self?.onEvent?(.availabilityChanged(updater.canCheckForUpdates)) }
        }, controller.updater.observe(\.automaticallyChecksForUpdates, options: [.new]) { [weak self] updater, _ in
            Task { @MainActor [weak self] in self?.onEvent?(.availabilityChanged(updater.canCheckForUpdates)) }
        }]
        try controller.updater.start()
    }
    func checkForUpdates() { controller.checkForUpdates(nil) }
    func checkForUpdatesOnLaunch() { controller.updater.checkForUpdatesInBackground() }

    func feedURLString(for updater: SPUUpdater) -> String? { configuration.feedURL.absoluteString }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard mayPerformCheck?(updateCheck != .updates) == true else {
            throw NSError(domain: Self.policyDomain, code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "The next automatic update check is scheduled for later."])
        }
    }
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        onEvent?(.found(version: item.displayVersionString))
    }
    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        onEvent?(.downloading(version: item.displayVersionString))
    }
    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
        onEvent?(.downloaded(version: item.displayVersionString))
    }
    func userDidCancelDownload(_ updater: SPUUpdater) { onEvent?(.downloadCancelled) }
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        let failure = error as NSError?
        if failure?.domain == Self.policyDomain { return }
        // No new version and a cancelled authorization are ordinary completed checks.
        let ordinary = failure == nil || (failure?.domain == SUSparkleErrorDomain &&
            [Int(SUError.noUpdateError.rawValue), Int(SUError.installationCanceledError.rawValue)].contains(failure!.code))
        onEvent?(.finished(failureClass: ordinary ? nil : "\(failure!.domain):\(failure!.code)"))
    }
}
