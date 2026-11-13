public enum ProfileSaveGate {
    /// Runs a profile save and applies the server-confirmed value only when the
    /// request succeeds.  Callers can use the return value to gate dismissal.
    @MainActor
    public static func run<Value>(
        save: () async -> Value?,
        accept: (Value) -> Void
    ) async -> Bool {
        await run(save: save, accept: accept, rejected: {})
    }

    /// The same, and a refused save also calls `rejected`, so the caller can put
    /// the fields the server may refuse back to what the server holds.  Without
    /// it a refused switch sits in the sheet looking saved, with an error
    /// banner above it.  Edits the server has no say over, like a name, stay
    /// in the sheet for the retry.
    @MainActor
    public static func run<Value>(
        save: () async -> Value?,
        accept: (Value) -> Void,
        rejected: () -> Void
    ) async -> Bool {
        guard let saved = await save() else {
            rejected()
            return false
        }
        accept(saved)
        return true
    }
}
