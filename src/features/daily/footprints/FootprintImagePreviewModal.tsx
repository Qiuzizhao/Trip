// 全屏图片预览：左右滑动切图 + 双指缩放/双击放大/放大后平移 + 下拉关闭（接近系统「照片」的手感）。
// 手势由 react-native-zoom-toolkit 的 Gallery 提供（纯 JS，复用已有的 reanimated 4 / gesture-handler）。
//
// 几个容易踩的点（都已在实现里处理）：
// 1. Modal 渲染在独立原生根视图里，手势必须自己包 GestureHandlerRootView；
// 2. Gallery 会测量子元素尺寸，百分比尺寸会解析成 0，必须给明确的窗口尺寸；
// 3. 原图（尤其 HDR HEIC）体积大，先用列表已缓存的缩略图做占位，加载完再替换；
// 4. 预先取相邻图片，滑动切换时不再等网络。
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage, type ImageStyle } from 'expo-image';
import * as ScreenOrientation from 'expo-screen-orientation';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gallery, type GalleryRefType, type SwipeDirection } from 'react-native-zoom-toolkit';

import { radius, spacing } from '@/src/shared/theme';
import type { PreviewImage } from './assetResolver';
import { shareFootprintImage } from './download';
import { formatTakenAt, readTakenAtFromFile } from './imageMetadata';
import { buildPreviewPages, isClonePage, previewRealIndex, previewVisualIndex } from './previewPager';
import { createVerticalPullHandler } from './previewGestures';
import { debugLog } from './previewDebugLog';

/** 预览里停留多久就把全分辨率那层挂上（毫秒） */
const PREVIEW_HI_RES_DELAY_MS = 1000;
/**
 * 下拉多少距离背景就完全淡掉（露出下面的页面）。
 * 系统「照片」就是这样：往下拖时黑色背板先化掉，只剩照片跟着手指走。
 */
const PULL_BACKDROP_FADE_DISTANCE = 240;
/** 顶部计数/关闭按钮/下载按钮比背景淡得更快（和系统「照片」的控件一起退场） */
const PULL_CHROME_FADE_DISTANCE = 140;
/** 翻页交叉淡入淡出：先淡出（毫秒） */
const SWAP_FADE_OUT_MS = 90;
/** 翻页交叉淡入淡出：再淡入（毫秒） */
const SWAP_FADE_IN_MS = 140;
/**
 * 最多同时保留几张全分辨率位图。
 * 每张 24MP / 10 位约 93MB，所以只留最近看过的几张（前后翻动时不必重新解），
 * 超出的按最久未访问淘汰；关闭预览全部释放。
 */
const PREVIEW_HI_RES_KEEP = 3;

/**
 * 预览里单张图的两层渲染。
 *
 * 关键：**等容器量出真实尺寸之后再挂图片**。
 * expo-image 的 `enforceEarlyResizing` 是按「视图 bounds × 屏幕倍率」决定解码尺寸的，
 * 如果加载发生在布局之前、拿到偏小的 bounds，解码出来就是一张很小的图，
 * 全屏显示会糊得没法看（也正是"竖屏糊、横屏转一圈又好了"的来源）。
 */
function PreviewItem({
  contentFit,
  hiRes,
  imageStyle,
  onError,
  reloadToken,
  uri,
  windowHeight,
  windowWidth,
}: {
  contentFit: 'contain' | 'cover';
  hiRes: boolean;
  imageStyle?: StyleProp<ImageStyle>;
  onError: () => void;
  reloadToken: number;
  uri: string;
  windowHeight: number;
  windowWidth: number;
}) {
  const [measured, setMeasured] = useState(false);

  return (
    <View
      onLayout={(event) => {
        const { height, width } = event.nativeEvent.layout;
        if (!measured && width > 0 && height > 0) setMeasured(true);
      }}
      style={{ height: windowHeight, width: windowWidth }}
    >
      {measured ? (
        <>
          <ExpoImage
            cachePolicy="memory-disk"
            contentFit={contentFit}
            // 第一层：按屏幕尺寸解码（enforceEarlyResizing 让 ImageIO 直接出小图），
            // 打开即有图、内存也小；HDR 同样保留（这条路径实测 headroom 仍是 2.30）。
            enforceEarlyResizing
            key={`${uri}-${reloadToken}-screen`}
            onError={onError}
            priority="high"
            source={{ uri }}
            style={[{ height: windowHeight, width: windowWidth }, imageStyle]}
            transition={0}
          />
          {hiRes ? (
            <ExpoImage
              // 第二层：全分辨率。放大（或停留 1 秒）后叠上来替换。
              // - allowDownscaling=false：不要缩到屏幕尺寸，保留原分辨率，放大才清晰；
              // - 独立 cacheKey：与第一层分开缓存，否则会直接命中那张屏幕尺寸的图。
              allowDownscaling={false}
              cachePolicy="memory-disk"
              contentFit={contentFit}
              key={`${uri}-${reloadToken}-full`}
              priority="high"
              source={{ cacheKey: `${uri}#full`, uri }}
              style={[StyleSheet.absoluteFill, imageStyle]}
              transition={120}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

type FootprintImagePreviewModalProps = {
  action?: React.ReactNode;
  /**
   * 是否显示「下载」按钮（保存到相册/分享）。
   * 默认显示：首页列表与相册页的预览行为保持一致；编辑页的图本来就在本机，传 false。
   */
  showDownload?: boolean;
  contentFit?: 'contain' | 'cover';
  imageStyle?: StyleProp<ImageStyle>;
  items: PreviewImage[];
  /** 传空数组表示关闭 */
  initialIndex?: number;
  onClose: () => void;
  /** 左右滑动切图后回调（用于「下载当前图片」这类跟随当前图的操作） */
  onIndexChange?: (index: number) => void;
};

export function FootprintImagePreviewModal({
  action,
  contentFit = 'contain',
  imageStyle,
  items,
  initialIndex = 0,
  onClose,
  onIndexChange,
  showDownload = true,
}: FootprintImagePreviewModalProps) {
  const uris = useMemo(() => items.map((entry) => entry.uri), [items]);
  const visible = uris.length > 0;
  const [index, setIndex] = useState(initialIndex);
  // 失败的图片（uri -> 重试次数），用于展示「图片不可用」并支持重试
  const [failedUris, setFailedUris] = useState<Record<string, number>>({});
  const [reloadToken, setReloadToken] = useState(0);
  // 已经挂了全分辨率层的图（最近访问的排在后面）：放大看细节，或停留超过 DWELL 时长都会加进来
  const [hiResUris, setHiResUris] = useState<string[]>([]);
  // 手势进行中：这期间不启动「停留 1 秒升级全分辨率」的计时。
  // 快速左右翻页时每张都启动一次 24MP 解码会把主线程拖住，手势排队，
  // 卡顿结束后积压的滑动一次性生效（表现为"卡住、然后一下跳好几张"）。
  const [interacting, setInteracting] = useState(false);
  const galleryRef = useRef<GalleryRefType>(null);
  // 当前真实下标（回调/定时器里用 ref 读最新值，避免闭包拿到旧 state）
  const indexRef = useRef(index);
  indexRef.current = index;
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  // 打开预览的时刻：用来过滤"打开那一下的抬手被 Gallery 当成单击"（会立刻把预览关掉）
  const openedAtRef = useRef(0);
  // 横屏查看：只在预览里把屏幕转过来，退出预览恢复竖屏
  const [landscape, setLandscape] = useState(false);
  // 调用方没带拍摄时间时，自己从本地文件读一次（只在真正看到这张图时才读）
  const [measuredTakenAt, setMeasuredTakenAt] = useState<Record<string, number | null>>({});

  const insets = useSafeAreaInsets();
  // Gallery 会测量子元素尺寸来计算缩放边界，百分比尺寸在这条链路里解析为 0，因此给明确的窗口尺寸
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const currentItem = visible ? items[Math.min(index, items.length - 1)] ?? null : null;
  const currentUri = currentItem?.uri ?? null;
  const currentTakenAt = currentItem
    ? currentItem.takenAt ?? measuredTakenAt[currentItem.uri] ?? null
    : null;
  const takenAtLabel = formatTakenAt(currentTakenAt);
  const currentFailed = currentUri ? Boolean(failedUris[currentUri]) : false;

  /**
   * 打开预览时要**在渲染期**把下标对齐到父组件给的 initialIndex。
   *
   * 用 useEffect 会晚一拍：`Gallery` 在 visible 变 true 的那次渲染就挂载了，
   * 那时内部 index 还是上一次会话留下的值，而 Gallery 只在挂载时读 initialIndex，
   * 之后改 prop 不会跳页 —— 表现就是「点第 1 张，却打开上次停在第 3 张的那张图」。
   * 渲染期 setState（React 官方的“派生 state”写法）会在本次提交前重渲染，Gallery 拿到正确下标。
   */
  const [openedSession, setOpenedSession] = useState(visible);
  if (visible !== openedSession) {
    setOpenedSession(visible);
    if (visible) {
      setIndex(initialIndex);
      openedAtRef.current = Date.now();
    }
  }

  useEffect(() => {
    if (!currentItem || currentItem.takenAt) return;
    const uri = currentItem.uri;
    if (measuredTakenAt[uri] !== undefined) return;
    if (!uri.startsWith('file://')) return;
    let cancelled = false;
    void readTakenAtFromFile(uri).then((takenAt) => {
      if (!cancelled) setMeasuredTakenAt((previous) => ({ ...previous, [uri]: takenAt }));
    });
    return () => {
      cancelled = true;
    };
  }, [currentItem, measuredTakenAt]);

  // 预取当前图与相邻图（滑动时基本无等待）
  useEffect(() => {
    if (!visible) return;
    const around = uris.slice(Math.max(0, index - 1), index + 2);
    if (around.length) void ExpoImage.prefetch(around, 'memory-disk');
  }, [index, uris, visible]);

  /**
   * 无限循环：Gallery 是线性滚动，做不到"从头绕回尾"的滑动动画，
   * 所以数据首尾各补一张（最后一张放到最前、第一张放到最后）：
   * 滑到克隆项后再"无声"跳回真实项（内容一模一样，看不出跳），
   * 这样两个方向都能滑出完整的滑动动画，而不是之前的硬切闪烁。
   */
  const count = uris.length;
  const infinite = count > 1;
  const galleryData = useMemo(() => buildPreviewPages(uris), [uris]);
  const toVisualIndex = useCallback((realIndex: number) => previewVisualIndex(realIndex, count), [count]);
  const toRealIndex = useCallback((visualIndex: number) => previewRealIndex(visualIndex, count), [count]);

  const handleIndexChange = useCallback((visualIndex: number) => {
    const realIndex = toRealIndex(visualIndex);
    setIndex(realIndex);
    indexRef.current = realIndex;
    onIndexChange?.(realIndex);
    // 任何一次翻页都意味着手势结束了（库在"滑动"这条路径不回调 onPanEnd，
    // 不在这里清掉的话 interacting 会一直挂起，停留升级就再也不触发）
    setInteracting(false);

    // 落在克隆项上：立刻无动画跳回对应真实项
    if (isClonePage(visualIndex, count)) {
      requestAnimationFrame(() => galleryRef.current?.setIndex(toVisualIndex(realIndex)));
    }
  }, [count, onIndexChange, toRealIndex, toVisualIndex]);

  // 下拉关闭：极简——松手到阈值就直接关，不做任何收尾动画
  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);


  // 下拉超过阈值并松手时关闭（和系统「照片」一致的手感）。
  // Gallery 会在 UI 线程的 worklet 里直接调用它，所以必须由 createVerticalPullHandler 生成 worklet，
  // 不能直接传普通函数（那会闪退，见 previewGestures.ts）。
  const handleVerticalPull = useMemo(() => createVerticalPullHandler(requestClose), [requestClose]);

  /** 单击关闭；刚打开的那一下抬手不算（否则打开瞬间又被关掉） */
  const handleTapClose = useCallback(() => {
    if (Date.now() - openedAtRef.current < 400) return;
    onClose();
  }, [onClose]);

  const handleRetry = useCallback(() => {
    if (!currentUri) return;
    setFailedUris((previous) => {
      const next = { ...previous };
      delete next[currentUri];
      return next;
    });
    setReloadToken((token) => token + 1);
  }, [currentUri]);

  /**
   * 分级加载（苹果相册的做法）：先用「屏幕尺寸」的位图秒出图，
   * 用户开始捏合/双击放大时，再解一张全分辨率的替换上去。
   *
   * Gallery 的 onZoomBegin 走 JS 线程（库内部用 scheduleOnRN），可以直接 setState。
   */
  /** 把某张图标记为「要全分辨率」，并按上限淘汰最久没看的那张 */
  const markHiRes = useCallback((uri: string | null) => {
    if (!uri) return;
    setHiResUris((previous) => (
      [...previous.filter((value) => value !== uri), uri].slice(-PREVIEW_HI_RES_KEEP)
    ));
  }, []);

  const handleZoomBegin = useCallback((zoomIndex: number) => {
    debugLog(`zoomBegin index=${zoomIndex}`);
    setInteracting(true);
    markHiRes(uris[zoomIndex] ?? null);
  }, [markHiRes, uris]);

  const handleZoomEnd = useCallback(() => {
    debugLog('zoomEnd');
    setInteracting(false);
  }, []);
  const handlePanStart = useCallback(() => setInteracting(true), []);
  const handlePanEnd = useCallback(() => setInteracting(false), []);
  const handleGestureEnd = useCallback(() => setInteracting(false), []);
  const logPinchStart = useCallback(() => debugLog('pinchStart'), []);
  const logPinchEnd = useCallback(() => debugLog('pinchEnd'), []);

  // 兜底：万一某条手势路径没有回调"结束"，最多挂起 1.5 秒就自动恢复，
  // 保证"停留 1 秒升级清晰度"不会因为一次丢事件而永久失效。
  useEffect(() => {
    if (!interacting) return;
    const timer = setTimeout(() => setInteracting(false), 1500);
    return () => clearTimeout(timer);
  }, [interacting]);

  // 下载/分享当前这张（大图本身就是原图地址，不需要再取缩略图）
  const [downloading, setDownloading] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!currentUri || downloading) return;
    setDownloading(true);
    try {
      await shareFootprintImage(currentUri);
    } catch (error) {
      Alert.alert('下载失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setDownloading(false);
    }
  }, [currentUri, downloading]);

  /**
   * 手势结束信号：库里"滑动"这条路径不会回调 onPanEnd，
   * 所以 onSwipe 这里必须把 interacting 清掉（否则停留升级会一直挂起）。
   */
  /**
   * 翻页：极简——照片拖动时由 Gallery 跟手，松手直接切到目标页（不做任何动画）。
   * 库自己的翻页动画已经用补丁关掉（它会被布局重算打断，出现回弹/闪烁），
   * 这里用 setIndex 一次到位，永远和计数、下载按钮指向的图一致。
   */
  const handleSwipe = useCallback((direction: SwipeDirection) => {
    setInteracting(false);
    if (count < 2 || (direction !== 'left' && direction !== 'right')) return;
    // 放大状态下不翻页：`setIndex` 会把缩放/位移一起清零（表现就是"放大后被弹回原样"），
    // 而且放大时的横向拖动本来就该是平移图片，不是翻页。
    const zoomScale = galleryRef.current?.getState().scale ?? 1;
    if (zoomScale > 1.02) return;

    const target = ((indexRef.current + (direction === 'left' ? 1 : -1)) % count + count) % count;
    indexRef.current = target;
    setIndex(target);
    onIndexChangeRef.current?.(target);
    galleryRef.current?.setIndex(toVisualIndex(target));
  }, [count, toVisualIndex]);


  /**
   * 停留即升级：即使没捏合，某张图看超过 1 秒也把全分辨率那层挂上，
   * 这样"停下来看细节"和"捏合放大"都能得到清晰画面。
   * 换图会重新计时；已经加载过的会留在最近访问列表里（见 PREVIEW_HI_RES_KEEP），
   * 所以来回翻动时不用重新解一遍。
   */
  useEffect(() => {
    if (!visible || !currentUri || interacting) return;

    const timer = setTimeout(() => markHiRes(currentUri), PREVIEW_HI_RES_DELAY_MS);
    return () => clearTimeout(timer);
  }, [visible, currentUri, markHiRes, interacting]);

  // 关闭预览就全部释放，别把几十上百 MB 的位图留在后台
  useEffect(() => {
    if (!visible) setHiResUris([]);
  }, [visible]);

  /** 横屏查看：只在预览里转动屏幕，退出预览恢复竖屏（App 本体始终竖屏） */
  const toggleLandscape = useCallback(() => {
    setLandscape((previous) => {
      const next = !previous;
      void ScreenOrientation.lockAsync(
        next
          ? ScreenOrientation.OrientationLock.LANDSCAPE
          : ScreenOrientation.OrientationLock.PORTRAIT_UP,
      );
      return next;
    });
  }, []);

  // 关闭预览（或组件卸载）时一定转回竖屏，避免把横屏状态带回列表
  useEffect(() => {
    if (visible) return;
    setLandscape(false);
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, [visible]);

  useEffect(() => () => {
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  }, []);

  const topOffset = useMemo(() => insets.top + 8, [insets.top]);
  const bottomOffset = useMemo(() => Math.max(insets.bottom, spacing.lg) + spacing.md, [insets.bottom]);

  return (
    <Modal
      // 关闭自带转场：下拉离场由我们自己的动画完成，原生淡出会和它叠在一起闪一下
      animationType="none"
      onRequestClose={onClose}
      // RN 的 Modal 默认只声明竖屏，会把 App 的横屏锁定挡掉（UIKit 报
      // "Supported orientations has no common orientation"），预览要支持横屏必须在这里放开。
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      {/* Modal 渲染在独立的原生根视图里，手势必须自己包一层 GestureHandlerRootView */}
      <GestureHandlerRootView style={styles.root}>
        {/* 背板：始终纯黑。下滑不再跟手/淡出，松手直接关闭预览（等同点空白） */}
        <View pointerEvents="none" style={styles.backdrop} />

        {/* 照片层：跟手下滑由 Gallery 负责 */}
        <View style={styles.content}>
          {visible ? (
            <Gallery
              data={galleryData}
              // 横竖屏切换后容器尺寸变了，重新挂载让它重新测量；带上当前下标避免跳回第一张
              initialIndex={toVisualIndex(index)}
              key={landscape ? 'landscape' : 'portrait'}
              keyExtractor={(uri, itemIndex) => `${uri}-${itemIndex}`}
              maxScale={6}
              onIndexChange={handleIndexChange}
              onGestureEnd={handleGestureEnd}
              onPanEnd={handlePanEnd}
              onPanStart={handlePanStart}
              onSwipe={handleSwipe}
              onTap={handleTapClose}
              onVerticalPull={handleVerticalPull}
              onPinchEnd={logPinchEnd}
              onPinchStart={logPinchStart}
              onZoomBegin={handleZoomBegin}
              onZoomEnd={handleZoomEnd}
              ref={galleryRef}
              renderItem={(uri, itemIndex) => (
                <PreviewItem
                  contentFit={contentFit}
                  hiRes={hiResUris.includes(uri)}
                  imageStyle={imageStyle}
                  // 首尾克隆项和真实项是同一个 uri，key 必须带上位置
                  key={`${uri}-${itemIndex}`}
                  onError={() => {
                    setFailedUris((previous) => ({ ...previous, [uri]: (previous[uri] ?? 0) + 1 }));
                  }}
                  reloadToken={reloadToken}
                  uri={uri}
                  windowHeight={windowHeight}
                  windowWidth={windowWidth}
                />
              )}
              tapOnEdgeToItem={false}
              windowSize={3}
            />
          ) : null}

          {currentFailed ? (
            <View pointerEvents="box-none" style={styles.errorWrap}>
              <Ionicons name="alert-circle-outline" size={40} color="rgba(255,255,255,0.72)" />
              <Text style={styles.errorText}>图片不可用</Text>
              <Pressable accessibilityRole="button" onPress={handleRetry} style={styles.retryButton}>
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* 控件层 */}
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>

          {visible && (uris.length > 1 || takenAtLabel) ? (
            <View pointerEvents="none" style={[styles.topCenter, { top: topOffset }]}>
              {uris.length > 1 ? (
                <Text style={[styles.counterText, styles.chip]}>{index + 1} / {uris.length}</Text>
              ) : null}
              {takenAtLabel ? <Text style={styles.takenAtText}>{takenAtLabel}</Text> : null}
            </View>
          ) : null}

          <Pressable
            accessibilityLabel={landscape ? '竖屏查看' : '横屏查看'}
            accessibilityRole="button"
            onPress={toggleLandscape}
            style={[styles.closeButton, { right: spacing.lg + 44, top: topOffset }]}
          >
            <Ionicons
              color="#fff"
              name={landscape ? 'phone-portrait-outline' : 'phone-landscape-outline'}
              size={20}
            />
          </Pressable>

          <Pressable
            accessibilityLabel="关闭图片预览"
            accessibilityRole="button"
            onPress={onClose}
            style={[styles.closeButton, { top: topOffset }]}
          >
            <Ionicons name="close" size={26} color="#fff" />
          </Pressable>

          {visible && (showDownload || action) ? (
            <View pointerEvents="box-none" style={[styles.actionWrap, { bottom: bottomOffset }]}>
              <View style={styles.actionRow}>
                {showDownload ? (
                  <Pressable
                    accessibilityLabel={downloading ? '正在下载图片' : '下载图片'}
                    accessibilityRole="button"
                    disabled={downloading}
                    onPress={(event) => {
                      event.stopPropagation();
                      void handleDownload();
                    }}
                    style={[styles.downloadButton, downloading && styles.downloadButtonDisabled]}
                  >
                    <Ionicons name="download-outline" size={18} color="#fff" />
                    <Text style={styles.downloadButtonText}>{downloading ? '下载中' : '下载'}</Text>
                  </Pressable>
                ) : null}
                {action}
              </View>
            </View>
          ) : null}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  actionWrap: {
    left: spacing.lg,
    position: 'absolute',
    right: spacing.lg,
  },
  downloadButton: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(17, 24, 39, 0.76)',
    borderColor: 'rgba(255, 255, 255, 0.18)',
    borderRadius: radius.full,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  downloadButtonDisabled: {
    opacity: 0.45,
  },
  downloadButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    position: 'absolute',
    right: spacing.lg,
    width: 36,
    zIndex: 2,
  },
  chip: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  counterText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    overflow: 'hidden',
  },
  // 拍摄时间：和系统「照片」一样放在顶部中间，白字 + 阴影，亮图暗图都能看清
  takenAtText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textShadowColor: 'rgba(0, 0, 0, 0.65)',
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 6,
  },
  topCenter: {
    alignItems: 'center',
    gap: 6,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  errorText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 15,
    fontWeight: '600',
    marginTop: spacing.sm,
  },
  errorWrap: {
    alignItems: 'center',
    alignSelf: 'center',
    justifyContent: 'center',
    position: 'absolute',
    top: '42%',
  },
  // 背板：整屏纯黑
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  // 照片层
  content: {
    flex: 1,
  },
  retryButton: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 16,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  root: {
    flex: 1,
  },
});
