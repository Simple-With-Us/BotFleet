// Where the device token lives in the keychain, and how a phone that paired
// under the product's previous name keeps its pairing across the rename.
//
// The keychain service string is the token's address. The rename to
// BotFleet moved that address from the OpenMausBot service to the BotFleet
// one and nothing moved the items, so every updated phone looked under the
// new name, found nothing, and treated itself as never paired — while the
// old token sat one service over. The decision of what to do about that is
// pure, so it lives here where `swift test` can reach it; the app's
// Keychain does the reading and writing.
import Foundation

public enum CompanionTokenService {
    /// The service the app reads and writes today.
    public static let current = "com.botfleet.companion.token"

    /// Services earlier builds wrote under, newest first. A token found here
    /// is moved to `current` on first read. The current service never
    /// belongs in this list: a list that names itself migrates nothing.
    public static let legacy = ["com.openmausbot.companion.token"]
}

/// What a restore should do with what the keychain holds for a connection.
public enum CompanionTokenResolution: Equatable, Sendable {
    /// The token is where the current build expects it.
    case current(token: String)
    /// The token is where a previous build left it: use it now, copy it to
    /// the current service, and only then delete the old copy.
    case migrate(token: String, fromService: String)
    /// No service holds a token for this connection — the phone was never
    /// paired, or was signed out.
    case unpaired
}

public enum CompanionTokenMigration {
    /// Decide where a connection's token is, asking `lookup` one service at
    /// a time — the current one first, then each predecessor in order.
    ///
    /// `lookup` returns nil for "no item under this service" and throws for
    /// anything else. A throw is passed straight up rather than read as
    /// absence: a locked keychain answers the same way for every service,
    /// and mistaking it for "unpaired" is precisely the failure this app once
    /// had after every reboot.
    public static func resolve(
        lookup: (String) throws -> String?
    ) rethrows -> CompanionTokenResolution {
        if let token = try lookup(CompanionTokenService.current) {
            return .current(token: token)
        }
        for service in CompanionTokenService.legacy {
            if let token = try lookup(service) {
                return .migrate(token: token, fromService: service)
            }
        }
        return .unpaired
    }
}
