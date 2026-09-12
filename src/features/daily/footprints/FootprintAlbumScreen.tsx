import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage, type ImageSource, type ImageStyle } from 'expo-image';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View, type StyleProp } from 'react-native';

import { ScreenShell, Item } from '../_shared/ReplicatedScreens';
import { colors, radius, spacing, shadow } from '@/src/shared/theme';
import { buildAssetUrl } from '@/src/shared/api';
import { listFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { StateView } from '@/src/shared/components';
import { shareFootprintImage } from './download';
import { FootprintImagePreviewModal } from './FootprintImagePreviewModal';

const footprintAlbumImageSourceCache = new Map<string, ImageSource>();

function imageList(values?: string[] | string | null, fallback?: string | null) {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : fallback ? [fallback] : [];
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)));
}

function imageSourceFor(uri: string) {
  const cached = footprintAlbumImageSourceCache.get(uri);
  if (cached) return cached;
  const source = /^https?:\/\//i.test(uri) ? { uri, cacheKey: uri } : { uri };
  footprintAlbumImageSourceCache.set(uri, source);
  return source;
}

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

function footprintImageUris(item: Item) {
  return imageList(item.image_urls, item.image_url);
}

export function FootprintAlbumScreen({
  footprintId,
  onBack,
}: {
  footprintId: string;
  onBack: () => void;
}) {
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullImage, setFullImage] = useState<string | null>(null);
  const [downloadingFullImage, setDownloadingFullImage] = useState(false);

  const loadItem = async () => {
    try {
      setLoading(true);
      setError(null);
      const footprints = await listFootprintsLocal();
      const found = footprints.find((f) => f.id === footprintId);
      if (found) {
        setItem(found);
      } else {
        setError('未找到该足迹记录');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载足迹失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadItem();
  }, [footprintId]);

  const images = item ? footprintImageUris(item) : [];

  const handleDownloadFullImage = useCallback(async () => {
    if (!fullImage) return;
    try {
      setDownloadingFullImage(true);
      await shareFootprintImage(fullImage);
    } catch (err) {
      Alert.alert('下载失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      setDownloadingFullImage(false);
    }
  }, [fullImage]);

  return (
    <ScreenShell title="足迹相册" onBack={onBack}>
      <StateView loading={loading} error={error} onRetry={loadItem} />

      {!loading && !error && item && (
        <View style={albumStyles.container}>
          <View style={albumStyles.headerCard}>
            <View style={albumStyles.titleRow}>
              <View style={albumStyles.locationIconContainer}>
                <Ionicons name="location-outline" size={20} color={colors.warning} />
              </View>
              <Text style={albumStyles.locationTitle}>{item.location}</Text>
            </View>

            {item.coordinate ? (
              <View style={albumStyles.coordinateRow}>
                <Ionicons name="location" size={13} color={colors.primary} />
                <Text style={albumStyles.coordinateText}>{item.coordinate}</Text>
              </View>
            ) : null}

            <Text style={albumStyles.dateText}>到达日期：{item.visit_date}</Text>

            {item.notes ? (
              <Text style={albumStyles.notesText}>{item.notes}</Text>
            ) : null}
          </View>

          <View style={albumStyles.sectionHeader}>
            <Text style={albumStyles.sectionTitle}>所有照片</Text>
            <Text style={albumStyles.photoCount}>共 {images.length} 张</Text>
          </View>

          {images.length > 0 ? (
            <FlatList
              data={images}
              keyExtractor={(uri, idx) => `${uri}-${idx}`}
              numColumns={3}
              contentContainerStyle={albumStyles.grid}
              showsVerticalScrollIndicator={false}
              renderItem={({ item: uri }) => {
                const displayUri = buildAssetUrl(uri) || uri;
                return (
                  <Pressable
                    style={albumStyles.photoTile}
                    onPress={() => setFullImage(displayUri)}
                  >
                    <CachedFootprintImage uri={displayUri} style={albumStyles.photoImage} />
                  </Pressable>
                );
              }}
            />
          ) : (
            <View style={albumStyles.emptyContainer}>
              <Ionicons name="images-outline" size={48} color={colors.muted} />
              <Text style={albumStyles.emptyText}>
                此足迹还没有上传照片
              </Text>
            </View>
          )}
        </View>
      )}

      <FootprintImagePreviewModal
        uri={fullImage}
        onClose={() => setFullImage(null)}
        action={(
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={downloadingFullImage ? '正在下载图片' : '下载图片'}
            disabled={downloadingFullImage}
            onPress={(event) => {
              event.stopPropagation();
              void handleDownloadFullImage();
            }}
            style={[albumStyles.fullImageToolbarButton, downloadingFullImage && albumStyles.disabled]}
          >
            <Ionicons name="download-outline" size={18} color="#fff" />
            <Text style={albumStyles.fullImageToolbarText}>{downloadingFullImage ? '下载中' : '下载'}</Text>
          </Pressable>
        )}
      />
    </ScreenShell>
  );
}

const albumStyles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerCard: {
    backgroundColor: colors.surface,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.xl,
    ...shadow,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  locationIconContainer: {
    backgroundColor: colors.warningSoft,
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    flex: 1,
  },
  coordinateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  coordinateText: {
    fontSize: 14,
    color: colors.textSoft,
    fontWeight: '600',
  },
  dateText: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: '500',
    marginTop: 4,
  },
  notesText: {
    fontSize: 15,
    color: colors.textSoft,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  photoCount: {
    fontSize: 14,
    color: colors.muted,
    fontWeight: '500',
  },
  grid: {
    paddingHorizontal: spacing.md - 4,
    paddingBottom: spacing.xxl,
  },
  photoTile: {
    flex: 1 / 3,
    aspectRatio: 1,
    margin: 4,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.border,
    ...shadow,
  },
  photoImage: {
    width: '100%',
    height: '100%',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    marginTop: 40,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 15,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 22,
  },
  disabled: {
    opacity: 0.45,
  },
  fullImageToolbarButton: {
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
  fullImageToolbarText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
