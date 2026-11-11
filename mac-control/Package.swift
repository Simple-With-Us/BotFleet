// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BotFleetControl",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "BotFleetControl", targets: ["BotFleetControl"])
    ],
    targets: [
        .target(name: "BotFleetControlCore"),
        .executableTarget(name: "BotFleetControl", dependencies: ["BotFleetControlCore"]),
        .testTarget(name: "BotFleetControlCoreTests", dependencies: ["BotFleetControlCore"])
    ]
)
