const preset = require('jest-expo/jest-preset');

module.exports = {
  ...preset,
  // 追加全局 setup（不能直接覆盖 preset 的 setupFiles，否则 React Native 的 jest 环境会丢）
  setupFiles: [...(preset.setupFiles ?? []), '<rootDir>/jest.setup.js'],
};
