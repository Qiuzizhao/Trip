const { withAppBuildGradle } = require('@expo/config-plugins');

// Keep release credentials outside the checkout and preserve signing across prebuilds.
module.exports = function withAndroidSigning(config) {
  return withAppBuildGradle(config, (config) => {
    const marker = '// Trip Android release signing';
    if (config.modResults.contents.includes(marker)) return config;
    config.modResults.contents = config.modResults.contents.replace(
      'android {',
      `${marker}
def tripSigningFile = new File(System.getProperty("user.home"), ".config/trip/android-signing.properties")
def tripSigning = new Properties()
if (tripSigningFile.exists()) {
    tripSigningFile.withInputStream { tripSigning.load(it) }
}
if (gradle.startParameter.taskNames.any { it.toLowerCase().contains("release") } &&
    !["storeFile", "storePassword", "keyAlias", "keyPassword"].every { tripSigning.getProperty(it) }) {
    throw new GradleException("Missing Trip release signing: " + tripSigningFile)
}

android {`
    ).replace(
      'signingConfigs {',
      `signingConfigs {
        release {
            if (tripSigning.getProperty("storeFile")) {
                storeFile file(tripSigning.getProperty("storeFile"))
                storePassword tripSigning.getProperty("storePassword")
                keyAlias tripSigning.getProperty("keyAlias")
                keyPassword tripSigning.getProperty("keyPassword")
            }
        }`
    ).replace(/(release\s*\{\s*\/\/ Caution:[\s\S]*?)signingConfig signingConfigs.debug/, '$1signingConfig signingConfigs.release');
    return config;
  });
};
