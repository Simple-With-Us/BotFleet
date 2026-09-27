# iOS companion pairing and stream resume

The iOS companion fixture verifies server QR confirmation, manual pairing codes, stream recovery after network interruption, and hidden activity isolation using disposable simulators and offline fixtures.

## Setup

```sh
cd ios && swift test
```

Or run a specific companion test:

```sh
xcodebuild -scheme BotFleet -destination 'platform=iOS Simulator,name=iPhone 15' test
```

The test suite:

1. Starts an isolated BotFleet server
2. Launches a simulator instance
3. Runs pairing flows (QR code and manual codes)
4. Simulates stream interruption and recovery
5. Verifies transcript folds and Hidden activity markers

## Steps

```sh
# 1. Run the iOS test suite
cd ios && swift test

# 2. Expected assertions:
# - QR code generation succeeds and encodes the server URL
# - Manual pairing codes are displayed and accepted
# - Stream reconnects after network dropout without losing messages
# - Completed turns fold in the transcript
# - Hidden reasoning is marked but not displayed
# - Message rendering matches the server's turn structure
```

## Expected Evidence

A passing run shows:

- **Test output:** All iOS tests pass on the simulator
- **Simulator logs:** Connection logs show successful pairing and reconnection
- **Transcript folds:** Completed turns display as collapsed rows
- **Activity log:** Hidden reasoning entries appear with the Hidden marker

## Key Behaviors Verified

- **QR pairing:** The companion generates and validates QR codes server-side
- **Manual codes:** Fallback pairing codes are numeric and single-use
- **Stream resume:** After Ctrl-C or network delay, the client reconnects and receives pending messages
- **Transcript folds:** Turns marked complete fold automatically
- **Hidden activity:** Reasoning marked hidden does not display in the main transcript

## Cleanup

The simulator session closes automatically.  Temporary data is removed.
