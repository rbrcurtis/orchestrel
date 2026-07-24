import UIKit
import UniformTypeIdentifiers
import WebKit

final class ShareViewController: UIViewController, WKScriptMessageHandler {
    private let appGroup = "group.com.orchestrel.ios.share"
    private let composerURL = URL(string: "https://orchestrel.com/share/card")!
    private let maxBytes: Int64 = 25 * 1024 * 1024
    private let maxChunk = 512 * 1024
    private var webView: WKWebView!
    private var shareDirectory: URL?
    private var manifest: [String: Any]?
    private var filesByID: [String: [String: Any]] = [:]
    private var didImport = false
    private var didFinish = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        configureWebView()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !didImport else { return }
        didImport = true
        Task { await importItems() }
    }

    private func configureWebView() {
        let controller = WKUserContentController()
        controller.add(self, name: "orchestrelShare")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private func importItems() async {
        let id = UUID().uuidString.lowercased()
        do {
            guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
                throw ShareError.missingAppGroup
            }
            pruneInbox(in: container)
            let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
            let temp = inbox.appendingPathComponent(".\(id).tmp", isDirectory: true)
            let filesDirectory = temp.appendingPathComponent("files", isDirectory: true)
            try FileManager.default.createDirectory(at: filesDirectory, withIntermediateDirectories: true)

            var text: [String] = []
            var files: [[String: Any]] = []
            var errors: [String] = []
            for input in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
                for provider in input.attachments ?? [] {
                    do {
                        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                           let value = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                           !value.isFileURL {
                            if !text.contains(value.absoluteString) { text.append(value.absoluteString) }
                            continue
                        }
                        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                           let value = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                            if !text.contains(value) { text.append(value) }
                            continue
                        }
                        let type = preferredFileType(for: provider)
                        let item = try await provider.loadItem(forTypeIdentifier: type)
                        let source: URL
                        var temporarySource: URL?
                        if let url = item as? URL {
                            source = url
                        } else if let data = item as? Data {
                            let url = temp.appendingPathComponent(UUID().uuidString)
                            try data.write(to: url)
                            source = url
                            temporarySource = url
                        } else if let image = item as? UIImage, let data = image.pngData() {
                            let url = temp.appendingPathComponent(UUID().uuidString + ".png")
                            try data.write(to: url)
                            source = url
                            temporarySource = url
                        } else {
                            throw ShareError.unreadable
                        }

                        let values = try source.resourceValues(forKeys: [.fileSizeKey, .nameKey])
                        let size = Int64(values.fileSize ?? 0)
                        let name = sanitize(values.name ?? source.lastPathComponent)
                        if size > maxBytes { throw ShareError.oversized(name) }
                        let fileID = UUID().uuidString.lowercased()
                        let relative = "files/\(fileID)-\(name)"
                        let destination = temp.appendingPathComponent(relative)
                        try FileManager.default.copyItem(at: source, to: destination)
                        if let temporarySource { try? FileManager.default.removeItem(at: temporarySource) }
                        files.append([
                            "id": fileID,
                            "name": name,
                            "mimeType": UTType(type)?.preferredMIMEType ?? "application/octet-stream",
                            "relativePath": relative,
                            "size": size,
                        ])
                    } catch {
                        errors.append(error.localizedDescription)
                    }
                }
            }
            guard !text.isEmpty || !files.isEmpty else { throw ShareError.empty }
            let storedManifest: [String: Any] = [
                "version": 1,
                "id": id,
                "createdAt": ISO8601DateFormatter().string(from: Date()),
                "text": text.joined(separator: "\n\n"),
                "files": files,
                "errors": errors,
            ]
            let data = try JSONSerialization.data(withJSONObject: storedManifest)
            try data.write(to: temp.appendingPathComponent("manifest.json"), options: .atomic)
            let destination = inbox.appendingPathComponent(id, isDirectory: true)
            try FileManager.default.moveItem(at: temp, to: destination)

            shareDirectory = destination
            manifest = [
                "version": 1,
                "id": id,
                "text": text.joined(separator: "\n\n"),
                "files": files.map { file in
                    ["id": file["id"]!, "name": file["name"]!, "mimeType": file["mimeType"]!, "size": file["size"]!]
                },
                "errors": errors,
            ]
            filesByID = Dictionary(uniqueKeysWithValues: files.compactMap { file in
                guard let id = file["id"] as? String else { return nil }
                return (id, file)
            })
            webView.load(URLRequest(url: composerURL))
        } catch {
            showError(error)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "orchestrelShare",
              message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "https",
              message.frameInfo.request.url?.host == "orchestrel.com",
              let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "ready": sendManifest()
        case "readChunk": readChunk(body)
        case "complete": finish(cancelled: false)
        case "cancel": finish(cancelled: true)
        default: break
        }
    }

    private func sendManifest() {
        guard let manifest else { return }
        send(["type": "manifest", "manifest": manifest])
    }

    private func readChunk(_ body: [String: Any]) {
        let requestID = body["requestId"] as? String
        do {
            guard let requestID,
                  let fileID = body["fileId"] as? String,
                  let offsetNumber = body["offset"] as? NSNumber,
                  let lengthNumber = body["length"] as? NSNumber,
                  let file = filesByID[fileID],
                  let relative = file["relativePath"] as? String,
                  let sizeNumber = file["size"] as? NSNumber,
                  let directory = shareDirectory else { throw ShareError.invalidRequest }
            let offset = offsetNumber.intValue
            let length = lengthNumber.intValue
            let size = sizeNumber.intValue
            guard offset >= 0, offset < size, length > 0, length <= maxChunk else { throw ShareError.invalidRequest }
            let root = directory.standardizedFileURL
            let url = directory.appendingPathComponent(relative).standardizedFileURL
            guard url.path.hasPrefix(root.path + "/") else { throw ShareError.invalidRequest }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            let data = try handle.read(upToCount: min(length, size - offset)) ?? Data()
            guard !data.isEmpty else { throw ShareError.unreadable }
            send([
                "type": "chunk",
                "requestId": requestID,
                "fileId": fileID,
                "offset": offset,
                "base64": data.base64EncodedString(),
                "done": offset + data.count >= size,
            ])
        } catch {
            send(["type": "error", "requestId": requestID ?? "", "message": error.localizedDescription])
        }
    }

    private func send(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__orchestrelShareReceive?.(\(json))")
    }

    private func finish(cancelled: Bool) {
        guard !didFinish else { return }
        didFinish = true
        if let shareDirectory { try? FileManager.default.removeItem(at: shareDirectory) }
        if cancelled {
            extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
        } else {
            extensionContext?.completeRequest(returningItems: [])
        }
    }

    private func preferredFileType(for provider: NSItemProvider) -> String {
        let preferred = [UTType.image.identifier, UTType.movie.identifier, UTType.audio.identifier, UTType.pdf.identifier, UTType.fileURL.identifier, UTType.data.identifier]
        return preferred.first(where: provider.hasItemConformingToTypeIdentifier) ?? provider.registeredTypeIdentifiers.first ?? UTType.data.identifier
    }

    private func pruneInbox(in container: URL) {
        let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
        for entry in entries {
            let modified = try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            if modified.map({ $0 < cutoff }) ?? false { try? FileManager.default.removeItem(at: entry) }
        }
    }

    private func sanitize(_ name: String) -> String {
        let value = (name as NSString).lastPathComponent
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._ -"))
        return value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
    }

    private func showError(_ error: Error) {
        let alert = UIAlertController(title: "Could not share", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in self.finish(cancelled: true) })
        present(alert, animated: true)
    }
}

private enum ShareError: LocalizedError {
    case missingAppGroup, unreadable, empty, invalidRequest, oversized(String)
    var errorDescription: String? {
        switch self {
        case .missingAppGroup: return "Shared App Group is unavailable"
        case .unreadable: return "An item could not be read"
        case .empty: return "No supported content was shared"
        case .invalidRequest: return "The shared file request was invalid"
        case .oversized(let name): return "\(name) exceeds the 25 MB limit"
        }
    }
}
