import Darwin
import Foundation

public enum PersistencePolicyError: LocalizedError {
    case invalidValue
    case writeFailed

    public var errorDescription: String? {
        switch self {
        case .invalidValue: return "The local server preference has an invalid value."
        case .writeFailed: return "Could not save the local server preference."
        }
    }
}

/// The offline preference is a single non-secret boolean, consumed by the server and Electron.
public final class PersistencePolicy {
    private let directory: URL
    private let files: FileManager

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                environment: [String: String] = ProcessInfo.processInfo.environment,
                files: FileManager = .default) {
        if let value = environment["OMB_DATA_DIR"], !value.isEmpty, value.hasPrefix("/") {
            directory = URL(fileURLWithPath: value, isDirectory: true)
        } else {
            directory = home.appendingPathComponent(".botfleet", isDirectory: true)
        }
        self.files = files
    }

    public var value: Bool? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("persist-on-exit.policy")) else { return nil }
        switch data {
        case Data("true\n".utf8): return true
        case Data("false\n".utf8): return false
        default: return nil
        }
    }

    public func set(_ enabled: Bool) throws {
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent("persist-on-exit.policy")
        let temporary = directory.appendingPathComponent(".persist-on-exit.\(UUID().uuidString).tmp")
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw PersistencePolicyError.writeFailed }
        defer { _ = Darwin.close(descriptor); try? files.removeItem(at: temporary) }
        let bytes = Array((enabled ? "true\n" : "false\n").utf8)
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw PersistencePolicyError.writeFailed }
                offset += count
            }
        }
        guard Darwin.fsync(descriptor) == 0,
              Darwin.rename(temporary.path, destination.path) == 0 else {
            throw PersistencePolicyError.writeFailed
        }
        guard value == enabled else { throw PersistencePolicyError.invalidValue }
    }
}
