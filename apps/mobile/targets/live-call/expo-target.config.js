// The live call's Live Activity (lock screen banner, Dynamic Island). LiveCallAttributes.swift is a
// symlink to modules/live-call/ios/LiveCallAttributes.swift: the app and this extension must
// compile the same ActivityAttributes type. _shared/ is linked into the app target too.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = () => ({
  type: "widget",
  name: "LiveCallActivity",
  displayName: "Relay Live Call",
  bundleIdentifier: ".livecall",
  deploymentTarget: "18.0",
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit", "AppIntents"],
});
