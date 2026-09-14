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
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gallery } from 'react-native-zoom-toolkit';

import { spacing } from '@/src/shared/theme';
import type { PreviewImage } from './assetResolver';
import { formatTakenAt, readTakenAtFromFile } from './imageMetadata';
import { createVerticalPullHandler } from './previewGestures';

type FootprintImagePreviewModalProps = {
  action?: React.ReactNode;
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
}: FootprintImagePreviewModalProps) {
  const uris = useMemo(() => items.map((entry) => entry.uri), [items]);
  const visible = uris.length > 0;
  const [index, setIndex] = useState(initialIndex);
  // 失败的图片（uri -> 重试次数），用于展示「图片不可用」并支持重试
  const [failedUris, setFailedUris] = useState<Record<string, number>>({});
  const [reloadToken, setReloadToken] = useState(0);
  // 已经触发过「放大看细节」的图（uri）：这些图会多叠一层全分辨率位图
  const [hiResUris, setHiResUris] = useState<Set<string>>(() => new Set());
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

  useEffect(() => {
    if (visible) setIndex(initialIndex);
  }, [initialIndex, visible]);

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
    () => createVerticalPullHandler(onClose),
    [onClose],
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
  const handleZoomBegin = useCallback((zoomIndex: number) => {
    const uri = uris[zoomIndex];
    if (!uri) return;
    setHiResUris((previous) => (previous.has(uri) ? previous : new Set(previous).add(uri)));
  }, [uris]);

  const topOffset = useMemo(() => insets.top + 8, [insets.top]);
  const bottomOffset = useMemo(() => Math.max(insets.bottom, spacing.lg) + spacing.md, [insets.bottom]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      {/* Modal 渲染在独立的原生根视图里，手势必须自己包一层 GestureHandlerRootView */}
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.overlay}>
          {visible ? (
            <Gallery
              data={uris}
              initialIndex={initialIndex}
              keyExtractor={(uri, itemIndex) => `${uri}-${itemIndex}`}
              maxScale={6}
              onIndexChange={handleIndexChange}
              onTap={onClose}
              onVerticalPull={handleVerticalPull}
              onZoomBegin={handleZoomBegin}
              renderItem={(uri) => (
                <View style={{ height: windowHeight, width: windowWidth }}>
                  <ExpoImage
                    cachePolicy="memory-disk"
                    contentFit={contentFit}
                    // 第一层：按屏幕尺寸解码（enforceEarlyResizing 让 ImageIO 直接出小图），
                    // 打开即有图、内存也小；HDR 同样保留（这条路径实测 headroom 仍是 2.30）。
                    enforceEarlyResizing
                    key={`${uri}-${reloadToken}-screen`}
                    onError={() => {
                      setFailedUris((previous) => ({ ...previous, [uri]: (previous[uri] ?? 0) + 1 }));
                    }}
                    priority="high"
                    source={{ uri }}
                    style={[{ height: windowHeight, width: windowWidth }, imageStyle]}
                    transition={0}
                  />
                  {hiResUris.has(uri) ? (
                    <ExpoImage
                      // 放大后叠上全分辨率那层：
                      // - allowDownscaling=false：不要缩到屏幕尺寸，保留原分辨率，放大才清晰；
                      // - 独立 cacheKey：SDWebImage 的内存缓存按 key 命中，
                      //   沿用同一个 key 会直接返回上一层那张小图，等于白解。
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
                </View>
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
            accessibilityLabel="关闭图片预览"
            accessibilityRole="button"
            onPress={onClose}
            style={[styles.closeButton, { top: topOffset }]}
          >
            <Ionicons name="close" size={26} color="#fff" />
          </Pressable>

          {action ? <View style={[styles.actionWrap, { bottom: bottomOffset }]}>{action}</View> : null}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  actionWrap: {
    left: spacing.lg,
    position: 'absolute',
    right: spacing.lg,
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
