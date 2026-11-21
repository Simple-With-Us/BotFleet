import Foundation

/// Pure byte-level parser for the artifact stamp a packaged native host carries in its
/// `__TEXT,__bf_identity` section.  This is a Swift port of the bounds-checked
/// `inspectHostMachO` in `scripts/native-host-artifact.mjs`, kept to the same refusals so
/// the install-time reader and the packaging-time verifier agree on what a stamped binary
/// is.  It never executes or loads the file it inspects: no dlopen, no NSBundle, no
/// process spawn.  Every offset and length taken from the file is bounds-checked against
/// the actual byte count before use.
///
/// Contract beyond the reference parser, per review:
///  - every slice of a fat binary must carry a valid stamp, and all slice stamps must be
///    byte-identical, so the stamp cannot depend on which slice happens to run;
///  - the stamp JSON must carry exactly the packaging key set with the packaging field
///    checks (`encodeHostIdentity`), and its canonical re-encoding must reproduce the
///    section bytes exactly, rejecting reordered keys, duplicate keys, non-string types
///    and alternate number spellings;
///  - the image must be `MH_EXECUTE`, matching the packaging gate;
///  - `stamp.codeIdentifier` is pinned to the packaging value here and additionally bound
///    to the configured expectation and the verified signing identity by the installer.
enum NativeHostMachOStampParsing {
    static let hostCodeIdentifier = "BotFleetNativeHost"
    static let hostCapabilities = ["identity-v1", "foreground-service-data-v1", "signal-drain-v1",
                                   "automatic-start-v1", "checked-control-v1"]
    /// The packaging key order; the canonical re-encode compares against the raw bytes.
    private static let keyOrder = ["schemaVersion", "codeIdentifier", "sourceCommit", "build",
                                   "marketingVersion", "capabilities", "distribution", "sourceDirty"]
    private static let keys = Set(keyOrder)
    static let maximumStampBytes = 4096

    struct ParsedIdentity: Equatable {
        let schemaVersion: Int
        let codeIdentifier: String
        let capabilities: [String]
    }

    private struct Slice {
        let cpu: UInt32
        let arch: String
        let fileType: UInt32
        let stamp: Data?
        let identity: ParsedIdentity?
    }

    enum Failure: Error { case refused }

    private static func require(_ condition: Bool) throws {
        if !condition { throw Failure.refused }
    }

    // MARK: - Byte access (explicit little/big-endian assembly, bounds-checked)

    private static func bounds(_ bytes: Data, _ offset: Int, _ length: Int) throws {
        try require(offset >= 0 && length >= 0 && offset <= bytes.count && length <= bytes.count - offset)
    }

    private static func integerLE(_ bytes: Data, _ offset: Int, _ length: Int) throws -> UInt64 {
        try bounds(bytes, offset, length)
        var value: UInt64 = 0
        for index in 0 ..< length {
            value |= UInt64(bytes[offset + index]) << UInt64(index * 8)
        }
        return value
    }

    private static func integerBE(_ bytes: Data, _ offset: Int, _ length: Int) throws -> UInt64 {
        try bounds(bytes, offset, length)
        var value: UInt64 = 0
        for index in 0 ..< length {
            value = value << 8 | UInt64(bytes[offset + index])
        }
        return value
    }

    private static func u32le(_ bytes: Data, _ offset: Int) throws -> UInt32 {
        UInt32(try integerLE(bytes, offset, 4))
    }

    private static func u32be(_ bytes: Data, _ offset: Int) throws -> UInt32 {
        UInt32(try integerBE(bytes, offset, 4))
    }

    private static func u64le(_ bytes: Data, _ offset: Int) throws -> UInt64 {
        try integerLE(bytes, offset, 8)
    }

    private static func u64be(_ bytes: Data, _ offset: Int) throws -> UInt64 {
        try integerBE(bytes, offset, 8)
    }

    /// A fixed-width Mach-O name field: UTF-8 up to the first NUL, no control characters.
    private static func name(_ bytes: Data, _ offset: Int, _ length: Int, requireTerminator: Bool = false) throws -> String {
        try bounds(bytes, offset, length)
        var field = Data(bytes[offset ..< offset + length])
        if let nul = field.firstIndex(of: 0) {
            field = field.subdata(in: 0 ..< nul)
        } else if requireTerminator {
            throw Failure.refused
        }
        guard let value = String(data: field, encoding: .utf8),
              value.unicodeScalars.allSatisfy({ $0.value >= 32 })
        else { throw Failure.refused }
        return value
    }

    // MARK: - Stamp JSON (packaging field checks plus exact canonical encoding)

    private static func isLowerHexDigit(_ character: Character) -> Bool {
        guard let value = character.asciiValue else { return false }
        return (48 ... 57).contains(value) || (97 ... 102).contains(value)
    }

    private static func isASCIIDigit(_ character: Character) -> Bool {
        guard let value = character.asciiValue else { return false }
        return (48 ... 57).contains(value)
    }

    private static func parseStamp(_ bytes: Data) throws -> ParsedIdentity {
        guard let object = try? JSONSerialization.jsonObject(with: bytes),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == keys,
              let schemaVersion = dictionary["schemaVersion"] as? Int,
              let codeIdentifier = dictionary["codeIdentifier"] as? String,
              let sourceCommit = dictionary["sourceCommit"] as? String,
              let build = dictionary["build"] as? String,
              let marketingVersion = dictionary["marketingVersion"] as? String,
              let capabilities = dictionary["capabilities"] as? [String],
              let distribution = dictionary["distribution"] as? String,
              let sourceDirty = dictionary["sourceDirty"] as? Bool
        else { throw Failure.refused }
        // Mirrors encodeHostIdentity's field checks exactly.
        guard schemaVersion == 1,
              codeIdentifier == hostCodeIdentifier,
              marketingVersion == "0.1.0",
              sourceCommit.count == 40, sourceCommit.allSatisfy(isLowerHexDigit),
              !sourceCommit.allSatisfy({ $0 == "0" }),
              build.count == 12, build.allSatisfy(isASCIIDigit),
              !build.allSatisfy({ $0 == "0" }),
              capabilities == hostCapabilities,
              distribution == "developer-id" || distribution == "unsigned-development",
              !(distribution == "developer-id" && sourceDirty)
        else { throw Failure.refused }
        // The canonical re-encode (packaging key order, no whitespace) must reproduce the
        // section bytes exactly.  Every interpolated value above is pinned or restricted
        // to a safe alphabet, so no JSON escaping can be involved.
        let capabilityList = capabilities.map { "\"\($0)\"" }.joined(separator: ",")
        let canonical = "{\"schemaVersion\":\(schemaVersion),\"codeIdentifier\":\"\(codeIdentifier)\"," +
            "\"sourceCommit\":\"\(sourceCommit)\",\"build\":\"\(build)\"," +
            "\"marketingVersion\":\"\(marketingVersion)\",\"capabilities\":[\(capabilityList)]," +
            "\"distribution\":\"\(distribution)\",\"sourceDirty\":\(sourceDirty ? "true" : "false")}"
        guard Data(canonical.utf8) == bytes else { throw Failure.refused }
        return ParsedIdentity(schemaVersion: schemaVersion, codeIdentifier: codeIdentifier,
                              capabilities: capabilities)
    }

    // MARK: - Mach-O structure

    private static func thin(_ bytes: Data) throws -> Slice {
        try bounds(bytes, 0, 32)
        try require(u32le(bytes, 0) == 0xfeedfacf) // MH_MAGIC_64
        let cpu = try u32le(bytes, 4)
        let subtype = try u32le(bytes, 8) & 0x00ff_ffff
        let fileType = try u32le(bytes, 12)
        let arch: String
        switch cpu {
        case 0x0100_000c: arch = "arm64"
        case 0x0100_0007: arch = "x86_64"
        default: throw Failure.refused
        }
        try require(subtype == (arch == "arm64" ? 0 : 3))
        let count = Int(try u32le(bytes, 16))
        let commandBytes = Int(try u32le(bytes, 20))
        try bounds(bytes, 32, commandBytes)
        try require(count <= commandBytes / 8)
        let end = 32 + commandBytes
        var cursor = 32
        var stamp: Data?
        var identity: ParsedIdentity?
        for _ in 0 ..< count {
            try bounds(bytes, cursor, 8)
            let command = try u32le(bytes, cursor)
            let length = Int(try u32le(bytes, cursor + 4))
            try require(length >= 8 && length % 8 == 0 && cursor + length <= end)
            switch command {
            case 0x19: // LC_SEGMENT_64
                try require(length >= 72)
                let sections = Int(try u32le(bytes, cursor + 64))
                try require(length == 72 + sections * 80)
                for section in 0 ..< sections {
                    let start = cursor + 72 + section * 80
                    guard try name(bytes, start, 16) == "__bf_identity" else { continue }
                    try require(stamp == nil) // a second stamp section is a contradiction
                    try require(name(bytes, cursor + 8, 16) == "__TEXT")
                    try require(name(bytes, start + 16, 16) == "__TEXT")
                    let size = try u64le(bytes, start + 40)
                    let offset = UInt64(try u32le(bytes, start + 48))
                    let address = try u64le(bytes, start + 32)
                    let vmAddress = try u64le(bytes, cursor + 24)
                    let vmSize = try u64le(bytes, cursor + 32)
                    let segmentOffset = try u64le(bytes, cursor + 40)
                    let segmentSize = try u64le(bytes, cursor + 48)
                    let fileLength = UInt64(bytes.count)
                    try require(segmentOffset <= fileLength && segmentSize <= fileLength - segmentOffset)
                    try require(offset <= fileLength && size <= fileLength - offset)
                    try require(size > 0 && size <= UInt64(maximumStampBytes))
                    // The section bytes must sit after the load commands and inside the
                    // segment's file range, and the VM mapping must mirror the file range.
                    try require(offset >= UInt64(end) && offset >= segmentOffset)
                    // offset >= segmentOffset is proven, so this subtraction cannot
                    // underflow; the comparison against segmentSize comes before any
                    // second subtraction, so a section offset past the segment end
                    // (but inside the file) refuses instead of trapping.
                    let offsetInSegment = offset - segmentOffset
                    try require(offsetInSegment <= segmentSize && size <= segmentSize - offsetInSegment)
                    try require(address >= vmAddress)
                    let vmOffset = address - vmAddress
                    try require(vmOffset == offsetInSegment)
                    try require(vmOffset <= vmSize && size <= vmSize - vmOffset)
                    stamp = Data(bytes[Int(offset) ..< Int(offset + size)])
                }
            case 0x27: // LC_DYLD_ENVIRONMENT can alter loader resolution invisibly
                throw Failure.refused
            case 0xc, 0x8000_0018, 0x8000_001f, 0x8000_0023, 0x20, 0x8000_001c, 0xe:
                // Dylib/dylinker/rpath commands: the embedded name must be a bounded,
                // NUL-terminated, printable string inside the command.
                let minimum = (command == 0x8000_001c || command == 0xe) ? 12 : 24
                try require(length >= minimum)
                let nameOffset = Int(try u32le(bytes, cursor + 8))
                try require(nameOffset >= minimum && nameOffset < length)
                let value = try name(bytes, cursor + nameOffset, length - nameOffset, requireTerminator: true)
                try require(!value.isEmpty)
                if command == 0xe { try require(value == "/usr/lib/dyld") }
            default:
                break
            }
            cursor += length
        }
        try require(cursor == end)
        if let stamp {
            identity = try parseStamp(stamp)
        }
        return Slice(cpu: cpu, arch: arch, fileType: fileType, stamp: stamp, identity: identity)
    }

    private static func slices(in bytes: Data) throws -> [Slice] {
        try bounds(bytes, 0, 8)
        if try u32le(bytes, 0) == 0xfeedfacf { return [try thin(bytes)] }
        let magic = try u32be(bytes, 0)
        let fat64 = magic == 0xcafe_babf
        try require(magic == 0xcafe_babe || fat64)
        let count = Int(try u32be(bytes, 4))
        let stride = fat64 ? 32 : 20
        try require(count == 2)
        try bounds(bytes, 8, count * stride)
        var ranges: [(offset: UInt64, size: UInt64)] = []
        var slices: [Slice] = []
        for index in 0 ..< count {
            let record = 8 + index * stride
            let cpu = try u32be(bytes, record)
            let subtype = try u32be(bytes, record + 4) & 0x00ff_ffff
            let offset: UInt64
            let size: UInt64
            if fat64 {
                offset = try u64be(bytes, record + 8)
                size = try u64be(bytes, record + 16)
            } else {
                offset = UInt64(try u32be(bytes, record + 8))
                size = UInt64(try u32be(bytes, record + 12))
            }
            let fileLength = UInt64(bytes.count)
            try require(offset <= fileLength && size <= fileLength - offset)
            try require(offset >= UInt64(8 + count * stride) && size > 0)
            for existing in ranges {
                try require(!(offset < existing.offset + existing.size && existing.offset < offset + size))
            }
            ranges.append((offset: offset, size: size))
            let slice = try thin(Data(bytes[Int(offset) ..< Int(offset + size)]))
            try require(slice.cpu == cpu)
            try require(subtype == (slice.arch == "arm64" ? 0 : 3))
            try require(!slices.contains(where: { $0.arch == slice.arch }))
            slices.append(slice)
        }
        return slices
    }

    /// The reduced stamp for the installer's gate.  Refuses when any slice lacks a stamp,
    /// when slice stamps differ, or when the image is not an executable.
    static func stamp(in bytes: Data) throws -> NativeHostArtifactStamp {
        let slices = try slices(in: bytes)
        guard let first = slices.first, let firstStamp = first.stamp, let identity = first.identity
        else { throw Failure.refused }
        for slice in slices {
            try require(slice.fileType == 2) // MH_EXECUTE, matching the packaging gate
            try require(slice.stamp == firstStamp)
        }
        return NativeHostArtifactStamp(schemaVersion: identity.schemaVersion,
                                       capabilities: identity.capabilities,
                                       codeIdentifier: identity.codeIdentifier)
    }
}

#if os(macOS)
import Darwin

/// The production stamp reader.  It opens the configured target executable itself, on a
/// file descriptor it owns (`O_NOFOLLOW` refuses a symlink substituted after the
/// installer's `lstat` check), `fstat`s that descriptor, and parses the bytes read from
/// it.  Nothing about the target is executed or loaded.
///
/// Size discipline: the packaged host binary is a few megabytes; anything past
/// `maximumFileBytes` is refused instead of buffered, and a file whose size changes
/// mid-read is refused rather than parsed as a splice.
///
/// TOCTOU posture: the stamp read, the signature check and the installer's `lstat` are
/// three separate opens of the same path.  This read holds its own descriptor
/// (`O_NOFOLLOW` refuses a swapped symlink, `O_NONBLOCK` refuses to hang on a swapped
/// FIFO), but `SecStaticCodeCheckValidity` reopens by path because the Security
/// framework offers no descriptor-based entry point.  `O_NOFOLLOW` covers only the
/// final path component; parent-directory symlinks are covered no better than the
/// installer's `lstat` covers them.  A path swap between the opens therefore remains
/// possible to whoever can write the executable; the existing ownership and mode checks
/// (owner or root, not group/world-writable) limit that to the owner.  The stamp lives
/// in `__TEXT`, so a stamp read from the same bytes the signature later covers is
/// itself signature-covered (the installer checks all architectures); the residual risk
/// is a swap to a differently signed binary between the opens, which install rollback
/// and `verifyInstalled()` do not hide.  The PR body must state this three-open
/// structure so nobody assumes a single-descriptor guarantee that is not made here.
///
/// Subtypes: only arm64 (subtype 0) and x86_64 (subtype 3) slices are accepted, matching
/// the packaging reference parser; an arm64e slice is refused rather than read loosely.
/// If a future artifact ships arm64e, the packaging gate changes first and this reader
/// follows it.
public struct MachONativeHostStampReader: NativeHostStampReading {
    static let maximumFileBytes = 512 * 1024 * 1024

    public init() {}

    public func stamp(ofExecutableAt url: URL) -> NativeHostArtifactStamp? {
        guard url.isFileURL else { return nil }
        // O_NONBLOCK keeps a FIFO swapped in after the installer's lstat from hanging
        // the open; regular files ignore the flag, and the fstat below refuses any
        // other type.  The descriptor, not the path, is what gets read.
        let fd = open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { return nil }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_size > 0,
              info.st_size <= Self.maximumFileBytes
        else { return nil }
        guard let bytes = Self.readAll(fd: fd, expectedSize: Int(info.st_size)) else { return nil }
        return try? NativeHostMachOStampParsing.stamp(in: bytes)
    }

    /// Reads exactly `expectedSize` bytes.  Returns nil when the file shrank (short
    /// read) or grew during the read (a trailing probe byte exists), so a changing file
    /// is never parsed as a splice and never buffered past the inspected size.  Internal
    /// seam so tests can drive the size discipline through a pipe.
    static func readAll(fd: Int32, expectedSize: Int) -> Data? {
        guard expectedSize > 0 else { return nil }
        var data = Data()
        data.reserveCapacity(expectedSize)
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        while data.count < expectedSize {
            let wanted = min(buffer.count, expectedSize - data.count)
            let count = Darwin.read(fd, &buffer, wanted)
            if count > 0 {
                data.append(contentsOf: buffer[..<count])
            } else if count < 0, errno == EINTR {
                continue
            } else {
                return nil // EOF or error before the inspected size: treat as changed
            }
        }
        var probe: UInt8 = 0
        let extra = Darwin.read(fd, &probe, 1)
        guard extra == 0 else { return nil } // the file grew after the fstat
        return data
    }
}
#endif
