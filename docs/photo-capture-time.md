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

## 新建足迹页：把拍摄时间做成可点选的气泡

拍照后手动敲日期很容易填错，所以「记录新足迹」页在**日期下方**列出这次所选照片拍摄的日期：

```
日期            [ 2026-09-05 ]
照片拍摄日期     (2026年9月5日)  (2026年9月6日)
```

点一下气泡就把 `visit_date` 填成那天的 `YYYY-MM-DD`；当前日期与某个气泡同一天时该气泡高亮。

规则（`takenAtOptions()`，与 UI 拆开、可单测）：

- 选完照片就异步读一次 EXIF，**只读本地文件**（`file://`）。编辑模式下图片可能只有远端 URL，
  不为读元数据把原图整张下载下来——那种情况等图片下载到本地后再读。
- 读不到时间的照片直接跳过；**按日期去重**——同一天拍的照片（哪怕跨了好几个小时）只出现一个气泡，
  取当天最早的一张作为排序依据；结果按日期先后排序。
- 只填日期：`visit_date` 是日期字段（列表、相册、同步都用它），照片的时分不进入记录，气泡也只显示到日期，
  避免同一天多张照片时误导性地只显示其中某个时间。
- 已经读过（哪怕是读失败）的 uri 会记成 `null`，不会反复读同一个文件。
- 读失败、全部读不到时，这一块整块不渲染，不留空位。

相关实现：`FootprintEditorScreen.tsx` 的 `takenAtByUri` 状态 + `readTakenAtFromFile()`；
日期换算用 `dateStringFromTakenAt()`，刻意不用 `toISOString()`——那是 UTC，东八区凌晨的照片会掉到前一天。

## 验证

- 单元测试 `src/features/daily/footprints/__tests__/imageMetadata.test.ts`：12 条，含
  **手工构造的真实 EXIF JPEG 字节**（IFD0 `DateTime`）→ 时间戳，验证的是解析链路而不是正则。
- 气泡候选（`takenAtOptions`）单测覆盖：按日期排序、同一天去重、跨天排列、跳过读不到时间的照片。
- 用账号里两张真实 HDR HEIC 跑解析链路：EXIF `17:56:07` / `17:56:02`（`+08:00`）
  → 都收敛成同一个气泡「2026年9月5日」，填入日期 `2026-09-05`（按日期去重生效）。
- 模拟器（iPhone 18 Pro / iOS 27）实测：
  - 桔钓沙两张 HDR HEIC → 顶部显示 `2026年9月5日 17:56`（EXIF 实际 `17:56:02` / `17:56:07`）；
  - 换一张 2018 年的 HEIC → 显示 `2018年3月30日 12:14`，证明是**每张图各自的 EXIF**；
  - asset 记录里已写入 `takenAt: 1788602162000 / 1788602167000`（缓存生效）。
- `npx tsc --noEmit` 0 错误；`npx jest` 61 通过 / 2 跳过。

> 注意：这台机器的 Metro **没有可靠监听 `/Volumes/Data` 下的文件改动**，改完代码要让模拟器看到效果，
> 需要重启 Metro（`--clear`）并重新启动 App；靠 Fast Refresh 会看到旧界面。
