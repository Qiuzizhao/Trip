# 全屏图片预览（照片级手势）

## 现在支持什么

打开任意足迹的图片后：

- **左右滑动** 在同一足迹的图片之间切换（多图时顶部显示 `当前 / 总数`）；
- **双指捏合缩放**（最大 6 倍）、**双击放大 / 还原**；
- 放大后**拖动平移**，到边界时再滑动即切换上一张/下一张；
- **单击任意处关闭**、**向下拖动松手关闭**（和系统「照片」一致）。
- 顶部中间在计数下方显示**这张照片的拍摄时间**（读 EXIF，见 `docs/photo-capture-time.md`）。
- 右上角有**横屏查看**按钮：点一下屏幕转成横屏、照片铺满宽度看细节，再点回到竖屏；
  关闭预览会自动转回竖屏。
- **循环滑动**：最后一张继续往左滑回到第一张，第一张往右滑去到第最后一张（只有一张时不循环）。
- 底部有**下载**按钮（保存到相册 / 系统分享当前这张）。它做在预览组件内部，
  所以**首页列表和记录详细页的预览都有**；编辑页例外（那里的图本来就在本机，传 `showDownload={false}`）。

> 早先只有相册页传了 `action` 插槽、首页没传，于是"首页放大没有下载按钮、进详情页放大才有"。
> 现在下载按钮收进 `FootprintImagePreviewModal`（`showDownload` 默认 true），三个入口默认一致。

## 循环滑动怎么实现的

`react-native-zoom-toolkit` 的 `Gallery` 本身不循环（边界会被 clamp 住），但它在边界处
**仍会把滑动方向回调给 `onSwipe`**（内部只是不移动画面）。所以做法是：

```tsx
const galleryRef = useRef<GalleryRefType>(null);
const handleSwipe = (direction) => {
  if (uris.length < 2) return;
  if (direction === 'left' && index >= uris.length - 1) galleryRef.current?.setIndex(0);
  else if (direction === 'right' && index <= 0) galleryRef.current?.setIndex(uris.length - 1);
};
```

`setIndex` 会更新 `activeIndex`，进而触发 `onIndexChange`，所以计数、拍摄时间、
全分辨率层这些都跟着走。注意 ref 要挂在 **`ref`** 上（导出的 `Gallery` 是 `forwardRef` 包过的
Provider，不是内部那个 `reference` 属性）。

> 提示：本机 Device Hub 无法合成带速度的 fling 手势，循环这步是用相同的处理函数直接触发验证的
> （打开第 2 张 → 触发边界左滑 → 计数回到 1/2），实际滑动手感需要在真机上确认。

## 横屏查看的实现要点

1. **原生方向要放开**：`app.json` 的 `orientation` 从 `portrait` 改成 `default`，
   否则 iPhone 的 `UISupportedInterfaceOrientations` 里没有横屏，锁也锁不过去。
2. **App 本体仍锁竖屏**：`app/_layout.tsx` 启动时 `lockAsync(PORTRAIT_UP)`，
   只有预览里手动切横屏，退出预览（或组件卸载）时恢复竖屏。
3. **RN 的 `Modal` 必须声明支持的方向**——这是最容易踩的一步：
   默认它只声明竖屏，UIKit 会直接抛
   `Supported orientations has no common orientation with the application, and [RCTFabricModalHostViewController shouldAutorotate] is returning YES`，
   表现为「按钮状态变了但屏幕不转」。要显式写
   `supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}`。
4. 用 `expo-screen-orientation` 的 `OrientationLock.LANDSCAPE`（左右横屏都允许），
   横竖屏切换后 `useWindowDimensions()` 会变，`Gallery` 用 `key` 重新挂载以重新测量，
   同时传当前下标避免跳回第一张。

验证（模拟器实测日志）：点按钮 `(Pu) -> (Ll Lr)`、截图从 1206×2622 变 2622×1206；
关闭预览 `(Ll Lr) -> (Pu)` 回到竖屏。

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
3. **打开预览时下标必须"在渲染期"对齐**：`Gallery` 只在挂载那一刻读 `initialIndex`，
   而 `visible` 刚变 true 的那次渲染里，组件内部的 `index` 还是上一次会话留下的值。
   只用 `useEffect` 事后同步的话，Gallery 会带着旧下标挂载 —— 表现就是
   「点第 1 张图，却打开上次停在第 3 张的那张图」（时有时无，取决于上次停在哪一张）。
   现在用渲染期 `setState`（React 官方的派生 state 写法）在提交前对齐，Gallery 拿到正确下标。

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
