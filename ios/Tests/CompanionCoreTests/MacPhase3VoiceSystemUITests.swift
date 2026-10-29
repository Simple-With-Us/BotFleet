import XCTest
@testable import CompanionCore

final class MacPhase3VoiceSystemUITests: XCTestCase {

    // MARK: - 1. BF-2483: MacVoiceEngine Tests

    func testVoiceStartingCancelPreventsLatePermissionFromOpeningMicrophone() {
        let engine = MacVoiceEngine()
        let attemptId = engine.tapMicrophoneButton(mode: .composerDictation, currentDraft: "Initial draft")
        XCTAssertNotNil(attemptId)
        XCTAssertEqual(engine.state, .starting)
        XCTAssertEqual(engine.currentDraft, "Initial draft")
        XCTAssertFalse(engine.isMicrophoneHardwareOpen)

        // Second tap while starting cancels the pending start.
        let secondTap = engine.tapMicrophoneButton(mode: .composerDictation, currentDraft: "Initial draft")
        XCTAssertNil(secondTap)
        XCTAssertEqual(engine.state, .idle)
        XCTAssertFalse(engine.isMicrophoneHardwareOpen)

        // A late permission grant arriving after cancel MUST NEVER open the microphone.
        let opened = engine.completeStartPermissionGrant(
            attemptId: attemptId,
            micGranted: true,
            speechGranted: true
        )
        XCTAssertFalse(opened)
        XCTAssertEqual(engine.state, .idle)
        XCTAssertFalse(engine.isMicrophoneHardwareOpen)
        XCTAssertEqual(engine.currentDraft, "Initial draft")
    }

    func testComposerDictationReplacesPartialsInPlaceAndNeverAutoSendsOnSilence() {
        let engine = MacVoiceEngine()
        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "Hello")
        XCTAssertTrue(
            engine.completeStartPermissionGrant(
                attemptId: attempt,
                micGranted: true,
                speechGranted: true
            )
        )
        XCTAssertTrue(engine.isMicrophoneHardwareOpen)

        engine.receivePartialTranscript("world", audioLevel: 0.4)
        XCTAssertEqual(engine.currentDraft, "Hello world")

        // Subsequent partial replaces the previous partial in place rather than stacking.
        engine.receivePartialTranscript("world how are you", audioLevel: 0.7)
        XCTAssertEqual(engine.currentDraft, "Hello world how are you")

        // Silence pause in composer dictation does NOT end capture or auto-commit a turn.
        XCTAssertNil(engine.handleSilencePause())
        XCTAssertTrue(engine.committedLiveCallTurns.isEmpty)
        XCTAssertEqual(
            engine.state,
            .recording(level: 0.7, partialTranscript: "world how are you", mode: .composerDictation)
        )

        // Explicit stop closes the mic and leaves the composed draft intact.
        engine.stopCapture()
        XCTAssertEqual(engine.state, .idle)
        XCTAssertFalse(engine.isMicrophoneHardwareOpen)
        XCTAssertEqual(engine.currentDraft, "Hello world how are you")
    }

    func testLiveCallModeCommitsTurnOnSilenceAndExposesControlLabels() {
        let engine = MacVoiceEngine()
        let callMode = MacVoiceMode.liveCall(botName: "Monet", isMuted: false, isSpeakerOn: true)
        XCTAssertEqual(callMode.controlLabels, ["Mute", "Speaker", "End Call"])

        let attempt = engine.beginStart(mode: callMode, currentDraft: "")
        XCTAssertTrue(
            engine.completeStartPermissionGrant(
                attemptId: attempt,
                micGranted: true,
                speechGranted: true
            )
        )

        engine.receivePartialTranscript("Ship the release notes", audioLevel: 0.8)
        let committed = engine.handleSilencePause()
        XCTAssertEqual(committed, "Ship the release notes")
        XCTAssertEqual(engine.committedLiveCallTurns, ["Ship the release notes"])
        XCTAssertEqual(engine.currentDraft, "")
        XCTAssertEqual(
            engine.state,
            .recording(level: 0.0, partialTranscript: "", mode: callMode)
        )
    }

    func testEchoSuppressionPausesBotPlaybackWhenStartingCapture() {
        let engine = MacVoiceEngine()
        engine.startBotPlayback()
        XCTAssertTrue(engine.isBotPlaybackActive)
        XCTAssertFalse(engine.isPlaybackPausedForEchoSuppression)

        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "")
        XCTAssertTrue(
            engine.completeStartPermissionGrant(
                attemptId: attempt,
                micGranted: true,
                speechGranted: true
            )
        )

        XCTAssertFalse(engine.isBotPlaybackActive)
        XCTAssertTrue(engine.isPlaybackPausedForEchoSuppression)
        XCTAssertTrue(engine.isMicrophoneHardwareOpen)
    }

    func testRouteChangeBannerAndNoMicrophoneFallback() {
        let engine = MacVoiceEngine()
        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "")
        engine.completeStartPermissionGrant(attemptId: attempt, micGranted: true, speechGranted: true)

        engine.handleRouteChange(newDeviceName: "AirPods Pro", hasInput: true)
        XCTAssertEqual(engine.routeBanner, "Now using AirPods Pro.")
        XCTAssertTrue(engine.isMicrophoneHardwareOpen)

        engine.handleRouteChange(newDeviceName: nil, hasInput: false)
        XCTAssertNil(engine.routeBanner)
        XCTAssertFalse(engine.isMicrophoneHardwareOpen)
        XCTAssertEqual(engine.state, .failed(.noMicrophoneAvailable))
        XCTAssertEqual(
            MacVoiceFailure.noMicrophoneAvailable.message,
            "No microphone found.  Connect a microphone, then try again."
        )
    }

    func testTwoStrikeAutoRetryCeilingAndPausedNeverAutoResumes() {
        let engine = MacVoiceEngine()

        // Strike 1
        let attempt1 = engine.beginStart(mode: .composerDictation, currentDraft: "Draft")
        engine.completeStartPermissionGrant(
            attemptId: attempt1,
            micGranted: true,
            speechGranted: true,
            micBusy: true
        )
        XCTAssertEqual(engine.consecutiveFailedStarts, 1)
        XCTAssertTrue(engine.canAutoRetry)

        // Auto-retry 1 -> Strike 2
        let retryAttempt = engine.attemptAutoRetry()
        XCTAssertNotNil(retryAttempt)
        engine.completeStartPermissionGrant(
            attemptId: retryAttempt,
            micGranted: true,
            speechGranted: true,
            micBusy: true
        )
        XCTAssertEqual(engine.consecutiveFailedStarts, 2)
        XCTAssertFalse(engine.canAutoRetry)

        // After 2 consecutive failed starts, auto-retry stops and waits for an explicit tap.
        XCTAssertNil(engine.attemptAutoRetry())

        // Explicit user tap is allowed again and resets the session once granted.
        let manualAttempt = engine.tapMicrophoneButton(mode: .composerDictation, currentDraft: "Draft")
        XCTAssertNotNil(manualAttempt)
        XCTAssertTrue(
            engine.completeStartPermissionGrant(
                attemptId: manualAttempt,
                micGranted: true,
                speechGranted: true
            )
        )
        XCTAssertEqual(engine.consecutiveFailedStarts, 0)

        // Pause copy and non-auto-resume verification.
        engine.pauseCapture()
        XCTAssertEqual(
            engine.state,
            .paused(reason: "Listening paused.  Tap to resume when you're ready.")
        )
        XCTAssertEqual(engine.state.accessibilityLabel, "Listening paused")
        engine.handleAudioInterruptionEnded()
        XCTAssertEqual(
            engine.state,
            .paused(reason: "Listening paused.  Tap to resume when you're ready.")
        )
        XCTAssertFalse(engine.isMicrophoneHardwareOpen)

        XCTAssertTrue(engine.resumeFromPause())
        XCTAssertTrue(engine.isMicrophoneHardwareOpen)
        XCTAssertEqual(engine.state.accessibilityLabel, "Listening")
        XCTAssertTrue(engine.state.usesStaticIndicator(reduceMotion: true))
        XCTAssertFalse(engine.state.usesStaticIndicator(reduceMotion: false))
    }

    func testExactVoiceFailureProductCopyAndPersonalVoiceFallback() {
        XCTAssertEqual(
            MacVoiceFailure.microphoneRefused(isCall: false).message,
            "Dictation needs Microphone access.  Enable it in System Settings, then try again."
        )
        XCTAssertEqual(
            MacVoiceFailure.microphoneRefused(isCall: true).message,
            "Calls need Microphone access.  Enable it in System Settings, then try again."
        )
        XCTAssertEqual(
            MacVoiceFailure.speechRecognitionRefused(isCall: false).message,
            "Dictation needs Speech Recognition access.  Enable it in System Settings, then try again."
        )
        XCTAssertEqual(
            MacVoiceFailure.speechRecognitionRefused(isCall: true).message,
            "Calls need Speech Recognition access.  Enable it in System Settings, then try again."
        )
        XCTAssertEqual(
            MacVoiceFailure.noMicrophoneAvailable.message,
            "No microphone found.  Connect a microphone, then try again."
        )
        XCTAssertEqual(
            MacVoiceFailure.languageNotSupported.message,
            "Dictation isn't available for this language.  Choose a different language in Settings."
        )
        XCTAssertEqual(
            MacVoiceFailure.microphoneBusy.message,
            "Couldn't start the microphone.  Check that no other app is using it, then try again."
        )
        XCTAssertEqual(
            MacVoiceFailure.recognitionFailedMidSession.message,
            "Couldn't transcribe that.  Your draft is unchanged."
        )
        XCTAssertEqual(
            MacVoiceFailure.playbackFailed.message,
            "Couldn't play the voice.  The reply is shown as text instead."
        )
        XCTAssertEqual(MacVoiceFailure.microphoneRefused(isCall: false).actionButtonTitle, "Open Settings")
        XCTAssertEqual(MacVoiceFailure.languageNotSupported.actionButtonTitle, "Open Settings")
        XCTAssertNil(MacVoiceFailure.microphoneBusy.actionButtonTitle)

        // Mid-session failure preserves frozen draft.
        let engine = MacVoiceEngine()
        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "Keep this text")
        engine.completeStartPermissionGrant(attemptId: attempt, micGranted: true, speechGranted: true)
        engine.receivePartialTranscript("discarded partial")
        XCTAssertEqual(engine.currentDraft, "Keep this text discarded partial")
        engine.handleMidSessionRecognitionFailure()
        XCTAssertEqual(engine.currentDraft, "Keep this text")
        XCTAssertEqual(engine.state, .failed(.recognitionFailedMidSession))

        // Personal Voice selection when authorized vs clean fallback when denied.
        let authorizedVoice = MacVoiceEngine.resolveSynthesisVoice(
            requestedVoiceId: "personal:com.apple.voice.personal.jay",
            personalVoiceAuthorized: true,
            availableVoiceIds: ["com.apple.voice.personal.jay", "com.apple.voice.compact.en-US.Samantha"],
            fallbackSystemVoiceId: "com.apple.voice.compact.en-US.Samantha"
        )
        XCTAssertEqual(
            authorizedVoice,
            MacResolvedSynthesisVoice(identifier: "com.apple.voice.personal.jay", source: .personalVoice)
        )

        let deniedVoice = MacVoiceEngine.resolveSynthesisVoice(
            requestedVoiceId: "personal:com.apple.voice.personal.jay",
            personalVoiceAuthorized: false,
            availableVoiceIds: ["com.apple.voice.personal.jay", "com.apple.voice.compact.en-US.Samantha"],
            fallbackSystemVoiceId: "com.apple.voice.compact.en-US.Samantha"
        )
        XCTAssertEqual(
            deniedVoice,
            MacResolvedSynthesisVoice(
                identifier: "com.apple.voice.compact.en-US.Samantha",
                source: .systemDefault
            )
        )
    }

    // MARK: - 2. BF-2484: MacSystemIntegration Tests

    func testMenubarStatePriorityAndExactTwelveItemOrdering() {
        let waitingBot = MacWaitingBotItem(
            id: "bot-1",
            botName: "Monet",
            threadId: "thread-1",
            needDescription: "Approve a change"
        )
        let state = MacMenubarState(
            isConnected: true,
            workingBotCount: 3,
            waitingBots: [waitingBot],
            allBotsPaused: false,
            reduceMotion: false
        )

        // Waiting ALWAYS wins over working.
        XCTAssertEqual(state.iconState, .waitingForPerson)
        XCTAssertTrue(state.shouldPulseIcon)
        XCTAssertEqual(state.statusLine, "3 bots working, 1 waiting for you")

        // Reduced Motion disables pulse while keeping waitingForPerson icon state.
        var reducedMotionState = state
        reducedMotionState.reduceMotion = true
        XCTAssertEqual(reducedMotionState.iconState, .waitingForPerson)
        XCTAssertFalse(reducedMotionState.shouldPulseIcon)

        // Verify the exact 12-item menu order.
        let items = state.menuItems
        XCTAssertEqual(items.count, 12)
        XCTAssertEqual(items[0], .openBotFleet)
        XCTAssertEqual(items[0].title, "Open BotFleet")
        XCTAssertEqual(items[1], .separator)
        XCTAssertEqual(items[2], .statusLine("3 bots working, 1 waiting for you"))
        XCTAssertEqual(items[3].title, "Compose New Message")
        XCTAssertEqual(items[4].title, "Dictate Message")
        XCTAssertEqual(items[5], .separator)
        XCTAssertEqual(items[6], .waitingBot(waitingBot))
        XCTAssertEqual(items[6].title, "Monet — Approve a change")
        XCTAssertEqual(items[7], .separator)
        XCTAssertEqual(items[8].title, "Pause All Bots")
        XCTAssertEqual(items[9].title, "Settings")
        XCTAssertEqual(items[10], .separator)
        XCTAssertEqual(items[11].title, "Quit BotFleet")

        // Swapping Pause / Resume item and idle / connection-lost status lines.
        let pausedIdle = MacMenubarState(
            isConnected: true,
            workingBotCount: 0,
            waitingBots: [],
            allBotsPaused: true,
            reduceMotion: false
        )
        XCTAssertEqual(pausedIdle.iconState, .idle)
        XCTAssertEqual(pausedIdle.statusLine, "All bots idle")
        XCTAssertEqual(pausedIdle.pauseResumeTitle, "Resume All Bots")

        let disconnected = MacMenubarState(
            isConnected: false,
            workingBotCount: 2,
            waitingBots: [waitingBot],
            allBotsPaused: false,
            reduceMotion: false
        )
        XCTAssertEqual(disconnected.iconState, .connectionLost)
        XCTAssertEqual(
            disconnected.statusLine,
            "Connection lost.  Your bots will reconnect on their own"
        )
    }

    func testGlobalHotkeyManagerDefaultOffCollisionAndSecureInputGuard() {
        var secureInputActive = false
        let manager = MacGlobalHotkeyManager(
            secureInputProvider: { secureInputActive },
            carbonRegistrar: { _, combo in
                if combo.keyCode == 49 && combo.carbonModifiers == 256 {
                    return .conflict
                }
                return .success
            }
        )

        // Both hotkeys are off by default.
        XCTAssertFalse(manager.binding(for: .showOrHideBotFleet).isEnabled)
        XCTAssertNil(manager.binding(for: .showOrHideBotFleet).keyCombo)
        XCTAssertFalse(manager.binding(for: .pushToTalk).isEnabled)
        XCTAssertNil(manager.binding(for: .pushToTalk).keyCombo)
        XCTAssertEqual(MacGlobalHotkeyAction.showOrHideBotFleet.displayTitle, "Show or Hide BotFleet")
        XCTAssertEqual(MacGlobalHotkeyAction.pushToTalk.displayTitle, "Push to Talk")

        // Record a colliding shortcut -> exact inline error copy.
        manager.beginRecording(for: .showOrHideBotFleet)
        XCTAssertFalse(manager.handleRecordedKey(keyCode: 49, carbonModifiers: 256))
        XCTAssertEqual(
            manager.inlineCollisionError,
            "That shortcut is used by another app.  Choose a different one."
        )
        XCTAssertFalse(manager.binding(for: .showOrHideBotFleet).isEnabled)

        // Record a valid shortcut -> enabled.
        manager.beginRecording(for: .pushToTalk)
        XCTAssertTrue(manager.handleRecordedKey(keyCode: 14, carbonModifiers: 768))
        XCTAssertNil(manager.inlineCollisionError)
        XCTAssertTrue(manager.binding(for: .pushToTalk).isEnabled)

        // Escape during recording cancels without losing the existing binding.
        manager.beginRecording(for: .pushToTalk)
        XCTAssertFalse(
            manager.handleRecordedKey(
                keyCode: MacGlobalHotkeyManager.escapeKeyCode,
                carbonModifiers: 0,
                isEscape: true
            )
        )
        XCTAssertTrue(manager.binding(for: .pushToTalk).isEnabled)

        // Secure Input Guard: refuses to trigger while a password field is focused.
        secureInputActive = true
        XCTAssertFalse(manager.triggerIfAllowed(.pushToTalk))
        XCTAssertTrue(manager.triggeredHistory.isEmpty)

        secureInputActive = false
        XCTAssertTrue(manager.triggerIfAllowed(.pushToTalk))
        XCTAssertEqual(manager.triggeredHistory, [.pushToTalk])

        // Delete clears the shortcut back to off.
        manager.beginRecording(for: .pushToTalk)
        XCTAssertTrue(
            manager.handleRecordedKey(
                keyCode: MacGlobalHotkeyManager.deleteKeyCode,
                carbonModifiers: 0,
                isDelete: true
            )
        )
        XCTAssertFalse(manager.binding(for: .pushToTalk).isEnabled)
        XCTAssertNil(manager.binding(for: .pushToTalk).keyCombo)
    }

    func testNotificationCoordinatorThreeKindFilterSuppressionAndDeniedCopy() {
        let coordinator = MacNotificationCoordinator(
            initialPermission: .notDetermined,
            permissionGrantResult: true
        )
        coordinator.activeOnScreenThreadId = "thread-on-screen"

        // Never requests permission at launch.
        XCTAssertFalse(coordinator.hasRequestedPermission)

        // Routine progress, normal completions, and connection changes NEVER notify
        // and NEVER trigger a permission prompt.
        XCTAssertEqual(
            coordinator.handleEvent(.routineProgress(botId: "b1", threadId: "t2", detail: "Running tests")),
            .suppressedNonBlockingEvent
        )
        XCTAssertEqual(
            coordinator.handleEvent(.normalCompletion(botId: "b1", threadId: "t2", summary: "Done")),
            .suppressedNonBlockingEvent
        )
        XCTAssertEqual(
            coordinator.handleEvent(.connectionStateChanged(isConnected: false)),
            .suppressedNonBlockingEvent
        )
        XCTAssertFalse(coordinator.hasRequestedPermission)
        XCTAssertTrue(coordinator.deliveredNotifications.isEmpty)

        // Blocking event on the currently visible on-screen thread is suppressed.
        XCTAssertEqual(
            coordinator.handleEvent(
                .botNeedsApproval(
                    botId: "b1",
                    botName: "Monet",
                    threadId: "thread-on-screen",
                    requestId: "req-1",
                    summary: "Run git push"
                )
            ),
            .suppressedAlreadyOnScreen
        )
        XCTAssertFalse(coordinator.hasRequestedPermission)

        // First off-screen blocking event prompts for permission and delivers
        // with the exact actions and timeSensitive interruption level.
        let approvalDecision = coordinator.handleEvent(
            .botNeedsApproval(
                botId: "b1",
                botName: "Monet",
                threadId: "thread-background",
                requestId: "req-2",
                summary: "Run git push"
            )
        )
        XCTAssertTrue(coordinator.hasRequestedPermission)
        guard case .deliver(let approvalPayload) = approvalDecision else {
            return XCTFail("Expected approval notification delivery")
        }
        XCTAssertEqual(approvalPayload.actionTitles, ["Approve", "Deny"])
        XCTAssertEqual(approvalPayload.interruptionLevel, .timeSensitive)

        let questionDecision = coordinator.handleEvent(
            .botAskedQuestion(
                botId: "b2",
                botName: "Grok",
                threadId: "thread-background-2",
                requestId: "req-3",
                question: "Which target should I build?"
            )
        )
        guard case .deliver(let questionPayload) = questionDecision else {
            return XCTFail("Expected question notification delivery")
        }
        XCTAssertEqual(questionPayload.actionTitles, ["Reply"])
        XCTAssertTrue(questionPayload.supportsInlineTextReply)
        XCTAssertEqual(questionPayload.interruptionLevel, .timeSensitive)

        let mentionDecision = coordinator.handleEvent(
            .callOrMentionNeedsPerson(
                botId: "b3",
                botName: "Claude",
                threadId: "thread-background-3",
                message: "@jay ready for review"
            )
        )
        guard case .deliver(let mentionPayload) = mentionDecision else {
            return XCTFail("Expected mention notification delivery")
        }
        // A takeover asks for the person's hands, not for an answer, so it
        // arrives as an ordinary banner — the way the paired phone sends it.
        XCTAssertEqual(mentionPayload.interruptionLevel, .active)

        // Refused permission surfaces exact Settings status copy and "Open Settings".
        let deniedCoordinator = MacNotificationCoordinator(
            initialPermission: .notDetermined,
            permissionGrantResult: false
        )
        let deniedDecision = deniedCoordinator.handleEvent(
            .botNeedsApproval(
                botId: "b1",
                botName: "Monet",
                threadId: "thread-bg",
                requestId: "req-9",
                summary: "Deploy"
            )
        )
        XCTAssertEqual(
            deniedDecision,
            .suppressedPermissionDenied(
                statusBanner: "Notifications are off.  Bots that need you will wait in the menubar",
                actionTitle: "Open Settings"
            )
        )
        XCTAssertEqual(
            deniedCoordinator.settingsStatusBanner,
            "Notifications are off.  Bots that need you will wait in the menubar"
        )
        XCTAssertEqual(deniedCoordinator.settingsActionTitle, "Open Settings")
    }

    // MARK: - 3. BF-2501: MacTranscriptEngine 50,000-Message & Parity Tests

    func testTranscriptEngineIncrementalStreamingAnd50kMessageWindowingPerformance() {
        let engine = MacTranscriptEngine()

        // Build a synthetic 50,000-message thread.
        var syntheticMessages: [Message] = []
        syntheticMessages.reserveCapacity(50_000)
        for index in 0..<50_000 {
            var msg = Message(
                id: "msg-\(index)",
                role: index.isMultiple(of: 2) ? .user : .bot,
                kind: .text,
                at: Double(index) * 1000.0
            )
            msg.text = "Message #\(index) with **bold** and `inline code`."
            syntheticMessages.append(msg)
        }
        engine.setSettledMessages(syntheticMessages)
        XCTAssertEqual(engine.settledMessageCount, 50_000)

        // Measure 50,000-message viewport windowing: must complete in < 10 ms.
        let windowStartNs = DispatchTime.now().uptimeNanoseconds
        let slice = engine.computeWindowSlice(
            in: syntheticMessages,
            scrollOffsetY: 1_800_000.0,
            viewportHeight: 800.0,
            defaultRowHeight: 72.0,
            overscanRows: 8
        )
        let windowDurationMs = Double(DispatchTime.now().uptimeNanoseconds - windowStartNs) / 1_000_000.0

        XCTAssertEqual(slice.totalMessageCount, 50_000)
        XCTAssertFalse(slice.visibleMessages.isEmpty)
        XCTAssertLessThan(slice.visibleMessages.count, 40)
        XCTAssertLessThan(windowDurationMs, 10.0, "50,000-message windowing took \(windowDurationMs) ms")

        // Stream multi-paragraph Markdown + fenced code block deltas and verify
        // zero settled messages are re-parsed and per-delta parse stays fast.
        engine.beginStreaming(
            messageId: "stream-live-1",
            initialText: "# Heading 1\n\nFirst paragraph complete.\n\n"
        )
        for i in 0..<20 {
            engine.appendStreamingDelta(
                "Paragraph \(i) with *emphasis* and a bullet:\n- item \(i)\n\n",
                messageId: "stream-live-1"
            )
        }
        let blocks = engine.appendStreamingDelta(
            "```swift\nlet answer = 42\n```",
            messageId: "stream-live-1"
        )

        XCTAssertEqual(engine.settledMessagesReparsedOnLastDelta, 0)
        XCTAssertLessThan(engine.blocksParsedOnLastDelta, 5)
        XCTAssertLessThan(engine.lastDeltaParseDurationMs, 5.0)
        XCTAssertEqual(blocks.last?.block, .code(language: "swift", text: "let answer = 42"))
    }

    func testElectronParityCapabilitiesSettingsDeepLinksAndContextMenuBuilder() {
        let capsMacOS14 = MacDesktopCapabilities(
            appVersion: "1.0.4",
            buildNumber: "202610251200",
            osMajorVersion: 14
        )
        XCTAssertFalse(capsMacOS14.supportsLiquidGlassSidebar)
        XCTAssertTrue(capsMacOS14.supportsNativeCua)
        XCTAssertTrue(capsMacOS14.supportsNativeVoice)
        XCTAssertEqual(capsMacOS14.versionStamp, "BotFleet macOS 1.0.4 (202610251200)")

        let capsMacOS26 = MacDesktopCapabilities(
            appVersion: "1.0.4",
            buildNumber: "202610251200",
            osMajorVersion: 26
        )
        XCTAssertTrue(capsMacOS26.supportsLiquidGlassSidebar)

        // Deep-link routing to all 6 settings sections.
        for section in MacSettingsSection.allCases {
            guard let url = URL(string: "botfleet://settings/\(section.rawValue)") else {
                XCTFail("Failed to construct the settings deep-link URL for \(section.rawValue)")
                continue
            }
            XCTAssertEqual(MacSettingsDeepLinkRouter.section(for: url), section)
        }
        guard let queryURL = URL(string: "botfleet://settings?section=permissions") else {
            return XCTFail("Failed to construct the query-form settings deep-link URL")
        }
        XCTAssertEqual(MacSettingsDeepLinkRouter.section(for: queryURL), .permissions)
        XCTAssertEqual(
            MacSettingsDeepLinkRouter.section(forVoiceFailure: .languageNotSupported),
            .voice
        )
        XCTAssertEqual(
            MacSettingsDeepLinkRouter.section(forVoiceFailure: .microphoneRefused(isCall: false)),
            .permissions
        )

        // Context menu builder & Quote in Reply formatting.
        let actions = MacTranscriptContextMenuBuilder.actions(
            messageText: "Here is the fix:\nLine two",
            focusedCodeBlock: (code: "swift test", language: "bash")
        )
        XCTAssertEqual(actions.map(\.title), ["Copy", "Copy Code Block", "Quote in Reply"])
        let updatedDraft = MacTranscriptContextMenuBuilder.applyQuoteInReply(
            "Line one\nLine two",
            to: "Existing draft"
        )
        XCTAssertEqual(updatedDraft, "Existing draft\n\n> Line one\n> Line two\n\n")

        // Dock unread badge capping.
        let emptyBadge = MacUnreadBadgeSummary(unreadBotCount: 0, unreadRoomCount: 0, waitingBotCount: 0)
        XCTAssertNil(emptyBadge.dockBadgeLabel)
        let normalBadge = MacUnreadBadgeSummary(unreadBotCount: 3, unreadRoomCount: 2, waitingBotCount: 1)
        XCTAssertEqual(normalBadge.dockBadgeLabel, "6")
        let cappedBadge = MacUnreadBadgeSummary(unreadBotCount: 80, unreadRoomCount: 25, waitingBotCount: 0)
        XCTAssertEqual(cappedBadge.dockBadgeLabel, "99+")
    }

    // MARK: - 4. Review Triage: Voice State Machine

    /// A microphone tap that cancels a pending start must never hand the
    /// composer a stale snapshot of the text.
    func testCancellingAPendingStartKeepsTextTypedWhileTheMicrophoneWarmedUp() {
        let engine = MacVoiceEngine()

        let firstTap = engine.tapMicrophoneButtonReportingOutcome(
            mode: .composerDictation,
            currentDraft: "Typed before"
        )
        guard case .startedCapture = firstTap else {
            return XCTFail("Expected the first tap to start a capture")
        }
        XCTAssertEqual(engine.state, .starting)

        // The user keeps typing while the microphone is warming up.
        let secondTap = engine.tapMicrophoneButtonReportingOutcome(
            mode: .composerDictation,
            currentDraft: "Typed before and after"
        )
        XCTAssertEqual(secondTap, .cancelledPendingStart)
        XCTAssertEqual(engine.state, .idle)

        // The engine's own snapshot still holds the pre-tap text.
        XCTAssertEqual(engine.currentDraft, "Typed before")
        // The composer keeps what the user actually has: the stale snapshot
        // must never overwrite it.
        XCTAssertEqual(
            engine.composerDraftAfterTap(incomingDraft: "Typed before and after"),
            "Typed before and after"
        )
    }

    /// Pausing and resuming must not rebase the draft on itself, or the
    /// spoken words come back twice.
    func testResumingFromPauseDoesNotDuplicateTheSpokenWords() {
        let engine = MacVoiceEngine()
        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "Hello")
        engine.completeStartPermissionGrant(attemptId: attempt, micGranted: true, speechGranted: true)
        engine.receivePartialTranscript("world", audioLevel: 0.5)
        XCTAssertEqual(engine.currentDraft, "Hello world")

        engine.pauseCapture()
        XCTAssertTrue(engine.resumeFromPause())

        // The recognizer's next result is cumulative.
        engine.receivePartialTranscript("world how are you", audioLevel: 0.6)
        XCTAssertEqual(engine.currentDraft, "Hello world how are you")
        // The frozen base is still the text from before dictation started.
        XCTAssertEqual(engine.frozenBaseDraft, "Hello")
    }

    /// A playback failure during an active capture must not clobber the
    /// capture state machine or drop the later partials.
    func testAPlaybackFailureDuringRecordingKeepsTheCaptureAlive() {
        let engine = MacVoiceEngine()
        let attempt = engine.beginStart(mode: .composerDictation, currentDraft: "Hello")
        engine.completeStartPermissionGrant(attemptId: attempt, micGranted: true, speechGranted: true)
        engine.receivePartialTranscript("world", audioLevel: 0.5)

        engine.handlePlaybackFailure(forMessageId: "msg-1")

        XCTAssertEqual(
            engine.state,
            .recording(level: 0.5, partialTranscript: "world", mode: .composerDictation)
        )
        XCTAssertTrue(engine.isMicrophoneHardwareOpen)
        XCTAssertEqual(engine.textFallbackMessageIds, ["msg-1"])

        // Later partials are still accepted.
        engine.receivePartialTranscript("world how are you", audioLevel: 0.6)
        XCTAssertEqual(engine.currentDraft, "Hello world how are you")
    }

    // MARK: - 5. Review Triage: Transcript Cache & Surface Cost

    /// A message patched under the same id carries new text, and the rendered
    /// block cache must notice that.
    func testRenderedBlocksReparseAMessagePatchedUnderTheSameId() {
        let engine = MacTranscriptEngine()
        var message = Message(id: "msg-1", role: .bot, kind: .text, at: 0)
        message.text = "# Old heading"

        let beforePatch = engine.renderedBlocks(for: message)
        guard case .heading(let beforeLevel, let beforeText) = beforePatch[0].block else {
            return XCTFail("Expected a heading block")
        }
        XCTAssertEqual(beforeLevel, 1)
        XCTAssertEqual(beforeText, "Old heading")

        // The harness patches the message under the same id.
        message.text = "# New heading"
        let afterPatch = engine.renderedBlocks(for: message)
        guard case .heading(_, let afterText) = afterPatch[0].block else {
            return XCTFail("Expected a heading block")
        }
        XCTAssertEqual(afterText, "New heading")
        XCTAssertNotEqual(beforePatch, afterPatch)
    }

    /// The pending-card scan finds the newest pending card without walking
    /// the whole card list of the thread.
    func testPendingCardScanFindsTheNewestPendingCard() {
        func cardMessage(_ id: String, requestId: String?, tool: String?) -> Message {
            var message = Message(id: id, role: .bot, kind: .options, at: 0)
            message.card = OptionCard(
                title: "Approval needed",
                subtitle: "rm -rf ./build",
                options: ["Allow", "Deny"],
                answered: nil,
                dismissed: nil,
                requestId: requestId,
                tool: tool,
                held: nil,
                allowKey: nil
            )
            return message
        }

        let messages = [
            cardMessage("m1", requestId: "r-1", tool: "Bash"),
            cardMessage("m2", requestId: nil, tool: nil),
            cardMessage("m3", requestId: "r-3", tool: nil),
        ]

        XCTAssertEqual(MacPendingCardScanner.mostRecentPendingCard(in: messages)?.requestId, "r-3")
        XCTAssertTrue(MacPendingCardScanner.hasPendingCard(in: messages))
        XCTAssertFalse(
            MacPendingCardScanner.hasPendingCard(in: [cardMessage("m2", requestId: nil, tool: nil)])
        )
        XCTAssertNil(MacPendingCardScanner.mostRecentPendingCard(in: []))
    }

    /// The system surfaces are rebuilt at most once per interval, and the
    /// menubar menu object is only rebuilt when its rows actually change.
    func testSystemSurfaceSyncIsThrottledAndTheMenuOnlyRebuildsWhenItsRowsChange() {
        let now = Date()
        XCTAssertTrue(MacSystemSurfaceSyncPolicy.shouldSync(now: now, lastSync: nil))
        // A rebuild 50 ms ago is inside the window, so it has to wait.
        XCTAssertFalse(
            MacSystemSurfaceSyncPolicy.shouldSync(now: now, lastSync: now.addingTimeInterval(-0.05))
        )
        // A rebuild 250 ms ago is outside the window, so it may run now.
        XCTAssertTrue(
            MacSystemSurfaceSyncPolicy.shouldSync(now: now, lastSync: now.addingTimeInterval(-0.25))
        )

        let base = MacMenubarState(
            isConnected: true,
            workingBotCount: 1,
            waitingBots: [],
            allBotsPaused: false,
            reduceMotion: false
        )
        XCTAssertFalse(MacMenubarState.menuNeedsRebuild(previous: base, next: base))

        // A changed status line changes the rows, so the menu is rebuilt.
        var moreWorking = base
        moreWorking.workingBotCount = 2
        XCTAssertTrue(MacMenubarState.menuNeedsRebuild(previous: base, next: moreWorking))
    }

    // MARK: - 6. Review Triage: Notifications & Hotkeys

    /// A harness notify frame becomes the candidate event the coordinator
    /// evaluates, and the delivered payload reaches the notification submitter
    /// instead of only an in-memory array.
    func testNotifyFramesBecomeCandidateEventsAndReachTheNotificationSubmitter() {
        let approval = NotificationFrame(
            kind: "approval",
            botId: "b1",
            botName: "Scout",
            threadId: "t1",
            title: "Scout needs approval",
            body: "rm -rf ./build",
            requestId: "req-9"
        )
        let event = MacCandidateNotificationEvent(notificationFrame: approval)
        XCTAssertEqual(
            event,
            .botNeedsApproval(
                botId: "b1",
                botName: "Scout",
                threadId: "t1",
                requestId: "req-9",
                summary: "rm -rf ./build"
            )
        )
        XCTAssertTrue(event.requiresPersonAttention)

        // Routine completion NEVER notifies.
        let done = NotificationFrame(
            kind: "done",
            botId: "b1",
            botName: "Scout",
            threadId: "t1",
            title: "Scout finished",
            body: "pushed"
        )
        let doneEvent = MacCandidateNotificationEvent(notificationFrame: done)
        XCTAssertFalse(doneEvent.requiresPersonAttention)

        // The payload reaches the submitter.
        let recorder = NotificationRecorder()
        let coordinator = MacNotificationCoordinator(
            initialPermission: .notDetermined,
            permissionGrantResult: true
        ) { payload in
            recorder.record(payload)
        }
        let decision = coordinator.handleEvent(event)
        guard case .deliver(let payload) = decision else {
            return XCTFail("Expected the approval notification to be delivered")
        }
        XCTAssertEqual(recorder.recorded, [payload])
        XCTAssertEqual(payload.categoryIdentifier, NotificationCategoryIdentifier.approval)
    }

    /// A registered Carbon hotkey has to route back to the action that
    /// registered it.
    func testCarbonHotKeyIdsRoundTripToTheirActions() {
        XCTAssertEqual(
            MacGlobalHotkeyAction(carbonHotKeyId: MacGlobalHotkeyAction.showOrHideBotFleet.carbonHotKeyID),
            .showOrHideBotFleet
        )
        XCTAssertEqual(
            MacGlobalHotkeyAction(carbonHotKeyId: MacGlobalHotkeyAction.pushToTalk.carbonHotKeyID),
            .pushToTalk
        )
        XCTAssertNil(MacGlobalHotkeyAction(carbonHotKeyId: 99))
    }
}

/// Collects the notification payloads handed to the coordinator's submitter.
private final class NotificationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var payloads: [MacDeliverableNotification] = []

    func record(_ payload: MacDeliverableNotification) {
        lock.lock()
        payloads.append(payload)
        lock.unlock()
    }

    var recorded: [MacDeliverableNotification] {
        lock.lock()
        defer { lock.unlock() }
        return payloads
    }
}
