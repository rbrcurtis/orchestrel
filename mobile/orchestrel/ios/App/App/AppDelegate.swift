import UIKit
import Capacitor
import WebKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var didRestoreLastURL = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
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
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        restoreLastURL()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        saveCurrentURL()
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        if url.scheme == "orchestrel", url.host == "share", let id = url.pathComponents.last, UUID(uuidString: id) != nil {
            currentWebView()?.load(URLRequest(url: defaultURL))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NotificationCenter.default.post(name: .sharedDraftReceived, object: id)
            }
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
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
        URL(string: "https://cecil.orchestrel.com/")!
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

    func isRestorableURL(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "cecil.orchestrel.com"
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
