import Foundation
import CompanionCore

@main
struct MacPerfHarnessCLI {
    static func main() async {
        do {
            let report = try await MacPerformanceHarness.runFullSuite()
            print(report.formattedSummary())
            if !report.allPassed {
                Foundation.exit(1)
            }
        } catch {
            fputs("MacPerfHarness error: \(error)\n", stderr)
            Foundation.exit(2)
        }
    }
}
