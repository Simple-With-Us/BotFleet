import Foundation

/// Native reproduction of `electron/package-link.mjs` for `botfleet://install` deep links (BF-2495).
/// Enforces the strict host and extension allowlist (`github.com`, `www.github.com`,
/// and `raw.githubusercontent.com` over `https:` only; `.md` and `.json` paths only)
/// so a package install deep link can never become an arbitrary fetch.
public enum PackageLinkAllowlist {
    public static let allowedHosts: Set<String> = [
        "github.com",
        "www.github.com",
        "raw.githubusercontent.com",
    ]

    public static func packageUrlFromDeepLink(_ rawValue: String) -> String? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let linkComponents = URLComponents(string: trimmed),
              linkComponents.scheme?.lowercased() == "botfleet",
              linkComponents.host?.lowercased() == "install" else {
            return nil
        }

        guard let rawPackage = linkComponents.queryItems?.first(where: { $0.name == "url" })?.value,
              !rawPackage.isEmpty,
              let packageComponents = URLComponents(string: rawPackage),
              let packageURL = packageComponents.url else {
            return nil
        }

        guard packageComponents.scheme?.lowercased() == "https" else {
            return nil
        }
        if let user = packageComponents.user, !user.isEmpty {
            return nil
        }
        if let password = packageComponents.password, !password.isEmpty {
            return nil
        }
        if packageComponents.port != nil {
            return nil
        }

        guard let host = packageComponents.host?.lowercased(),
              allowedHosts.contains(host) else {
            return nil
        }

        let path = packageComponents.percentEncodedPath.isEmpty ? packageComponents.path : packageComponents.percentEncodedPath
        // Reject path traversal segments or encoded dot-segments so a crafted path
        // cannot escape the expected file extension check.
        let decodedPath = path.removingPercentEncoding ?? path
        let segments = decodedPath.split(separator: "/", omittingEmptySubsequences: true)
        if segments.contains("..") || segments.contains(".") {
            return nil
        }

        let lowerPath = packageComponents.path.lowercased()
        guard lowerPath.hasSuffix(".md") || lowerPath.hasSuffix(".json") else {
            return nil
        }

        return packageURL.absoluteString
    }

    public static func packageUrlFromCommandLine(_ argv: [String]) -> String? {
        for arg in argv {
            if let resolved = packageUrlFromDeepLink(arg) {
                return resolved
            }
        }
        return nil
    }
}
