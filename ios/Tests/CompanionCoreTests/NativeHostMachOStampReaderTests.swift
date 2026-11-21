#if os(macOS)
import Darwin
import Foundation
import Testing
@testable import CompanionCore

/// Fixture-binary tests for the production stamp reader.  Every binary is built in code
/// below and written to a temporary file; nothing executes, loads, or signs anything.
/// The same fixture corpus is machine-checked against the reference parser
/// (`inspectHostMachO` in `scripts/native-host-artifact.mjs`, sha256 recorded in the
/// review packet): each fixture's expected accept/refuse outcome matched the reference
/// plus the reader's slice contract (identical stamps on every slice, MH_EXECUTE).
@Suite("Native Host Mach-O Stamp Reader", .serialized)
struct NativeHostMachOStampReaderTests {
    private let reader = MachONativeHostStampReader()

    // MARK: - Acceptance

    @Test("A thin arm64 executable with a valid stamp is accepted (stamp ending exactly at the segment end)")
    func thinValidStampAccepted() throws {
        try withFixture(MachOFixture.thin()) { url in
            let stamp = try #require(reader.stamp(ofExecutableAt: url))
            #expect(stamp.schemaVersion == 1)
            #expect(stamp.codeIdentifier == "BotFleetNativeHost")
            #expect(stamp.capabilities == MachOFixture.hostCapabilities)
        }
    }

    @Test("A stamp strictly inside a padded segment file range is accepted")
    func stampStrictlyInsideSegmentAccepted() throws {
        try withFixture(MachOFixture.thin(trailingPadding: 100)) { url in
            #expect(reader.stamp(ofExecutableAt: url) != nil)
        }
    }

    @Test("A fat executable with identical valid stamps on both slices is accepted")
    func fatValidStampsAccepted() throws {
        try withFixture(MachOFixture.fat2(MachOFixture.thin(), MachOFixture.thin(arch: "x86_64"))) { url in
            let stamp = try #require(reader.stamp(ofExecutableAt: url))
            #expect(stamp.schemaVersion == 1)
            #expect(stamp.codeIdentifier == "BotFleetNativeHost")
        }
    }

    @Test("A 64-bit fat executable with identical valid stamps is accepted")
    func fat64ValidStampsAccepted() throws {
        try withFixture(MachOFixture.fat2(MachOFixture.thin(), MachOFixture.thin(arch: "x86_64"), fat64: true)) { url in
            #expect(reader.stamp(ofExecutableAt: url) != nil)
        }
    }

    @Test("An unsigned-development stamp is accepted by the reader (distribution gating belongs to the caller)")
    func unsignedDevelopmentStampAccepted() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(
            distribution: "unsigned-development", sourceDirtyLiteral: "true"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) != nil)
        }
    }

    // MARK: - Slice contract

    @Test("A fat executable with one unstamped slice is refused")
    func fatWithOneUnstampedSliceRefused() throws {
        try withFixture(MachOFixture.fat2(MachOFixture.thin(),
                                          MachOFixture.thin(arch: "x86_64", stamp: nil))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A fat executable whose slices carry different stamps is refused")
    func fatWithMismatchedSliceStampsRefused() throws {
        let other = MachOFixture.canonicalStamp(build: "202611200002")
        try withFixture(MachOFixture.fat2(MachOFixture.thin(),
                                          MachOFixture.thin(arch: "x86_64", stamp: other))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A fat executable declaring a single slice is refused")
    func fatWithSingleSliceRefused() throws {
        try withFixture(MachOFixture.fat([MachOFixture.FatRecord(cpu: 0x0100_000c, subtype: 0,
                                                                 slice: MachOFixture.thin())])) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A fat executable declaring three slices is refused")
    func fatWithThreeSlicesRefused() throws {
        try withFixture(MachOFixture.fat([MachOFixture.FatRecord(cpu: 0x0100_000c, subtype: 0, slice: MachOFixture.thin()),
                                          MachOFixture.FatRecord(cpu: 0x0100_0007, subtype: 3, slice: MachOFixture.thin(arch: "x86_64")),
                                          MachOFixture.FatRecord(cpu: 0x0100_000c, subtype: 0, slice: MachOFixture.thin())])) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A fat executable with duplicate arm64 slices is refused")
    func fatWithDuplicateArchitectureRefused() throws {
        try withFixture(MachOFixture.fat([MachOFixture.FatRecord(cpu: 0x0100_000c, subtype: 0, slice: MachOFixture.thin()),
                                          MachOFixture.FatRecord(cpu: 0x0100_000c, subtype: 0, slice: MachOFixture.thin())])) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("Fat slice ranges that overlap are refused")
    func overlappingFatSlicesRefused() throws {
        try withFixture(MachOFixture.fat2(MachOFixture.thin(), MachOFixture.thin(arch: "x86_64"),
                                          overlap: true)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("64-bit fat slice ranges that overlap are refused")
    func overlappingFat64SlicesRefused() throws {
        try withFixture(MachOFixture.fat2(MachOFixture.thin(), MachOFixture.thin(arch: "x86_64"),
                                          overlap: true, fat64: true)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A slice whose cpu type contradicts its fat record is refused")
    func sliceCpuMismatchingFatRecordRefused() throws {
        try withFixture(MachOFixture.fat([MachOFixture.FatRecord(cpu: 0x0100_0007, subtype: 3, slice: MachOFixture.thin()),
                                          MachOFixture.FatRecord(cpu: 0x0100_000c, subtype: 0, slice: MachOFixture.thin(arch: "x86_64"))])) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("An arm64e slice is refused, matching the reference parser")
    func arm64eSubtypeRefused() throws {
        try withFixture(MachOFixture.thin(subtypeOverride: 2)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    // MARK: - Header and load-command structure

    @Test("An empty file is refused")
    func emptyFileRefused() throws {
        try withFixture(Data()) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A bad magic is refused")
    func badMagicRefused() throws {
        try withFixture(MachOFixture.thin(mutate: { $0.setU32LE(0xfeedface, at: 0) })) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("An ncmds count beyond the command table is refused")
    func ncmdsBeyondCommandTableRefused() throws {
        try withFixture(MachOFixture.thin(mutate: { $0.setU32LE(99, at: 16) })) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A load command whose length is not a multiple of 8 is refused")
    func oddLoadCommandLengthRefused() throws {
        try withFixture(MachOFixture.thin(extraCommand: MachOFixture.oddLengthCommand())) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("An unterminated dylib name is refused")
    func unterminatedDylibNameRefused() throws {
        try withFixture(MachOFixture.thin(extraCommand: MachOFixture.unterminatedDylibCommand())) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A foreign dyld path is refused")
    func foreignDyldPathRefused() throws {
        try withFixture(MachOFixture.thin(extraCommand: MachOFixture.loadCommand(0xe, name: "/evil/dyld"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A dyld environment load command is refused")
    func dyldEnvironmentCommandRefused() throws {
        try withFixture(MachOFixture.thin(extraCommand: MachOFixture.loadCommand(0x27, name: "X"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    // MARK: - Section bounds

    @Test("A truncated file is refused")
    func truncatedFileRefused() throws {
        try withFixture(Data(MachOFixture.thin().prefix(200))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp section larger than the 4096-byte cap is refused")
    func oversizedStampSectionRefused() throws {
        try withFixture(MachOFixture.thin(sectionSizeOverride: 4097)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A zero-size stamp section is refused")
    func zeroSizeStampSectionRefused() throws {
        try withFixture(MachOFixture.thin(sectionSizeOverride: 0)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp section inside the load-command area is refused")
    func stampSectionInsideLoadCommandsRefused() throws {
        try withFixture(MachOFixture.thin(mutate: { bytes in
            bytes.setU32LE(100, at: 152) // section offset, inside the load commands
            bytes.setU64LE(0x1_0000_0000 + 100, at: 136) // keep addr mirroring it
        })) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp section offset past the segment end but inside the file refuses, never traps")
    func stampSectionPastSegmentEndRefused() throws {
        // Regression for the unsigned-subtraction trap found in review: with the old
        // check order this shape crashed instead of refusing.
        try withFixture(MachOFixture.thin(sectionSizeOverride: 16, trailingPadding: 100, mutate: { bytes in
            bytes.setU64LE(0x100, at: 80) // segment filesize: 0 ..< 0x100
            bytes.setU32LE(0x200, at: 152) // section offset: past the segment end, within the file
            bytes.setU64LE(0x1_0000_0000 + 0x200, at: 136) // addr mirrors the offset
        })) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp section offset exactly at the segment end with nonzero size is refused")
    func stampSectionAtSegmentEndRefused() throws {
        try withFixture(MachOFixture.thin(mutate: { $0.setU64LE(184, at: 80) })) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp address not mirroring its file offset is refused")
    func stampAddressNotMirroringFileOffsetRefused() throws {
        try withFixture(MachOFixture.thin(mutate: { $0.setU64LE(0x1_0000_0000 + 184 + 8, at: 136) })) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp exceeding the segment VM range is refused")
    func stampExceedingVMRangeRefused() throws {
        try withFixture(MachOFixture.thin(mutate: { $0.setU64LE(100, at: 64) })) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A second stamp section is refused")
    func duplicateStampSectionRefused() throws {
        try withFixture(MachOFixture.thin(duplicateStampSection: true)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp section outside __TEXT is refused")
    func stampSectionOutsideTextRefused() throws {
        try withFixture(MachOFixture.thin(segmentName: "__DATA")) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp section whose own segment-name field is foreign is refused")
    func stampSectionForeignSegnameRefused() throws {
        try withFixture(MachOFixture.thin(sectionSegName: "__DATA")) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    // MARK: - Stamp content

    @Test("A thin executable without any stamp is refused")
    func thinWithoutStampRefused() throws {
        try withFixture(MachOFixture.thin(stamp: nil)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A library filetype carrying a valid stamp is refused")
    func nonExecutableFiletypeRefused() throws {
        try withFixture(MachOFixture.thin(fileType: 6)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp naming a different code identifier is refused")
    func wrongCodeIdentifierRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(codeIdentifier: "NotTheHost"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp with an extra key is refused")
    func extraKeyRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(extraField: "\"unexpected\":\"field\""))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp with a missing key is refused")
    func missingKeyRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(omitSourceDirty: true))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A non-canonical key order is refused even with valid fields")
    func nonCanonicalKeyOrderRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(reorderKeys: true))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("Non-canonical whitespace is refused even with valid fields")
    func nonCanonicalWhitespaceRefused() throws {
        var stamp = MachOFixture.canonicalStamp()
        stamp.replaceSubrange(stamp.range(of: Data("\"schemaVersion\":1".utf8))!,
                              with: Data("\"schemaVersion\": 1".utf8))
        try withFixture(MachOFixture.thin(stamp: stamp)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A boolean schema version is refused")
    func booleanSchemaVersionRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(schemaVersionLiteral: "true"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("An all-zero source commit is refused")
    func allZeroSourceCommitRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(
            sourceCommit: String(repeating: "0", count: 40)))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("An uppercase source commit is refused")
    func uppercaseSourceCommitRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(
            sourceCommit: MachOFixture.commit.uppercased()))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A short source commit is refused")
    func shortSourceCommitRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(
            sourceCommit: String(MachOFixture.commit.prefix(39))))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A short build number is refused")
    func shortBuildRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(build: "20261120001"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp missing a contract capability is refused")
    func missingCapabilityRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(
            capabilities: Array(MachOFixture.hostCapabilities.prefix(4))))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A stamp with an unexpected extra capability is refused")
    func extraCapabilityRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(
            capabilities: MachOFixture.hostCapabilities + ["queued-jobs-v1"]))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A wrong marketing version is refused")
    func wrongMarketingVersionRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(marketingVersion: "1.0.0"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A developer-id stamp with dirty source is refused")
    func dirtyDeveloperIDRefused() throws {
        try withFixture(MachOFixture.thin(stamp: MachOFixture.canonicalStamp(sourceDirtyLiteral: "true"))) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("A BOM-prefixed stamp is refused")
    func bomPrefixedStampRefused() throws {
        var stamp = Data([0xef, 0xbb, 0xbf])
        stamp.append(MachOFixture.canonicalStamp())
        try withFixture(MachOFixture.thin(stamp: stamp)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    @Test("Invalid UTF-8 in the stamp is refused")
    func invalidUTF8StampRefused() throws {
        var stamp = Data([0xff])
        stamp.append(MachOFixture.canonicalStamp())
        try withFixture(MachOFixture.thin(stamp: stamp)) { url in
            #expect(reader.stamp(ofExecutableAt: url) == nil)
        }
    }

    // MARK: - File discipline (open and read behavior)

    @Test("A symlink substituted for the executable is refused")
    func symlinkRefused() throws {
        let directory = try fixtureDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let target = directory.appendingPathComponent("real")
        try MachOFixture.thin().write(to: target)
        let alias = directory.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: target)
        #expect(reader.stamp(ofExecutableAt: alias) == nil)
    }

    @Test("A FIFO substituted for the executable is refused without hanging")
    func fifoRefused() throws {
        let directory = try fixtureDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fifo = directory.appendingPathComponent("fifo")
        #expect(mkfifo(fifo.path, 0o600) == 0)
        // Without O_NONBLOCK this open would hang until a writer appears.
        #expect(reader.stamp(ofExecutableAt: fifo) == nil)
    }

    @Test("A directory target is refused")
    func directoryRefused() throws {
        let directory = try fixtureDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        #expect(reader.stamp(ofExecutableAt: directory) == nil)
    }

    @Test("A sparse file over the size cap is refused without being read")
    func oversizedFileRefused() throws {
        let directory = try fixtureDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("oversized")
        try Data().write(to: url)
        let handle = try FileHandle(forWritingTo: url)
        handle.truncateFile(atOffset: UInt64(MachONativeHostStampReader.maximumFileBytes + 1))
        try handle.close()
        #expect(reader.stamp(ofExecutableAt: url) == nil)
    }

    @Test("The read discipline refuses a file that grows mid-read")
    func growingReadRefused() throws {
        var endpoints: [Int32] = [0, 0]
        #expect(pipe(&endpoints) == 0)
        let payload = Data(repeating: 0x41, count: 110)
        Darwin.write(endpoints[1], [UInt8](payload), payload.count)
        Darwin.close(endpoints[1])
        #expect(MachONativeHostStampReader.readAll(fd: endpoints[0], expectedSize: 100) == nil)
        Darwin.close(endpoints[0])
    }

    @Test("The read discipline refuses a file that shrinks mid-read")
    func shrinkingReadRefused() throws {
        var endpoints: [Int32] = [0, 0]
        #expect(pipe(&endpoints) == 0)
        let payload = Data(repeating: 0x41, count: 90)
        Darwin.write(endpoints[1], [UInt8](payload), payload.count)
        Darwin.close(endpoints[1])
        #expect(MachONativeHostStampReader.readAll(fd: endpoints[0], expectedSize: 100) == nil)
        Darwin.close(endpoints[0])
    }

    @Test("The read discipline returns exactly the inspected size")
    func exactSizeReadAccepted() throws {
        var endpoints: [Int32] = [0, 0]
        #expect(pipe(&endpoints) == 0)
        let payload = Data(repeating: 0x41, count: 100)
        Darwin.write(endpoints[1], [UInt8](payload), payload.count)
        Darwin.close(endpoints[1])
        let data = MachONativeHostStampReader.readAll(fd: endpoints[0], expectedSize: 100)
        Darwin.close(endpoints[0])
        #expect(data == payload)
    }

    // MARK: - Installer integration and signature binding

    @Test("The default stamp reader is the Mach-O production reader and validates a stamped host")
    func defaultReaderIntegration() throws {
        let harness = try BindingHarness()
        defer { harness.remove() }
        // Constructing without a stampReader argument proves the production default exists;
        // validation then runs the real reader over the fixture binary.
        let installer = NativeHeadlessHostInstaller(configuration: harness.configuration(),
                                                    inspector: harness.matchingInspector(),
                                                    ownershipApplier: BindingHarness.FakeOwnershipApplier())
        let validation = try installer.validate()
        #expect(validation.executable == harness.executable.standardizedFileURL)
    }

    @Test("A stamp whose code identifier differs from the configured expectation is refused as an identity mismatch")
    func stampBindingRefusesMismatchedExpectation() throws {
        let harness = try BindingHarness()
        defer { harness.remove() }
        let foreign = BindingHarness.InjectedStampReader(stamp:
            NativeHostArtifactStamp(schemaVersion: 1, capabilities: MachOFixture.hostCapabilities,
                                    codeIdentifier: "NotTheHost"))
        let installer = NativeHeadlessHostInstaller(configuration: harness.configuration(),
                                                    inspector: harness.matchingInspector(),
                                                    ownershipApplier: BindingHarness.FakeOwnershipApplier(),
                                                    stampReader: foreign)
        #expect(throws: NativeHeadlessHostInstallerError.identityMismatch) { _ = try installer.validate() }
    }

    @Test("The binding follows the configured expectation rather than a hardcoded identifier")
    func stampBindingFollowsConfiguration() throws {
        // The injected reader (not the Mach-O reader, which pins the packaging identifier)
        // is what exercises the configurable half of the binding.
        let harness = try BindingHarness(codeIdentifier: "CustomHost")
        defer { harness.remove() }
        let custom = BindingHarness.InjectedStampReader(stamp:
            NativeHostArtifactStamp(schemaVersion: 1, capabilities: MachOFixture.hostCapabilities,
                                    codeIdentifier: "CustomHost"))
        let installer = NativeHeadlessHostInstaller(configuration: harness.configuration(),
                                                    inspector: harness.matchingInspector(),
                                                    ownershipApplier: BindingHarness.FakeOwnershipApplier(),
                                                    stampReader: custom)
        #expect(throws: Never.self) { _ = try installer.validate() }
    }

    // MARK: - Fixture file helpers

    /// Writes bytes as an executable file in a fresh temporary directory, runs the body,
    /// and removes the directory afterwards.
    private func withFixture(_ bytes: Data, _ body: (URL) throws -> Void) throws {
        let directory = try fixtureDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("BotFleetNativeHost")
        try bytes.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        try body(url)
    }

    private func fixtureDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("stamp-reader-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        return directory
    }
}

private extension Data {
    mutating func setU32LE(_ value: UInt32, at offset: Int) {
        self[offset] = UInt8(value & 0xff)
        self[offset + 1] = UInt8((value >> 8) & 0xff)
        self[offset + 2] = UInt8((value >> 16) & 0xff)
        self[offset + 3] = UInt8((value >> 24) & 0xff)
    }

    mutating func setU64LE(_ value: UInt64, at offset: Int) {
        for index in 0 ..< 8 {
            self[offset + index] = UInt8((value >> UInt64(index * 8)) & 0xff)
        }
    }
}

/// Builds the Mach-O fixture binaries.  Layouts mirror the packaging reference exactly:
/// 32-byte mach_header_64, one LC_SEGMENT_64, section_64 entries, then the stamp payload.
/// Default-layout absolute offsets used by the mutation closures above:
/// header ncmds@16; LC_SEGMENT_64 @32 with cmdsize@36, segname@40, vmaddr@56, vmsize@64,
/// fileoff@72, filesize@80, nsects@96; section_64 @104 with sectname@104, segname@120,
/// addr@136, size@144, offset@152; stamp bytes @184.
private enum MachOFixture {
    static let hostCapabilities = ["identity-v1", "foreground-service-data-v1", "signal-drain-v1",
                                   "automatic-start-v1", "checked-control-v1"]
    static let commit = "0123456789abcdef0123456789abcdef01234567"

    /// The canonical stamp JSON in packaging key order; literals allow malformed variants.
    static func canonicalStamp(build: String = "202611200001",
                               codeIdentifier: String = "BotFleetNativeHost",
                               sourceCommit: String? = nil,
                               marketingVersion: String = "0.1.0",
                               capabilities: [String]? = nil,
                               distribution: String = "developer-id",
                               schemaVersionLiteral: String = "1",
                               sourceDirtyLiteral: String = "false",
                               extraField: String? = nil,
                               omitSourceDirty: Bool = false,
                               reorderKeys: Bool = false) -> Data {
        let sourceCommit = sourceCommit ?? Self.commit
        let capabilities = capabilities ?? Self.hostCapabilities
        let capabilityList = capabilities.map { "\"\($0)\"" }.joined(separator: ",")
        var fields = [
            "\"schemaVersion\":\(schemaVersionLiteral)",
            "\"codeIdentifier\":\"\(codeIdentifier)\"",
            "\"sourceCommit\":\"\(sourceCommit)\"",
            "\"build\":\"\(build)\"",
            "\"marketingVersion\":\"\(marketingVersion)\"",
            "\"capabilities\":[\(capabilityList)]",
            "\"distribution\":\"\(distribution)\"",
        ]
        if !omitSourceDirty { fields.append("\"sourceDirty\":\(sourceDirtyLiteral)") }
        if let extraField { fields.append(extraField) }
        if reorderKeys { fields.swapAt(0, 1) }
        return Data("{\(fields.joined(separator: ","))}".utf8)
    }

    static func thin(arch: String = "arm64", stamp: Data? = canonicalStamp(),
                     segmentName: String = "__TEXT", sectionSegName: String? = nil,
                     fileType: UInt32 = 2, extraCommand: Data? = nil,
                     sectionSizeOverride: Int? = nil, duplicateStampSection: Bool = false,
                     subtypeOverride: UInt32? = nil, trailingPadding: Int = 0,
                     mutate: ((inout Data) -> Void)? = nil) -> Data {
        let cpu: UInt32 = arch == "arm64" ? 0x0100_000c : 0x0100_0007
        let subtype = subtypeOverride ?? (arch == "arm64" ? 0 : 3)
        let sectionCount = stamp != nil ? (duplicateStampSection ? 2 : 1) : 0
        let segmentSize = 72 + 80 * sectionCount
        let commandBytes = segmentSize + (extraCommand?.count ?? 0)
        let dataOffset = 32 + commandBytes
        let declaredSize = sectionSizeOverride ?? (stamp?.count ?? 0)
        let payloadLength = max(declaredSize, stamp?.count ?? 0)
        let copies = duplicateStampSection ? 2 : 1
        let total = dataOffset + payloadLength * copies + trailingPadding

        var bytes = Assembler()
        bytes.u32le(0xfeedfacf) // MH_MAGIC_64
        bytes.u32le(cpu)
        bytes.u32le(subtype)
        bytes.u32le(fileType)
        bytes.u32le(UInt32(extraCommand != nil ? 2 : 1)) // ncmds
        bytes.u32le(UInt32(commandBytes))
        bytes.u32le(0) // flags
        bytes.u32le(0) // reserved
        bytes.u32le(0x19) // LC_SEGMENT_64
        bytes.u32le(UInt32(segmentSize))
        bytes.fixed(segmentName)
        bytes.u64le(0x1_0000_0000) // vmaddr
        bytes.u64le(0x2000) // vmsize
        bytes.u64le(0) // fileoff
        bytes.u64le(UInt64(total)) // filesize
        bytes.u32le(5) // maxprot
        bytes.u32le(5) // initprot
        bytes.u32le(UInt32(sectionCount)) // nsects
        bytes.u32le(0) // flags
        if stamp != nil {
            func writeSection(_ payloadOffset: Int) {
                bytes.fixed("__bf_identity")
                bytes.fixed(sectionSegName ?? segmentName)
                bytes.u64le(0x1_0000_0000 + UInt64(payloadOffset)) // addr
                bytes.u64le(UInt64(declaredSize)) // size
                bytes.u32le(UInt32(payloadOffset)) // offset
                for _ in 0 ..< 7 { bytes.u32le(0) } // align, reloff, nreloc, flags, reserved1-3
            }
            writeSection(dataOffset)
            if duplicateStampSection { writeSection(dataOffset + payloadLength) }
        }
        if let extraCommand { bytes.append(extraCommand) }
        if let stamp {
            bytes.append(stamp)
            bytes.pad(to: dataOffset + payloadLength)
            if duplicateStampSection { bytes.append(stamp) }
        }
        bytes.pad(to: total)
        var result = bytes.data
        if let mutate { mutate(&result) }
        return result
    }

    /// A generic dylib/dylinker/dyld-environment style load command carrying a name.
    static func loadCommand(_ command: UInt32, name: String) -> Data {
        var bytes = Assembler()
        let nameBytes = Array((name + "\0").utf8)
        let length = ((12 + nameBytes.count + 7) / 8) * 8
        bytes.u32le(command)
        bytes.u32le(UInt32(length))
        bytes.u32le(12) // name offset
        bytes.append(Data(nameBytes))
        bytes.pad(to: length)
        return bytes.data
    }

    /// An LC_LOAD_DYLIB command whose declared length is not a multiple of 8.
    static func oddLengthCommand() -> Data {
        var bytes = Assembler()
        bytes.u32le(0xc) // LC_LOAD_DYLIB
        bytes.u32le(9)
        bytes.u32le(24)
        bytes.pad(to: 9)
        return bytes.data
    }

    /// An LC_LOAD_DYLIB command with exactly room for a 12-character name and no NUL.
    static func unterminatedDylibCommand() -> Data {
        var bytes = Assembler()
        bytes.u32le(0xc) // LC_LOAD_DYLIB
        bytes.u32le(24)
        bytes.u32le(12)
        bytes.append(Data("abcdefghijkl".utf8))
        return bytes.data
    }

    struct FatRecord {
        let cpu: UInt32
        let subtype: UInt32
        let slice: Data
    }

    /// A big-endian fat wrapper for the supplied slice records (cafebabe or cafebabf).
    static func fat(_ records: [FatRecord], overlap: Bool = false, fat64: Bool = false) -> Data {
        let stride = fat64 ? 32 : 20
        let firstOffset = 8 + records.count * stride
        var offsets: [Int] = []
        var cursor = firstOffset
        for record in records {
            offsets.append(cursor)
            cursor += record.slice.count
        }
        if overlap, offsets.count > 1 { offsets[1] = firstOffset + 10 }
        let total = (overlap && offsets.count > 1) ? offsets[1] + records[1].slice.count : cursor

        var bytes = Assembler()
        bytes.u32be(fat64 ? 0xcafe_babf : 0xcafe_babe)
        bytes.u32be(UInt32(records.count))
        for (index, record) in records.enumerated() {
            bytes.u32be(record.cpu)
            bytes.u32be(record.subtype)
            if fat64 {
                bytes.u64be(UInt64(offsets[index]))
                bytes.u64be(UInt64(record.slice.count))
            } else {
                bytes.u32be(UInt32(offsets[index]))
                bytes.u32be(UInt32(record.slice.count))
            }
            bytes.u32be(0) // align
            if fat64 { bytes.u32be(0) } // reserved
        }
        for (index, record) in records.enumerated() {
            bytes.pad(to: offsets[index])
            bytes.append(record.slice)
        }
        bytes.pad(to: total)
        return bytes.data
    }

    static func fat2(_ arm64: Data, _ x86_64: Data, overlap: Bool = false, fat64: Bool = false) -> Data {
        fat([FatRecord(cpu: 0x0100_000c, subtype: 0, slice: arm64),
             FatRecord(cpu: 0x0100_0007, subtype: 3, slice: x86_64)], overlap: overlap, fat64: fat64)
    }
}

private struct Assembler {
    private(set) var data = Data()

    mutating func u32le(_ value: UInt32) {
        data.append(contentsOf: [UInt8(value & 0xff), UInt8((value >> 8) & 0xff),
                                 UInt8((value >> 16) & 0xff), UInt8((value >> 24) & 0xff)])
    }

    mutating func u32be(_ value: UInt32) {
        data.append(contentsOf: [UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
                                 UInt8((value >> 8) & 0xff), UInt8(value & 0xff)])
    }

    mutating func u64le(_ value: UInt64) {
        for shift in stride(from: 0, through: 56, by: 8) {
            data.append(UInt8((value >> shift) & 0xff))
        }
    }

    mutating func u64be(_ value: UInt64) {
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((value >> shift) & 0xff))
        }
    }

    mutating func fixed(_ name: String, _ width: Int = 16) {
        var field = Data(name.utf8)
        if field.count < width { field.append(Data(count: width - field.count)) }
        data.append(field.prefix(width))
    }

    mutating func append(_ other: Data) { data.append(other) }

    mutating func pad(to length: Int) {
        if data.count < length { data.append(Data(count: length - data.count)) }
    }
}

/// Minimal installer scaffolding for the binding tests, kept local so this file stays
/// independent of the existing installer fixture file (which a separate delta touches).
private final class BindingHarness {
    final class FakeOwnershipApplier: NativeHostDataRootOwnershipApplying, @unchecked Sendable {
        func serviceUID(forUserName name: String) -> uid_t? { 9999 }
        func applyOwnership(of url: URL, userName: String) throws {}
    }

    struct InjectedStampReader: NativeHostStampReading {
        let stamp: NativeHostArtifactStamp?
        func stamp(ofExecutableAt url: URL) -> NativeHostArtifactStamp? { stamp }
    }

    struct FakeSignatureInspector: NativeHostSignatureInspecting {
        let identity: NativeHostSigningIdentity?
        func signingIdentity(ofExecutableAt url: URL) -> NativeHostSigningIdentity? { identity }
    }

    let parent: URL
    let codeIdentifier: String
    var executable: URL { parent.appendingPathComponent("BotFleetNativeHost") }
    var dataRoot: URL { parent.appendingPathComponent("service-data", isDirectory: true) }
    var launchdDirectory: URL { parent.appendingPathComponent("launchd", isDirectory: true) }
    var destination: URL { launchdDirectory.appendingPathComponent("app.botfleet.nativehost.plist") }

    init(codeIdentifier: String = "BotFleetNativeHost") throws {
        self.codeIdentifier = codeIdentifier
        parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("stamp-binding-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.createDirectory(at: launchdDirectory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try MachOFixture.thin().write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }

    func configuration() -> NativeHeadlessHostInstallConfiguration {
        NativeHeadlessHostInstallConfiguration(executable: executable, serviceDataRoot: dataRoot,
                                               plistDestination: destination,
                                               expectedTeamIdentifier: "TEAMFIXTURE1",
                                               expectedCodeIdentifier: codeIdentifier)
    }

    func matchingInspector() -> FakeSignatureInspector {
        FakeSignatureInspector(identity: NativeHostSigningIdentity(codeIdentifier: codeIdentifier,
                                                                   teamIdentifier: "TEAMFIXTURE1",
                                                                   signingFlags: 0))
    }

    func remove() { try? FileManager.default.removeItem(at: parent) }
}
#endif
