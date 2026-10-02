// iOS 27 SDK refuses to launch apps without the UIScene lifecycle
// (UIKit asserts in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
// Expo only ships scene support from SDK 57 (expo/expo#46664), so this patches the
// SDK 54 prebuild output: scene manifest in Info.plist, a SceneDelegate that owns
// the window and starts React Native, URL opens forwarded to the AppDelegate.
// Delete once the app is on an Expo SDK with built-in scene support.
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const STARTUP_BLOCK =
  /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;
const LINKING_MARKER = "\n  // Linking API";
const RN_DELEGATE_MARKER = "\nclass ReactNativeDelegate: ExpoReactNativeFactoryDelegate";

const SCENE_CONFIGURATION = `
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
`;

const SCENE_DELEGATE = `
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = appDelegate.reactNativeFactory else {
      return
    }

    let sceneWindow = UIWindow(windowScene: windowScene)
    window = sceneWindow
    // React Native internals still read application.delegate.window.
    appDelegate.window = sceneWindow
    factory.startReactNative(withModuleName: "main", in: sceneWindow, launchOptions: nil)

    if !connectionOptions.urlContexts.isEmpty {
      self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let context = URLContexts.first,
      let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }

    var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
    if let sourceApplication = context.options.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = context.options.annotation {
      options[.annotation] = annotation
    }
    _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
  }
}
`;

function patchAppDelegate(contents) {
  if (contents.includes("class SceneDelegate")) return contents;
  if (!STARTUP_BLOCK.test(contents) || !contents.includes(LINKING_MARKER) || !contents.includes(RN_DELEGATE_MARKER)) {
    throw new Error("withSceneLifecycle: AppDelegate.swift no longer matches the Expo SDK 54 template; update the plugin.");
  }
  return contents
    .replace(STARTUP_BLOCK, "")
    .replace(LINKING_MARKER, `${SCENE_CONFIGURATION}${LINKING_MARKER}`)
    .replace(RN_DELEGATE_MARKER, `${SCENE_DELEGATE}${RN_DELEGATE_MARKER}`);
}

module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, (next) => {
    next.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return next;
  });
  return withAppDelegate(config, (next) => {
    if (next.modResults.language !== "swift") {
      throw new Error(`withSceneLifecycle: expected a Swift AppDelegate, got ${next.modResults.language}.`);
    }
    next.modResults.contents = patchAppDelegate(next.modResults.contents);
    return next;
  });
};
