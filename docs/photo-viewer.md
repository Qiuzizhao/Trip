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

## 滑动手感：补丁放宽了翻页判定

`react-native-zoom-toolkit` 原版的翻页判定很苛刻（`utils/getSwipeDirection`）：

```js
const SWIPE_TIME = 175;      // 必须是手势最后 175ms 内的动作
const SWIPE_VELOCITY = 500;  // 速度必须 ≥ 500 px/s（也就是必须"甩"）
const SWIPE_DISTANCE = 20;
```

三个条件同时满足才翻页 —— 所以慢慢拖不翻、从左半边起手加不起速也不翻，手感很涩。
补丁（`patches/react-native-zoom-toolkit+5.1.1.patch`，由 `postinstall` 自动套用）额外接受：

```js
// 拖过 itemSize 的 25% 也算翻页（系统相册的手感），快速甩动的老行为保持不变
const SWIPE_DRAG_RATIO = 0.25;
```

调用处同时把 `itemSize` 传进判定函数（TS 源码与 `lib/module` 编译产物都改，避免打包走哪份都能生效）。
回归测试 `__tests__/gallerySwipePatch.test.ts` 直接读 node_modules 里的实现来断言三条行为
（慢拖 50% 翻页 / 慢拖 5% 不翻页 / 快速甩动照旧）—— 补丁哪天没应用上，测试会直接失败。

## 快速翻页不再卡住

「停留 1 秒加载全分辨率」这条规则原本是**任何时刻**都在计时，于是快速连续翻页时，
每翻到一张就会启动一次 24MP 解码（约 1 秒 CPU），主线程被拖住、手势排队，
卡顿结束后积压的滑动一次性生效 —— 表现就是"卡住、然后一下跳好几张"。

现在改成**手势停止后才计时**：`onPanStart` / `onZoomBegin` 时挂起计时，
`onPanEnd` / `onZoomEnd` 后重新计 1 秒。快速翻页期间不再触发全分辨率解码，
手指停下来 1 秒才升级清晰度。

### 补一刀：手势结束信号不可靠

上面这条依赖 `onPanEnd`，但库里它只在**非滑动**的手势结束时才回调
（`GalleryGestureHandler`：`if (direction === undefined && onPanEnd) …`）。
结果滑动过一次之后 `interacting` 永远停在 true，**"停留 1 秒升级"再也不触发**
（捏合放大走的是另一条路径，所以那种情况仍然有效 —— 正好对应"停留没用、放大有用"）。

现在改成任何一个结束信号都会清掉：`onPanEnd` / `onSwipe` / `onGestureEnd` / `onZoomEnd`，
外加 1.5 秒兜底计时（万一某条路径又漏了事件，最多挂起 1.5 秒就恢复）。

## 循环滑动的动画

循环原本是滑到边界后调 `galleryRef.setIndex()` —— 库内部是**直接赋值**（`scroll.value = …`），
所以是硬切闪烁，没有过渡动画。

现在改成最经典的首尾克隆（`previewPager.ts`）：

```
数据 = [最后一张, 第一张, 第二张, …, 最后一张, 第一张]
        ↑ 克隆                                    ↑ 克隆
```

- 两个方向都能滑出完整的滑动动画（不再是硬切）；
- 滑到克隆项后立刻**无声跳回**对应真实项（克隆与真实内容一致，看不到跳）；
- 真实下标与 Gallery 位置的互换算在 `previewIndex` 系列纯函数里，并有单测覆盖
  （`__tests__/previewPager.test.ts`：映射往返、首尾克隆折回、单图不循环）。

## 下拉收起不弹回

库在垂直下拉松手时**无条件**把图片弹回原位（`translate.y.value = withTiming(0, …)`），
不区分使用方是否要关闭 —— 所以"下拉收不干净"：图片先弹回，然后才整体淡出。

补丁（`react-native-zoom-toolkit+5.1.1.patch`）里加了：位移超过 80（与 App 侧
`VERTICAL_PULL_CLOSE_THRESHOLD` 一致）就**保持位移不弹回**，交给 `previewGestures`
把收起动画走完再关闭。注意不能顺手把 `isPullingVertical` 置回 false ——
下面的 `useAnimatedReaction` 只在 `isPulling` 为真时回调 `onVerticalPull`，
置回 false 会让"松手关闭"整个丢失。

## 动画：翻页时长跟手、下拉收起跟手

**翻页（左右滑动）**：库里原本无论甩得多快都用固定的 `snapTimingConfig = { duration: 300,
easing: Easing.out(Easing.cubic) }` —— 快甩时显得"动画追不上手指"，慢拖时又显得拖沓。补丁改成按速度算时长：

```js
// 翻页：距离 / 速度，钳在 160–380ms
const swipeDuration = clamp(swipeDistance / Math.max(Math.abs(velocity), 400) * 1000, 160, 380);
// 松手回位（没够到翻页）：钳在 140–320ms
const snapDuration = clamp(snapDistance / Math.max(Math.abs(velocity), 300) * 1000, 140, 320);
```

调用处把 `e.velocityX` 传进 `onSwipe` 与 `snapToScrollPosition`（TS 源码与 `lib/module` 编译产物同时改）。

**下拉关闭（2026-09-14 重做）**：以前是"整个预览层一起变淡 + 缩小"，看起来像一张黑纸慢慢化掉，
用户反馈"既然下滑了，黑背景就该消失，只留照片在动"。现在拆成三层（`FootprintImagePreviewModal`）：

- **黑色背板单独一层**：`pull`（下拉位移）驱动它淡到全透明（240pt 内淡完），露出下面的列表；
- **照片层**：跟手下滑由 Gallery 负责，这一层只叠加"松手甩出去"的那一段位移（`exitOffset`，120pt / 170ms）；
- **控件层**（计数 / 拍摄时间 / 关闭 / 横屏 / 下载）：140pt 内先淡出。

松手超过阈值（80pt）：背板继续淡到底 + 照片顺势再走一段（170ms）后关闭；
没到阈值：220ms 顺滑回位。
`pull` 与 `exitOffset` **每次打开预览都清零**（共享值活在组件上，Modal 关闭不会卸载它），
否则下次打开会出现"半透明"或"照片停在偏下位置"。

## 三个「卡住 / 半透明」的坑（2026-09-14 修复）

用户报的三个现象是同一个手势状态机漏掉收尾的不同表现：

1. **左右滑不动**：库在 `onStart` 用**起手瞬间的速度**判断这次手势是不是下拉
   （`Math.abs(e.velocityY) > Math.abs(e.velocityX)`）。这个值是噪声很大的瞬时量，
   横滑起手带一点点下压就会被判成纵向，而库里 `onEnd` 为了不让下拉误触发翻页，
   会传 `translate.x = 100` 让横向判定必定失败 —— 整条横向手势被吞掉。
   现在改成**锁轴**：手势前 12px 的实际位移决定这是横滑还是下拉，方向只定一次
   （横滑照旧走 scroll，下拉才进 pull 分支）。
2. **重开预览是半透明 + 缩小 6%**：驱动容器透明度/缩放的共享值 `pull` 活在
   `FootprintImagePreviewModal` 上，而 Modal 关闭**不会卸载这个组件** ——
   下拉收起留下的位移一直留着，下次打开就是 `opacity 1 - pull/320*0.7` 的半透明状态。
   现在每次「打开预览」都在渲染期把 `pull` 归零。
3. **下拉到一半卡住、图片半透明、底下列表透出来**：关不关以前挂在 `withTiming` 的
   `finished` 回调上。动画一旦被打断（新手势写 `pull`、GestureHandler 被取消），
   回调带 `finished = false` 回来，`onClose` 就永远不会触发，预览永久停在下拉一半。
   现在 UI 线程只负责动画，**关闭由 JS 侧按同样时长兜底**（`requestClose` →
   `setTimeout(onClose, 170)`），动画被打断也一定会关掉。

配套的库补丁（`react-native-zoom-toolkit+5.1.1.patch`）还有两处收尾：

- 手势被**取消**时 RNGH 只回调 `onFinalize`、不回调 `onEnd`（第二根手指落下让
  `maxPointers(1)` 失败、并发的捏合/双击把 pan 置成 disabled 都会这样）。
  补丁在 `onFinalize` 里补一次收尾：超过阈值就通知使用方关闭，没到就把位移弹回去。
- 每次手势开始都重置 `pullReleased` / `pullHandled` 标志位 —— 原来这两个是"只置不清"的
  闩锁，第二次下拉松手时值没变化，`useAnimatedReaction` 不再回调，松手事件整个丢失。

另外修掉一个「手势永久失效」的隐患：捏合回弹动画被打断时，库里
`gesturesEnabled` 会永久停在 `false`（pan / tap / pinch 全禁用，预览再也滑不动）。
补丁改成不管动画是否被打断都恢复开关，并把「关」排在 `cancelAnimation` 之后。
回归测试：`__tests__/previewGestures.test.ts`、`__tests__/gallerySwipePatch.test.ts`
（直接读 `node_modules` 源码断言补丁在不在，补丁丢了就红）。

## 左右滑动翻页：App 侧兜底（2026-09-14）

库里翻页是"先播 `scroll` 动画、动画结束才改 `activeIndex`"。新架构下这次布局重算会再走一遍
`measureRoot`，而它原本**无条件**把 `scroll` 写回当前页 —— 正在播的动画被打断
（`finished=false` 直接 return），表现就是"滑过去又弹回来、计数不变"（左右滑不动）。

两层修复：

1. 补丁：`measureRoot` 只有尺寸真的变了才写 `scroll`（`Gallery.js` / `Gallery.tsx`）；
2. App 兜底：`onSwipe` 里记下预期下标，460ms 内 `onIndexChange` 没到就直接
   `galleryRef.setIndex()` 翻过去 —— 动画正常时兜底会被 `onIndexChange` 清掉。

另外把"打开预览那一下的抬手"过滤掉（`openedAtRef`）：否则那一下会被 Gallery 当成单击，
预览刚打开就被关掉（表现为"点缩略图没反应，要点两次"）。

### 真触摸验收（这台机器上可行的方法）

Device Hub 里合成鼠标事件**不会**变成应用内拖拽（点击、系统边缘手势可以），
所以手感/手势类改动要用 XCUITest 注入真触摸：

```bash
# 一次性生成一个最小 UI Test 工程（XcodeGen），再跑：
xcodebuild test -project TripUIAutomation.xcodeproj -scheme TripUITests \
  -destination 'platform=iOS Simulator,id=<UDID>' -derivedDataPath /tmp/trip-ui-dd \
  -only-testing:TripUITests/PreviewGestureTests
```

用例里用 `press(forDuration:thenDragTo:)` 做真实拖拽，并采样截图像素判断"背板是否不透明"。
注意模拟器里装的是 **Release 包（内置 main.jsbundle）**：改完 JS 必须
`xcodebuild -workspace ios/Trip.xcworkspace -scheme Trip -configuration Release -sdk iphonesimulator`
重新构建再 `simctl install`，改 Metro 没用。

当前 4 条用例全绿：左右翻页、打开不透明、下拉关闭+重开不透明、小幅下拉回弹。

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

- `npx tsc --noEmit` 0 错误；`npx jest` 97 通过（含补丁守护测试）。
- 模拟器（iPhone 18 Pro / iOS 27）实测：预览正常渲染（全屏图片 + 计数 + 关闭按钮）。
- 2026-09-14 修「左右滑不动 / 重开半透明 / 下拉卡一半」时，除了单测，
  还确认了 **Metro 真的把补丁打进包**：`curl` 拉 `/.expo/.virtual-metro-entry.bundle`
  后能查到 `PAN_AXIS_LOCK_DISTANCE` / `releasePull` 且已没有 `isVerticalPan`，
  再 deep link 重载 App 无红屏 —— 注意包用的是 `lib/module` 产物（不是 `src`）。
- **手势手感需要真机确认**：这台机器的模拟器（Device Hub）不接受合成触摸事件，脚本无法模拟捏合/滑动；请在手机上体验。
- 已随 **1.0.6 (9)** 上传到 App Store Connect。

## 后续可调项

- 最大放大倍数：`maxScale={6}`；
- 下拉关闭阈值：`handleVerticalPull` 里的 `translateY > 80`；
- 单击关闭 vs 「单击隐藏/显示控件」：目前是单击关闭（延续旧行为），若要更像系统「照片」可改为切换工具栏显隐。

## 相关文档

- HDR / XDR 显示（预览大图为什么能用上扩展动态范围）：`docs/ios-hdr-patch.md`
- 拍摄时间来源：`docs/photo-capture-time.md`
