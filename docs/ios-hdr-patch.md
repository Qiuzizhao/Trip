# iOS 照片 HDR（XDR）显示说明

> 目标：App 里看 iPhone 拍的 HDR 照片（HEIC + ISO gain map）时，高光要像系统「照片」那样跳出 SDR 白，
> 而不是整张图曝光看起来"均衡"。
>
> 结论：图和数据链路本来就 HDR-ready，**改动全在显示层**，通过 `patch-package` 固化在
> `patches/expo-image+3.0.11.patch` 加一处 JS 开关实现，随 1.0.7 起生效。

## 0. 先理解"为什么不够亮"

一张 SDR 图的白就是屏幕的白；HDR 图额外带一层 **gain map**（增益图），告诉系统"这些高光还能再亮多少"。
这个余量叫 **headroom**：

- `headroom = 1.0` → 没有余量，就是 SDR；
- `headroom = 2.30` → 高光最多可以亮到 SDR 白的 2.3 倍。

所以"HDR 不惊艳"通常不是图的问题，而是链路里某一环把图**解码成 / 重绘成 SDR**，headroom 被抹平成 1.0 ——
表现就是整张图亮度均匀、没有高光层次。

## 1. 三层链路现状

| 层 | 状态 | 位置 |
| --- | --- | --- |
| 采集 | ✅ 保留原图 | `FootprintEditorScreen.tsx` 用 `preferredAssetRepresentationMode: Current`，iOS 不会把 HDR HEIC 转成 SDR JPEG |
| 传输 / 存储 | ✅ 字节级原样 | 全程 copy + 二进制上传，无重编码；`src/sync/mimeTypes.ts` 映射 `.heic → image/heic`；gain map 随文件一起保存 |
| 显示 | ✅ 已修（本文档） | `expo-image@3.0.11` 原生不带 HDR 能力，靠补丁 + JS 开关补上 |

## 2. 渲染链路：为什么必须改原生

图片从文件到屏幕一共四步，每步都可能把 HDR 丢掉：

1. **解码**：ImageIO 默认 `DecodeToSDR`，会把 gain map 合成成 8-bit SDR。
   需要 `kCGImageSourceDecodeRequest = DecodeToHDR` 才是 10-bit + `headroom 2.30`。
2. **expo-image 的 context 构造**：屏幕上渲染图片走的是 `ImageView.swift` 自己构造的
   `createSDWebImageContext(...)` + `imageManager.loadImage(...)`，**不经过 `ImageLoader.swift`**。
   ⚠️ 踩过的坑：只改 `ImageLoader` 时，`Image.loadAsync` 拿到的是 HDR，但界面显示的仍然一模一样是 SDR。
3. **降采样重绘**：照片（5712×4284）比视图（1179×2556 px）大，命中 `ImageView.processImage` → `ImageUtils.resize()`，
   里面用 `UIGraphicsImageRenderer` 重画一遍。**没显式要扩展色域的重绘会把 HDR 压回 SDR**（实测见第 4 节）。
4. **上屏**：`UIImageView.preferredImageDynamicRange` 默认 `.standard`，必须设成 `.high` 才允许 EDR 输出（iOS 17+）。

## 3. 改动清单

| 文件 | 改动 |
| --- | --- |
| `patches/expo-image+3.0.11.patch` | 三处原生改动（见 3.1–3.3） |
| `src/features/daily/footprints/FootprintImagePreviewModal.tsx` | 预览大图加 `enforceEarlyResizing`（见 3.4） |
| `package.json` | devDependency `patch-package@^8.0.1` + `"postinstall": "patch-package"` |

不需要改 `ios/` 工程文件：Pod 本来就指向 `../node_modules/expo-image/ios`（`ios/Podfile.lock` 里
`ExpoImage (from ../node_modules/expo-image/ios)`），所以重新 archive 就会编译补丁后的源码。

### 3.1 解码时保留 HDR（`ImageUtils.swift`）

`createSDWebImageContext` 是 `ImageView`（上屏路径）与 `ImageLoader`（数据路径）共用的构造点，改这里两处都受益：

```swift
if #available(iOS 17.0, *) {
  context[.imageDecodeToHDR] = true
}
```

底层 `SDWebImage 5.21.7` 支持这条链路：`SDWebImageContextImageDecodeToHDR` → `SDImageCoderDecodeToHDR`
→ `SDImageIOCoder` 传给 ImageIO。`SDImageHDRType` 覆盖 `ISOHDR`（10bit+）与 `ISOGainMap`
（HEIC / AVIF / JPEG-XL / JPEG 的 gain map）。

### 3.2 重绘时保留扩展色域（`ImageUtils.swift`）

```swift
func resize(image: UIImage, toSize size: CGSize, scale: Double) -> UIImage {
  let format = UIGraphicsImageRendererFormat()
  format.scale = scale
  // Trip HDR patch: 重绘必须显式要扩展色域，否则 HDR 位图会被压回 SDR（高光塌成一片白）。
  if #available(iOS 17.0, *) {
    format.preferredRange = .extended
  }
  return UIGraphicsImageRenderer(size: size, format: format).image { _ in
    image.draw(in: CGRect(origin: .zero, size: size))
  }
}
```

`UIGraphicsImageRendererFormat()` 是**手动构造**的默认格式，`preferredRange` 是 `.automatic`
（Apple 文档：按内容色域自动选像素格式）。XDR 真机上它原则上会选扩展色域，但这条路径没法在 Mac 上验证，
所以显式写成 `.extended`，给所有仍会降采样的地方兜底。

### 3.3 允许 EDR 上屏（`ImageView.swift`）

```swift
let sdImageView: SDAnimatedImageView = {
  let view = SDAnimatedImageView(frame: .zero)
  if #available(iOS 17.0, *) {
    view.preferredImageDynamicRange = .high
  }
  return view
}()
```

### 3.4 预览大图改走 ImageIO 解码（JS 侧）

`FootprintImagePreviewModal.tsx` 里的预览 `ExpoImage` 加了：

```tsx
enforceEarlyResizing
```

效果：解码时就按视图尺寸出图（`context[.imageThumbnailPixelSize]` → ImageIO `CGImageSourceCreateThumbnailAtIndex`，
该路径会把 `DecodeToHDR` 一起传下去），于是**跳过第 2 节第 3 步的 UIKit 重绘**，HDR 稳定保住，内存也更省。

顺带说明：解码尺寸 = 视图尺寸，放大到 100% 以上是插值放大 —— 这与改动前 `resize()` 产出的位图尺寸一致，
所以**放大画质没有退化**。

## 4. 实测数据

用账号里真实的 iPhone HDR 原图（`5712×4284` HEIC）跑 `scripts/hdr-headroom-check.swift`：

```
源文件             : Headroom=2.301952
SDR 解码          : 5712x4284 bpc=8  headroom=1.0000 space=kCGColorSpaceDisplayP3
HDR 解码          : 5712x4284 bpc=10 headroom=2.3020 space=nil
ImageIO 缩略图解码  : 1179x884  bpc=10 headroom=2.3020 space=nil
8bit sRGB 重绘      : 1179x884  bpc=8  headroom=1.0000 space=kCGColorSpaceSRGB
```

逐条读法：

- 老构建走的是第一行「SDR 解码」→ headroom 1.0，所以界面怎么调都是 SDR；
- 3.1 修好解码后是 10-bit / headroom 2.30；
- 3.4 走的 ImageIO 缩略图路径**同样保住 2.30**；
- 最后一行说明**任何落到标准色域的重绘都会把 HDR 抹平**，这就是 3.2 存在的原因。

复跑方式（macOS 侧，不需要真机）：

```bash
xcrun swift scripts/hdr-headroom-check.swift /path/to/photo.heic
```

## 5. 生效条件与限制

- **仅 iOS 17+ 生效**：补丁里都有 `#available` 保护，低版本行为与改动前一致。
- **只有真机能看出效果**：模拟器没有 XDR 屏，模拟器与 Device Hub 截图都会把 HDR tone-map 成 SDR。
  同理，模拟器里读到的 `contentHeadroom` 也不可信（实测它把 HDR 解码结果也报成 1.0），只能在真机判读。
- **列表 / 相册缩略图走服务端 imgproxy**（`render/image/...?width=400`），输出必然是 SDR —— 预期行为；
  只有点开的**预览大图**用原图（HEIC）显示。
- SDR 图片（JPEG / PNG）不受影响：`preferredImageDynamicRange = .high` 只对有扩展范围的内容生效。
- 观感还受系统状态影响：低电量模式、降低白点、屏幕亮度与环境光都会改变系统分给 App 的 EDR headroom。
  和系统「照片」对比时，请在同一时刻、同一张图上比。

## 6. 验收方法（真机）

1. TestFlight 装最新 build（≥ 1.0.7 (12)）；
2. 打开一条含 iPhone HDR 照片的足迹 → 点开放大；
3. 与系统「照片」里的同一张图并排对比高光；
4. A/B：TestFlight 里保留旧 build，和新 build 对比同一张图，差异更直观。

## 7. 回退

删除 `patches/expo-image+3.0.11.patch`、去掉 `package.json` 里的 `postinstall`，然后
`npm install` → `npx expo prebuild --platform ios` → 重新打包，即恢复原始 SDR 行为。

## 8. 升级依赖时注意

`expo-image` 升级后补丁大概率失效（`patch-package` 会明确报错，不会静默跳过）：
按 3.1–3.3 三处重新套用，再用 `npx patch-package expo-image` 重新生成补丁。
如果未来的 `expo-image` 原生支持 HDR（例如新增 `dynamicRange` prop），应优先改用官方能力并删掉本补丁。

## 9. 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-09-13 | 定位到「解码默认走 SDR」，补丁加上 `imageDecodeToHDR` + `preferredImageDynamicRange = .high`（随 1.0.6 (8)–(10) 验证） |
| 2026-09-13 晚 | 真机对比「照片」仍觉高光不够跳：实测确认降采样重绘会压回 SDR；预览大图改用 `enforceEarlyResizing`，并给 `resize()` 补 `preferredRange = .extended`（1.0.7 (12) 起） |
| 2026-09-13 晚 | 真机取数用的 `[TripHDR]` 诊断日志在验证完成后摘除，正式构建不再写日志 |
