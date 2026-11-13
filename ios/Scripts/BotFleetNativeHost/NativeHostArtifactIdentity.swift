import Foundation
#if os(macOS)
import MachO

/// Read only the running image's signed section; never an editable bundle or sidecar dictionary.
enum NativeHostArtifactIdentity {
    static let capabilities = ["identity-v1", "foreground-service-data-v1", "signal-drain-v1"]
    private static let keys: Set<String> = ["schemaVersion", "codeIdentifier", "sourceCommit", "build",
                                          "marketingVersion", "capabilities", "distribution", "sourceDirty"]
    private struct Stamp: Decodable {
        let schemaVersion: Int
        let codeIdentifier: String
        let sourceCommit: String
        let build: String
        let marketingVersion: String
        let capabilities: [String]
        let distribution: String
        let sourceDirty: Bool
    }
    enum Failure: Error { case unavailable }

    static func encoded() throws -> Data {
        guard let rawHeader = _dyld_get_image_header(0) else { throw Failure.unavailable }
        var count: UInt = 0
        let pointer = rawHeader.withMemoryRebound(to: mach_header_64.self, capacity: 1) {
            getsectiondata($0, "__TEXT", "__bf_identity", &count)
        }
        // The flat identity schema is small; bound the copy before decoding an untrusted image.
        guard let pointer, count > 0, count <= 4096 else { throw Failure.unavailable }
        let data = Data(bytes: pointer, count: Int(count))
        guard let dictionary = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(dictionary.keys) == keys else { throw Failure.unavailable }
        let stamp = try JSONDecoder().decode(Stamp.self, from: data)
        guard stamp.schemaVersion == 1, stamp.codeIdentifier == "BotFleetNativeHost",
              stamp.marketingVersion == "0.1.0", stamp.capabilities == capabilities,
              stamp.sourceCommit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              stamp.sourceCommit != String(repeating: "0", count: 40),
              stamp.build.range(of: "^[0-9]{12}$", options: .regularExpression) != nil,
              stamp.build != String(repeating: "0", count: 12),
              ["unsigned-development", "developer-id"].contains(stamp.distribution),
              stamp.distribution != "developer-id" || !stamp.sourceDirty
        else { throw Failure.unavailable }
        return data
    }
}
#endif
