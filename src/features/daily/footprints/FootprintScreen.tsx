// This screen renders footprint records which contain image_urls
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  FlatList,
  InteractionManager,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { StateView } from '@/src/shared/components';
import { colors } from '@/src/shared/theme';
import { postcardColors } from '../_shared/styles';
import { getPreloadedData, homePreloadKeys, setPreloadedData } from '@/src/local/homePreload';
import { isLocalOnlyMode, subscribeAppSettings } from '@/src/local/repositories/appSettingsRepository';
import { listFootprintIdsWithPendingAssets, subscribeAssetsLocal } from '@/src/local/repositories/assetRepository';
import { listFootprintsLocal, subscribeFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { styles } from '../_shared/styles';
import { Item, ScreenShell } from '../_shared/ReplicatedScreens';
import { FootprintImagePreviewModal } from './FootprintImagePreviewModal';
import { FootprintThumbnail } from './FootprintThumbnail';
import { resolveFootprintImageUris, type PreviewImage } from './assetResolver';
import { collectTagCounts, itemHasTag, normalizeTags } from './footprintTags';
import { tagColorFor } from './tagColors';
import { footprintDisplayImageUri, footprintImageUris, prefetchFootprintImages } from './imageCache';

/** 卡片上最多直接显示的标签数，多出来的折成 +N */
const MAX_VISIBLE_TAGS = 3;

/** 明信片"地址线"画多少段 */
const RULE_DASHES = Array.from({ length: 22 }, (_, index) => index);

/** 明信片邮戳上的年月（2026-09-05 → 09·05） */
function postmarkDay(visitDate?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(visitDate ?? '').trim());
  return match ? `${match[2]}·${match[3]}` : null;
}

/** 票根感的日期（2026-09-05 → 2026.09.05） */
function dottedDate(visitDate?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(visitDate ?? '').trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : String(visitDate ?? '');
}

/** 明信片的"地址线"：一条条画出来，保证 iOS 上一定是虚线 */
function PostcardRule() {
  return (
    <View style={styles.postcardRule}>
      <View style={styles.postcardRuleDashes}>
        {RULE_DASHES.map((key) => (
          <View key={key} style={styles.postcardRuleDash} />
        ))}
      </View>
    </View>
  );
}

/** 卡片进入：fade + 上移 12px，按 index 错开 40ms；按下缩放 0.985 */
function PostcardPressable({
  children,
  index,
  onLongPress,
  onPress,
}: {
  children: React.ReactNode;
  index: number;
  onLongPress: () => void;
  onPress: () => void;
}) {
  const enter = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(enter, {
      delay: Math.min(index, 8) * 40,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [enter, index]);

  const animatePress = (toValue: number) => {
    Animated.timing(press, { duration: 150, toValue, useNativeDriver: true }).start();
  };

  return (
    <Animated.View
      style={{
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
          { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.985] }) },
        ],
      }}
    >
      <Pressable
        delayLongPress={350}
        onLongPress={onLongPress}
        onPress={onPress}
        onPressIn={() => animatePress(1)}
        onPressOut={() => animatePress(0)}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

/** 标签胶囊：按下缩到 0.94、松开弹回 1 */
function SpringPill({
  accessibilityLabel,
  children,
  onPress,
  style,
}: {
  accessibilityLabel: string;
  children: React.ReactNode;
  onPress: () => void;
  style: any;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { bounciness: 0, speed: 40, toValue: 0.94, useNativeDriver: true }).start()}
      onPressOut={() => Animated.spring(scale, { bounciness: 12, speed: 14, toValue: 1, useNativeDriver: true }).start()}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

export function FootprintScreen({
  onBack,
  onSettings,
  onCreate,
  onEdit,
  onPressCard,
  rightAction,
}: {
  onBack?: () => void;
  onSettings?: () => void;
  onCreate: () => void;
  onEdit: (item: Item) => void;
  onPressCard: (item: Item) => void;
  rightAction?: React.ReactNode;
}) {
  const [items, setItems] = useState<Item[]>(() => getPreloadedData<Item[]>(homePreloadKeys.footprints) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ items: PreviewImage[]; index: number } | null>(null);
  const [pendingAssetIds, setPendingAssetIds] = useState<Set<string>>(() => new Set());
  // 本地模式下图片只留在本机，不存在「待同步」这回事，也不再显示对应标记
  const [localOnly, setLocalOnly] = useState(false);
  const [resolvedAssetUris, setResolvedAssetUris] = useState<Record<string, string[]>>({});

  const stats = useMemo(() => {
    return {
      total: items.length,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (!itemHasTag(item, activeTag)) return false;
      if (!query) return true;
      const locationMatch = String(item.location || '').toLowerCase().includes(query);
      const notesMatch = String(item.notes || '').toLowerCase().includes(query);
      const cityMatch = String(item.coordinate || '').toLowerCase().includes(query);
      const tagMatch = normalizeTags(item.tags).some((tag) => tag.toLowerCase().includes(query));
      return locationMatch || notesMatch || cityMatch || tagMatch;
    });
  }, [items, searchQuery, activeTag]);

  const tagCounts = useMemo(() => collectTagCounts(items), [items]);

  // 标签在筛选状态下被删掉时，避免留下一个空列表
  useEffect(() => {
    if (activeTag && !tagCounts.some((entry) => entry.tag === activeTag)) setActiveTag(null);
  }, [activeTag, tagCounts]);

  // 解析每条记录的展示用图片 URI（asset 优先：本地文件在就用本地，否则用远端对象）。
  // 记录或资产变化时都要刷新，否则同步后新加的记录不会显示图片。
  const refreshResolvedAssetUris = useCallback(async (nextItems: Item[]) => {
    const entries = await Promise.all(nextItems.map(async (item) => (
      [String(item.id), await resolveFootprintImageUris(String(item.id), footprintImageUris(item))] as const
    )));
    setResolvedAssetUris(Object.fromEntries(entries));
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const localOnlyMode = await isLocalOnlyMode();
      setLocalOnly(localOnlyMode);
      const localItems = await listFootprintsLocal();
      setPreloadedData(homePreloadKeys.footprints, localItems);
      prefetchFootprintImages(localItems);
      setItems(localItems);
      setPendingAssetIds(localOnlyMode ? new Set() : await listFootprintIdsWithPendingAssets());
      await refreshResolvedAssetUris(localItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载足迹失败');
    }
  }, [refreshResolvedAssetUris]);

  useFocusEffect(
    useCallback(() => {
      const task = InteractionManager.runAfterInteractions(() => {
        void load();
      });
      return () => task.cancel();
    }, [load]),
  );

  // 设置页里开关本地模式后，列表上的「图片待同步」要立刻跟着消失/恢复
  useEffect(() => subscribeAppSettings((settings) => {
    setLocalOnly(settings.localOnlyMode);
    if (settings.localOnlyMode) setPendingAssetIds(new Set());
  }), []);

  useEffect(() => subscribeFootprintsLocal((nextItems) => {
    setPreloadedData(homePreloadKeys.footprints, nextItems);
    prefetchFootprintImages(nextItems);
    setItems(nextItems);
    void refreshResolvedAssetUris(nextItems);
    if (!localOnly) {
      void listFootprintIdsWithPendingAssets().then(setPendingAssetIds).catch(() => undefined);
    }
  }), [refreshResolvedAssetUris, localOnly]);

  // 资产变化（上传成功/下载完成/失败标记）也要刷新，否则新增记录在 asset 建立前就被解析成空
  useEffect(() => subscribeAssetsLocal(() => {
    void listFootprintsLocal()
      .then((nextItems) => refreshResolvedAssetUris(nextItems))
      .catch(() => undefined);
    if (!localOnly) {
      void listFootprintIdsWithPendingAssets().then(setPendingAssetIds).catch(() => undefined);
    }
  }), [refreshResolvedAssetUris, localOnly]);

  return (
    <ScreenShell title="足迹" onBack={onBack} onSettings={onSettings} rightAction={rightAction}>
      <FlatList
        contentContainerStyle={styles.content}
        data={!error ? filteredItems : []}
        initialNumToRender={8}
        keyExtractor={(item) => String(item.id)}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={(
          <>
            <View style={styles.postcardHeroBlock}>
              {/* 顶部一片天空：明亮的底色，配合纸片卡片 */}
              <LinearGradient
                colors={[postcardColors.sky, '#F7FAFF', 'rgba(247,248,250,0)']}
                end={{ x: 0.5, y: 1 }}
                pointerEvents="none"
                start={{ x: 0.5, y: 0 }}
                style={styles.postcardHeroGradient}
              />
              <View style={styles.postcardHeroTop}>
                <View>
                  <Text style={styles.postcardHeroLabel}>去过的地方</Text>
                  <View style={styles.postcardHeroValueRow}>
                    <Text style={styles.postcardHeroValue}>{stats.total}</Text>
                    <Text style={styles.postcardHeroUnit}>个</Text>
                  </View>
                </View>
                <LinearGradient
                  colors={['#FFE9BE', '#FDD79A']}
                  end={{ x: 1, y: 1 }}
                  start={{ x: 0, y: 0 }}
                  style={styles.postcardHeroIcon}
                >
                  <Ionicons name="compass-outline" size={24} color="#8A5B12" />
                </LinearGradient>
              </View>

              <View style={styles.postcardSearch}>
                <Ionicons name="search-outline" size={18} color={postcardColors.inkFaint} />
                <TextInput
                  placeholder="搜索地点、见闻、标签…"
                  placeholderTextColor={postcardColors.inkFaint}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  style={[styles.postcardSearchInput, { outlineStyle: 'none' } as any]}
                  clearButtonMode="while-editing"
                />
                {searchQuery.length > 0 && (
                  <Pressable onPress={() => setSearchQuery('')}>
                    <Ionicons name="close-circle" size={16} color={postcardColors.inkFaint} />
                  </Pressable>
                )}
              </View>

              {tagCounts.length ? (
                <View style={styles.postcardPills}>
                  <SpringPill
                    accessibilityLabel="显示全部足迹"
                    onPress={() => setActiveTag(null)}
                    style={[styles.postcardPill, !activeTag && styles.postcardPillSelected]}
                  >
                    <Text style={[styles.postcardPillText, !activeTag && styles.postcardPillTextSelected]}>
                      全部 {items.length}
                    </Text>
                  </SpringPill>
                  {tagCounts.map(({ tag, count }) => {
                    const selected = activeTag === tag;
                    return (
                      <SpringPill
                        key={tag}
                        accessibilityLabel={`按标签 ${tag} 筛选`}
                        onPress={() => setActiveTag(selected ? null : tag)}
                        style={[styles.postcardPill, selected && styles.postcardPillSelected]}
                      >
                        <View style={[styles.postcardPillDot, { backgroundColor: tagColorFor(tag).color }]} />
                        <Text style={[styles.postcardPillText, selected && styles.postcardPillTextSelected]}>
                          {tag} {count}
                        </Text>
                      </SpringPill>
                    );
                  })}
                </View>
              ) : null}

              <StateView loading={false} error={error} onRetry={load} />
            </View>

          </>
        )}
        maxToRenderPerBatch={6}
        renderItem={({ item, index: cardIndex }) => {
          const images = resolvedAssetUris[String(item.id)] ?? footprintImageUris(item);
          const hasPendingAssets = !localOnly && pendingAssetIds.has(String(item.id));
          const tags = normalizeTags(item.tags);
          const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
          const hiddenTagCount = tags.length - visibleTags.length;
          const stampDay = postmarkDay(item.visit_date);
          const place = String(item.coordinate || '').trim();
          const openPreview = (index: number) => setPreview({ items: images.map((uri) => ({ uri })), index });

          const syncBadge = hasPendingAssets ? (
            <View style={styles.postcardSyncBadge}>
              <Ionicons name="cloud-upload-outline" size={12} color="#B4761B" />
              <Text style={styles.postcardSyncText}>图片待同步</Text>
            </View>
          ) : null;

          const stamp = stampDay ? (
            <View pointerEvents="none" style={styles.postcardStamp}>
              <Text style={styles.postcardStampDay}>{stampDay}</Text>
              {place ? (
                <Text numberOfLines={1} style={styles.postcardStampCity}>{place.toUpperCase()}</Text>
              ) : null}
            </View>
          ) : null;

          const photo = (key: string, uri: string, style: any, index: number, overlay?: React.ReactNode) => (
            <Pressable
              key={key}
              accessibilityLabel="放大足迹照片"
              accessibilityRole="imagebutton"
              onPress={(event) => {
                event.stopPropagation();
                openPreview(index);
              }}
              style={style}
            >
              <FootprintThumbnail uri={footprintDisplayImageUri(uri)} style={{ height: '100%', width: '100%' }} />
              {overlay}
            </Pressable>
          );

          const foot = (
            <>
              <PostcardRule />
              <View style={styles.postcardFoot}>
                <View style={styles.postcardChips}>
                  {visibleTags.map((tag) => {
                    const tone = tagColorFor(tag);
                    return (
                      <View key={tag} style={[styles.postcardChip, { backgroundColor: tone.backgroundColor }]}>
                        <View style={[styles.postcardChipDot, { backgroundColor: tone.color }]} />
                        <Text style={[styles.postcardChipText, { color: tone.color }]}>{tag}</Text>
                      </View>
                    );
                  })}
                  {hiddenTagCount > 0 ? (
                    <View style={[styles.postcardChip, { backgroundColor: 'rgba(35,41,47,0.06)' }]}>
                      <Text style={[styles.postcardChipText, { color: postcardColors.inkSoft }]}>+{hiddenTagCount}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.postcardDate}>{dottedDate(item.visit_date)}</Text>
              </View>
            </>
          );

          const body = (
            <>
              <View style={styles.postcardBody}>
                <View style={styles.postcardPlaceRow}>
                  <Text numberOfLines={1} style={styles.postcardPlace}>{item.location}</Text>
                  {place ? (
                    <View style={styles.postcardCityRow}>
                      <Ionicons name="location" size={12} color={postcardColors.sun} />
                      <Text numberOfLines={1} style={styles.postcardCity}>{place}</Text>
                    </View>
                  ) : null}
                </View>
                {item.notes ? (
                  <Text numberOfLines={2} style={styles.postcardNote}>{item.notes}</Text>
                ) : null}
              </View>
              {foot}
            </>
          );

          return (
            <PostcardPressable
              index={cardIndex}
              onLongPress={() => onEdit(item)}
              onPress={() => onPressCard(item)}
            >
              {images.length === 0 ? (
                /* 无照片：票根（淡蓝→暖白渐变 + 左右撕口 + 右侧邮票框） */
                <View style={styles.postcardTicket}>
                  <LinearGradient
                    colors={['#FFFFFF', '#FFF7E8', '#EAF4FF']}
                    end={{ x: 1, y: 1 }}
                    pointerEvents="none"
                    start={{ x: 0, y: 0 }}
                    style={StyleSheet.absoluteFill}
                  />
                  <View pointerEvents="none" style={[styles.postcardTicketNotch, { left: -11 }]} />
                  <View pointerEvents="none" style={[styles.postcardTicketNotch, { right: -11 }]} />
                  <View style={styles.postcardTicketRow}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.postcardPlaceRow}>
                        <Text numberOfLines={1} style={styles.postcardPlace}>{item.location}</Text>
                      </View>
                      {place ? (
                        <View style={styles.postcardCityRow}>
                          <Ionicons name="location" size={12} color={postcardColors.sun} />
                          <Text numberOfLines={1} style={styles.postcardCity}>{place}</Text>
                        </View>
                      ) : null}
                      <Text numberOfLines={2} style={styles.postcardNote}>
                        {item.notes || '旅行可以后补 —— 加几张照片，明信片就完整了。'}
                      </Text>
                    </View>
                    <View style={styles.postcardTicketStamp}>
                      <Text style={styles.postcardTicketStampText}>{'照片\n待补'}</Text>
                    </View>
                  </View>
                  {foot}
                </View>
              ) : (
                <View style={styles.postcardCard}>
                  {images.length === 1 ? (
                    photo('main', images[0], styles.postcardPhotoFull, 0, <>{stamp}{syncBadge}</>)
                  ) : images.length === 2 ? (
                    <View style={styles.postcardPhotoRow}>
                      {photo('main', images[0], styles.postcardPhotoMain, 0, <>{stamp}{syncBadge}</>)}
                      <View style={styles.postcardPhotoSide}>
                        {photo('side-0', images[1], styles.postcardPhotoSideSquare, 1)}
                      </View>
                    </View>
                  ) : (
                    <View style={styles.postcardPhotoRow}>
                      {photo('main', images[0], styles.postcardPhotoMain, 0, <>{stamp}{syncBadge}</>)}
                      <View style={styles.postcardPhotoSide}>
                        {images.slice(1, 3).map((uri, idx) => photo(
                          `side-${idx}`,
                          uri,
                          styles.postcardPhotoSideCell,
                          idx + 1,
                          idx === 1 && images.length > 3 ? (
                            <View style={styles.postcardNoteCount}>
                              <Text style={styles.postcardNoteCountText}>+{images.length - 3}</Text>
                            </View>
                          ) : null,
                        ))}
                      </View>
                    </View>
                  )}
                  {body}
                </View>
              )}
            </PostcardPressable>
          );
        }}
        showsVerticalScrollIndicator={false}
        windowSize={7}
      />

      <Pressable style={styles.fab} onPress={onCreate}>
        <LinearGradient colors={[colors.primary, colors.primaryDark]} style={styles.fabGradient}>
          <Ionicons name="add" size={32} color="#fff" />
        </LinearGradient>
      </Pressable>
      <FootprintImagePreviewModal
        initialIndex={preview?.index ?? 0}
        items={preview?.items ?? []}
        onClose={() => setPreview(null)}
      />
    </ScreenShell>
  );
}
