import Foundation
import Testing
#if os(macOS)
import Darwin
#endif
@testable import CompanionCore

@Suite("Engine Runners, Replay Corpus, and ProcessSupervisorActor")
struct EngineRunnerAndSupervisorTests {

    // MARK: - 1. 100-Turn Replay Corpus Verification (20 per Engine Family)

    @Test("Claude Code stream-json 20-turn replay corpus produces exact TurnEvent sequence and spawn spec")
    func claudeReplayCorpusParity() async throws {
        let fixtures = EngineReplayHarness.claudeFixtures()
        #expect(fixtures.count == 20)

        for fixture in fixtures {
            let result = try await EngineReplayHarness.runFixture(fixture)
            #expect(result.recordedSpawnSpec == fixture.expectedSpawnSpec, "Spawn spec mismatch on \(fixture.id)")
            #expect(result.actualEvents == fixture.expectedEvents, "Event sequence mismatch on \(fixture.id)")
            #expect(result.passed, "Fixture \(fixture.id) failed replay check")
        }
    }

    @Test("Codex app-server JSON-RPC 20-turn replay corpus produces exact TurnEvent sequence and spawn spec")
    func codexReplayCorpusParity() async throws {
        let fixtures = EngineReplayHarness.codexFixtures()
        #expect(fixtures.count == 20)

        for fixture in fixtures {
            let result = try await EngineReplayHarness.runFixture(fixture)
            #expect(result.recordedSpawnSpec == fixture.expectedSpawnSpec, "Spawn spec mismatch on \(fixture.id)")
            #expect(result.actualEvents == fixture.expectedEvents, "Event sequence mismatch on \(fixture.id)")
            #expect(result.passed, "Fixture \(fixture.id) failed replay check")
        }
    }

    @Test("Grok Build ACP 20-turn replay corpus produces exact TurnEvent sequence and enforces Double Replay Gate")
    func grokAcpReplayCorpusParity() async throws {
        let fixtures = EngineReplayHarness.grokFixtures()
        #expect(fixtures.count == 20)

        for fixture in fixtures {
            let result = try await EngineReplayHarness.runFixture(fixture)
            #expect(result.recordedSpawnSpec == fixture.expectedSpawnSpec, "Spawn spec mismatch on \(fixture.id)")
            #expect(result.actualEvents == fixture.expectedEvents, "Event sequence mismatch on \(fixture.id)")
            #expect(result.passed, "Fixture \(fixture.id) failed replay check")
        }
    }

    @Test("MiniMax Code (mcode) ACP 20-turn replay corpus verifies session/set_config_option round-trip and replay gate")
    func mcodeAcpReplayCorpusParity() async throws {
        let fixtures = EngineReplayHarness.mcodeFixtures()
        #expect(fixtures.count == 20)

        for fixture in fixtures {
            let result = try await EngineReplayHarness.runFixture(fixture)
            #expect(result.recordedSpawnSpec == fixture.expectedSpawnSpec, "Spawn spec mismatch on \(fixture.id)")
            #expect(result.actualEvents == fixture.expectedEvents, "Event sequence mismatch on \(fixture.id)")
            #expect(result.passed, "Fixture \(fixture.id) failed replay check")
        }
    }

    @Test("Muse ACP 20-turn replay corpus produces exact TurnEvent sequence and fail-closed permissions")
    func museAcpReplayCorpusParity() async throws {
        let fixtures = EngineReplayHarness.museFixtures()
        #expect(fixtures.count == 20)

        for fixture in fixtures {
            let result = try await EngineReplayHarness.runFixture(fixture)
            #expect(result.recordedSpawnSpec == fixture.expectedSpawnSpec, "Spawn spec mismatch on \(fixture.id)")
            #expect(result.actualEvents == fixture.expectedEvents, "Event sequence mismatch on \(fixture.id)")
            #expect(result.passed, "Fixture \(fixture.id) failed replay check")
        }
    }

    // MARK: - 2. ProcessSupervisorActor Hostile Process Tests

    #if os(macOS)
    @Test("50 consecutive mid-tool-call cancels leave zero descendant processes within 5 seconds")
    func fiftyConsecutiveMidToolCallCancelsLeaveZeroDescendants() async throws {
        let supervisor = ProcessSupervisorActor(
            config: ProcessSupervisorConfig(
                maxLineBytes: 16 * 1024 * 1024,
                sigtermGraceSeconds: 0.04,
                pollIntervalMilliseconds: 4
            )
        )

        var allSpawnedLeaders: [Int32] = []
        var allObservedDescendants: Set<Int32> = []

        for iteration in 1...50 {
            // Spawn a shell that forks a background subshell child and emits a tool_call marker on stdout.
            let script = """
            /bin/sleep 30 &
            child_pid=$!
            echo "{\\"iteration\\":\(iteration),\\"child_pid\\":$child_pid}"
            wait $child_pid
            """
            let spec = EngineSpawnSpec(
                executable: "/bin/sh",
                arguments: ["-c", script]
            )

            let session = try await supervisor.launch(
                spec: spec,
                threadId: "cancel-thread-\(iteration)",
                engineId: "hostile-cancel"
            )
            allSpawnedLeaders.append(session.pid)

            var iterator = session.stdoutLines.makeAsyncIterator()
            if let firstLine = await iterator.next(),
               let data = firstLine.data(using: .utf8),
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let childPid = json["child_pid"] as? Int {
                allObservedDescendants.insert(Int32(childPid))
            }

            let treeBeforeCancel = ProcessSupervisorActor.discoverDescendantAndGroupPIDs(
                rootPid: session.pid,
                pgid: session.pid
            )
            allObservedDescendants.formUnion(treeBeforeCancel)

            // Cancel mid-tool-call while the subshell child is sleeping.
            await session.cancel()
            let exitReason = await session.waitForExit()
            #expect(exitReason == .cancelled)
        }

        // Verify zero surviving leaders or descendants within the 5-second ceiling.
        let verifyStart = DispatchTime.now().uptimeNanoseconds
        let fiveSecondsNanos: UInt64 = 5_000_000_000

        while DispatchTime.now().uptimeNanoseconds - verifyStart < fiveSecondsNanos {
            let aliveLeaders = allSpawnedLeaders.filter { ProcessSupervisorActor.isProcessAlive($0) }
            let aliveDescendants = allObservedDescendants.filter { ProcessSupervisorActor.isProcessAlive($0) }
            if aliveLeaders.isEmpty && aliveDescendants.isEmpty {
                break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        let remainingLeaders = allSpawnedLeaders.filter { ProcessSupervisorActor.isProcessAlive($0) }
        let remainingDescendants = allObservedDescendants.filter { ProcessSupervisorActor.isProcessAlive($0) }

        #expect(remainingLeaders.isEmpty, "Found surviving leader PIDs: \(remainingLeaders)")
        #expect(remainingDescendants.isEmpty, "Found surviving descendant PIDs: \(remainingDescendants)")
        #expect(await supervisor.activeProcessCount() == 0)
    }

    @Test("SIGKILL mid-stream yields a terminal .error event within < 2 seconds and the next turn succeeds immediately")
    func sigkillMidStreamEmitsErrorUnderTwoSecondsAndRecovers() async throws {
        let supervisor = ProcessSupervisorActor(config: .testing)

        let crashSpec = EngineSpawnSpec(
            executable: "/bin/sh",
            arguments: ["-c", "echo 'READY'; /bin/sleep 30"]
        )

        let startNanos = DispatchTime.now().uptimeNanoseconds
        let stream = try await supervisor.runSupervisedTurnStream(
            spec: crashSpec,
            threadId: "thread-sigkill",
            engineId: "test-engine"
        ) { line in
            if line == "READY" {
                return [.textDelta("READY")]
            }
            return []
        }

        var receivedEvents: [TurnEvent] = []
        for await event in stream {
            receivedEvents.append(event)
            if event == .textDelta("READY") {
                if let pid = await supervisor.activePID(forThread: "thread-sigkill") {
                    _ = Darwin.kill(pid, SIGKILL)
                }
            }
        }

        let elapsedSeconds = Double(DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000_000.0
        #expect(elapsedSeconds < 2.0, "Expected SIGKILL recovery in < 2.0s, took \(elapsedSeconds)s")
        #expect(receivedEvents.first == .textDelta("READY"))

        let hasSignalError = receivedEvents.contains { event in
            if case .error(let code, _) = event {
                return code == "process_signal"
            }
            return false
        }
        #expect(hasSignalError, "Expected .error(code: \"process_signal\", ...), got \(receivedEvents)")

        // Immediately run the next turn on the same thread and verify clean completion.
        let nextSpec = EngineSpawnSpec(
            executable: "/bin/sh",
            arguments: ["-c", "echo 'NEXT_OK'"]
        )
        let nextStream = try await supervisor.runSupervisedTurnStream(
            spec: nextSpec,
            threadId: "thread-sigkill",
            engineId: "test-engine"
        ) { line in
            if line == "NEXT_OK" {
                return [
                    .textDelta("Next turn succeeded."),
                    .completed(stopReason: "end_turn", inputTokens: 10, outputTokens: 5)
                ]
            }
            return []
        }

        var nextEvents: [TurnEvent] = []
        for await event in nextStream {
            nextEvents.append(event)
        }
        #expect(nextEvents == [
            .textDelta("Next turn succeeded."),
            .completed(stopReason: "end_turn", inputTokens: 10, outputTokens: 5)
        ])
    }

    @Test("1 MB of stderr concurrent with a single 5 MB stdout JSON line completes without deadlock or truncation")
    func concurrentOneMegabyteStderrAndFiveMegabyteStdoutLine() async throws {
        let supervisor = ProcessSupervisorActor(config: .testing)
        let targetStdoutPayloadBytes = 5 * 1024 * 1024
        let targetStderrBytes = 1 * 1024 * 1024

        // Use perl (always shipped at /usr/bin/perl on macOS) to write 1 MB of stderr interleaved
        // with a single 5 MB JSON line on stdout so both kernel pipe buffers are stressed simultaneously.
        let perlScript = """
        $| = 1;
        my $errChunk = "E" x 65536;
        my $outChunk = "A" x 327680;
        print STDOUT qq({"type":"huge","payload":");
        for (my $i = 0; $i < 16; $i++) {
            syswrite(STDERR, $errChunk);
            print STDOUT $outChunk;
        }
        print STDOUT qq("}\\n);
        """

        let spec = EngineSpawnSpec(
            executable: "/usr/bin/perl",
            arguments: ["-e", perlScript]
        )

        let session = try await supervisor.launch(
            spec: spec,
            threadId: "thread-large-pipes",
            engineId: "pipe-stress"
        )

        async let stdoutLinesTask: [String] = {
            var lines: [String] = []
            for await line in session.stdoutLines {
                lines.append(line)
            }
            return lines
        }()

        async let stderrBytesTask: Int = {
            var totalBytes = 0
            for await chunk in session.stderrChunks {
                totalBytes += chunk.utf8.count
            }
            return totalBytes
        }()

        let (lines, totalStderrBytes) = await (stdoutLinesTask, stderrBytesTask)
        let exitReason = await session.waitForExit()

        #expect(exitReason == .exited(code: 0))
        #expect(totalStderrBytes == targetStderrBytes, "Expected \(targetStderrBytes) stderr bytes, got \(totalStderrBytes)")
        #expect(lines.count == 1, "Expected exactly 1 single 5 MB stdout line, got \(lines.count)")

        guard let singleLine = lines.first else {
            Issue.record("Missing stdout line")
            return
        }
        #expect(singleLine.utf8.count > targetStdoutPayloadBytes)

        let jsonData = try #require(singleLine.data(using: .utf8))
        let parsed = try #require(try JSONSerialization.jsonObject(with: jsonData) as? [String: Any])
        #expect((parsed["type"] as? String) == "huge")
        let payload = try #require(parsed["payload"] as? String)
        #expect(payload.utf8.count == targetStdoutPayloadBytes)
    }
    #endif

    // MARK: - 3. Coordinator Failover, Backpressure Coalescing, and SQLite Persistence

    @Test("EngineCoordinatorActor automatically fails over on pre-output error and persists transcript to DatabaseService")
    func coordinatorFailoverAndDatabasePersistence() async throws {
        let db = try DatabaseService(path: ":memory:")
        let dispatcher = TurnDispatcherActor(
            database: db,
            stallTimeoutSeconds: 5.0,
            maxRetriesPerEngine: 0,
            retryDelaySeconds: 0.01
        )

        // Primary Claude fixture fails with `unknown_model` before emitting any textDelta.
        let failingClaudeFixture = EngineReplayHarness.claudeFixtures()[17] // Turn 18: unknown_model
        let claudeLauncher = ScriptedProcessLauncher(fixture: failingClaudeFixture)
        let primaryDriver = ClaudeStreamRunner(engineId: "claude", launcher: claudeLauncher)

        // Fallback Grok fixture succeeds and streams a full answer.
        let succeedingGrokFixture = EngineReplayHarness.grokFixtures()[0] // Turn 1: streaming success
        let grokLauncher = ScriptedProcessLauncher(fixture: succeedingGrokFixture)
        let fallbackDriver = AcpProcessRunner(harnessKind: .grok, engineId: "grok", launcher: grokLauncher)

        let coordinator = EngineCoordinatorActor(
            drivers: [primaryDriver, fallbackDriver],
            botFallbackChains: ["bot-multi": ["claude", "grok"]],
            dispatcher: dispatcher
        )

        let input = TurnInput(
            threadId: "thread-failover-1",
            botId: "bot-multi",
            prompt: "Explain failover behavior.",
            modelId: "grok-4.7",
            workingDirectory: "/tmp/grok"
        )

        let stream = try await coordinator.sendTurn(input: input)
        var events: [TurnEvent] = []
        for await event in stream {
            events.append(event)
        }

        // Verify the stream completed using the fallback Grok driver.
        #expect(events.contains(.textDelta("grok reply 1 part A. ")))
        #expect(events.contains(.textDelta("Part B.")))
        #expect(events.last == .completed(stopReason: "end_turn", inputTokens: 121, outputTokens: 26))

        // Verify both user prompt and assistant response were persisted to SQLite DatabaseService.
        let storedMessages = try await db.loadMessages(forThread: "thread-failover-1")
        #expect(storedMessages.count == 2)
        #expect(storedMessages[0].role == "user")
        #expect(storedMessages[0].content == "Explain failover behavior.")
        #expect(storedMessages[1].role == "assistant")
        #expect(storedMessages[1].content == "grok reply 1 part A. Part B.")
    }

    @Test("BoundedTurnEventBuffer coalesces adjacent text deltas under backpressure without dropping tool calls")
    func boundedTurnEventBufferCoalescing() {
        var buffer = BoundedTurnEventBuffer(capacity: 4)
        buffer.enqueue(.sessionStarted(sessionId: "s1"))
        buffer.enqueue(.textDelta("Hello "))
        buffer.enqueue(.textDelta("world"))
        buffer.enqueue(.toolCall(id: "t1", name: "Bash", argumentsJSON: "{}"))
        // Buffer is now at capacity (4). Adding another event triggers compaction of "Hello " + "world".
        buffer.enqueue(.completed(stopReason: "end_turn", inputTokens: 10, outputTokens: 5))

        let drained = buffer.drainAll()
        #expect(drained == [
            .sessionStarted(sessionId: "s1"),
            .textDelta("Hello world"),
            .toolCall(id: "t1", name: "Bash", argumentsJSON: "{}"),
            .completed(stopReason: "end_turn", inputTokens: 10, outputTokens: 5)
        ])
        #expect(buffer.coalescedDeltaCount >= 1)
    }

    @Test("NativeProtocolRecord redacts embedded API keys and tokens before diagnostic logging")
    func nativeProtocolRedaction() {
        let raw = #"{"apiKey":"secret-value-123","prompt":"Use sk-abcdefghijklmnopqrstuvwxyz123456"}"#
        let record = NativeProtocolRecord(
            engineId: "claude",
            threadId: "t-redact",
            direction: .outbound,
            line: raw
        )
        #expect(!record.redactedLine.contains("secret-value-123"))
        #expect(!record.redactedLine.contains("sk-abcdefghijklmnopqrstuvwxyz123456"))
        #expect(record.redactedLine.contains("[REDACTED]"))
    }
}
