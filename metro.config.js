// Expo 默认 Metro 配置 + 一处必要补丁。
//
// 背景：读取照片拍摄时间用的 exifreader，package.json 的 `main` 指向 dist/exif-reader.js
// （webpack UMD 打包产物），里面保留了 Node 专用分支：
//   require('https') / require('http') / require('fs')
// 这些分支只在「把文件路径交给 ExifReader」时才会执行，我们传的是 ArrayBuffer，运行时永远不会走到。
// 但 Metro 是静态解析依赖，打包时就会尝试解析这些模块，直接报 `Unable to resolve module https`。
// 所以这里把 Node 内置模块解析成空模块（只有 exifreader 这类库会 require 它们）。
const { getDefaultConfig } = require('expo/metro-config');

const NODE_ONLY_MODULES = new Set(['fs', 'http', 'https', 'node:fs', 'node:http', 'node:https']);

const config = getDefaultConfig(__dirname);

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (NODE_ONLY_MODULES.has(moduleName)) {
    return { type: 'empty' };
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
