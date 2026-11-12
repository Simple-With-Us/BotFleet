public struct LiveActivityRefreshBackoff: Sendable {
    private let maximumNanoseconds: UInt64
    private var nextNanoseconds: UInt64

    public init(
        initialNanoseconds: UInt64 = 1_000_000_000,
        maximumNanoseconds: UInt64 = 15_000_000_000
    ) {
        self.maximumNanoseconds = maximumNanoseconds
        self.nextNanoseconds = min(initialNanoseconds, maximumNanoseconds)
    }

    public mutating func takeNextDelay() -> UInt64 {
        let delay = nextNanoseconds
        if nextNanoseconds > maximumNanoseconds / 2 {
            nextNanoseconds = maximumNanoseconds
        } else {
            nextNanoseconds = min(nextNanoseconds * 2, maximumNanoseconds)
        }
        return delay
    }
}
