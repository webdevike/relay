// Xcode 27 refuses to build pod targets whose iOS deployment target is below 15.0. Some pods
// (SDWebImage's resource bundle, pulled in by expo-image-manipulator) still declare 9.0, so the
// Podfile's post_install raises every pod target below the floor to the app's own target.
// Delete once those pods declare a supported deployment target.
const { withPodfile } = require("expo/config-plugins");

const MARKER = "# relay: pod deployment floor";
const FLOOR = "15.0";

const SNIPPET = `
    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build|
        current = build.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = podfile_properties['ios.deploymentTarget'] || '${FLOOR}' if current.nil? || current.to_f < ${FLOOR}
      end
    end
`;

module.exports = function withPodDeploymentFloor(config) {
  return withPodfile(config, (podfile) => {
    const contents = podfile.modResults.contents;
    if (contents.includes(MARKER)) return podfile;
    // After react_native_post_install, so nothing it sets is overridden back below the floor.
    const call = contents.indexOf("react_native_post_install(");
    const close = call === -1 ? -1 : contents.indexOf("\n    )\n", call);
    if (close === -1) throw new Error("withPodDeploymentFloor: no react_native_post_install call in the Podfile");
    const insertAt = close + "\n    )\n".length;
    podfile.modResults.contents = contents.slice(0, insertAt) + SNIPPET + contents.slice(insertAt);
    return podfile;
  });
};
