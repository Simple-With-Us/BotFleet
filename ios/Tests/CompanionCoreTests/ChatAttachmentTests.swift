import Foundation
import XCTest
@testable import CompanionCore

final class ChatAttachmentTests: XCTestCase {
    func testComposeImageTagCarriesTheDiskPath() {
        let prompt = ChatAttachments.composeMessage(
            text: "what is this?",
            attachments: [
                ChatPromptAttachment(
                    kind: .image,
                    path: "/Users/example/.botfleet/attachments/abc.png"
                ),
            ]
        )
        XCTAssertEqual(
            prompt,
            "what is this?\n\n<attached-image path=\"/Users/example/.botfleet/attachments/abc.png\" />"
        )
    }

    func testComposeFileTagMirrorsDesktopXML() {
        let prompt = ChatAttachments.composeMessage(
            text: "",
            attachments: [
                ChatPromptAttachment(kind: .file, path: "/tmp/notes.txt"),
            ]
        )
        XCTAssertEqual(prompt, "<attached-file path=\"/tmp/notes.txt\" />")
    }

    func testComposeEscapesAttributeCharacters() {
        let prompt = ChatAttachments.composeMessage(
            text: "  intro  ",
            attachments: [
                ChatPromptAttachment(kind: .file, path: "/tmp/a\"&<>\t\n\r.txt"),
            ]
        )
        XCTAssertEqual(
            prompt,
            "intro\n\n<attached-file path=\"/tmp/a&quot;&amp;&lt;&gt;&#9;&#10;&#13;.txt\" />"
        )
    }

    func testComposeJoinsSeveralAttachments() {
        let prompt = ChatAttachments.composeMessage(
            text: "look at this",
            attachments: [
                ChatPromptAttachment(kind: .image, path: "/a/b/one.png"),
                ChatPromptAttachment(kind: .image, path: "/a/b/two.jpg"),
            ]
        )
        XCTAssertEqual(
            prompt,
            "look at this\n\n<attached-image path=\"/a/b/one.png\" />\n\n<attached-image path=\"/a/b/two.jpg\" />"
        )
    }

    func testSplitStripsTagsAndKeepsDisplayText() {
        let stored = """
        caption

        <attached-image path="/a/b/one.png" />

        <attached-file path="/tmp/notes.txt" />
        """
        let split = ChatAttachments.split(stored)
        XCTAssertEqual(split.display, "caption")
        XCTAssertEqual(split.images, ["/a/b/one.png"])
        XCTAssertEqual(split.files, ["/tmp/notes.txt"])
    }

    func testSplitUnescapesAmpersandsLast() {
        let stored = "<attached-image path=\"/a/b/&amp;x.png\" />"
        let split = ChatAttachments.split(stored)
        XCTAssertEqual(split.images, ["/a/b/&x.png"])
        XCTAssertEqual(split.display, "")
    }

    func testFetchPathOnlyAllowsSidecarImageNames() {
        XCTAssertEqual(
            ChatAttachments.fetchPath(forDiskPath: "/Users/example/.botfleet/attachments/abc-123.png"),
            "/api/attachments/abc-123.png"
        )
        XCTAssertNil(ChatAttachments.fetchPath(forDiskPath: "/tmp/notes.txt"))
        XCTAssertNil(ChatAttachments.fetchPath(forDiskPath: "/tmp/avatar.svg"))
        XCTAssertNil(ChatAttachments.fetchPath(forDiskPath: "/tmp/avatar.html"))
        XCTAssertNil(ChatAttachments.fetchPath(forDiskPath: "C:\\\\data\\\\attachments\\\\abc.png.exe"))
    }

    func testDisplayImageContractMatchesTheSidecarAllowlist() {
        for mime in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            XCTAssertTrue(ChatAttachments.isDisplayImageMIME(mime), mime)
        }
        for mime in ["image/heic", "image/heif", "image/avif", "image/bmp", "image/svg+xml"] {
            XCTAssertFalse(ChatAttachments.isDisplayImageMIME(mime), mime)
        }

        for name in ["photo.png", "photo.jpg", "photo.jpeg", "photo.gif", "photo.webp"] {
            XCTAssertTrue(ChatAttachments.isRenderableImageName(name), name)
        }
        for name in ["photo.heic", "photo.heif", "photo.avif", "photo.bmp", "photo.svg"] {
            XCTAssertFalse(ChatAttachments.isRenderableImageName(name), name)
        }
    }

    func testSniffImageMagicBytes() {
        var png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        png.append(contentsOf: [0, 0, 0, 0])
        XCTAssertEqual(ChatAttachments.sniffImageMIME(png), "image/png")

        XCTAssertEqual(ChatAttachments.sniffImageMIME(Data([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg")
        XCTAssertEqual(ChatAttachments.sniffImageMIME(Data("GIF89a".utf8)), "image/gif")
        XCTAssertEqual(ChatAttachments.sniffImageMIME(Data([0x42, 0x4d, 0, 0])), "image/bmp")
        XCTAssertEqual(ChatAttachments.sniffImageMIME(Data("<svg xmlns='http://www.w3.org/2000/svg'></svg>".utf8)), "image/svg+xml")
        XCTAssertNil(ChatAttachments.sniffImageMIME(Data("not an image".utf8)))
    }

    func testAttachmentResponseDecoding() throws {
        let data = Data(#"{"path":"/Users/example/.botfleet/attachments/abc.png","mime":"image/png","bytes":12}"#.utf8)
        let saved = try JSONDecoder().decode(AttachmentResponse.self, from: data)
        XCTAssertEqual(saved.path, "/Users/example/.botfleet/attachments/abc.png")
        XCTAssertEqual(saved.mime, "image/png")
        XCTAssertEqual(saved.bytes, 12)
    }
}

private final class AttachmentRequestStub: URLProtocol {
    static var statusCode = 201
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class ChatAttachmentClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        AttachmentRequestStub.statusCode = 201
        AttachmentRequestStub.capturedRequest = nil
        AttachmentRequestStub.capturedBody = nil
        AttachmentRequestStub.responseBody = Data(
            #"{"path":"/Users/example/.botfleet/attachments/abc.png","mime":"image/png","bytes":4}"#.utf8
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AttachmentRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testUploadChatAttachmentPostsRawBytesAndReturnsDiskPath() async throws {
        let bytes = Data([0x89, 0x50, 0x4e, 0x47])
        let saved = try await client.uploadChatAttachment(
            data: bytes,
            mime: "image/png",
            filename: "shot.png"
        )

        let request = try XCTUnwrap(AttachmentRequestStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/attachments")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "image/png")
        XCTAssertEqual(AttachmentRequestStub.capturedBody, bytes)
        XCTAssertEqual(saved.path, "/Users/example/.botfleet/attachments/abc.png")
        XCTAssertEqual(saved.mime, "image/png")
        XCTAssertEqual(saved.bytes, 4)
    }

    func testUploadAvatarStillReturnsTheFetchURL() async throws {
        let bytes = Data([0x89, 0x50, 0x4e, 0x47])
        let url = try await client.uploadAvatar(data: bytes, mime: "image/png")
        XCTAssertEqual(url, "/api/attachments/abc.png")
    }

    func testUploadAvatarAcceptsOnlyRoundTripDisplayMimes() async throws {
        let bytes = Data([1, 2, 3, 4])
        for mime in ["image/png", "image/jpeg", "image/gif", "image/webp"] {
            AttachmentRequestStub.capturedRequest = nil
            _ = try await client.uploadAvatar(data: bytes, mime: mime)
            XCTAssertEqual(AttachmentRequestStub.capturedRequest?.value(forHTTPHeaderField: "Content-Type"), mime)
        }

        for mime in ["image/heic", "image/heif", "image/avif", "image/bmp", "image/svg+xml"] {
            AttachmentRequestStub.capturedRequest = nil
            do {
                _ = try await client.uploadAvatar(data: bytes, mime: mime)
                XCTFail("expected \(mime) to require conversion")
            } catch let error as APIError {
                XCTAssertTrue(error.localizedDescription.contains("PNG, JPEG, GIF, or WebP"))
            }
            XCTAssertNil(AttachmentRequestStub.capturedRequest)
        }
    }

    func testRegisterPushTokenPostsHexToCompanionRoute() async throws {
        AttachmentRequestStub.statusCode = 200
        AttachmentRequestStub.responseBody = Data(#"{"ok":true}"#.utf8)
        let hex = String(repeating: "ab", count: 32)
        try await client.registerPushToken(hex)

        let request = try XCTUnwrap(AttachmentRequestStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/companion/push-token")
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(AttachmentRequestStub.capturedBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["token"] as? String, hex)
    }

    func testAnImageAttachmentKeepsItsBytesForAComposerPreview() {
        let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        let image = PendingChatAttachment(name: "photo.png", mime: "image/png", data: png)
        XCTAssertEqual(image.kind, .image)
        XCTAssertEqual(image.previewImageData, png)

        let file = PendingChatAttachment(name: "notes.txt", mime: "text/plain", data: Data("hi".utf8))
        XCTAssertNil(file.previewImageData)

        let svg = PendingChatAttachment(name: "mark.svg", mime: "image/svg+xml", data: Data("<svg></svg>".utf8))
        XCTAssertEqual(svg.kind, .image)
        XCTAssertNil(svg.previewImageData, "a format the phone cannot draw stays an icon")

        let empty = PendingChatAttachment(name: "blank.jpg", mime: "image/jpeg", data: Data())
        XCTAssertNil(empty.previewImageData)
    }

    func testUploadChatAttachmentRejectsOversizedImages() async {
        let data = Data(repeating: 1, count: ChatAttachments.imageMaxBytes + 1)
        do {
            _ = try await client.uploadChatAttachment(data: data, mime: "image/png", filename: "big.png")
            XCTFail("expected a transport error")
        } catch let error as APIError {
            XCTAssertTrue(error.localizedDescription.contains("10 MB"))
        } catch {
            XCTFail("wrong error \(error)")
        }
        XCTAssertNil(AttachmentRequestStub.capturedRequest)
    }
}
