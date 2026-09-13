# 全屏图片预览（照片级手势）

## 现在支持什么

打开任意足迹的图片后：

- **左右滑动** 在同一足迹的图片之间切换（多图时顶部显示 `当前 / 总数`）；
- **双指捏合缩放**（最大 6 倍）、**双击放大 / 还原**；
- 放大后**拖动平移**，到边界时再滑动即切换上一张/下一张；
- **单击任意处关闭**、**向下拖动松手关闭**（和系统「照片」一致）。
- 顶部中间在计数下方显示**这张照片的拍摄时间**（读 EXIF，见 `docs/photo-capture-time.md`）。

## 实现方式

用 [`react-native-zoom-toolkit`](https://github.com/Glazzes/react-native-zoom-toolkit) 的 `Gallery` 组件
（MIT、无运行时依赖、纯 JS；2026-08 仍在发版）。

选它的原因：

| 候选 | 结论 |
| --- | --- |
| `react-native-zoom-toolkit` | ✅ 自带 Gallery（切图）+ 缩放/平移/双击，直接使用 `react-native-worklets`（即 Reanimated 4 的 API 形态），与当前依赖完全匹配 |
| `react-native-awesome-gallery` | ❌ 最后发版 2024-09，peer 要求 `reanimated ^3.2.0` |
| `@likashefqet/react-native-image-zoom` | ❌ 只做单图缩放，没有切图能力 |
| `react-native-image-viewing` | ❌ 有切图但没有捏合缩放 |

因为是纯 JS，**不需要 pod install、不需要改原生工程**；复用了项目已有的 `react-native-reanimated 4.1.1` /
`react-native-worklets 0.5.1` / `react-native-gesture-handler 2.28`。

## 接入时踩到的两个坑（已在代码里注明）

1. **`Modal` 里的手势必须自己包 `GestureHandlerRootView`**：RN 的 `Modal` 渲染在独立的原生根视图里，不会继承外层的 gesture root，否则手势完全没反应。
2. **`Gallery` 会测量子元素尺寸**：给子元素用 `width/height: '100%'` 会解析成 0，图片不显示。改成显式传入窗口尺寸（`useWindowDimensions()`）后才正常。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/features/daily/footprints/FootprintImagePreviewModal.tsx` | 重写为 Gallery 版：新增 `items: PreviewImage[]`（`{ uri, takenAt? }`）+ `initialIndex` + `onIndexChange`，保留 `action` 插槽；单击/下拉关闭；多图显示计数；顶部显示拍摄时间 |
| `FootprintScreen.tsx` | 点缩略图时把**整条足迹的图片列表 + 当前下标**传进预览 |
| `FootprintAlbumScreen.tsx` | 相册九宫格同样传列表 + 下标；「下载」按钮改为下载**当前正在看的那张**（`onIndexChange` 同步下标） |
| `FootprintEditorScreen.tsx` | 编辑页预览也支持左右切换 |

## 验证情况

- `npx tsc --noEmit` 0 错误；`npx jest` 40 通过；无未使用代码。
- 模拟器（iPhone 18 Pro / iOS 27）实测：预览正常渲染（全屏图片 + `1 / 3` 计数 + 关闭按钮）。
- **手势手感需要真机确认**：这台机器的模拟器（Device Hub）不接受合成触摸事件，脚本无法模拟捏合/滑动；请在手机上体验。
- 已随 **1.0.6 (9)** 上传到 App Store Connect。

## 后续可调项

- 最大放大倍数：`maxScale={6}`；
- 下拉关闭阈值：`handleVerticalPull` 里的 `translateY > 80`；
- 单击关闭 vs 「单击隐藏/显示控件」：目前是单击关闭（延续旧行为），若要更像系统「照片」可改为切换工具栏显隐。

## 相关文档

- HDR / XDR 显示（预览大图为什么能用上扩展动态范围）：`docs/ios-hdr-patch.md`
- 拍摄时间来源：`docs/photo-capture-time.md`
