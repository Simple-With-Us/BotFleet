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
                FileHandle.standardOutput.write(Data("Native host remains deliberately stopped.\n".utf8))
                return
            }
            let control: NativeHostControlServer
            do {
                control = try NativeHostControlServer(host: host) { continuation.yield(.checkedStop) }
            } catch {
                try await host.shutdown()
                throw error
            }
            defer { control.close() }
            FileHandle.standardOutput.write(Data("Native host running with service credential access unavailable.\n".utf8))
            for await completion in completions {
                if case .signal = completion { try await host.shutdown() }
                break
            }
        } catch {
            FileHandle.standardError.write(Data("Native host could not complete safely: \(type(of: error))\n".utf8))
            exit(1)
        }
        #else
        FileHandle.standardError.write(Data("BotFleetNativeHost requires macOS.\n".utf8))
        #endif
    }
}
