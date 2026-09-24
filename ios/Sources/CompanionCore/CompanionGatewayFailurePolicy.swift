import Foundation

/// Identifies gateway-offline responses from the currently paired computer.
///
/// Only an offline signal is suppressed: Cloudflare answers 530 with error
/// 1033 (no tunnel connector) on a hosted route when the paired computer's
/// tunnel is down. Cloudflare also answers 530 for other 1xxx errors (1016
/// origin DNS/config and the like), which are real breakages, so the 1033
/// marker is required too. Sentry's failed-request event carries no body but
/// does carry the sanitized response headers, and Cloudflare stamps its own
/// error pages with `cf-error-type`, so the marker is read from there. 502 and 503 are not offline signals here: the companion proxy
/// returns 502 for its own faults on a reachable gateway (response too
/// large, not preparable for this device, upstream failure) and forwards the
/// harness's own 503s, so those stay reportable.
public enum CompanionGatewayFailurePolicy {
    private static let tunnelOfflineStatusCode = 530
    private static let tunnelOfflineErrorType = "1033"

    public static func shouldSuppress(
        statusCode: Int,
        responseHeaders: [String: String]?,
        requestURL: String?,
        pairedConnection: Connection?
    ) -> Bool {
        guard statusCode == tunnelOfflineStatusCode,
              cloudflareErrorType(in: responseHeaders) == tunnelOfflineErrorType,
              let requestURL,
              let requestOrigin = origin(for: requestURL),
              let pairedConnection
        else { return false }

        // Direct tailnet/LAN routes never pass through the Cloudflare tunnel,
        // so only a paired hosted route can carry the tunnel-offline signal.
        return pairedConnection.orderedEndpoints.contains { endpoint in
            guard endpoint.kind == .hosted, let endpointURL = endpoint.baseURL else { return false }
            return origin(for: endpointURL.absoluteString) == requestOrigin
        }
    }

    /// HTTP header names are case-insensitive, and HTTP/2 delivers them lowercased.
    private static func cloudflareErrorType(in headers: [String: String]?) -> String? {
        headers?.first { $0.key.caseInsensitiveCompare("cf-error-type") == .orderedSame }?
            .value.trimmingCharacters(in: .whitespaces)
    }

    private static func origin(for value: String) -> Origin? {
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(),
              !host.isEmpty
        else { return nil }

        let defaultPort = scheme == "https" ? 443 : 80
        return Origin(scheme: scheme, host: host, port: components.port ?? defaultPort)
    }

    private struct Origin: Equatable {
        let scheme: String
        let host: String
        let port: Int
    }
}
