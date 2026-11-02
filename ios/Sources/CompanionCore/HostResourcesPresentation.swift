import Foundation

/// Data volume mount descriptor reported in `CapacitySample`.
public struct HostDataVolume: Codable, Equatable, Sendable {
    public var device: String
    public var mountPoint: String

    public init(device: String, mountPoint: String) {
        self.device = device
        self.mountPoint = mountPoint
    }
}

/// Bracketed storage-device observation from `GET /api/host/resources`.
public struct HostStorageState: Codable, Equatable, Sendable {
    public var online: Bool
    public var dataDevice: String?
    public var rootDevice: String?
    public var reason: String?

    public init(online: Bool, dataDevice: String? = nil, rootDevice: String? = nil, reason: String? = nil) {
        self.online = online
        self.dataDevice = dataDevice
        self.rootDevice = rootDevice
        self.reason = reason
    }
}

/// Point-in-time host capacity reading (`CapacitySample` in `shared/placement.ts`).
/// Null readings mean unknown, never zero capacity or zero use.
public struct HostCapacitySample: Codable, Equatable, Sendable {
    public var at: Double
    public var cores: Double?
    public var loadPerCore: Double?
    public var ramTotalBytes: Double?
    public var ramAvailableBytes: Double?
    public var memoryPressure: String?
    public var memoryAvailablePercent: Double?
    public var swapTotalBytes: Double?
    public var swapUsedBytes: Double?
    public var diskTotalBytes: Double?
    public var diskFreeBytes: Double?
    public var inodesTotal: Double?
    public var inodesFree: Double?
    public var dataVolume: HostDataVolume?
    public var rootDiskFreeBytes: Double?
    public var storage: HostStorageState?

    public init(
        at: Double,
        cores: Double? = nil,
        loadPerCore: Double? = nil,
        ramTotalBytes: Double? = nil,
        ramAvailableBytes: Double? = nil,
        memoryPressure: String? = nil,
        memoryAvailablePercent: Double? = nil,
        swapTotalBytes: Double? = nil,
        swapUsedBytes: Double? = nil,
        diskTotalBytes: Double? = nil,
        diskFreeBytes: Double? = nil,
        inodesTotal: Double? = nil,
        inodesFree: Double? = nil,
        dataVolume: HostDataVolume? = nil,
        rootDiskFreeBytes: Double? = nil,
        storage: HostStorageState? = nil
    ) {
        self.at = at
        self.cores = cores
        self.loadPerCore = loadPerCore
        self.ramTotalBytes = ramTotalBytes
        self.ramAvailableBytes = ramAvailableBytes
        self.memoryPressure = memoryPressure
        self.memoryAvailablePercent = memoryAvailablePercent
        self.swapTotalBytes = swapTotalBytes
        self.swapUsedBytes = swapUsedBytes
        self.diskTotalBytes = diskTotalBytes
        self.diskFreeBytes = diskFreeBytes
        self.inodesTotal = inodesTotal
        self.inodesFree = inodesFree
        self.dataVolume = dataVolume
        self.rootDiskFreeBytes = rootDiskFreeBytes
        self.storage = storage
    }
}

/// Admission thresholds reported by `GET /api/host/resources`.
public struct HostAdmissionThresholds: Codable, Equatable, Sendable {
    public var maxSwapPercent: Double
    public var minFreeDiskBytes: Double
    public var minFreeInodes: Double?
    public var reservedCpuCores: Double?
    public var reservedRamBytes: Double?
    public var minMemoryAvailablePercent: Double?
    public var unknownReading: String

    public init(
        maxSwapPercent: Double = 98,
        minFreeDiskBytes: Double = 2 * 1024 * 1024 * 1024,
        minFreeInodes: Double? = nil,
        reservedCpuCores: Double? = nil,
        reservedRamBytes: Double? = nil,
        minMemoryAvailablePercent: Double? = nil,
        unknownReading: String = "admit"
    ) {
        self.maxSwapPercent = maxSwapPercent
        self.minFreeDiskBytes = minFreeDiskBytes
        self.minFreeInodes = minFreeInodes
        self.reservedCpuCores = reservedCpuCores
        self.reservedRamBytes = reservedRamBytes
        self.minMemoryAvailablePercent = minMemoryAvailablePercent
        self.unknownReading = unknownReading
    }

    private enum CodingKeys: String, CodingKey {
        case maxSwapPercent
        case minFreeDiskBytes
        case minFreeInodes
        case reservedCpuCores
        case reservedRamBytes
        case minMemoryAvailablePercent
        case unknownReading
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        maxSwapPercent = try container.decode(Double.self, forKey: .maxSwapPercent)
        minFreeDiskBytes = try container.decode(Double.self, forKey: .minFreeDiskBytes)
        minFreeInodes = try container.decodeIfPresent(Double.self, forKey: .minFreeInodes)
        reservedCpuCores = try container.decodeIfPresent(Double.self, forKey: .reservedCpuCores)
        reservedRamBytes = try container.decodeIfPresent(Double.self, forKey: .reservedRamBytes)
        minMemoryAvailablePercent = try container.decodeIfPresent(Double.self, forKey: .minMemoryAvailablePercent)
        let reading = try container.decode(String.self, forKey: .unknownReading)
        guard reading == "admit" else {
            throw DecodingError.dataCorruptedError(
                forKey: .unknownReading,
                in: container,
                debugDescription: "unknownReading must be admit"
            )
        }
        unknownReading = reading
    }
}

/// Per-resource enforcement mechanism reported by `GET /api/host/resources`.
public enum HostEnforcementState: Codable, Equatable, Sendable {
    case kernelCap(mechanism: String)
    case stopWhenOver
    case gateOnly
    case priorityOnly
    case unsupported(reason: String)
    case notApplied(reason: String, restartRequired: Bool)

    private enum CodingKeys: String, CodingKey {
        case kind
        case mechanism
        case reason
        case restartRequired
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "kernelCap":
            self = .kernelCap(mechanism: try container.decode(String.self, forKey: .mechanism))
        case "stopWhenOver":
            self = .stopWhenOver
        case "gateOnly":
            self = .gateOnly
        case "priorityOnly":
            self = .priorityOnly
        case "unsupported":
            self = .unsupported(reason: try container.decode(String.self, forKey: .reason))
        case "notApplied":
            self = .notApplied(
                reason: try container.decode(String.self, forKey: .reason),
                restartRequired: try container.decodeIfPresent(Bool.self, forKey: .restartRequired) ?? false
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown EnforcementState kind: \(kind)"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .kernelCap(let mechanism):
            try container.encode("kernelCap", forKey: .kind)
            try container.encode(mechanism, forKey: .mechanism)
        case .stopWhenOver:
            try container.encode("stopWhenOver", forKey: .kind)
        case .gateOnly:
            try container.encode("gateOnly", forKey: .kind)
        case .priorityOnly:
            try container.encode("priorityOnly", forKey: .kind)
        case .unsupported(let reason):
            try container.encode("unsupported", forKey: .kind)
            try container.encode(reason, forKey: .reason)
        case .notApplied(let reason, let restartRequired):
            try container.encode("notApplied", forKey: .kind)
            try container.encode(reason, forKey: .reason)
            try container.encode(restartRequired, forKey: .restartRequired)
        }
    }
}

/// The six resource enforcement entries in `HostResourcesReport`.
public struct HostEnforcementMap: Codable, Equatable, Sendable {
    public var cpu: HostEnforcementState
    public var memory: HostEnforcementState
    public var swap: HostEnforcementState
    public var disk: HostEnforcementState
    public var inodes: HostEnforcementState
    public var io: HostEnforcementState

    public init(
        cpu: HostEnforcementState = .priorityOnly,
        memory: HostEnforcementState = .gateOnly,
        swap: HostEnforcementState = .gateOnly,
        disk: HostEnforcementState = .gateOnly,
        inodes: HostEnforcementState = .unsupported(reason: "No inode admission gate is active"),
        io: HostEnforcementState = .unsupported(reason: "No I/O rate enforcement observed")
    ) {
        self.cpu = cpu
        self.memory = memory
        self.swap = swap
        self.disk = disk
        self.inodes = inodes
        self.io = io
    }
}

/// Full report returned by `GET /api/host/resources`.
public struct HostResourcesReport: Codable, Equatable, Sendable {
    public var hostId: String
    public var version: String?
    public var platform: String
    public var capabilities: [String]
    public var sample: HostCapacitySample
    public var storage: HostStorageState?
    public var admission: HostAdmissionThresholds
    public var enforcement: HostEnforcementMap
    public var observedLimits: [String: String?]
    public var limitations: [String]

    private enum CodingKeys: String, CodingKey {
        case hostId, version, platform, capabilities, sample, storage, admission, enforcement, observedLimits, limitations
    }

    public init(
        hostId: String,
        version: String? = nil,
        platform: String,
        capabilities: [String] = [],
        sample: HostCapacitySample,
        storage: HostStorageState? = nil,
        admission: HostAdmissionThresholds = HostAdmissionThresholds(),
        enforcement: HostEnforcementMap = HostEnforcementMap(),
        observedLimits: [String: String?] = [:],
        limitations: [String] = []
    ) {
        self.hostId = hostId
        self.version = version
        self.platform = platform
        self.capabilities = capabilities
        self.sample = sample
        self.storage = storage
        self.admission = admission
        self.enforcement = enforcement
        self.observedLimits = observedLimits
        self.limitations = limitations
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostId = try container.decode(String.self, forKey: .hostId)
        version = try container.decodeIfPresent(String.self, forKey: .version)
        let decodedPlatform = try container.decode(String.self, forKey: .platform)
        guard decodedPlatform == "darwin" || decodedPlatform == "linux" else {
            throw DecodingError.dataCorruptedError(
                forKey: .platform,
                in: container,
                debugDescription: "Unsupported host platform: \(decodedPlatform)"
            )
        }
        platform = decodedPlatform
        capabilities = try container.decode([String].self, forKey: .capabilities)
        sample = try container.decode(HostCapacitySample.self, forKey: .sample)
        storage = try container.decodeIfPresent(HostStorageState.self, forKey: .storage)
        admission = try container.decode(HostAdmissionThresholds.self, forKey: .admission)
        enforcement = try container.decode(HostEnforcementMap.self, forKey: .enforcement)
        observedLimits = try container.decodeIfPresent([String: String?].self, forKey: .observedLimits) ?? [:]
        limitations = try container.decode([String].self, forKey: .limitations)
    }
}

/// One resource reading row for `Settings › Resources`.
public struct HostResourceRow: Equatable, Identifiable, Sendable {
    public var key: String
    public var label: String
    public var detected: String
    public var use: String
    public var enforcement: String
    public var alert: String?

    public var id: String { key }

    public init(
        key: String,
        label: String,
        detected: String,
        use: String,
        enforcement: String,
        alert: String? = nil
    ) {
        self.key = key
        self.label = label
        self.detected = detected
        self.use = use
        self.enforcement = enforcement
        self.alert = alert
    }
}

/// One saved-versus-applied admission threshold row for `Settings › Resources`.
public struct HostAdmissionRow: Equatable, Identifiable, Sendable {
    public var key: String
    public var label: String
    /// Config knob path, e.g. `jobs.admission.maxSwapPercent`.
    public var knob: String
    /// Infisical / environment variable name, e.g. `BOTFLEET_JOBS_MAX_SWAP_PERCENT`.
    public var source: String
    public var saved: String
    public var applied: String
    public var mismatch: String?
    public var note: String?

    public var id: String { key }
    public var envOverride: String { source }

    public init(
        key: String,
        label: String,
        knob: String,
        source: String,
        saved: String,
        applied: String,
        mismatch: String? = nil,
        note: String? = nil
    ) {
        self.key = key
        self.label = label
        self.knob = knob
        self.source = source
        self.saved = saved
        self.applied = applied
        self.mismatch = mismatch
        self.note = note
    }
}

/// Pure presentation helpers for `Settings › Resources`, mirroring `src/lib/host-resources.ts`.
///
/// Copy rules (`docs/plans/2026-10-29-native-server-mode.md`):
/// units on every number; `"Enforced by the system"` only for `kernelCap`;
/// `"Not set"` never reads as a number; the words `"limit"` and `"cap"` appear
/// only on a `kernelCap` row; sentence gaps use `"\u{00A0} "`; times in Central,
/// 12-hour.
public enum HostResourcesPresentation {
    private static let gap = "\u{00A0} "
    private static let unknown = "Unknown"
    private static let countFormatterLock = NSLock()
    private static let countFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        return formatter
    }()
    private static let centralTimeFormatterLock = NSLock()
    private static let centralTimeZone = TimeZone(identifier: "America/Chicago") ?? .current
    private static let centralTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = centralTimeZone
        formatter.dateFormat = "MMM d, h:mm a"
        return formatter
    }()

    /// `"this Mac"` on darwin, `"the server"` on linux — the nouns the refusal
    /// and no-capacity sentences use, so no host name lands in a default.
    public static func hostNoun(_ report: HostResourcesReport) -> String {
        if report.platform == "darwin" || report.hostId.hasPrefix("mac:") {
            return "this Mac"
        }
        if report.platform == "linux" || report.hostId.hasPrefix("server:") {
            return "the server"
        }
        return "this host"
    }

    public static func hostNoun(platform: String) -> String {
        if platform == "darwin" || platform.hasPrefix("mac:") {
            return "this Mac"
        }
        if platform == "linux" || platform.hasPrefix("server:") {
            return "the server"
        }
        return "this host"
    }

    /// The one enforcement sentence per `HostEnforcementState`, and nothing else.
    public static func enforcementSentence(_ state: HostEnforcementState, noun: String) -> String {
        switch state {
        case .kernelCap(let mechanism):
            return "Enforced by the system (\(mechanism))"
        case .stopWhenOver:
            return "Watched: jobs are stopped if they exceed it"
        case .gateOnly:
            return "Checked before each job starts"
        case .priorityOnly:
            return "Full speed allowed.\(gap)Jobs run at background priority."
        case .unsupported(let reason):
            return "Not enforced on \(noun): \(reason)"
        case .notApplied(let reason, _):
            return reason.hasPrefix("Not applied") ? reason : "Not applied: \(reason)"
        }
    }

    public static func enforcementSentence(for report: HostResourcesReport) -> String {
        enforcementSentence(report.enforcement.cpu, noun: hostNoun(report))
    }

    /// Formats a byte count with its unit (`GB`, `MB`, `KB`, or `bytes`).
    public static func formatBytes(_ bytes: Double) -> String {
        let gb = pow(1024.0, 3.0)
        let mb = pow(1024.0, 2.0)
        let kb = 1024.0
        if bytes >= gb {
            return String(format: "%.1f GB", locale: Locale(identifier: "en_US_POSIX"), bytes / gb)
        }
        if bytes >= mb {
            return "\(Int((bytes / mb).rounded())) MB"
        }
        if bytes >= kb {
            return "\(Int((bytes / kb).rounded())) KB"
        }
        return "\(Int(bytes.rounded())) bytes"
    }

    public static func formatBytes(_ bytes: Double?) -> String {
        guard let bytes else { return unknown }
        return formatBytes(bytes)
    }

    /// Formats a count with US digit grouping and its unit word, never a bare number.
    public static func formatCount(_ n: Double, singular: String, plural: String? = nil) -> String {
        let intVal = Int(n.rounded())
        let word = intVal == 1 ? singular : (plural ?? "\(singular)s")
        countFormatterLock.lock()
        let digits = countFormatter.string(from: NSNumber(value: intVal)) ?? "\(intVal)"
        countFormatterLock.unlock()
        return "\(digits) \(word)"
    }

    public static func formatCount(_ n: Double?, singular: String = "item", plural: String? = nil) -> String {
        guard let n else { return unknown }
        return formatCount(n, singular: singular, plural: plural)
    }

    /// Formats a percentage matching TypeScript `${value}%` interpolation:
    /// whole numbers omit `.0` (`98%`), fractional values preserve decimals (`85.5%`).
    public static func formatPercent(_ value: Double) -> String {
        "\(formatNumericValue(value))%"
    }

    /// Formats a numeric value without `.0` for exact integers while preserving fractional digits.
    public static func formatNumericValue(_ value: Double) -> String {
        if value.isFinite, value.truncatingRemainder(dividingBy: 1) == 0 {
            return "\(Int(value))"
        }
        return String(format: "%g", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    /// Central Time (`America/Chicago`), 12-hour format with short timezone name.
    public static func formatCentralTime(_ timestampMs: Double) -> String {
        let date = Date(timeIntervalSince1970: timestampMs / 1000.0)
        centralTimeFormatterLock.lock()
        let formatted = centralTimeFormatter.string(from: date)
        let tzAbbrev = centralTimeZone.abbreviation(for: date) ?? "CT"
        centralTimeFormatterLock.unlock()
        return "\(formatted) \(tzAbbrev)"
    }

    /// `"This leaves BotFleet no capacity on <host>.  New jobs will wait here until you lower it"`
    public static func noCapacitySentence(noun: String) -> String {
        "This leaves BotFleet no capacity on \(noun).\(gap)New jobs will wait here until you lower it"
    }

    public static func noCapacitySentence(platform: String) -> String {
        let noun = (platform == "this Mac" || platform == "the server" || platform == "this host")
            ? platform
            : hostNoun(platform: platform)
        return noCapacitySentence(noun: noun)
    }

    /// Effective memory enforcement state: on a swapless host with an owner-set
    /// available-memory headroom knob, the scheduler still enforces the memory
    /// gate via `MemAvailable`, so it reads as `gateOnly` instead of `unsupported`.
    public static func effectiveMemoryEnforcement(for report: HostResourcesReport) -> HostEnforcementState {
        let headroomSet = report.admission.reservedRamBytes != nil || report.admission.minMemoryAvailablePercent != nil
        if headroomSet,
           report.sample.swapTotalBytes == 0,
           case .unsupported = report.enforcement.memory {
            return .gateOnly
        }
        return report.enforcement.memory
    }

    private static func appliedFromEnforcement(
        value: String,
        enforcement: HostEnforcementState,
        noun: String
    ) -> (applied: String, mismatch: String?) {
        switch enforcement {
        case .notApplied, .unsupported:
            let sentence = enforcementSentence(enforcement, noun: noun)
            return (sentence, sentence)
        case .kernelCap, .stopWhenOver, .gateOnly, .priorityOnly:
            return (value, nil)
        }
    }

    private static func unknownReadingSentence(sampleAt: Double) -> String {
        "Reading unavailable as of \(formatCentralTime(sampleAt)): not checked before jobs start"
    }

    /// Saved-versus-applied admission threshold rows.
    public static func admissionRows(for report: HostResourcesReport) -> [HostAdmissionRow] {
        let noun = hostNoun(report)
        let admission = report.admission
        let enforcement = report.enforcement
        let sample = report.sample
        var rows: [HostAdmissionRow] = []

        // 1. Swap gate
        do {
            let value = formatPercent(admission.maxSwapPercent)
            let (applied, mismatch) = appliedFromEnforcement(value: value, enforcement: enforcement.swap, noun: noun)
            rows.append(
                HostAdmissionRow(
                    key: "maxSwapPercent",
                    label: "Swap gate",
                    knob: "jobs.admission.maxSwapPercent",
                    source: "BOTFLEET_JOBS_MAX_SWAP_PERCENT",
                    saved: value,
                    applied: applied,
                    mismatch: mismatch,
                    note: "98% is the built-in default in force when the owner has set nothing — a current default, not a measured value."
                )
            )
        }

        // 2. Minimum free disk
        do {
            let value = formatBytes(admission.minFreeDiskBytes)
            let (applied, rawMismatch) = appliedFromEnforcement(value: value, enforcement: enforcement.disk, noun: noun)
            let overCapacity = sample.diskTotalBytes != nil && admission.minFreeDiskBytes >= sample.diskTotalBytes!
            let mismatch = (rawMismatch == nil && overCapacity) ? noCapacitySentence(noun: noun) : rawMismatch
            rows.append(
                HostAdmissionRow(
                    key: "minFreeDisk",
                    label: "Minimum free disk",
                    knob: "jobs.admission.minFreeDiskMb",
                    source: "BOTFLEET_JOBS_MIN_FREE_DISK_MB",
                    saved: value,
                    applied: applied,
                    mismatch: mismatch,
                    note: "2 GB is the built-in default in force when the owner has set nothing — a current default, not a measured value."
                )
            )
        }

        // 3. Minimum free inodes
        do {
            let saved = admission.minFreeInodes.map { formatCount($0, singular: "inode") } ?? "Not set"
            let applied: String
            let mismatch: String?
            if admission.minFreeInodes == nil {
                applied = "Not set: no gate"
                mismatch = nil
            } else {
                (applied, mismatch) = appliedFromEnforcement(value: saved, enforcement: enforcement.inodes, noun: noun)
            }
            rows.append(
                HostAdmissionRow(
                    key: "minFreeInodes",
                    label: "Minimum free inodes",
                    knob: "jobs.admission.minFreeInodes",
                    source: "BOTFLEET_JOBS_MIN_FREE_INODES",
                    saved: saved,
                    applied: applied,
                    mismatch: mismatch
                )
            )
        }

        // 4. Reserved CPU cores
        do {
            let saved = admission.reservedCpuCores.map { formatCount($0, singular: "core") } ?? "Not set"
            var applied = saved
            var mismatch: String? = nil
            if let reservedCores = admission.reservedCpuCores {
                if report.platform == "darwin" {
                    applied = "Not applied on this Mac: reserved CPU never refuses a job on macOS; it sizes budgets instead"
                    mismatch = applied
                } else {
                    (applied, mismatch) = appliedFromEnforcement(value: saved, enforcement: enforcement.cpu, noun: noun)
                    if mismatch == nil, let totalCores = sample.cores, reservedCores >= totalCores {
                        mismatch = noCapacitySentence(noun: noun)
                    }
                }
            }
            rows.append(
                HostAdmissionRow(
                    key: "reservedCpuCores",
                    label: "Reserved CPU for other apps",
                    knob: "jobs.admission.reservedCpuCores",
                    source: "BOTFLEET_JOBS_RESERVED_CPU_CORES",
                    saved: saved,
                    applied: applied,
                    mismatch: mismatch,
                    note: "Set by the owner — there is deliberately no default.\(gap)An unset knob leaves admission unchanged."
                )
            )
        }

        // 5. Reserved RAM
        do {
            let saved = admission.reservedRamBytes.map(formatBytes) ?? "Not set"
            var applied = saved
            var mismatch: String? = nil
            if let reservedRam = admission.reservedRamBytes {
                (applied, mismatch) = appliedFromEnforcement(
                    value: saved,
                    enforcement: effectiveMemoryEnforcement(for: report),
                    noun: noun
                )
                if mismatch == nil, let totalRam = sample.ramTotalBytes, reservedRam >= totalRam {
                    mismatch = noCapacitySentence(noun: noun)
                }
            }
            rows.append(
                HostAdmissionRow(
                    key: "reservedRam",
                    label: "Reserved RAM for other apps",
                    knob: "jobs.admission.reservedRamMb",
                    source: "BOTFLEET_JOBS_RESERVED_RAM_MB",
                    saved: saved,
                    applied: applied,
                    mismatch: mismatch,
                    note: "Set by the owner — there is deliberately no default.\(gap)An unset knob leaves admission unchanged."
                )
            )
        }

        // 6. Minimum available-memory percent
        do {
            let saved = admission.minMemoryAvailablePercent.map(formatPercent) ?? "Not set"
            var applied = saved
            var mismatch: String? = nil
            if admission.minMemoryAvailablePercent != nil {
                (applied, mismatch) = appliedFromEnforcement(
                    value: saved,
                    enforcement: effectiveMemoryEnforcement(for: report),
                    noun: noun
                )
            }
            rows.append(
                HostAdmissionRow(
                    key: "minMemoryAvailablePercent",
                    label: "Minimum available memory",
                    knob: "jobs.admission.minMemoryAvailablePercent",
                    source: "BOTFLEET_JOBS_MIN_MEMORY_AVAILABLE_PERCENT",
                    saved: saved,
                    applied: applied,
                    mismatch: mismatch,
                    note: "Set by the owner — there is deliberately no default.\(gap)An unset knob leaves admission unchanged."
                )
            )
        }

        return rows
    }

    /// Resource rows for CPU, Memory, Swap, Disk (data volume), Disk (root), Inodes, and I/O.
    public static func resourceRows(for report: HostResourcesReport) -> [HostResourceRow] {
        let noun = hostNoun(report)
        let sample = report.sample
        let enforcement = report.enforcement
        let sampled = "Sampled \(formatCentralTime(sample.at))"
        func useWith(_ text: String) -> String { "\(text) · \(sampled)" }

        let cpuUse: String
        if let load = sample.loadPerCore {
            cpuUse = String(format: "Load %.2f per core", locale: Locale(identifier: "en_US_POSIX"), load)
        } else {
            cpuUse = unknown
        }

        let memoryUse: String
        if let avail = sample.ramAvailableBytes {
            if sample.ramTotalBytes != nil, let pct = sample.memoryAvailablePercent {
                memoryUse = "\(formatBytes(avail)) available (\(Int(pct.rounded()))% of total)"
            } else {
                memoryUse = "\(formatBytes(avail)) available"
            }
        } else {
            memoryUse = unknown
        }

        let swapUse: String
        if let used = sample.swapUsedBytes {
            if let total = sample.swapTotalBytes, total > 0 {
                swapUse = "\(formatBytes(used)) used (\(Int(((used / total) * 100.0).rounded()))% of total)"
            } else {
                swapUse = "\(formatBytes(used)) used"
            }
        } else {
            swapUse = unknown
        }

        let diskUse = sample.diskFreeBytes.map { "\(formatBytes($0)) free" } ?? unknown
        let rootUse = sample.rootDiskFreeBytes.map { "\(formatBytes($0)) free" } ?? unknown
        let inodeUse = sample.inodesFree.map { "\(formatCount($0, singular: "inode")) free" } ?? unknown

        func gateOrUnknown(_ use: String, _ state: HostEnforcementState) -> String {
            if use == unknown, state == .gateOnly {
                return unknownReadingSentence(sampleAt: sample.at)
            }
            return enforcementSentence(state, noun: noun)
        }

        let diskAlert: String?
        if sample.storage?.online == false || report.storage?.online == false {
            let mount = sample.dataVolume?.mountPoint ?? "data volume"
            diskAlert = "Data volume \(mount) is not mounted.\(gap)BotFleet has stopped admitting jobs there and is not writing to the root disk."
        } else {
            diskAlert = nil
        }

        return [
            HostResourceRow(
                key: "cpu",
                label: "CPU",
                detected: sample.cores.map { formatCount($0, singular: "core") } ?? unknown,
                use: useWith(cpuUse),
                enforcement: enforcementSentence(enforcement.cpu, noun: noun)
            ),
            HostResourceRow(
                key: "memory",
                label: "Memory",
                detected: sample.ramTotalBytes.map(formatBytes) ?? unknown,
                use: useWith(
                    sample.memoryPressure != nil && memoryUse != unknown
                        ? "\(memoryUse) · Pressure \(sample.memoryPressure!)"
                        : memoryUse
                ),
                enforcement: gateOrUnknown(memoryUse, effectiveMemoryEnforcement(for: report))
            ),
            HostResourceRow(
                key: "swap",
                label: "Swap",
                detected: sample.swapTotalBytes == nil
                    ? unknown
                    : (sample.swapTotalBytes == 0 ? "None configured" : formatBytes(sample.swapTotalBytes!)),
                use: useWith(swapUse),
                enforcement: gateOrUnknown(swapUse, enforcement.swap)
            ),
            HostResourceRow(
                key: "disk",
                label: sample.dataVolume.map { "Disk (\($0.mountPoint))" } ?? "Disk (data volume)",
                detected: sample.diskTotalBytes.map(formatBytes) ?? unknown,
                use: useWith(diskUse),
                enforcement: gateOrUnknown(diskUse, enforcement.disk),
                alert: diskAlert
            ),
            HostResourceRow(
                key: "rootDisk",
                label: "Disk (root)",
                detected: unknown,
                use: useWith(rootUse),
                enforcement: enforcementSentence(enforcement.disk, noun: noun)
            ),
            HostResourceRow(
                key: "inodes",
                label: "Inodes",
                detected: sample.inodesTotal.map { formatCount($0, singular: "inode") } ?? unknown,
                use: useWith(inodeUse),
                enforcement: gateOrUnknown(inodeUse, enforcement.inodes)
            ),
            HostResourceRow(
                key: "io",
                label: "I/O",
                detected: sample.dataVolume.map { "\($0.device) on \($0.mountPoint)" } ?? unknown,
                use: useWith("Not sampled"),
                enforcement: enforcementSentence(enforcement.io, noun: noun)
            ),
        ]
    }

    /// Header line for the host card: platform, version and capabilities.
    public static func hostSubtitle(for report: HostResourcesReport) -> String {
        let platform: String
        switch report.platform {
        case "darwin": platform = "macOS"
        case "linux": platform = "Linux"
        default: platform = report.platform
        }
        let version = report.version ?? "unknown version"
        let capabilities = report.capabilities.isEmpty
            ? "no capabilities reported"
            : report.capabilities.joined(separator: ", ")
        return "\(platform) · \(version) · \(capabilities)"
    }

    public static func hostSubtitle(for host: HostRecord, activeReport: HostResourcesReport?) -> String {
        if let activeReport {
            return "\(activeReport.hostId) · \(hostSubtitle(for: activeReport))"
        }
        return host.origin.url.absoluteString
    }
}
