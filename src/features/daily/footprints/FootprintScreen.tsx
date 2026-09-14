// This screen renders footprint records which contain image_urls
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { Image as ExpoImage, type ImageStyle } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, InteractionManager, Pressable, Text, View, TextInput, StyleSheet, type StyleProp } from 'react-native';

import { StateView } from '@/src/shared/components';
import { colors, spacing } from '@/src/shared/theme';
import { getPreloadedData, homePreloadKeys, setPreloadedData } from '@/src/local/homePreload';
import { listFootprintIdsWithPendingAssets, subscribeAssetsLocal } from '@/src/local/repositories/assetRepository';
import { listFootprintsLocal, subscribeFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { styles } from '../_shared/styles';
import { Item, ScreenShell, SectionCard, Tag } from '../_shared/ReplicatedScreens';
import { FootprintImagePreviewModal } from './FootprintImagePreviewModal';
import { resolveFootprintImageUris, type PreviewImage } from './assetResolver';
import { collectTagCounts, itemHasTag, normalizeTags } from './footprintTags';
import { tagColorFor } from './tagColors';
import { footprintDisplayImageUri, footprintImageUris, imageSourceFor, prefetchFootprintImages, thumbnailUrlFor } from './imageCache';

/** 卡片上最多直接显示的标签数，多出来的折成 +N */
const MAX_VISIBLE_TAGS = 3;

function CachedFootprintImage({
  uri,
  style,
  contentFit = 'cover',
}: {
  uri: string;
  style: StyleProp<ImageStyle>;
  contentFit?: 'cover' | 'contain';
}) {
  return (
    <ExpoImage
      cachePolicy="memory-disk"
      contentFit={contentFit}
      priority="high"
      source={imageSourceFor(uri)}
      style={style}
      transition={0}
    />
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
      const localItems = await listFootprintsLocal();
      setPreloadedData(homePreloadKeys.footprints, localItems);
      prefetchFootprintImages(localItems);
      setItems(localItems);
      setPendingAssetIds(await listFootprintIdsWithPendingAssets());
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

  useEffect(() => subscribeFootprintsLocal((nextItems) => {
    setPreloadedData(homePreloadKeys.footprints, nextItems);
    prefetchFootprintImages(nextItems);
    setItems(nextItems);
    void refreshResolvedAssetUris(nextItems);
    void listFootprintIdsWithPendingAssets().then(setPendingAssetIds).catch(() => undefined);
  }), [refreshResolvedAssetUris]);

  // 资产变化（上传成功/下载完成/失败标记）也要刷新，否则新增记录在 asset 建立前就被解析成空
  useEffect(() => subscribeAssetsLocal(() => {
    void listFootprintsLocal()
      .then((nextItems) => refreshResolvedAssetUris(nextItems))
      .catch(() => undefined);
    void listFootprintIdsWithPendingAssets().then(setPendingAssetIds).catch(() => undefined);
  }), [refreshResolvedAssetUris]);

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
            <View style={styles.summaryHero}>
              <View style={styles.summaryHeroTop}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.summaryHeroLabel}>去过的地方</Text>
                  <Text style={styles.summaryHeroValue}>{stats.total} 个</Text>
                </View>
                <View style={[styles.summaryHeroIcon, { backgroundColor: colors.warningSoft }]}>
                  <Ionicons name="map-outline" size={25} color={colors.warning} />
                </View>
              </View>
            </View>

            <View
              style={[
                styles.searchPanel,
                {
                  marginHorizontal: 0,
                  marginTop: spacing.md,
                  marginBottom: spacing.xs,
                  borderWidth: 0.8,
                  borderColor: 'rgba(0, 0, 0, 0.04)',
                }
              ]}
            >
              <Ionicons name="search-outline" size={18} color={colors.muted} />
              <TextInput
                placeholder="搜索地点、见闻记录等..."
                placeholderTextColor={colors.muted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                style={[styles.searchInput, { outlineStyle: 'none' } as any]}
                clearButtonMode="while-editing"
              />
              {searchQuery.length > 0 && (
                <Pressable onPress={() => setSearchQuery('')}>
                  <Ionicons name="close-circle" size={16} color={colors.faint} />
                </Pressable>
              )}
            </View>

            {tagCounts.length ? (
              <View style={[styles.pills, { marginTop: spacing.xs }]}>
                <Pressable
                  accessibilityLabel="显示全部足迹"
                  accessibilityRole="button"
                  onPress={() => setActiveTag(null)}
                  style={[styles.pill, !activeTag && styles.pillSelected]}
                >
                  <Text style={[styles.pillText, !activeTag && styles.pillTextSelected]}>
                    全部 {items.length}
                  </Text>
                </Pressable>
                {tagCounts.map(({ tag, count }) => {
                  const selected = activeTag === tag;
                  return (
                    <Pressable
                      key={tag}
                      accessibilityLabel={`按标签 ${tag} 筛选`}
                      accessibilityRole="button"
                      onPress={() => setActiveTag(selected ? null : tag)}
                      style={[styles.pill, selected && styles.pillSelected]}
                    >
                      <Text style={[styles.pillText, selected && styles.pillTextSelected]}>
                        {tag} {count}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            <StateView loading={false} error={error} onRetry={load} />
          </>
        )}
        maxToRenderPerBatch={6}
        renderItem={({ item }) => {
          const images = resolvedAssetUris[String(item.id)] ?? footprintImageUris(item);
          const hasPendingAssets = pendingAssetIds.has(String(item.id));
          const tags = normalizeTags(item.tags);
          const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
          return (
            <Pressable
              onPress={() => onPressCard(item)}
              onLongPress={() => onEdit(item)}
              delayLongPress={350}
            >
              <SectionCard style={styles.recordCard}>
                <View style={styles.recordCardHeader}>
                  <View style={[styles.recordCardIcon, { backgroundColor: colors.warningSoft }]}>
                    <Ionicons name="location-outline" size={18} color={colors.warning} />
                  </View>
                  <View style={styles.recordCardTitleRow}>
                    <Text numberOfLines={1} style={styles.recordCardTitle}>{item.location}</Text>
                    {item.coordinate ? (
                      <>
                        <Text style={styles.recordCardDot}>·</Text>
                        <Text numberOfLines={1} style={styles.recordCardCoordinate}>{item.coordinate}</Text>
                      </>
                    ) : null}
                  </View>
                </View>

                <View style={styles.recordCardMeta}>
                  <Text style={styles.metaText}>{item.visit_date}</Text>
                  {visibleTags.map((tag) => (
                    <Tag key={tag} compact label={tag} {...tagColorFor(tag)} />
                  ))}
                  {tags.length > visibleTags.length ? (
                    <Tag compact label={`+${tags.length - visibleTags.length}`} tone="gray" />
                  ) : null}
                  {hasPendingAssets ? (
                    <View style={styles.pendingBadge}>
                      <Ionicons name="cloud-upload-outline" size={11} color={colors.warning} />
                      <Text style={styles.pendingBadgeText}>图片待同步</Text>
                    </View>
                  ) : null}
                </View>

                {images.length > 0 ? (
                      <View style={styles.footprintImageGrid}>
                        {images.slice(0, 3).map((uri, idx) => {
                          const displayUri = footprintDisplayImageUri(uri);
                          const isOnlyImage = images.length === 1;
                          const isLastVisible = idx === 2;
                          const hasMore = images.length > 3;
                          return (
                            <View
                              key={`${uri}-${idx}`}
                              style={[
                                styles.footprintImageTile,
                                isOnlyImage && styles.footprintImageTileLarge,
                                images.length === 2 && { height: 120, width: '48.5%' },
                              ]}
                            >
                              <Pressable
                                accessibilityLabel="放大足迹照片"
                                accessibilityRole="imagebutton"
                                onPress={(event) => {
                                  event.stopPropagation();
                                  setPreview({ items: images.map((uri) => ({ uri })), index: idx });
                                }}
                                style={{ flex: 1 }}
                              >
                                <CachedFootprintImage uri={thumbnailUrlFor(displayUri)} style={{ height: '100%', width: '100%' }} />
                              </Pressable>
                              {isLastVisible && hasMore ? (
                                <View
                                  style={{
                                    ...StyleSheet.absoluteFillObject,
                                    alignItems: 'center',
                                    backgroundColor: 'rgba(0, 0, 0, 0.45)',
                                    justifyContent: 'center',
                                  }}
                                >
                                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                                    +{images.length - 3}
                                  </Text>
                                </View>
                              ) : null}
                            </View>
                          );
                        })}
                      </View>
                ) : null}
                {item.notes ? <Text style={[styles.bodyText, { marginTop: 4 }]}>{item.notes}</Text> : null}
              </SectionCard>
            </Pressable>
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
