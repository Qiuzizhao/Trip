import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { StateView } from '@/src/shared/components';
import { listFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { spacing } from '@/src/shared/theme';
import { Item, ScreenShell } from '../_shared/ReplicatedScreens';
import { postcardColors, postcardShadowSoft, styles as shared } from '../_shared/styles';
import { FootprintImagePreviewModal } from './FootprintImagePreviewModal';
import { FootprintThumbnail } from './FootprintThumbnail';
import { resolveFootprintImages, type PreviewImage } from './assetResolver';
import { shareFootprintImage } from './download';
import { footprintDisplayImageUri } from './imageCache';
import { normalizeTags } from './footprintTags';
import { tagColorFor } from './tagColors';

function imageList(values?: string[] | string | null, fallback?: string | null) {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : fallback ? [fallback] : [];
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)));
}

function footprintImageUris(item: Item) {
  return imageList(item.image_urls, item.image_url);
}

/** 票头邮戳用的日期拆解：2026-09-05 → 2026 / 09·05 / 2026.09.05 */
function dateParts(visitDate?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(visitDate ?? '').trim());
  if (!match) return null;
  return { year: match[1], day: `${match[2]}·${match[3]}`, dotted: `${match[1]}.${match[2]}.${match[3]}` };
}

function timeLabel(takenAt?: number | null) {
  if (!takenAt) return null;
  const date = new Date(takenAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function FootprintAlbumScreen({
  footprintId,
  onBack,
  onEdit,
}: {
  footprintId: string;
  onBack: () => void;
  /** 右上角「编辑这条足迹」入口；不传则不显示 */
  onEdit?: (item: Item) => void;
}) {
  const [item, setItem] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullIndex, setFullIndex] = useState<number | null>(null);
  const [resolvedImages, setResolvedImages] = useState<PreviewImage[] | null>(null);
  const [sharing, setSharing] = useState(false);

  const loadItem = async () => {
    try {
      setLoading(true);
      setError(null);
      const footprints = await listFootprintsLocal();
      const found = footprints.find((f) => f.id === footprintId);
      if (found) {
        setItem(found);
        setResolvedImages(await resolveFootprintImages(String(found.id), footprintImageUris(found)));
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

  // 展示用 URI 列表（照片墙、下载按钮）+ 预览用条目（带拍摄时间）
  const imageItems = useMemo<PreviewImage[]>(
    () => resolvedImages ?? (item ? footprintImageUris(item).map((uri) => ({ uri })) : []),
    [item, resolvedImages],
  );
  const images = useMemo(() => imageItems.map((entry) => entry.uri), [imageItems]);
  const tags = useMemo(() => (item ? normalizeTags(item.tags) : []), [item]);
  const parts = dateParts(item?.visit_date);
  const signTime = timeLabel(imageItems[0]?.takenAt);

  // 两列拍立得：奇数张时补一个占位，避免最后一张被拉满整行
  const wallData = useMemo(
    () => {
      const entries = imageItems.map((entry, index) => ({ ...entry, index }));
      return entries.length % 2 === 1 ? [...entries, null] : entries;
    },
    [imageItems],
  );

  const editAction = onEdit && item ? (
    <Pressable
      accessibilityLabel="编辑这条足迹"
      accessibilityRole="button"
      onPress={() => onEdit(item)}
      style={local.editButton}
    >
      <Ionicons name="create-outline" size={19} color={postcardColors.ink} />
    </Pressable>
  ) : undefined;

  const shareImageAt = async (uri: string) => {
    if (!uri || sharing) return;
    try {
      setSharing(true);
      await shareFootprintImage(footprintDisplayImageUri(uri));
    } catch (err) {
      Alert.alert('下载失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      setSharing(false);
    }
  };

  /** 单张直接下载；多张先让你选是哪一张（系统分享一次只能出一个文件） */
  const downloadOriginals = () => {
    if (!images.length) return;
    if (images.length === 1) {
      void shareImageAt(images[0]);
      return;
    }
    const MAX_CHOICES = 6;
    const choices = imageItems.slice(0, MAX_CHOICES).map((entry, index) => {
      const time = timeLabel(entry.takenAt);
      return {
        text: `第 ${index + 1} 张${time ? ` · ${time}` : ''}`,
        onPress: () => { void shareImageAt(entry.uri); },
      };
    });
    Alert.alert(
      '下载原图',
      images.length > MAX_CHOICES
        ? `这条足迹有 ${images.length} 张照片，这里先列前 ${MAX_CHOICES} 张；其余的点开照片，在全屏预览里逐张下载。`
        : `这条足迹有 ${images.length} 张照片，选择要下载的那一张。`,
      [...choices, { text: '取消', style: 'cancel' as const }],
    );
  };

  const header = item ? (
    <View>
      <View style={shared.albumHeroBlock}>
        <View style={shared.albumHeroRow}>
          <View style={shared.albumHeroInfo}>
            <Text style={shared.albumHeroTitle}>{item.location}</Text>
            {item.coordinate ? (
              <View style={shared.albumHeroCity}>
                <Ionicons name="location" size={13} color={postcardColors.sun} />
                <Text numberOfLines={1} style={shared.albumHeroCityText}>{item.coordinate}</Text>
              </View>
            ) : null}
            {tags.length ? (
              <View style={shared.albumHeroTags}>
                {tags.map((tag) => {
                  const tone = tagColorFor(tag);
                  return (
                    <View
                      key={tag}
                      style={[shared.postcardChip, local.tagChip, { backgroundColor: tone.backgroundColor }]}
                    >
                      <View style={[shared.postcardChipDot, { backgroundColor: tone.color }]} />
                      <Text style={[shared.postcardChipText, { color: tone.color }]}>{tag}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>

          {parts ? (
            <View style={shared.albumStamp}>
              <Text style={shared.albumStampYear}>{parts.year}</Text>
              <Text style={shared.albumStampDay}>{parts.day}</Text>
              {item.coordinate ? (
                <Text numberOfLines={1} style={shared.albumStampCity}>{item.coordinate.toUpperCase()}</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>

      {item.notes ? (
        <View style={shared.albumNoteCard}>
          <LinearGradient
            colors={['#FFD9A8', '#BFE3FF']}
            end={{ x: 0, y: 1 }}
            pointerEvents="none"
            start={{ x: 0, y: 0 }}
            style={shared.albumNoteBar}
          />
          <Text style={shared.albumNoteText}>{item.notes}</Text>
          <Text style={shared.albumNoteSign}>— 记于 {signTime ?? parts?.dotted ?? item.visit_date}</Text>
        </View>
      ) : null}

      {images.length ? (
        <View style={shared.albumWallHead}>
          <Text style={shared.albumWallTitle}>照片 · {images.length} 张</Text>
          <Text style={shared.albumWallCount}>{parts?.dotted ?? String(item.visit_date ?? '')}</Text>
        </View>
      ) : null}
    </View>
  ) : null;

  const footer = item ? (
    images.length ? (
      <View style={shared.albumToolbar}>
        <View>
          <Text style={shared.albumToolbarTitle}>共 {images.length} 张</Text>
          <Text style={shared.albumToolbarSub}>拍摄于 {parts?.dotted ?? item.visit_date}</Text>
        </View>
        <Pressable
          accessibilityLabel="下载原图"
          accessibilityRole="button"
          disabled={sharing}
          onPress={downloadOriginals}
          style={[local.downloadButton, sharing && local.downloadButtonBusy]}
        >
          {sharing ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Ionicons name="download-outline" size={16} color="#FFFFFF" />
          )}
          <Text style={local.downloadText}>{sharing ? '下载中' : '下载原图'}</Text>
        </Pressable>
      </View>
    ) : (
      <View style={[shared.albumEmptyCard, local.emptyCard]}>
        <LinearGradient
          colors={['#FFFFFF', '#FFF7E8', '#EAF4FF']}
          end={{ x: 1, y: 1 }}
          pointerEvents="none"
          start={{ x: 0, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={local.emptyStamp}>
          <Text style={local.emptyStampText}>{'照片\n待补'}</Text>
        </View>
        <Text style={local.emptyTitle}>这条足迹还没有照片</Text>
        <Text style={local.emptySub}>旅行可以后补 —— 把当时的照片加进来，明信片就完整了。</Text>
        {onEdit ? (
          <Pressable
            accessibilityLabel="去添加照片"
            accessibilityRole="button"
            onPress={() => onEdit(item)}
            style={local.emptyButton}
          >
            <Text style={local.emptyButtonText}>去添加照片</Text>
          </Pressable>
        ) : null}
      </View>
    )
  ) : null;

  return (
    <ScreenShell title="足迹相册" onBack={onBack} rightAction={editAction}>
      <View style={local.page}>
        <LinearGradient
          colors={[postcardColors.sky, '#F9FBFF', 'rgba(247,248,250,0)']}
          end={{ x: 0.5, y: 1 }}
          pointerEvents="none"
          start={{ x: 0.5, y: 0 }}
          style={local.pageGradient}
        />
        <StateView loading={loading} error={error} onRetry={loadItem} />

        {!loading && !error && item ? (
          <FlatList
            columnWrapperStyle={local.wallRow}
            contentContainerStyle={local.content}
            data={wallData}
            keyExtractor={(entry, index) => (entry ? `${entry.uri}-${index}` : `spacer-${index}`)}
            ListFooterComponent={footer}
            ListHeaderComponent={header}
            numColumns={2}
            renderItem={({ item: entry, index }) => {
              if (!entry) return <View style={shared.albumWallItem} />;
              return (
                <View style={shared.albumWallItem}>
                  <Pressable
                    accessibilityLabel="查看照片"
                    accessibilityRole="imagebutton"
                    onPress={() => setFullIndex(entry.index)}
                    style={[shared.albumPolaroid, index % 2 === 0 ? shared.albumTiltLeft : shared.albumTiltRight]}
                  >
                    <View style={[shared.albumPolaroidImage, index % 2 === 1 && local.polaroidWide]}>
                      <FootprintThumbnail
                        uri={footprintDisplayImageUri(entry.uri)}
                        style={{ height: '100%', width: '100%' }}
                      />
                    </View>
                    <View style={shared.albumPolaroidCap}>
                      <Text style={shared.albumPolaroidTime}>{timeLabel(entry.takenAt) ?? '—'}</Text>
                      <Text style={shared.albumPolaroidIndex}>{String(entry.index + 1).padStart(2, '0')}</Text>
                    </View>
                  </Pressable>
                </View>
              );
            }}
            showsVerticalScrollIndicator={false}
          />
        ) : null}
      </View>

      <FootprintImagePreviewModal
        initialIndex={fullIndex ?? 0}
        items={fullIndex === null ? [] : imageItems}
        onClose={() => setFullIndex(null)}
        onIndexChange={setFullIndex}
      />
    </ScreenShell>
  );
}

const local = StyleSheet.create({
  page: { flex: 1 },
  pageGradient: { height: 260, left: 0, position: 'absolute', right: 0, top: 0 },
  content: { paddingBottom: 40 },
  wallRow: { gap: 12, paddingHorizontal: spacing.md },
  tagChip: { borderRadius: 9, height: 26, paddingHorizontal: 10 },
  editButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    height: 34,
    justifyContent: 'center',
    width: 34,
    ...postcardShadowSoft,
  },
  downloadButton: {
    alignItems: 'center',
    backgroundColor: postcardColors.sun,
    borderRadius: 999,
    elevation: 6,
    flexDirection: 'row',
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    shadowColor: postcardColors.sun,
    shadowOffset: { height: 6, width: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
  },
  // 拍立得墙的错落：奇数张略扁一点，配合左右微倾斜做出手账感
  polaroidWide: { aspectRatio: 1.25 },
  downloadButtonBusy: { opacity: 0.7 },
  downloadText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  emptyCard: { overflow: 'hidden' },
  emptyStamp: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderColor: 'rgba(35,41,47,0.22)',
    borderRadius: 10,
    borderStyle: 'dashed',
    borderWidth: 2,
    height: 128,
    justifyContent: 'center',
    marginBottom: 14,
    width: 108,
  },
  emptyStampText: { color: '#A9B3BD', fontSize: 11, lineHeight: 16, textAlign: 'center' },
  emptyTitle: { color: postcardColors.ink, fontSize: 15, fontWeight: '800' },
  emptySub: { color: postcardColors.inkSoft, fontSize: 12.5, lineHeight: 19, marginTop: 6, textAlign: 'center' },
  emptyButton: {
    alignItems: 'center',
    backgroundColor: postcardColors.ink,
    borderRadius: 999,
    height: 38,
    justifyContent: 'center',
    marginTop: 14,
    paddingHorizontal: 18,
  },
  emptyButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
});
