// Relay Host: menu-bar wrapper that runs the bundled `relay-host` daemon and updates itself
// from the latest GitHub release of webdevike/relay (asset RelayHost.zip).
import AppKit
import ServiceManagement

let repo = "webdevike/relay"
let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/RelayHost.log")

/// `~/.config/relay/host.json` (`$XDG_CONFIG_HOME/relay/host.json`), written by the Relay setup wizard:
/// `{"agentHome": string, "name": string, "port": number, ...}`. Empty when absent or unreadable, so
/// every setting falls back to the original logic.
func readHostConfig() -> [String: Any] {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let base = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"] ?? "\(home)/.config"
  guard let data = FileManager.default.contents(atPath: "\(base)/relay/host.json"),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
  return json
}
final class App: NSObject, NSApplicationDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  let status = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
  let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
  var process: Process?
  var quitting = false

  func applicationDidFinishLaunching(_: Notification) {
    item.button?.title = "⌁"
    let menu = NSMenu()
    menu.addItem(status)
    menu.addItem(NSMenuItem(title: "Version \(appVersion)", action: nil, keyEquivalent: ""))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Show Log", action: #selector(showLog), keyEquivalent: "l"))
    menu.addItem(NSMenuItem(title: "Check for Updates", action: #selector(checkUpdates), keyEquivalent: "u"))
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(login)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
    menu.items.forEach { $0.target = self }
    item.menu = menu
    if SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register(); login.state = .on }
    start()
    checkUpdates()
    Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.checkUpdates() }
  }

  func start() {
    let p = Process()
    p.executableURL = Bundle.main.url(forAuxiliaryExecutable: "relay-host")
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let config = readHostConfig()
    // host.json first; without it: ~/Eva when it exists, else the home folder.
    let configuredHome = (config["agentHome"] as? String).map { ($0 as NSString).expandingTildeInPath }
    let agentHome = configuredHome ?? (FileManager.default.fileExists(atPath: "\(home)/Eva") ? "\(home)/Eva" : home)
    let port = (config["port"] as? Int) ?? 7817
    let name = (config["name"] as? String) ?? Host.current().localizedName ?? "Mac"
    let boards = "\(home)/Library/Application Support/Relay/boards"
    p.arguments = ["serve", "--port", "\(port)", "--name", name, "--agent-home", agentHome, "--no-clipboard", "--boards", boards]
    // A login item starts with a bare PATH: give relay-host the dirs omp, herdr and bun are installed in.
    var env = ProcessInfo.processInfo.environment
    let toolDirs = ["\(home)/.local/bin", "\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    var parts = (env["PATH"] ?? "").split(separator: ":").map(String.init)
    for dir in toolDirs where !parts.contains(dir) { parts.append(dir) }
    env["PATH"] = parts.joined(separator: ":")
    p.environment = env
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    let log = try? FileHandle(forWritingTo: logURL)
    log?.seekToEndOfFile()
    p.standardOutput = log
    p.standardError = log
    p.terminationHandler = { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, !self.quitting else { return }
        self.status.title = "Restarting…"
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.start() }
      }
    }
    do { try p.run(); process = p; status.title = "Running on port \(port)" } catch { status.title = "Failed: \(error.localizedDescription)" }
  }

  @objc func showLog() { NSWorkspace.shared.open(logURL) }

  @objc func toggleLogin() {
    if SMAppService.mainApp.status == .enabled { try? SMAppService.mainApp.unregister(); login.state = .off }
    else { try? SMAppService.mainApp.register(); login.state = .on }
  }

  @objc func quit() { quitting = true; process?.terminate(); NSApp.terminate(nil) }

  /// Latest release tag `vX.Y.Z` newer than ours → download RelayHost.zip, swap the bundle, relaunch.
  @objc func checkUpdates() {
    let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!
    URLSession.shared.dataTask(with: url) { data, _, _ in
      guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let tag = (json["tag_name"] as? String)?.replacingOccurrences(of: "host-v", with: ""),
            tag.compare(appVersion, options: .numeric) == .orderedDescending,
            let assets = json["assets"] as? [[String: Any]],
            let asset = assets.first(where: { ($0["name"] as? String) == "RelayHost.zip" }),
            let link = (asset["browser_download_url"] as? String).flatMap(URL.init) else { return }
      URLSession.shared.downloadTask(with: link) { file, _, _ in
        guard let file else { return }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("relayhost-\(tag)")
        try? FileManager.default.removeItem(at: dir)
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        unzip.arguments = ["-xk", file.path, dir.path]
        try? unzip.run(); unzip.waitUntilExit()
        let new = dir.appendingPathComponent("Relay Host.app")
        guard unzip.terminationStatus == 0, FileManager.default.fileExists(atPath: new.path) else { return }
        let target = Bundle.main.bundlePath
        // Swap after we exit so the running binary is never overwritten in place.
        let script = "sleep 1; rm -rf \"\(target)\"; mv \"\(new.path)\" \"\(target)\"; open \"\(target)\""
        let swap = Process()
        swap.executableURL = URL(fileURLWithPath: "/bin/sh")
        swap.arguments = ["-c", script]
        try? swap.run()
        DispatchQueue.main.async { self.quit() }
      }.resume()
    }.resume()
  }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
