// swift-tools-version: 6.4
// 6.4 is the first PackageDescription with `.iOS(.v27)` (Xcode 27.0).
// swiftLanguageModes keeps the Swift 5 language mode the package had under
// tools 5.9, so the bump does not also switch on Swift 6 strict concurrency.
import PackageDescription

// CompanionCore is everything the phone knows that is not a view: the wire
// types, the SSE parser, the API client, and the fold that maintains state.
// It is a package rather than app-target source so it can be built and
// tested with `swift test` alone — no Xcode, no simulator, no signing —
// which is also what lets the decoding tests run against fixtures captured
// from a real harness.
let package = Package(
    name: "CompanionCore",
    // macOS 13 rather than 14: the core needs nothing newer than
    // URLSession.bytes (macOS 12), and `swift test` should run on whatever
    // Mac is to hand. The app's iOS 27 floor lives in project.yml.
    platforms: [.iOS(.v27), .macOS(.v13)],
    products: [
        .library(name: "CompanionCore", targets: ["CompanionCore"])
    ],
    targets: [
        .target(name: "CompanionCore"),
        .testTarget(
            name: "CompanionCoreTests",
            dependencies: ["CompanionCore"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
