# 预览里显示照片的拍摄时间

## 需求

打开大图预览时，显示**这张照片自己的拍摄时间**（不是足迹记录的「到达日期」）。
位置参考系统「照片」：顶部中间，计数（`1 / 3`）下面一行，白字 + 阴影。

## 数据来源：读 EXIF，不存副本

拍摄时间来自图片文件本身的 EXIF `DateTimeOriginal`（带 `OffsetTimeOriginal` 时区偏移，如 `+08:00`）。
不新增数据库列去存业务日期，也不改服务端。

解析库选了 [`exifreader`](https://github.com/mattiasw/ExifReader)（MPL-2.0，零运行时依赖）：

| 候选 | 结论 |
| --- | --- |
| `exifreader` | ✅ 实测能解析 iPhone 的 **HDR HEIC**（ftyp brand `heic/mif1/MiHB/MiHA`）与普通 JPEG/PNG/HEIF |
| `exifr` | ❌ 同一批 HDR HEIC 直接报 `Unknown file format`（已从依赖里移除） |
| 自写 TIFF/ISOBMFF 解析 | ❌ HEIC 的 EXIF 藏在 `meta`→`iinf/iloc` 里，自己写等于重造轮子 |

读取顺序（`src/features/daily/footprints/imageMetadata.ts`）：

1. `DateTimeOriginal`（+ `OffsetTimeOriginal`）
2. `DateTimeDigitized`（+ `OffsetTimeDigitized`）
3. IFD0 `DateTime`

读文件用 `expo-file-system` 的 `File.arrayBuffer()`（原生读，稳定），失败再退回 `fetch(file://)`。
**只读本地文件**：远端图没有下载到本地时不发额外请求，等下载完自然就有了。

## 性能：读一次，缓存一次

`assetRepository` 的 asset 记录里有 `takenAt`（毫秒）。打开相册时 `resolveFootprintImages()` 会：

1. 先用记录里缓存的 `takenAt`；
2. 没有就**只对本地文件**读一次 EXIF，然后 `setAssetTakenAt()` 写回记录（下次直接命中）。

列表页（`FootprintScreen`）仍然用 `resolveFootprintImageUris()`，不读 EXIF，避免一次刷新解析几十张原图。
预览弹窗自己兜底：当前这张如果还没有 `takenAt`，会在切到它时读一次（仅 `file://`）。

## Metro 补丁（必须保留）

`exifreader` 的 `main` 是 webpack UMD 产物 `dist/exif-reader.js`，里面保留了 Node 专用分支
`require('https') / require('http') / require('fs')`（只有「把文件路径交给 ExifReader」才会执行，
我们传的是 ArrayBuffer，运行时永远走不到）。Metro 是静态解析依赖，打包时直接失败：

```
Unable to resolve module https from node_modules/exifreader/dist/exif-reader.js
```

所以根目录加了 `metro.config.js`，把这些 Node 内置模块解析成空模块：

```js
const NODE_ONLY_MODULES = new Set(['fs', 'http', 'https', 'node:fs', 'node:http', 'node:https']);
config.resolver.resolveRequest = (context, moduleName, platform) =>
  NODE_ONLY_MODULES.has(moduleName)
    ? { type: 'empty' }
    : context.resolveRequest(context, moduleName, platform);
```

**删掉这个文件就会打包失败**，请勿移除。

## UI

- 位置：顶部中间，`1 / 3` 计数下面一行；只有一张图时只显示时间。
- 格式：`2026年9月5日 17:56`（`formatTakenAt()`）。
- 读不到 EXIF 就不显示这一行（不留空位、不显示「未知」）。
- 切换图片时时间跟着当前这张变（和计数用的是同一个 `index` 状态）。

## 验证

- 单元测试 `src/features/daily/footprints/__tests__/imageMetadata.test.ts`：8 条，含
  **手工构造的真实 EXIF JPEG 字节**（IFD0 `DateTime`）→ 时间戳，验证的是解析链路而不是正则。
- 模拟器（iPhone 18 Pro / iOS 27）实测：
  - 桔钓沙两张 HDR HEIC → 顶部显示 `2026年9月5日 17:56`（EXIF 实际 `17:56:02` / `17:56:07`）；
  - 换一张 2018 年的 HEIC → 显示 `2018年3月30日 12:14`，证明是**每张图各自的 EXIF**；
  - asset 记录里已写入 `takenAt: 1788602162000 / 1788602167000`（缓存生效）。
- `npx tsc --noEmit` 0 错误；`npx jest` 52 通过 / 2 跳过。

> 注意：这台机器的 Metro **没有可靠监听 `/Volumes/Data` 下的文件改动**，改完代码要让模拟器看到效果，
> 需要重启 Metro（`--clear`）并重新启动 App；靠 Fast Refresh 会看到旧界面。
