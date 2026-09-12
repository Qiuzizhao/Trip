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
import { listFootprintsLocal, subscribeFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { styles } from '../_shared/styles';
import { Item, ScreenShell, SectionCard } from '../_shared/ReplicatedScreens';
import { FootprintImagePreviewModal } from './FootprintImagePreviewModal';
import { footprintDisplayImageUri, footprintImageUris, imageSourceFor, prefetchFootprintImages } from './imageCache';

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
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  const stats = useMemo(() => {
    return {
      total: items.length,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => {
      const locationMatch = String(item.location || '').toLowerCase().includes(query);
      const notesMatch = String(item.notes || '').toLowerCase().includes(query);
      const cityMatch = String(item.coordinate || '').toLowerCase().includes(query);
      return locationMatch || notesMatch || cityMatch;
    });
  }, [items, searchQuery]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const localItems = await listFootprintsLocal();
      setPreloadedData(homePreloadKeys.footprints, localItems);
      prefetchFootprintImages(localItems);
      setItems(localItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载足迹失败');
    }
  }, []);

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
  }), []);

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

            <StateView loading={false} error={error} onRetry={load} />
          </>
        )}
        maxToRenderPerBatch={6}
        renderItem={({ item }) => {
          const images = footprintImageUris(item);
          return (
            <Pressable
              onPress={() => onPressCard(item)}
              onLongPress={() => onEdit(item)}
              delayLongPress={350}
            >
              <SectionCard style={styles.recordCard}>
                <View style={styles.rowTop}>
                  <View style={[styles.recordIcon, { backgroundColor: colors.warningSoft }]}>
                    <Ionicons name="location-outline" size={22} color={colors.warning} />
                  </View>
                  <View style={styles.flex}>
                    <View style={{ gap: 2 }}>
                      <Text style={styles.itemTitle}>{item.location}</Text>
                      {item.coordinate ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 }}>
                          <Ionicons name="location" size={12} color={colors.primary} />
                          <Text style={{ fontSize: 13, color: colors.textSoft, fontWeight: '600' }}>
                            {item.coordinate}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.metaText, { marginTop: 4, marginBottom: spacing.xs }]}>{item.visit_date}</Text>
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
                                  setPreviewImage(displayUri);
                                }}
                                style={{ flex: 1 }}
                              >
                                <CachedFootprintImage uri={displayUri} style={{ height: '100%', width: '100%' }} />
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
                  </View>
                </View>
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
      <FootprintImagePreviewModal uri={previewImage} onClose={() => setPreviewImage(null)} />
    </ScreenShell>
  );
}
