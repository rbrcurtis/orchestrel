import Foundation
import Capacitor

@objc(SharedDraftPlugin)
public class SharedDraftPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SharedDraftPlugin"
    public let jsName = "SharedDraft"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
    ]

    private let appGroup = "group.com.orchestrel.orcchat.ios.share"
    private let decoder = JSONDecoder()

    public override func load() {
        NotificationCenter.default.addObserver(forName: .sharedDraftReceived, object: nil, queue: .main) { [weak self] note in
            guard let id = note.object as? String else { return }
            self?.notifyListeners("sharedDraftReceived", data: ["id": id])
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        do {
            let root = try inboxURL()
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
            var drafts: [[String: Any]] = []
            for url in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) {
                let values = try url.resourceValues(forKeys: [.contentModificationDateKey])
                if let changed = values.contentModificationDate, changed < cutoff {
                    try? FileManager.default.removeItem(at: url)
                    continue
                }
                guard let data = try? Data(contentsOf: url.appendingPathComponent("manifest.json")),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = json["id"] as? String,
                      let createdAt = json["createdAt"] as? String else { continue }
                drafts.append(["id": id, "createdAt": createdAt])
            }
            drafts.sort { ($0["createdAt"] as? String ?? "") < ($1["createdAt"] as? String ?? "") }
            call.resolve(["drafts": drafts])
        } catch { call.reject(error.localizedDescription) }
    }

    @objc func read(_ call: CAPPluginCall) {
        do {
            let entry = try entryURL(call)
            let data = try Data(contentsOf: entry.appendingPathComponent("manifest.json"))
            guard var json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw SharedDraftError.invalidManifest
            }
            let files = (json["files"] as? [[String: Any]] ?? []).map { file -> [String: Any] in
                var result = file
                if let relative = file["relativePath"] as? String,
                   let url = safeURL(entry.appendingPathComponent(relative), inside: entry) {
                    result["url"] = url.absoluteString
                }
                return result
            }
            json["files"] = files
            call.resolve(json)
        } catch { call.reject(error.localizedDescription) }
    }

    @objc func acknowledge(_ call: CAPPluginCall) { remove(call) }
    @objc func discard(_ call: CAPPluginCall) { remove(call) }

    private func remove(_ call: CAPPluginCall) {
        do {
            try FileManager.default.removeItem(at: entryURL(call))
            call.resolve()
        } catch { call.reject(error.localizedDescription) }
    }

    private func inboxURL() throws -> URL {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            throw SharedDraftError.missingAppGroup
        }
        return root.appendingPathComponent("Inbox", isDirectory: true)
    }

    private func entryURL(_ call: CAPPluginCall) throws -> URL {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil else { throw SharedDraftError.invalidID }
        let root = try inboxURL()
        guard let url = safeURL(root.appendingPathComponent(id, isDirectory: true), inside: root) else { throw SharedDraftError.invalidPath }
        return url
    }

    private func safeURL(_ url: URL, inside root: URL) -> URL? {
        let value = url.standardizedFileURL.path
        let prefix = root.standardizedFileURL.path + "/"
        return value.hasPrefix(prefix) ? url.standardizedFileURL : nil
    }
}

extension Notification.Name { static let sharedDraftReceived = Notification.Name("SharedDraftReceived") }
private enum SharedDraftError: LocalizedError {
    case missingAppGroup, invalidID, invalidPath, invalidManifest
    var errorDescription: String? {
        switch self {
        case .missingAppGroup: return "Shared App Group is unavailable"
        case .invalidID: return "Invalid shared draft ID"
        case .invalidPath: return "Shared draft path is invalid"
        case .invalidManifest: return "Shared draft manifest is invalid"
        }
    }
}
