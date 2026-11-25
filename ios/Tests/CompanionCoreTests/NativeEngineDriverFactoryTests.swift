import Foundation
import Testing
@testable import CompanionCore

@Suite("Native Engine Driver Factory (BF-2689 Slice 2)")
struct NativeEngineDriverFactoryTests {
    private struct NeverLauncher: EngineProcessLauncher {
        func launch(spec: EngineSpawnSpec, threadId: String, engineId: String) async throws -> EngineProcessSession {
            throw EngineDriverError.spawnFailed("not launched in factory tests")
        }
    }

    @Test("Every supported matrix engine builds a driver carrying its own engine id")
    func supportedEnginesBuildDrivers() throws {
        for id in NativeEngineDriverFactory.supportedEngines {
            let driver = try NativeEngineDriverFactory.makeDriver(for: id, launcher: NeverLauncher())
            #expect(driver.engineId == id.rawValue)
        }
    }

    @Test("Engines without a native driver are refused, not silently substituted")
    func unsupportedEnginesRefused() {
        for id in EngineMatrixID.allCases where !NativeEngineDriverFactory.supports(id) {
            #expect(throws: NativeEngineDriverFactoryError.noNativeDriver(engineId: id.rawValue)) {
                _ = try NativeEngineDriverFactory.makeDriver(for: id, launcher: NeverLauncher())
            }
        }
        #expect(!NativeEngineDriverFactory.supports(.grokApi))
        #expect(!NativeEngineDriverFactory.supports(.cursor))
    }

    @Test("An empty executable override is refused")
    func emptyExecutableRefused() {
        #expect(throws: NativeEngineDriverFactoryError.missingExecutable(engineId: "claude")) {
            _ = try NativeEngineDriverFactory.makeDriver(for: .claude, launcher: NeverLauncher(), executableOverride: "")
        }
    }

    @Test("A whitespace-only executable override is refused, not deferred to spawn")
    func whitespaceExecutableRefused() {
        #expect(throws: NativeEngineDriverFactoryError.missingExecutable(engineId: "claude")) {
            _ = try NativeEngineDriverFactory.makeDriver(for: .claude, launcher: NeverLauncher(), executableOverride: "  \n\t ")
        }
    }

    @Test("A missing launcher is a distinct error from an unsupported engine")
    func missingLauncherIsDistinct() {
        #expect(NativeEngineDriverFactoryError.missingLauncher(engineId: "claude")
            != NativeEngineDriverFactoryError.noNativeDriver(engineId: "claude"))
    }
}
