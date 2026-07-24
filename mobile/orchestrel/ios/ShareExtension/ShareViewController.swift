import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let appGroup = "group.com.orchestrel.ios.share"
    private let scheme = "orchestrel"
    private let maxBytes: Int64 = 25 * 1024 * 1024

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await importItems() }
    }

    private func importItems() async {
        let id = UUID().uuidString.lowercased()
        do {
            guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
                throw ShareError.missingAppGroup
            }
            let inbox = container.appendingPathComponent("Inbox", isDirectory: true)
            let temp = inbox.appendingPathComponent(".\(id).tmp", isDirectory: true)
            let filesDir = temp.appendingPathComponent("files", isDirectory: true)
            try FileManager.default.createDirectory(at: filesDir, withIntermediateDirectories: true)

            var text: [String] = []
            var files: [[String: Any]] = []
            var errors: [String] = []
            for input in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
                for provider in input.attachments ?? [] {
                    do {
                        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                           let value = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                            if !text.contains(value.absoluteString) { text.append(value.absoluteString) }
                            continue
                        }
                        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                           let value = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                            if !text.contains(value) { text.append(value) }
                            continue
                        }
                        let type = provider.registeredTypeIdentifiers.first ?? UTType.data.identifier
                        let item = try await provider.loadItem(forTypeIdentifier: type)
                        let source: URL
                        if let url = item as? URL { source = url }
                        else if let data = item as? Data {
                            source = temp.appendingPathComponent(UUID().uuidString)
                            try data.write(to: source)
                        } else { throw ShareError.unreadable }
                        let values = try source.resourceValues(forKeys: [.fileSizeKey, .nameKey])
                        let size = Int64(values.fileSize ?? 0)
                        let name = sanitize(values.name ?? source.lastPathComponent)
                        if size > maxBytes { throw ShareError.oversized(name) }
                        let fileID = UUID().uuidString.lowercased()
                        let relative = "files/\(fileID)-\(name)"
                        let destination = temp.appendingPathComponent(relative)
                        try FileManager.default.copyItem(at: source, to: destination)
                        files.append(["id": fileID, "name": name, "mimeType": UTType(type)?.preferredMIMEType ?? "application/octet-stream", "relativePath": relative, "size": size])
                    } catch { errors.append(error.localizedDescription) }
                }
            }
            guard !text.isEmpty || !files.isEmpty else { throw ShareError.empty }
            let manifest: [String: Any] = ["version": 1, "id": id, "createdAt": ISO8601DateFormatter().string(from: Date()), "text": text.joined(separator: "\n\n"), "files": files, "errors": errors]
            let data = try JSONSerialization.data(withJSONObject: manifest)
            try data.write(to: temp.appendingPathComponent("manifest.json.tmp"), options: .atomic)
            try FileManager.default.moveItem(at: temp.appendingPathComponent("manifest.json.tmp"), to: temp.appendingPathComponent("manifest.json"))
            try FileManager.default.moveItem(at: temp, to: inbox.appendingPathComponent(id, isDirectory: true))
            openContainingApp(id)
            extensionContext?.completeRequest(returningItems: nil)
        } catch {
            let alert = UIAlertController(title: "Could not share", message: error.localizedDescription, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in self.extensionContext?.cancelRequest(withError: error) })
            present(alert, animated: true)
        }
    }

    private func openContainingApp(_ id: String) {
        guard let url = URL(string: "\(scheme)://share/\(id)") else { return }
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: Selector(("openURL:"))) {
                current.perform(Selector(("openURL:")), with: url)
                return
            }
            responder = current.next
        }
    }

    private func sanitize(_ name: String) -> String {
        let value = (name as NSString).lastPathComponent
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._ -"))
        return value.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
    }
}

private enum ShareError: LocalizedError {
    case missingAppGroup, unreadable, empty, oversized(String)
    var errorDescription: String? {
        switch self {
        case .missingAppGroup: return "Shared App Group is unavailable"
        case .unreadable: return "An item could not be read"
        case .empty: return "No supported content was shared"
        case .oversized(let name): return "\(name) exceeds the 25 MB limit"
        }
    }
}
