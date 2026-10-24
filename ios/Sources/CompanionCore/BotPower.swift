/// The On/Off switch as the phone decides it.
///
/// Switching Off a bot that is working is really two decisions — stop the
/// turn now, or stop it starting from now — and a switch cannot tell which one
/// was meant.  It asks, but only while a turn is running, because that is the
/// only state in which the two answers differ.  An idle bot has nothing to
/// stop, so its switch flips straight through.
///
/// The decision lives here rather than in the view because a SwiftUI
/// `Binding` is not something a test can call: the setter had been reading
/// `!isOff` while writing `isOff`, so the switch snapped back and no test
/// could see it.  The view passes what the switch reported and applies what
/// comes back.
public enum BotPowerToggleAction: Equatable, Sendable {
    /// A turn is in flight and the switch is being turned off: ask which of
    /// the two the person meant.  The bot stays on until they answer.
    case askAboutRunningTurn
    /// Nothing to ask about — set the switch to this.
    case setOff(Bool)

    /// The value the switch should now report, for the case that answers it.
    /// Asking has no answer yet, so it reports the current one: the bot is
    /// still on, which is exactly what the person is being asked about.
    public var resultingIsOff: Bool {
        switch self {
        case .askAboutRunningTurn: false
        case .setOff(let off): off
        }
    }
}

/// Decide what turning the switch to `turnedOn` means for a bot whose stored
/// state is `isOff`.
///
/// - Parameters:
///   - turnedOn: what the switch reports after the person touched it.
///   - isOff: the bot's stored state, which is what the switch *reads* as
///     its inverse.
///   - isBusy: whether a turn is running right now.
public func botPowerToggleAction(turnedOn: Bool, isOff: Bool, isBusy: Bool) -> BotPowerToggleAction {
    // Turning On is never in question — there is nothing running to stop and
    // the stored state is `false` by definition.
    if turnedOn {
        return .setOff(false)
    }
    // Only a working bot has a turn to decide about.
    if isBusy {
        return .askAboutRunningTurn
    }
    // An idle bot flips straight through.  The switch reports the inverse of
    // the stored state, so turning it off stores `true`.
    return .setOff(true)
}