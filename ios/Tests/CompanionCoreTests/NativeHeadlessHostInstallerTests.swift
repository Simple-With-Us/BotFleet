#if os(macOS)
import Foundation
import Testing
@testable import CompanionCore

/// Installer tests run only in temporary directories with a fake executable and a fake
/// signature inspector.  Nothing here registers with launchd or touches a system location.
@Suite("Native Headless Host Installer", .serialized)
struct NativeHeadlessHostInstallerTests {
    @Test("Install, validate, and uninstall round-trip in a temporary directory")
    func roundTrip() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        let installer = fixture.installer()
        let validation = try installer.validate()
        #expect(validation.signingIdentity.teamIdentifier == "TEAMFIXTURE1")
        #expect(!FileManager.default.fileExists(atPath: fixture.destination.path))
        let result = try installer.install()
        #expect(result.outcome == .installed)
        #expect(result.plistURL == fixture.destination)
        let parsed = try #require(NativeHeadlessHostInstaller.parsedPlist(at: fixture.destination))
        #expect(parsed["Label"] as? String == "app.botfleet.nativehost")
        #expect(parsed["ProgramArguments"] as? [String] == [fixture.executable.path, "--service-data", fixture.dataRoot.path])
        #expect(parsed["RunAtLoad"] as? Bool == true)
        #expect(parsed["UserName"] == nil)
        #expect(installer.verifyInstalled())
        // The install provisions the private service root, and uninstall never deletes its data.
        let sentinel = fixture.dataRoot.appendingPathComponent("keep-me")
        try Data("service data".utf8).write(to: sentinel)
        #expect(try installer.uninstall())
        #expect(!FileManager.default.fileExists(atPath: fixture.destination.path))
        #expect(FileManager.default.fileExists(atPath: sentinel.path))
        #expect(!installer.verifyInstalled())
        #expect(try !installer.uninstall())
    }

    @Test("The rendered plist carries no credential material or credential environment")
    func plistHasNoCredentials() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        let rendered = try fixture.installer().renderedPlistDictionary()
        #expect(rendered["EnvironmentVariables"] as? [String: String] == ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"])
        let keys = rendered.keys.joined(separator: " ").lowercased()
        #expect(!keys.contains("credential") && !keys.contains("secret") && !keys.contains("token") && !keys.contains("keychain"))
    }

    @Test("A mismatched signing identity is refused before anything is written")
    func refusalOnIdentityMismatch() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        let wrongTeam = fixture.installer(inspector: FakeSignatureInspector(identity:
            NativeHostSigningIdentity(codeIdentifier: "BotFleetNativeHost", teamIdentifier: "WRONGTEAM99", signingFlags: 0)))
        #expect(throws: NativeHeadlessHostInstallerError.identityMismatch) { _ = try wrongTeam.install() }
        let adHoc = fixture.installer(inspector: FakeSignatureInspector(identity:
            NativeHostSigningIdentity(codeIdentifier: "BotFleetNativeHost", teamIdentifier: "TEAMFIXTURE1", signingFlags: 0x0002)))
        #expect(throws: NativeHeadlessHostInstallerError.identityMismatch) { _ = try adHoc.install() }
        #expect(!FileManager.default.fileExists(atPath: fixture.destination.path))
        #expect(try fixture.launchdContents().isEmpty)
    }

    @Test("The production inspector refuses an unsigned fake executable")
    func refusalOnUnsignedExecutable() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        let installer = NativeHeadlessHostInstaller(configuration: fixture.configuration())
        #expect(throws: NativeHeadlessHostInstallerError.signatureValidationFailed) { _ = try installer.install() }
        #expect(!FileManager.default.fileExists(atPath: fixture.destination.path))
    }

    @Test("An injected failure before commit leaves no partial plist or temporary file")
    func rollbackOnFreshInstall() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        var installer = fixture.installer()
        installer.beforeCommitHook = { throw InjectedInstallerFailure() }
        #expect(throws: InjectedInstallerFailure.self) { _ = try installer.install() }
        #expect(!FileManager.default.fileExists(atPath: fixture.destination.path))
        #expect(try fixture.launchdContents().isEmpty)
    }

    @Test("An injected failure during replacement restores the previous plist exactly")
    func rollbackRestoresPrevious() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        _ = try fixture.installer().install()
        let original = try Data(contentsOf: fixture.destination)
        var updating = fixture.installer(serviceUserName: "_botfleet")
        updating.afterBackupHook = { throw InjectedInstallerFailure() }
        #expect(throws: InjectedInstallerFailure.self) { _ = try updating.install() }
        #expect(try Data(contentsOf: fixture.destination) == original)
        #expect(try fixture.launchdContents() == [fixture.destination.lastPathComponent])
        #expect(fixture.installer().verifyInstalled())
    }

    @Test("Re-installing an unchanged configuration is idempotent")
    func idempotentReinstall() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        let installer = fixture.installer()
        #expect(try installer.install().outcome == .installed)
        let attributes = try FileManager.default.attributesOfItem(atPath: fixture.destination.path)
        let inode = try #require(attributes[.systemFileNumber] as? NSNumber)
        let modified = try #require(attributes[.modificationDate] as? Date)
        #expect(try installer.install().outcome == .alreadyInstalled)
        let again = try FileManager.default.attributesOfItem(atPath: fixture.destination.path)
        #expect(again[.systemFileNumber] as? NSNumber == inode)
        #expect(again[.modificationDate] as? Date == modified)
        // A changed configuration updates in place instead of duplicating.
        #expect(try fixture.installer(serviceUserName: "_botfleet").install().outcome == .updated)
        let parsed = try #require(NativeHeadlessHostInstaller.parsedPlist(at: fixture.destination))
        #expect(parsed["UserName"] as? String == "_botfleet")
        #expect(try fixture.launchdContents() == [fixture.destination.lastPathComponent])
    }

    @Test("A foreign plist at the destination is never overwritten or removed")
    func foreignPlistRefused() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        let foreign: [String: Any] = ["Label": "com.example.other", "ProgramArguments": ["/usr/bin/true"]]
        try PropertyListSerialization.data(fromPropertyList: foreign, format: .xml, options: 0).write(to: fixture.destination)
        let original = try Data(contentsOf: fixture.destination)
        let installer = fixture.installer()
        #expect(throws: NativeHeadlessHostInstallerError.foreignPlistPresent) { _ = try installer.install() }
        #expect(throws: NativeHeadlessHostInstallerError.foreignPlistPresent) { _ = try installer.uninstall() }
        #expect(try Data(contentsOf: fixture.destination) == original)
    }

    @Test("An interactive data root is refused")
    func interactiveRootRefused() throws {
        let fixture = try InstallerFixture()
        defer { fixture.remove() }
        try FileManager.default.createDirectory(at: fixture.dataRoot, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try Data("{}".utf8).write(to: fixture.dataRoot.appendingPathComponent("config.json"))
        #expect(throws: NativeHeadlessHostInstallerError.invalidDataRoot) { _ = try fixture.installer().install() }
        #expect(!FileManager.default.fileExists(atPath: fixture.destination.path))
    }
}

private struct InjectedInstallerFailure: Error {}

private struct FakeSignatureInspector: NativeHostSignatureInspecting {
    let identity: NativeHostSigningIdentity?
    func signingIdentity(ofExecutableAt url: URL) -> NativeHostSigningIdentity? { identity }
}

private struct InstallerFixture {
    let parent: URL
    var executable: URL { parent.appendingPathComponent("BotFleetNativeHost") }
    var dataRoot: URL { parent.appendingPathComponent("service-data", isDirectory: true) }
    var launchdDirectory: URL { parent.appendingPathComponent("launchd", isDirectory: true) }
    var destination: URL { launchdDirectory.appendingPathComponent("app.botfleet.nativehost.plist") }

    init() throws {
        parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("native-host-installer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: launchdDirectory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }

    func configuration(serviceUserName: String? = nil) -> NativeHeadlessHostInstallConfiguration {
        NativeHeadlessHostInstallConfiguration(executable: executable, serviceDataRoot: dataRoot,
                                               plistDestination: destination, serviceUserName: serviceUserName,
                                               expectedTeamIdentifier: "TEAMFIXTURE1")
    }

    func installer(serviceUserName: String? = nil,
                   inspector: any NativeHostSignatureInspecting = FakeSignatureInspector(identity:
                       NativeHostSigningIdentity(codeIdentifier: "BotFleetNativeHost",
                                                 teamIdentifier: "TEAMFIXTURE1", signingFlags: 0)))
        -> NativeHeadlessHostInstaller {
        NativeHeadlessHostInstaller(configuration: configuration(serviceUserName: serviceUserName), inspector: inspector)
    }

    func launchdContents() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: launchdDirectory.path).sorted()
    }

    func remove() { try? FileManager.default.removeItem(at: parent) }
}
#endif
