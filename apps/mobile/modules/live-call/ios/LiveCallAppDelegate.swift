// App lifecycle hooks of live calls (registered in expo-module.config.json): at launch, before any
// call can start, end every live call Live Activity a killed app left on the lock screen; when the
// app terminates mid-call, end the call and its Live Activity before the process goes.

import ExpoModulesCore
import UIKit

public class LiveCallAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    MainActor.assumeIsolated {
      LiveCallEngine.shared.sweepOrphanedActivities()
    }
    return true
  }

  public func applicationWillTerminate(_ application: UIApplication) {
    MainActor.assumeIsolated {
      LiveCallEngine.shared.terminate()
    }
  }
}
