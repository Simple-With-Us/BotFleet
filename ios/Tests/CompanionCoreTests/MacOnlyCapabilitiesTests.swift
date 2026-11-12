import Foundation
import XCTest
@testable import CompanionCore

final class MacOnlyCapabilitiesTests: XCTestCase {
    func testMacOnlyCommandTableAndDerivedReason() {
        XCTAssertEqual(
            MacOnlyCapabilities.macOnlyCommands,
            ["xcodebuild", "xcrun", "simctl", "codesign", "notarytool", "osascript", "open"]
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("xcodebuild -scheme App build"),
            DerivedCapability(capability: "macos", command: "xcodebuild", reason: "needs xcodebuild")
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("/usr/bin/codesign --sign - app"),
            DerivedCapability(capability: "macos", command: "codesign", reason: "needs codesign")
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("DEVELOPER_DIR=/x xcrun simctl list")?.command,
            "xcrun"
        )
    }

    func testTreatsSwiftBuildAsMacOnlyOnlyUnderAMacPath() {
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("swift build", cwd: "/Users/jay/app"),
            DerivedCapability(capability: "macos", command: "swift build", reason: "needs swift build")
        )
        XCTAssertNil(MacOnlyCapabilities.derivedCapability("swift build", cwd: "/srv/app"))
        XCTAssertNil(MacOnlyCapabilities.derivedCapability("swift test", cwd: "/Users/jay/app"))
        XCTAssertTrue(MacOnlyCapabilities.isMacPath("/Users"))
        XCTAssertTrue(MacOnlyCapabilities.isMacPath("/Users/jay/app"))
        XCTAssertFalse(MacOnlyCapabilities.isMacPath("/srv/app"))
        XCTAssertFalse(MacOnlyCapabilities.isMacPath(nil))
    }

    func testLeavesOrdinaryCommandsAutomaticAndChecksHostCapabilities() {
        XCTAssertEqual(MacOnlyCapabilities.firstCommandWord("  pnpm test && echo done"), "pnpm")
        XCTAssertNil(MacOnlyCapabilities.derivedCapability("pnpm test"))
        XCTAssertTrue(MacOnlyCapabilities.hostCanRunCommand(capabilities: ["shell"], command: "pnpm test"))
        XCTAssertFalse(MacOnlyCapabilities.hostCanRunCommand(capabilities: ["shell"], command: "open ."))
        XCTAssertTrue(MacOnlyCapabilities.hostCanRunCommand(capabilities: ["shell", "macos"], command: "open ."))

        let linuxOpen = MacOnlyCapabilities.hostCanRunCommand(hostPlatform: "linux", command: "open .")
        XCTAssertFalse(linuxOpen.allowed)
        XCTAssertEqual(linuxOpen.required, DerivedCapability(capability: "macos", command: "open", reason: "needs open"))

        let darwinOpen = MacOnlyCapabilities.hostCanRunCommand(hostPlatform: .darwin, command: "open .")
        XCTAssertTrue(darwinOpen.allowed)
        XCTAssertEqual(darwinOpen.required?.reason, "needs open")
    }

    func testDerivesMacOnlyToolsPastChainsPipesAndWrappers() {
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("pnpm test; xcodebuild -scheme App build")?.command,
            "xcodebuild"
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("pnpm test && xcrun simctl list")?.command,
            "xcrun"
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("echo hi | xcodebuild -version")?.command,
            "xcodebuild"
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("sudo xcodebuild -scheme App build")?.command,
            "xcodebuild"
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("sudo -u worker codesign --sign - app")?.command,
            "codesign"
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("env DEVELOPER_DIR=/x xcrun simctl list")?.command,
            "xcrun"
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("sh -c 'xcodebuild -scheme App build'")?.command,
            "xcodebuild"
        )
        XCTAssertEqual(
            MacOnlyCapabilities.derivedCapability("sudo sh -c 'simctl list'")?.command,
            "simctl"
        )
        XCTAssertFalse(
            MacOnlyCapabilities.hostCanRunCommand(capabilities: ["shell"], command: "sh -c 'xcodebuild -scheme App build'")
        )
        XCTAssertTrue(
            MacOnlyCapabilities.hostCanRunCommand(capabilities: ["shell", "macos"], command: "sh -c 'xcodebuild -scheme App build'")
        )
        XCTAssertNil(MacOnlyCapabilities.derivedCapability("pnpm test && echo done"))
        XCTAssertNil(MacOnlyCapabilities.derivedCapability("sh -c 'pnpm test'"))
    }

    func testCrossLanguageParityWithSharedMacOnlyCapabilitiesTS() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let tsFile = repoRoot.appendingPathComponent("shared/mac-only-capabilities.ts")
        let source = try String(contentsOf: tsFile, encoding: .utf8)

        guard let assignRange = source.range(of: "export const MAC_ONLY_COMMANDS: readonly string[] = ["),
              let closeBracket = source[assignRange.upperBound...].firstIndex(of: "]") else {
            return XCTFail("Could not locate MAC_ONLY_COMMANDS in shared/mac-only-capabilities.ts")
        }

        let arrayBody = String(source[assignRange.upperBound..<closeBracket])
        let regex = try NSRegularExpression(pattern: #""([^"]+)""#)
        let matches = regex.matches(in: arrayBody, range: NSRange(arrayBody.startIndex..., in: arrayBody))
        let tsCommands = matches.compactMap { match -> String? in
            guard let range = Range(match.range(at: 1), in: arrayBody) else { return nil }
            return String(arrayBody[range])
        }

        XCTAssertEqual(MacOnlyCapabilities.macOnlyCommands, tsCommands)
        for command in tsCommands {
            let derived = MacOnlyCapabilities.derivedCapability(forCommand: command)
            XCTAssertEqual(derived?.capability, "macos")
            XCTAssertEqual(derived?.command, command)
            XCTAssertEqual(derived?.reason, "needs \(command)")
            XCTAssertEqual(MacOnlyCapabilities.macOnlyCommandReasons[command], "needs \(command)")
        }
    }
}
