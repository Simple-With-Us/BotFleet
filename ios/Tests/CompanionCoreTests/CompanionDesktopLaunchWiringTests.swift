import Foundation
import Testing
@testable import CompanionCore

/// The owner-side desktop-launch wiring of the native companion listener
/// (BF-2690): the gate `POST /api/desktop/open` keeps after its loopback
/// check, and the action it runs once both BF-2489 gates pass.
///
/// The listener suites start a real server on an ephemeral loopback port, the
/// same way `PhoneSettingsModelTests` does.  Requests go through
/// `handleRequest`, the router entry for both the socket and these tests, so
/// no desktop input happens and no window is brought forward here.
@Suite("Companion Desktop Launch Wiring (BF-2690)")
struct CompanionDesktopLaunchWiringTests {
    /// How many times the installed launch action ran.  Sendable by actor
    /// isolation, like the launch action's caller requires.
    private actor LaunchCounter {
        private var count = 0

        func increment() -> Int {
            count += 1
            return count
        }

        func current() -> Int {
            count
        }
    }

    /// Hands the server the listener built back to the test.  That closure is
    /// synchronous, so a lock-guarded box carries the server out, the way the
    /// Mac app carries its built runtime out.
    private final class BuiltServerBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: NativeCompanionServer?

        func store(_ server: NativeCompanionServer) {
            lock.lock()
            defer { lock.unlock() }
            stored = server
        }

        var server: NativeCompanionServer? {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
    }

    /// A paired device for the test servers.  Fixture-only, never a real
    /// pairing secret: the two halves are joined at run time, matching the
    /// runtime suites, so no bearer literal is stored in source.
    private static let token = "bf_test_" + "desktop_launch"

    private static func openRequest(address: String = "127.0.0.1") -> CompanionHTTPRequest {
        CompanionHTTPRequest(
            method: "POST",
            path: "/api/desktop/open",
            headers: ["Authorization": "Bearer \(token)"],
            remoteAddress: address
        )
    }

    /// The server the Mac app's first-start closure builds (BF-2690): the
    /// wiring handed in becomes the gate and the action, so the construction
    /// under test is the shipped one.  The paired fixture device is the one
    /// difference from the app, which pairs real phones.
    private static func wiredServer(
        _ wiring: CompanionDesktopLaunchWiring,
        database: DatabaseService
    ) -> NativeCompanionServer {
        NativeCompanionServer(
            database: database,
            pairedTokens: [token],
            config: CompanionServerConfig(allowRemoteDesktopLaunch: wiring.allowRemoteDesktopLaunch),
            onDesktopOpen: wiring.onDesktopOpen
        )
    }

    @Test("BF-2690: the server built on first start is built with the gate and action set before it")
    func builtServerCarriesTheWiring() async throws {
        let database = try DatabaseService(path: ":memory:")
        let launches = LaunchCounter()
        let built = BuiltServerBox()
        let backend = NativeCompanionListenerBackend { wiring in
            let server = Self.wiredServer(wiring, database: database)
            built.store(server)
            return server
        }

        // Set before the first start, so the server is built with them.
        await backend.setAllowRemoteDesktopLaunch(true)
        await backend.setDesktopOpenAction { _ = await launches.increment() }
        let port = try await backend.start(advertising: nil) { _ in }
        #expect(port != nil)

        let server = try #require(built.server)
        let opened = await server.handleRequest(Self.openRequest())
        #expect(opened.statusCode == 200)
        #expect(await server.desktopOpenCount == 1)
        #expect(await launches.current() == 1)

        // A stop and a start keep the same wired server.
        await backend.stop()
        let restarted = try await backend.start(advertising: nil) { _ in }
        #expect(restarted != nil)
        let reopened = await server.handleRequest(Self.openRequest())
        #expect(reopened.statusCode == 200)
        #expect(await launches.current() == 2)
        await backend.stop()
    }

    @Test("BF-2690: a refused Open on Mac never runs the launch action, and only the owner side opens the gate")
    func refusalsNeverLaunchAndOnlyTheOwnerOpensTheGate() async throws {
        let database = try DatabaseService(path: ":memory:")
        let launches = LaunchCounter()
        let built = BuiltServerBox()
        let backend = NativeCompanionListenerBackend { wiring in
            let server = Self.wiredServer(wiring, database: database)
            built.store(server)
            return server
        }
        // The action the Mac app installs, while the gate is still the closed
        // default.
        await backend.setDesktopOpenAction { _ = await launches.increment() }
        _ = try await backend.start(advertising: nil) { _ in }
        let server = try #require(built.server)

        // The setting gate: refused before the action is consulted.
        let disabled = await server.handleRequest(Self.openRequest())
        #expect(disabled.statusCode == 403)
        #expect(disabled.bodyString.contains("Opening the desktop app from iOS is disabled in Mac settings"))

        // A paired phone still cannot open the gate for itself.
        let phoneConfig = await server.handleRequest(
            CompanionHTTPRequest(
                method: "PUT",
                path: "/api/config",
                headers: ["Authorization": "Bearer \(Self.token)"],
                jsonString: "{\"allowRemoteDesktopLaunch\":true}"
            )
        )
        #expect(phoneConfig.statusCode == 403)

        // The owner side opens the gate on the server that is already up.
        await backend.setAllowRemoteDesktopLaunch(true)

        // The loopback gate: a request that did not come over loopback is
        // still refused, and still never reaches the action.
        let remote = await server.handleRequest(Self.openRequest(address: "192.168.1.44"))
        #expect(remote.statusCode == 403)
        #expect(remote.bodyString.contains("Desktop launch requires a loopback connection"))
        #expect(await server.desktopOpenCount == 0)
        #expect(await launches.current() == 0)

        // Both gates pass: the action runs exactly once.
        let opened = await server.handleRequest(Self.openRequest())
        #expect(opened.statusCode == 200)
        #expect(opened.bodyString.contains("\"launched\":true"))
        #expect(await server.desktopOpenCount == 1)
        #expect(await launches.current() == 1)

        // Closing the gate again refuses the next request.
        await backend.setAllowRemoteDesktopLaunch(false)
        let closedAgain = await server.handleRequest(Self.openRequest())
        #expect(closedAgain.statusCode == 403)
        #expect(await server.desktopOpenCount == 1)
        #expect(await launches.current() == 1)
        await backend.stop()
    }

    @Test("BF-2690: without an action the route stays 501, and a later install or removal reaches the running server")
    func actionInstallsAndRemovesOnTheRunningServer() async throws {
        let database = try DatabaseService(path: ":memory:")
        let launches = LaunchCounter()
        let built = BuiltServerBox()
        let backend = NativeCompanionListenerBackend { wiring in
            let server = Self.wiredServer(wiring, database: database)
            built.store(server)
            return server
        }
        await backend.setAllowRemoteDesktopLaunch(true)
        _ = try await backend.start(advertising: nil) { _ in }
        let server = try #require(built.server)

        // The gate is open and no action is installed: the honest answer is
        // still "not available on this Mac".
        let unavailable = await server.handleRequest(Self.openRequest())
        #expect(unavailable.statusCode == 501)
        #expect(unavailable.bodyString.contains("Opening the desktop app is not available on this Mac"))

        await backend.setDesktopOpenAction { _ = await launches.increment() }
        let installed = await server.handleRequest(Self.openRequest())
        #expect(installed.statusCode == 200)
        #expect(await launches.current() == 1)

        await backend.setDesktopOpenAction(nil)
        let removed = await server.handleRequest(Self.openRequest())
        #expect(removed.statusCode == 501)
        #expect(await server.desktopOpenCount == 1)
        await backend.stop()
    }

    @Test("BF-2690: the wiring given at construction is what the server built on first start carries")
    func constructionWiringIsCarriedByTheBuiltServer() async throws {
        let database = try DatabaseService(path: ":memory:")
        let launches = LaunchCounter()
        let built = BuiltServerBox()
        let backend = NativeCompanionListenerBackend(
            desktopLaunch: CompanionDesktopLaunchWiring(
                allowRemoteDesktopLaunch: true,
                onDesktopOpen: { _ = await launches.increment() }
            ),
            makeServer: { wiring in
                let server = Self.wiredServer(wiring, database: database)
                built.store(server)
                return server
            }
        )
        _ = try await backend.start(advertising: nil) { _ in }

        let server = try #require(built.server)
        let opened = await server.handleRequest(Self.openRequest())
        #expect(opened.statusCode == 200)
        #expect(await server.currentConfig().allowRemoteDesktopLaunch)
        #expect(await launches.current() == 1)
        await backend.stop()
    }

    @Test("BF-2690: a caller with no paired credential never reaches either gate")
    func unpairedCallerNeverLaunches() async throws {
        let database = try DatabaseService(path: ":memory:")
        let launches = LaunchCounter()
        let built = BuiltServerBox()
        let backend = NativeCompanionListenerBackend { wiring in
            let server = Self.wiredServer(wiring, database: database)
            built.store(server)
            return server
        }
        await backend.setAllowRemoteDesktopLaunch(true)
        await backend.setDesktopOpenAction { _ = await launches.increment() }
        _ = try await backend.start(advertising: nil) { _ in }
        let server = try #require(built.server)

        let unpaired = await server.handleRequest(
            CompanionHTTPRequest(method: "POST", path: "/api/desktop/open")
        )
        #expect(unpaired.statusCode == 401)
        #expect(await server.desktopOpenCount == 0)
        #expect(await launches.current() == 0)
        await backend.stop()
    }

    @Test("BF-2690: the native gate is the grant the harness reported, and closed while it is unknown")
    func nativeGateFollowsTheGrant() {
        #expect(MacLifecycleSettings(allowRemoteDesktopLaunch: nil).nativeDesktopLaunchAllowed == false)
        #expect(MacLifecycleSettings(allowRemoteDesktopLaunch: false).nativeDesktopLaunchAllowed == false)
        #expect(MacLifecycleSettings(allowRemoteDesktopLaunch: true).nativeDesktopLaunchAllowed == true)
    }
}
