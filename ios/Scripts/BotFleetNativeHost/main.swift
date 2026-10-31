import Foundation
import CompanionCore
#if os(macOS)
import Darwin
#endif

@main
struct BotFleetNativeHostMain {
    static func main() async {
        #if os(macOS)
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            guard arguments.count == 2, arguments[0] == "--service-data", arguments[1].hasPrefix("/") else {
                FileHandle.standardError.write(Data("Usage: BotFleetNativeHost --service-data /absolute/private/service-root\n".utf8))
                exit(64)
            }
            let (signals, continuation) = AsyncStream<Void>.makeStream()
            signal(SIGTERM, SIG_IGN)
            signal(SIGINT, SIG_IGN)
            let termination = DispatchSource.makeSignalSource(signal: SIGTERM)
            let interrupt = DispatchSource.makeSignalSource(signal: SIGINT)
            for source in [termination, interrupt] {
                source.setEventHandler { continuation.yield(()) }
                source.resume()
            }
            defer { termination.cancel(); interrupt.cancel() }
            // Signals received during startup remain buffered until the graph can perform checked shutdown.
            let host = try await NativeHeadlessHost.start(serviceData: URL(fileURLWithPath: arguments[1], isDirectory: true))
            FileHandle.standardOutput.write(Data("Native host running with service credential access unavailable.\n".utf8))
            for await _ in signals { break }
            try await host.shutdown()
        } catch {
            FileHandle.standardError.write(Data("Native host could not complete safely: \(type(of: error))\n".utf8))
            exit(1)
        }
        #else
        FileHandle.standardError.write(Data("BotFleetNativeHost requires macOS.\n".utf8))
        #endif
    }
}
