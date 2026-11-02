import Foundation

#if os(macOS)
import Darwin
import Security

public enum NativeHeadlessHostInstallerError: Error, Equatable, Sendable {
    case invalidLabel
    case invalidServiceUserName
    case invalidExecutable
    case signatureValidationFailed
    case identityMismatch
    case invalidDataRoot
    case invalidPlistDestination
    case foreignPlistPresent
    case writeFailed
    case removeFailed
}

/// Everything an opt-in install needs, supplied explicitly by the caller.  The installer never
/// chooses a system destination, creates a service account, registers with launchd, or touches
/// credentials: the installed host keeps the default `UnavailableNativeServiceCredentials`
/// source until a separately approved credential design exists.
public struct NativeHeadlessHostInstallConfiguration: Sendable {
    public let label: String
    public let executable: URL
    public let serviceDataRoot: URL
    /// Caller-provided plist path; its file name must be `<label>.plist` and its parent must exist.
    public let plistDestination: URL
    /// Optional launchd `UserName`.  The account itself is provisioned outside this installer.
    public let serviceUserName: String?
    public let expectedTeamIdentifier: String
    public let expectedCodeIdentifier: String

    public init(label: String = "app.botfleet.nativehost",
                executable: URL,
                serviceDataRoot: URL,
                plistDestination: URL,
                serviceUserName: String? = nil,
                expectedTeamIdentifier: String = SigningIdentityVerifier.expectedTeamID,
                expectedCodeIdentifier: String = "BotFleetNativeHost") {
        self.label = label
        self.executable = executable
        self.serviceDataRoot = serviceDataRoot
        self.plistDestination = plistDestination
        self.serviceUserName = serviceUserName
        self.expectedTeamIdentifier = expectedTeamIdentifier
        self.expectedCodeIdentifier = expectedCodeIdentifier
    }
}

public struct NativeHostSigningIdentity: Equatable, Sendable {
    public let codeIdentifier: String?
    public let teamIdentifier: String?
    public let signingFlags: UInt32

    public init(codeIdentifier: String?, teamIdentifier: String?, signingFlags: UInt32) {
        self.codeIdentifier = codeIdentifier
        self.teamIdentifier = teamIdentifier
        self.signingFlags = signingFlags
    }

    /// kSecCodeSignatureAdhoc == 0x0002, matching `SigningIdentityVerifier.evaluate`.
    public var isAdHoc: Bool { (signingFlags & 0x0002) != 0 || (teamIdentifier ?? "").isEmpty }
}

/// Reads the code-signing identity of an executable.  `nil` means the code object could not be
/// created or did not pass validity checks, which the installer treats as a refusal.
public protocol NativeHostSignatureInspecting: Sendable {
    func signingIdentity(ofExecutableAt url: URL) -> NativeHostSigningIdentity?
}

public struct SecCodeNativeHostSignatureInspector: NativeHostSignatureInspecting {
    public init() {}

    public func signingIdentity(ofExecutableAt url: URL) -> NativeHostSigningIdentity? {
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &staticCode) == errSecSuccess,
              let code = staticCode,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSCheckAllArchitectures), nil) == errSecSuccess
        else { return nil }
        var infoCF: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF) == errSecSuccess,
              let info = infoCF as? [String: Any] else { return nil }
        return NativeHostSigningIdentity(
            codeIdentifier: info[kSecCodeInfoIdentifier as String] as? String,
            teamIdentifier: info[kSecCodeInfoTeamIdentifier as String] as? String,
            signingFlags: (info[kSecCodeInfoFlags as String] as? UInt32) ?? 0)
    }
}

public struct NativeHeadlessHostInstallValidation: Sendable {
    public let executable: URL
    public let signingIdentity: NativeHostSigningIdentity
    public let serviceDataRoot: URL
    public let plistDestination: URL
}

public enum NativeHeadlessHostInstallOutcome: Equatable, Sendable {
    case installed
    case updated
    case alreadyInstalled
}

public struct NativeHeadlessHostInstallResult: Sendable {
    public let plistURL: URL
    public let outcome: NativeHeadlessHostInstallOutcome
}

/// Opt-in, reversible installer for the optional pre-login native host.  It validates the host
/// binary and service data root, renders the launchd definition, and writes it atomically to a
/// caller-provided destination with rollback on failure.  It never runs launchctl, never
/// creates accounts, and its uninstall removes exactly the plist it wrote — never service data.
public struct NativeHeadlessHostInstaller: Sendable {
    public let configuration: NativeHeadlessHostInstallConfiguration
    private let inspector: any NativeHostSignatureInspecting
    // Test-only fault seams, exercised by CompanionCoreTests to prove rollback.  Nil in production.
    var beforeCommitHook: (@Sendable () throws -> Void)?
    var afterBackupHook: (@Sendable () throws -> Void)?

    public init(configuration: NativeHeadlessHostInstallConfiguration,
                inspector: any NativeHostSignatureInspecting = SecCodeNativeHostSignatureInspector()) {
        self.configuration = configuration
        self.inspector = inspector
    }

    // MARK: - Validation (read-only)

    public func validate() throws -> NativeHeadlessHostInstallValidation {
        let config = configuration
        guard !config.label.isEmpty,
              config.label.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil
        else { throw NativeHeadlessHostInstallerError.invalidLabel }
        if let user = config.serviceUserName {
            guard !user.isEmpty, user.range(of: #"^[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil
            else { throw NativeHeadlessHostInstallerError.invalidServiceUserName }
        }
        let executable = try Self.validatedExecutable(config.executable)
        guard let identity = inspector.signingIdentity(ofExecutableAt: executable) else {
            throw NativeHeadlessHostInstallerError.signatureValidationFailed
        }
        guard !identity.isAdHoc,
              identity.codeIdentifier == config.expectedCodeIdentifier,
              identity.teamIdentifier == config.expectedTeamIdentifier
        else { throw NativeHeadlessHostInstallerError.identityMismatch }
        let dataRoot = try Self.validatedDataRoot(config.serviceDataRoot)
        let destination = try Self.validatedDestination(config.plistDestination, label: config.label)
        return NativeHeadlessHostInstallValidation(executable: executable, signingIdentity: identity,
                                                   serviceDataRoot: dataRoot, plistDestination: destination)
    }

    private static func validatedExecutable(_ url: URL) throws -> URL {
        guard url.isFileURL, url.path.hasPrefix("/"), !url.path.contains("\0") else {
            throw NativeHeadlessHostInstallerError.invalidExecutable
        }
        let standardized = url.standardizedFileURL
        var info = stat()
        // lstat + S_IFREG also refuses symlinks; a daemon binary must not be group/world-writable.
        guard lstat(standardized.path, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid() || info.st_uid == 0,
              info.st_mode & 0o022 == 0,
              info.st_mode & 0o100 != 0
        else { throw NativeHeadlessHostInstallerError.invalidExecutable }
        return standardized
    }

    /// Mirrors `NativeServicePaths` without creating anything: an existing root must already be
    /// a private, caller-owned directory and must not be an interactive/Node root; a missing
    /// root is created by `install()` through `NativeServicePaths` itself.
    private static func validatedDataRoot(_ url: URL) throws -> URL {
        guard url.isFileURL, url.path.hasPrefix("/"), url.path != "/", !url.path.contains("\0") else {
            throw NativeHeadlessHostInstallerError.invalidDataRoot
        }
        let standardized = url.standardizedFileURL
        var info = stat()
        if lstat(standardized.path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
                throw NativeHeadlessHostInstallerError.invalidDataRoot
            }
            for name in ["harness-owner.json", "config.json"]
            where FileManager.default.fileExists(atPath: standardized.appendingPathComponent(name).path) {
                throw NativeHeadlessHostInstallerError.invalidDataRoot
            }
        } else {
            guard errno == ENOENT else { throw NativeHeadlessHostInstallerError.invalidDataRoot }
            var parentInfo = stat()
            let parent = standardized.deletingLastPathComponent()
            guard lstat(parent.path, &parentInfo) == 0, parentInfo.st_mode & S_IFMT == S_IFDIR else {
                throw NativeHeadlessHostInstallerError.invalidDataRoot
            }
        }
        return standardized
    }

    private static func validatedDestination(_ url: URL, label: String) throws -> URL {
        guard url.isFileURL, url.path.hasPrefix("/"), !url.path.contains("\0"),
              url.lastPathComponent == "\(label).plist"
        else { throw NativeHeadlessHostInstallerError.invalidPlistDestination }
        let standardized = url.standardizedFileURL
        var parentInfo = stat()
        let parent = standardized.deletingLastPathComponent()
        guard lstat(parent.path, &parentInfo) == 0, parentInfo.st_mode & S_IFMT == S_IFDIR else {
            throw NativeHeadlessHostInstallerError.invalidPlistDestination
        }
        return standardized
    }

    // MARK: - Rendering

    /// The launchd definition for the validated configuration.  It carries no credential
    /// material and no credential environment: provider access stays unavailable by default.
    public func renderedPlistDictionary() throws -> [String: Any] {
        let validation = try validate()
        return Self.plistDictionary(label: configuration.label,
                                    executable: validation.executable,
                                    serviceDataRoot: validation.serviceDataRoot,
                                    serviceUserName: configuration.serviceUserName)
    }

    static func plistDictionary(label: String, executable: URL, serviceDataRoot: URL, serviceUserName: String?) -> [String: Any] {
        var dictionary: [String: Any] = [
            "Label": label,
            // Matches the BotFleetNativeHost executable contract: exactly `--service-data <root>`.
            "ProgramArguments": [executable.path, "--service-data", serviceDataRoot.path],
            "RunAtLoad": true,
            "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 5,
            "WorkingDirectory": serviceDataRoot.path,
            "StandardOutPath": serviceDataRoot.appendingPathComponent("nativehost.log").path,
            "StandardErrorPath": serviceDataRoot.appendingPathComponent("nativehost.log").path,
            "EnvironmentVariables": ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"],
        ]
        if let serviceUserName { dictionary["UserName"] = serviceUserName }
        return dictionary
    }

    func renderedPlistData(validation: NativeHeadlessHostInstallValidation) throws -> Data {
        let dictionary = Self.plistDictionary(label: configuration.label,
                                              executable: validation.executable,
                                              serviceDataRoot: validation.serviceDataRoot,
                                              serviceUserName: configuration.serviceUserName)
        do {
            return try PropertyListSerialization.data(fromPropertyList: dictionary, format: .xml, options: 0)
        } catch { throw NativeHeadlessHostInstallerError.writeFailed }
    }

    /// True only when the destination plist exists and semantically equals what this
    /// configuration would write now.
    public func verifyInstalled() -> Bool {
        guard let validation = try? validate(),
              let existing = Self.parsedPlist(at: validation.plistDestination) else { return false }
        let rendered = Self.plistDictionary(label: configuration.label,
                                            executable: validation.executable,
                                            serviceDataRoot: validation.serviceDataRoot,
                                            serviceUserName: configuration.serviceUserName)
        return (existing as NSDictionary) == (rendered as NSDictionary)
    }

    static func parsedPlist(at url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url),
              let object = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dictionary = object as? [String: Any] else { return nil }
        return dictionary
    }

    /// A plist is ours only when it parses, carries our label, and launches our executable.
    /// Anything else at the destination is foreign and is never overwritten or removed.
    private func isOurPlist(_ dictionary: [String: Any], executable: URL) -> Bool {
        dictionary["Label"] as? String == configuration.label &&
            (dictionary["ProgramArguments"] as? [String])?.first == executable.path
    }

    // MARK: - Install / uninstall

    /// Validates, provisions the private service data root, and writes the plist atomically.
    /// A failed commit restores the previous plist (or leaves none) and no temporary files.
    /// Re-installing an unchanged configuration is a no-op.  This writes only the plist file:
    /// it does not register the job with launchd.
    public func install() throws -> NativeHeadlessHostInstallResult {
        let validation = try validate()
        // Provision (or re-validate) the private, service-owned root the host itself requires.
        _ = try NativeServicePaths(serviceData: validation.serviceDataRoot)
        let destination = validation.plistDestination
        let rendered = Self.plistDictionary(label: configuration.label,
                                            executable: validation.executable,
                                            serviceDataRoot: validation.serviceDataRoot,
                                            serviceUserName: configuration.serviceUserName)
        var replacingOurs = false
        if FileManager.default.fileExists(atPath: destination.path) {
            guard let existing = Self.parsedPlist(at: destination), isOurPlist(existing, executable: validation.executable) else {
                throw NativeHeadlessHostInstallerError.foreignPlistPresent
            }
            if (existing as NSDictionary) == (rendered as NSDictionary) {
                return NativeHeadlessHostInstallResult(plistURL: destination, outcome: .alreadyInstalled)
            }
            replacingOurs = true
        }
        let data = try renderedPlistData(validation: validation)
        try writeAtomically(data, to: destination, replacingExisting: replacingOurs)
        return NativeHeadlessHostInstallResult(plistURL: destination, outcome: replacingOurs ? .updated : .installed)
    }

    /// Removes exactly the plist this installer wrote.  Returns false when nothing is
    /// installed.  Service data under the data root is always left in place.
    @discardableResult
    public func uninstall() throws -> Bool {
        let destination = try Self.validatedDestination(configuration.plistDestination, label: configuration.label)
        guard FileManager.default.fileExists(atPath: destination.path) else { return false }
        let executable = configuration.executable.standardizedFileURL
        guard let existing = Self.parsedPlist(at: destination), isOurPlist(existing, executable: executable) else {
            throw NativeHeadlessHostInstallerError.foreignPlistPresent
        }
        guard unlink(destination.path) == 0 else { throw NativeHeadlessHostInstallerError.removeFailed }
        Self.fsyncDirectory(destination.deletingLastPathComponent())
        return true
    }

    private func writeAtomically(_ data: Data, to destination: URL, replacingExisting: Bool) throws {
        let directory = destination.deletingLastPathComponent()
        let token = UUID().uuidString
        let temporary = directory.appendingPathComponent(".\(configuration.label).plist.tmp-\(token)")
        let backup = directory.appendingPathComponent(".\(configuration.label).plist.backup-\(token)")
        do {
            try Self.writeNewFile(data, at: temporary)
            try beforeCommitHook?()
            if replacingExisting {
                guard rename(destination.path, backup.path) == 0 else {
                    throw NativeHeadlessHostInstallerError.writeFailed
                }
                do {
                    try afterBackupHook?()
                    guard rename(temporary.path, destination.path) == 0 else {
                        throw NativeHeadlessHostInstallerError.writeFailed
                    }
                } catch {
                    // Roll back: the previous definition goes back exactly as it was.
                    _ = rename(backup.path, destination.path)
                    throw error
                }
                _ = unlink(backup.path)
            } else {
                guard rename(temporary.path, destination.path) == 0 else {
                    throw NativeHeadlessHostInstallerError.writeFailed
                }
            }
            Self.fsyncDirectory(directory)
        } catch {
            _ = unlink(temporary.path)
            _ = unlink(backup.path)
            throw error
        }
    }

    private static func writeNewFile(_ data: Data, at url: URL) throws {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw NativeHeadlessHostInstallerError.writeFailed }
        defer { Darwin.close(fd) }
        do {
            try data.withUnsafeBytes { bytes in
                var offset = 0
                while offset < bytes.count {
                    let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if written > 0 { offset += written }
                    else if written < 0, errno == EINTR { continue }
                    else { throw NativeHeadlessHostInstallerError.writeFailed }
                }
            }
        } catch {
            _ = unlink(url.path)
            throw error
        }
        // plist definitions are world-readable by convention; flush before it becomes visible.
        guard fchmod(fd, 0o644) == 0, fsync(fd) == 0 else {
            _ = unlink(url.path)
            throw NativeHeadlessHostInstallerError.writeFailed
        }
    }

    private static func fsyncDirectory(_ url: URL) {
        let fd = open(url.path, O_RDONLY | O_CLOEXEC)
        if fd >= 0 { _ = fsync(fd); Darwin.close(fd) }
    }
}
#endif
