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
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import type { PreviewImage } from './assetResolver';
import { shareFootprintImage } from './download';
import { formatTakenAt, readTakenAtFromFile } from './imageMetadata';
import { createVerticalPullHandler } from './previewGestures';

/** 预览里停留多久就把全分辨率那层挂上（毫秒） */
const PREVIEW_HI_RES_DELAY_MS = 1000;
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
  // 横屏查看：只在预览里把屏幕转过来，退出预览恢复竖屏
  const [landscape, setLandscape] = useState(false);
  // 下拉收起的位移（跟手）：容器据此同步变淡、轻微缩小
  const pull = useSharedValue(0);
  const overlayAnimatedStyle = useAnimatedStyle(() => {
    const progress = Math.min(1, Math.abs(pull.value) / 320);
    return {
      opacity: 1 - progress * 0.7,
      transform: [{ scale: 1 - progress * 0.06 }],
    };
  });
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
    if (visible) setIndex(initialIndex);
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

  const handleIndexChange = useCallback((nextIndex: number) => {
    setIndex(nextIndex);
    onIndexChange?.(nextIndex);
  }, [onIndexChange]);

  // 下拉超过阈值并松手时关闭（和系统「照片」一致的手感）。
  // Gallery 会在 UI 线程的 worklet 里直接调用它，所以必须由 createVerticalPullHandler 生成 worklet，
  // 不能直接传普通函数（那会闪退，见 previewGestures.ts）。
  const handleVerticalPull = useMemo(
    () => createVerticalPullHandler(onClose, pull),
    [onClose, pull],
  );

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
    setInteracting(true);
    markHiRes(uris[zoomIndex] ?? null);
  }, [markHiRes, uris]);

  const handleZoomEnd = useCallback(() => setInteracting(false), []);
  const handlePanStart = useCallback(() => setInteracting(true), []);
  const handlePanEnd = useCallback(() => setInteracting(false), []);

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
   * 循环滑动：滑到最后一张继续滑，绕回第一张；第一张反方向滑则跳到第最后一张。
   *
   * Gallery 在边界处会把位移 clamp 掉（画面不动），但用户回调仍然会收到方向，
   * 所以这里用 ref 直接跳页；setIndex 会更新 activeIndex，进而触发 onIndexChange，
   * 计数、拍摄时间、高清层这些都跟着走。
   */
  const galleryRef = useRef<GalleryRefType>(null);
  const handleSwipe = useCallback((direction: SwipeDirection) => {
    if (uris.length < 2) return;
    if (direction === 'left' && index >= uris.length - 1) {
      galleryRef.current?.setIndex(0);
    } else if (direction === 'right' && index <= 0) {
      galleryRef.current?.setIndex(uris.length - 1);
    }
  }, [index, uris.length]);

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
      animationType="fade"
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
        {/* 下拉时整体跟手变淡、轻微缩小，松手后由 previewGestures 把动画走完再关闭 */}
        <Animated.View style={[styles.overlay, overlayAnimatedStyle]}>
          {visible ? (
            <Gallery
              data={uris}
              // 横竖屏切换后容器尺寸变了，重新挂载让它重新测量；带上当前下标避免跳回第一张
              initialIndex={index}
              key={landscape ? 'landscape' : 'portrait'}
              keyExtractor={(uri, itemIndex) => `${uri}-${itemIndex}`}
              maxScale={6}
              onIndexChange={handleIndexChange}
              onPanEnd={handlePanEnd}
              onPanStart={handlePanStart}
              onSwipe={handleSwipe}
              onTap={onClose}
              onVerticalPull={handleVerticalPull}
              onZoomBegin={handleZoomBegin}
              onZoomEnd={handleZoomEnd}
              ref={galleryRef}
              renderItem={(uri) => (
                <PreviewItem
                  contentFit={contentFit}
                  hiRes={hiResUris.includes(uri)}
                  imageStyle={imageStyle}
                  key={uri}
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
        </Animated.View>
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
  overlay: {
    // 纯黑不透明背景：和系统「照片」一致，避免底下页面透出来（之前用 96% 半透明会隐约看到列表/FAB）
    backgroundColor: '#000',
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
