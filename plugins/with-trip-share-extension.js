const { withXcodeProject } = require('@expo/config-plugins');
const withShareIntent = require('expo-share-intent/app.plugin');
const fs = require('fs');
const path = require('path');

module.exports = function withTripShareExtension(config) {
  config = withShareIntent(config, {
    iosActivationRules: { NSExtensionActivationSupportsImageWithMaxCount: 1000 },
    disableAndroid: true,
  });
  return withXcodeProject(config, (config) => {
    const root = config.modRequest.platformProjectRoot;
    const source = fs.readFileSync(path.join(__dirname, 'TripShareViewController.swift'), 'utf8')
      .replaceAll('<GROUPIDENTIFIER>', `group.${config.ios.bundleIdentifier}`)
      .replaceAll('<SCHEME>', config.scheme);
    fs.writeFileSync(path.join(root, 'ShareExtension', 'ShareViewController.swift'), source);
    // Only the target name is ShareExtension; Photos shows the app's name.
    const plist = require('@expo/plist').default;
    const infoPath = path.join(root, 'ShareExtension', 'ShareExtension-Info.plist');
    const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
    info.CFBundleDisplayName = config.name;
    fs.writeFileSync(infoPath, plist.build(info));
    const settings = config.modResults.pbxXCBuildConfigurationSection();
    for (const entry of Object.values(settings)) {
      const bs = entry?.buildSettings;
      if (bs?.PRODUCT_NAME === '"ShareExtension"') {
        bs.IPHONEOS_DEPLOYMENT_TARGET = '15.1';
        bs.CURRENT_PROJECT_VERSION = `"${config.ios.buildNumber}"`;
        bs.MARKETING_VERSION = `"${config.version}"`;
      }
    }
    return config;
  });
};
