// Live call App Intents ("Talk to Nova", "Talk to Astra") belong to the app target itself: the App
// Intents metadata extraction only reads the app's own sources, and the Action Button and
// Shortcuts list what that metadata declares. This copies `plugins/intents/*.swift` into the
// generated `ios/<App>/` folder, adds them to the app target's Sources, and defines RELAY_APP for
// the app target's Swift, which the files shared with the Live Activity extension
// (targets/live-call/_shared) use to call the LiveCall engine only where it is linked.
const fs = require("fs");
const path = require("path");
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const SOURCE_DIR = path.join(__dirname, "intents");
const FLAG = "-D RELAY_APP";

function intentFiles() {
  return fs
    .readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".swift"))
    .sort();
}

module.exports = function withLiveCallIntents(config) {
  config = withDangerousMod(config, [
    "ios",
    (next) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(next.modRequest.projectRoot);
      const target = path.join(next.modRequest.platformProjectRoot, projectName);
      for (const name of intentFiles()) fs.copyFileSync(path.join(SOURCE_DIR, name), path.join(target, name));
      return next;
    },
  ]);
  return withXcodeProject(config, (next) => {
    const project = next.modResults;
    const projectName = IOSConfig.XcodeUtils.getProjectName(next.modRequest.projectRoot);
    const app = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
    for (const name of intentFiles()) {
      const filepath = `${projectName}/${name}`;
      if (project.hasFile(filepath)) continue;
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: projectName, project, targetUuid: app.uuid });
    }
    for (const [, build] of IOSConfig.XcodeUtils.getBuildConfigurationsForListId(project, app.target.buildConfigurationList)) {
      const flags = String(build.buildSettings.OTHER_SWIFT_FLAGS ?? '"$(inherited)"').replace(/^"|"$/g, "");
      if (!flags.includes(FLAG)) build.buildSettings.OTHER_SWIFT_FLAGS = `"${flags} ${FLAG}"`;
    }
    return next;
  });
};
