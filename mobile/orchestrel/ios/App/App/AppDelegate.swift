import UIKit
import Capacitor
import WebKit
import os

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var didRestoreLastURL = false
    private var memoryTimer: Timer?
    private var memoryWarnings = 0
    private let launchedAt = Date()
    private var pressureSource: DispatchSourceMemoryPressure?
    private let nativeLogQueue = DispatchQueue(label: "orchestrel.native-log")
    private let reportURL = URL(string: "https://orchestrel.com/api/pwa-log")!
    private var lastReportStatus = 0

    /// The page's session lives in the WebView, whose cookie store is separate from
    /// URLSession's. Cloudflare Access answers a request without it by redirecting to
    /// the login page, so the report never reaches the log line.
    private lazy var reportSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.httpShouldSetCookies = true
        return URLSession(configuration: config)
    }()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        startMemoryReporting()
        startPressureReporting()

        DispatchQueue.main.async {
            self.restoreLastURL()
        }

        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        saveCurrentURL()
        pushMemorySample(event: "bg")
        pushNativeSample(event: "bg")
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        pushMemorySample(event: "fg")
        pushNativeSample(event: "fg")
    }

    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        memoryWarnings += 1
        pushMemorySample(event: "warn")
        pushNativeSample(event: "warn")
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        restoreLastURL()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        saveCurrentURL()
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

private extension AppDelegate {
    var defaultURL: URL {
        URL(string: "https://orchestrel.com/")!
    }

    var lastURLDefaultsKey: String {
        "LastOrchestrelURL"
    }

    func currentWebView() -> WKWebView? {
        guard let bridgeViewController = window?.rootViewController as? CAPBridgeViewController else {
            return nil
        }

        return bridgeViewController.webView
    }

    /// WKWebView never exposes a JS heap number, so the only memory figure the
    /// phone can give us comes from the OS. Push it into the page on a timer and
    /// the web app adds it to the line it posts to /api/pwa-log. A local
    /// Capacitor plugin needs its class name in the generated
    /// capacitor.config.json, which `cap sync` rewrites, so the value rides the
    /// WebView instead.
    func startMemoryReporting() {
        guard memoryTimer == nil else {
            return
        }

        syncCookiesFromWebView()
        memoryTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.syncCookiesFromWebView()
            self?.pushMemorySample()
            self?.pushNativeSample()
        }
        pushMemorySample()
        pushNativeSample()
    }

    func syncCookiesFromWebView() {
        guard let webView = currentWebView() else {
            return
        }

        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            for cookie in cookies {
                HTTPCookieStorage.shared.setCookie(cookie)
            }
        }
    }

    /// Memory pressure is the earliest warning the OS gives before it reclaims a
    /// content process, and the WebView cannot record it, because the process that
    /// dies is the one that would have to do the recording.
    func startPressureReporting() {
        guard pressureSource == nil else {
            return
        }

        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            let critical = self.pressureSource?.data.contains(.critical) ?? false
            self.pushNativeSample(event: critical ? "pressure-critical" : "pressure-warning")
        }
        source.resume()
        pressureSource = source
    }

    /// The black box for a WebView kill. The samples go straight to the server
    /// instead of through the page, and every sample is also appended to a ring
    /// file, so a sample survives a failed send and can be pulled off the device.
    func pushNativeSample(event: String? = nil) {
        let line = nativeMemoryLine(event: event)
        let stamp = ISO8601DateFormatter().string(from: Date())
        nativeLogQueue.async {
            self.appendToNativeLog("[\(stamp)] \(line)")
        }
        guard let body = try? JSONSerialization.data(withJSONObject: ["msg": line, "ts": stamp]) else {
            return
        }
        var request = URLRequest(url: reportURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 10
        reportSession.dataTask(with: request) { [weak self] _, response, _ in
            if let code = (response as? HTTPURLResponse)?.statusCode {
                self?.lastReportStatus = code
            }
        }.resume()
    }

    func nativeMemoryLine(event: String? = nil) -> String {
        let stats = vmStatistics()
        var line = "mem-native up=\(Int(Date().timeIntervalSince(launchedAt)))s"
        line += " avail=\(os_proc_available_memory() / 1048576)MB"
        line += " total=\(ProcessInfo.processInfo.physicalMemory / 1048576)MB"
        line += " free=\(megabytes(stats.free_count + stats.inactive_count + stats.speculative_count))MB"
        line += " active=\(megabytes(stats.active_count))MB"
        line += " inactive=\(megabytes(stats.inactive_count))MB"
        line += " wired=\(megabytes(stats.wire_count))MB"
        line += " compressed=\(megabytes(stats.compressor_page_count))MB"
        line += " warn=\(memoryWarnings)"
        line += " posted=\(lastReportStatus)"
        line += " thermal=\(ProcessInfo.processInfo.thermalState.rawValue)"
        if let event = event {
            line += " event=\(event)"
        }
        return line
    }

    func megabytes(_ pages: natural_t) -> Int {
        Int(pages) * Int(getpagesize()) / 1048576
    }

    func nativeLogPath() -> String {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documents.appendingPathComponent("orchestrel-native.log").path
    }

    func appendToNativeLog(_ line: String) {
        let path = nativeLogPath()
        var lines = (try? String(contentsOfFile: path, encoding: .utf8))?.split(separator: "\n").map(String.init) ?? []
        lines.append(line)
        if lines.count > 1000 {
            lines.removeFirst(lines.count - 1000)
        }
        try? (lines.joined(separator: "\n") + "\n").write(toFile: path, atomically: true, encoding: .utf8)
    }

    /// The payload also answers three questions the JS side cannot: how long the
    /// app has run (a WebView reload after a content-process kill is told apart
    /// from a cold launch), how much device memory is free (a content process can
    /// be reclaimed when the whole device runs short, while this app's own budget
    /// still looks healthy), and whether the OS sent memory warnings.
    func pushMemorySample(event: String? = nil) {
        guard let webView = currentWebView() else {
            return
        }

        var payload = "{available:\(os_proc_available_memory())"
        payload += ",total:\(ProcessInfo.processInfo.physicalMemory)"
        payload += ",up:\(Int(Date().timeIntervalSince(launchedAt)))"
        payload += ",warn:\(memoryWarnings)"
        payload += ",sysFree:\(systemFreeBytes())"
        if let event = event {
            payload += ",event:'\(event)'"
        }
        payload += "}"

        webView.evaluateJavaScript("window.__iosMemory && window.__iosMemory(\(payload))", completionHandler: nil)
    }

    /// Device-wide free memory. os_proc_available_memory() only reports what this
    /// app may still allocate, which is not what the system looks at when it
    /// reclaims a WebView content process.
    func systemFreeBytes() -> Int {
        let stats = vmStatistics()
        let pages = Int64(stats.free_count) + Int64(stats.inactive_count) + Int64(stats.speculative_count)
        return Int(pages * Int64(getpagesize()))
    }

    func vmStatistics() -> vm_statistics64 {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.stride / MemoryLayout<integer_t>.stride)
        let result = withUnsafeMutablePointer(to: &stats) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, rebound, &count)
            }
        }
        if result != KERN_SUCCESS {
            return vm_statistics64()
        }
        return stats
    }

    func isRestorableURL(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "orchestrel.com"
    }

    func saveCurrentURL() {
        guard let url = currentWebView()?.url, isRestorableURL(url) else {
            return
        }

        UserDefaults.standard.set(url.absoluteString, forKey: lastURLDefaultsKey)
    }

    func restoreLastURL(retryCount: Int = 0) {
        guard !didRestoreLastURL else {
            return
        }

        guard let webView = currentWebView() else {
            if retryCount < 20 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self.restoreLastURL(retryCount: retryCount + 1)
                }
            }

            return
        }

        didRestoreLastURL = true

        guard let storedURLString = UserDefaults.standard.string(forKey: lastURLDefaultsKey),
              let storedURL = URL(string: storedURLString),
              isRestorableURL(storedURL),
              storedURL.absoluteString != defaultURL.absoluteString else {
            return
        }

        webView.load(URLRequest(url: storedURL))
    }
}
