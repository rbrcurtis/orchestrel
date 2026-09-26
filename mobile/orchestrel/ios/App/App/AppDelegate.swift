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

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        startMemoryReporting()

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
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        pushMemorySample(event: "fg")
    }

    func applicationDidReceiveMemoryWarning(_ application: UIApplication) {
        memoryWarnings += 1
        pushMemorySample(event: "warn")
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

        memoryTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.pushMemorySample()
        }
        pushMemorySample()
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
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.stride / MemoryLayout<integer_t>.stride)
        let result = withUnsafeMutablePointer(to: &stats) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, rebound, &count)
            }
        }
        guard result == KERN_SUCCESS else {
            return 0
        }

        let pages = Int64(stats.free_count) + Int64(stats.inactive_count) + Int64(stats.speculative_count)
        return Int(pages * Int64(getpagesize()))
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
