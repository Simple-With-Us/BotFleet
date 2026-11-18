import Foundation
import CompanionCore
#if os(macOS)
import Darwin
#endif

@main
struct BotFleetNativeHostMain {
    private enum Completion: Sendable { case signal, checkedStop }

    static func main() async {
        #if os(macOS)
        do {
            if Array(CommandLine.arguments.dropFirst()) == ["--identity"] {
                do {
                    let identity = try NativeHostArtifactIdentity.encoded()
                    FileHandle.standardOutput.write(identity + Data([0x0a]))
                } catch {
                    FileHandle.standardError.write(Data("Native host artifact identity is unavailable.\n".utf8))
                    exit(78)
                }
                return
            }
            let arguments: NativeHostLaunchArguments
            do {
                arguments = try NativeHostLaunchArguments(arguments: Array(CommandLine.arguments.dropFirst()))
            } catch {
                FileHandle.standardError.write(Data("Usage: BotFleetNativeHost --service-data /absolute/private/service-root [--automatic]\n".utf8))
                exit(64)
            }
            let (completions, continuation) = AsyncStream<Completion>.makeStream()
            signal(SIGTERM, SIG_IGN)
            signal(SIGINT, SIG_IGN)
            let termination = DispatchSource.makeSignalSource(signal: SIGTERM)
            let interrupt = DispatchSource.makeSignalSource(signal: SIGINT)
            for source in [termination, interrupt] {
                source.setEventHandler { continuation.yield(.signal) }
                source.resume()
            }
            defer { termination.cancel(); interrupt.cancel() }
            // Signals received during startup remain buffered until the graph can perform checked shutdown.
            let result = try await NativeHeadlessHost.launch(
                serviceData: arguments.serviceData, intent: arguments.intent)
            guard case .running(let host) = result else {
                // The owner's Stop is honoured: no host runs and nothing claims one did.
                FileHandle.standardOutput.write(Data("Native host was not started: the owner's stop marker is set.\n".utf8))
                return
            }
            let control: NativeHostControlServer
            do {
                control = try NativeHostControlServer(host: host) { continuation.yield(.checkedStop) }
            } catch {
                try? await host.shutdown()
                throw error
            }
            defer { control.close() }
            do {
                // The start path is checked, never assumed: the sequence verifies the
                // host through the control channel and owns the announcement, so the
                // host can never be announced before the check that backs it.
                try await NativeHostStartSequence.run(
                    verify: { _ = try await control.verifyStart() },
                    write: { text in FileHandle.standardOutput.write(Data(text.utf8)) })
            } catch {
                // A host that did not come up releases its owner and is never reported
                // as running; the reason travels with the refusal.
                try? await host.shutdown()
                control.close()
                let reason = NativeHostFailureReason.code(for: error)
                FileHandle.standardError.write(Data("Native host did not come up: reason=\(reason)\n".utf8))
                exit(1)
            }
            for await completion in completions {
                if case .signal = completion { try await host.shutdown() }
                break
            }
        } catch {
            // The refusal names the reason, never a Swift type and never a value
            // that could carry a path, a token or any other secret.
            let reason = NativeHostFailureReason.code(for: error)
            FileHandle.standardError.write(Data("Native host could not complete safely: reason=\(reason)\n".utf8))
            exit(1)
        }
        #else
        FileHandle.standardError.write(Data("BotFleetNativeHost requires macOS.\n".utf8))
        #endif
    }
}
