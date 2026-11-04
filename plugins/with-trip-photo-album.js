const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withTripPhotoAlbum(config) {
  return withAndroidManifest(config, (config) => {
    // Earlier picker-only builds blocked these. Remove stale merge rules on upgrade;
    // the local module declares read permissions and caps legacy write access at API 28.
    const media = new Set([
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
    ]);
    const blocked = new Set(config.android?.blockedPermissions || []);
    config.modResults.manifest['uses-permission'] = config.modResults.manifest['uses-permission']?.filter((entry) =>
      !(media.has(entry.$['android:name']) && entry.$['tools:node'] === 'remove' && !blocked.has(entry.$['android:name'])));
    return config;
  });
};
