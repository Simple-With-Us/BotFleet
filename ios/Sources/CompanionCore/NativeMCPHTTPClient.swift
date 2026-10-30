import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum NativeMCPHTTPClientError: Error, Sendable, Equatable {
    case invalidURL
    case invalidResponse
    case responseTooLarge
}

/// Private MCP requests use a fresh session without ambient identity and never follow redirects.
public final class NativeMCPURLSessionHTTPClient: NativeTurnToolHTTPClient, @unchecked Sendable {
    public static let maximumResponseBytes = 32 * 1024 * 1024
    private let configuration: URLSessionConfiguration
    private let responseLimit: Int
    private let timeout: TimeInterval

    /// A supplied configuration supports offline URLProtocol fixtures; ambient storage and headers are always removed.
    public init(configuration: URLSessionConfiguration? = nil,
                maximumResponseBytes: Int = NativeMCPURLSessionHTTPClient.maximumResponseBytes,
                timeout: TimeInterval = 30) {
        let clean = (configuration?.copy() as? URLSessionConfiguration) ?? .ephemeral
        let boundedTimeout = timeout.isFinite && timeout > 0 ? min(timeout, 120) : 30
        clean.urlCache = nil
        clean.httpCookieStorage = nil
        clean.httpShouldSetCookies = false
        clean.urlCredentialStorage = nil
        clean.httpAdditionalHeaders = nil
        clean.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        clean.timeoutIntervalForRequest = boundedTimeout
        clean.timeoutIntervalForResource = boundedTimeout
        clean.waitsForConnectivity = false
        self.configuration = clean
        self.responseLimit = max(1, min(maximumResponseBytes, Self.maximumResponseBytes))
        self.timeout = boundedTimeout
    }

    public func execute(_ supplied: URLRequest) async throws -> NativeMCPHTTPResponse {
        guard let url = supplied.url, ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false, url.user == nil, url.password == nil, url.fragment == nil else {
            throw NativeMCPHTTPClientError.invalidURL
        }
        var request = supplied
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.httpShouldHandleCookies = false
        request.timeoutInterval = supplied.timeoutInterval.isFinite && supplied.timeoutInterval > 0
            ? min(supplied.timeoutInterval, timeout) : timeout
        let operation = NativeMCPRequestOperation(limit: responseLimit)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<NativeMCPHTTPResponse, Error>) in
                operation.start(request: request, configuration: configuration, continuation: continuation)
            }
        } onCancel: {
            operation.cancel()
        }
    }
}

/// Delegate callbacks, task cancellation, and transport failures share one completion gate.
private final class NativeMCPRequestOperation: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Int
    private var completed = false
    private var continuation: CheckedContinuation<NativeMCPHTTPResponse, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var body = Data()
    private var deadline: Task<Void, Never>?

    init(limit: Int) { self.limit = limit }

    func start(request: URLRequest, configuration: URLSessionConfiguration,
               continuation: CheckedContinuation<NativeMCPHTTPResponse, Error>) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            continuation.resume(throwing: URLError(.cancelled))
            return
        }
        self.continuation = continuation
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        let task = session.dataTask(with: request)
        self.session = session
        self.task = task
        deadline = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(request.timeoutInterval * 1_000_000_000)) }
            catch { return }
            self?.finish(.failure(URLError(.timedOut)))
        }
        lock.unlock()
        task.resume()
    }

    func cancel() { finish(.failure(URLError(.cancelled))) }

    private func finish(_ result: Result<NativeMCPHTTPResponse, Error>) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        let callback = continuation
        continuation = nil
        let session = self.session
        self.session = nil
        task = nil
        let deadline = self.deadline
        self.deadline = nil
        body.removeAll(keepingCapacity: false)
        lock.unlock()
        deadline?.cancel()
        switch result {
        case .success: session?.finishTasksAndInvalidate()
        case .failure: session?.invalidateAndCancel()
        }
        callback?.resume(with: result)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock()
        if !completed { self.response = response }
        lock.unlock()
        completionHandler(nil)
    }

    private func answer(_ challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == "NSURLAuthenticationMethodServerTrust" {
            completionHandler(.performDefaultHandling, nil)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        answer(challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        answer(challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse else {
            finish(.failure(NativeMCPHTTPClientError.invalidResponse))
            completionHandler(.cancel)
            return
        }
        guard response.expectedContentLength <= Int64(limit) else {
            finish(.failure(NativeMCPHTTPClientError.responseTooLarge))
            completionHandler(.cancel)
            return
        }
        lock.lock()
        let active = !completed
        if active { self.response = response }
        lock.unlock()
        completionHandler(active ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        guard data.count <= limit - body.count else {
            lock.unlock()
            finish(.failure(NativeMCPHTTPClientError.responseTooLarge))
            return
        }
        body.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)); return }
        lock.lock()
        guard !completed else { lock.unlock(); return }
        let response = self.response
        let data = body
        lock.unlock()
        guard let response else { finish(.failure(NativeMCPHTTPClientError.invalidResponse)); return }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { output, header in
            output[String(describing: header.key)] = String(describing: header.value)
        }
        finish(.success(NativeMCPHTTPResponse(status: response.statusCode, headers: headers, body: data)))
    }
}
