import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage, type ImageSource, type ImageStyle } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View, type StyleProp } from 'react-native';

import { DateField, Field, PrimaryButton, SheetTextInput, StateView } from '@/src/shared/components';
import { buildAssetUrl } from '@/src/shared/api';
import { colors, spacing } from '@/src/shared/theme';
import { createFootprintCached, deleteFootprintCached, listFootprintsLocal, updateFootprintCached } from '@/src/local/repositories/footprintsRepository';
import { rebuildAssetsForFootprint } from '@/src/local/repositories/assetSync';
import { mirrorUrisForFootprint } from '@/src/local/repositories/assetSync';
import { styles } from '../_shared/styles';
import { Item, ScreenShell, confirmRemove, today } from '../_shared/ReplicatedScreens';
import { FootprintImagePreviewModal } from './FootprintImagePreviewModal';
import { persistFootprintImageUri } from './footprintImageFiles';
import { readTakenAtFromFile, takenAtOptions } from './imageMetadata';

const footprintEditorImageSourceCache = new Map<string, ImageSource>();

type FootprintForm = {
  location: string;
  coordinate: string;
  visit_date: string;
  notes: string;
  image_urls: string[];
};

function imageList(values?: string[] | string | null, fallback?: string | null) {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : fallback ? [fallback] : [];
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)));
}

function imageSourceFor(uri: string) {
  const cached = footprintEditorImageSourceCache.get(uri);
  if (cached) return cached;
  const source = /^https?:\/\//i.test(uri) ? { uri, cacheKey: uri } : { uri };
  footprintEditorImageSourceCache.set(uri, source);
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

function createFootprintForm(): FootprintForm {
  return { location: '', coordinate: '', visit_date: today(), notes: '', image_urls: [] };
}

function formFromItem(item: Item): FootprintForm {
  return {
    location: item.location || '',
    coordinate: item.coordinate || '',
    visit_date: item.visit_date || today(),
    notes: item.notes || '',
    image_urls: footprintImageUris(item),
  };
}

async function findFootprintById(id: string) {
  const items = await listFootprintsLocal();
  return items.find((item) => item.id === id) || null;
}

export function FootprintEditorScreen({
  footprintId,
  onBack,
}: {
  footprintId?: string | null;
  onBack: () => void;
}) {
  const isEditing = typeof footprintId === 'string' && Boolean(footprintId);
  const [form, setForm] = useState<FootprintForm>(() => createFootprintForm());
  const [loading, setLoading] = useState(Boolean(isEditing));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  // uri -> 拍摄时间（毫秒）；读不到记 null，避免重复读同一个文件
  const [takenAtByUri, setTakenAtByUri] = useState<Record<string, number | null>>({});
  const title = isEditing ? '编辑足迹' : '记录新足迹';
  const canSave = useMemo(() => Boolean(form.location.trim()) && !saving, [form.location, saving]);
  const previewItems = useMemo(() => form.image_urls.map((uri) => ({ uri })), [form.image_urls]);
  const takenAtChoices = useMemo(
    () => takenAtOptions(form.image_urls.map((uri) => takenAtByUri[uri])),
    [form.image_urls, takenAtByUri],
  );

  // 加了照片就顺手读一次 EXIF，把可以一键填入的拍摄时间找出来
  useEffect(() => {
    // 只读本地文件：编辑模式下图片可能只有远端 URL，不为读元数据把原图整张下载下来
    const pending = form.image_urls.filter((uri) => takenAtByUri[uri] === undefined && uri.startsWith('file://'));
    if (!pending.length) return;

    let cancelled = false;
    void Promise.all(
      pending.map(async (uri) => [uri, await readTakenAtFromFile(uri).catch(() => null)] as const),
    ).then((entries) => {
      if (cancelled) return;
      setTakenAtByUri((current) => {
        const next = { ...current };
        for (const [uri, takenAt] of entries) next[uri] = takenAt;
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [form.image_urls, takenAtByUri]);

  useEffect(() => {
    if (!isEditing || typeof footprintId !== 'string') return;
    let mounted = true;
    setLoading(true);
    setError(null);
    void findFootprintById(footprintId)
      .then(async (item) => {
        if (!mounted) return;
        if (!item) {
          setError('没有找到这条足迹');
          return;
        }
        // 图片来自 asset（记录里不再存图片字段）
        const assetUris = await mirrorUrisForFootprint(String(item.id));
        if (!mounted) return;
        setForm({ ...formFromItem(item), image_urls: assetUris });
      })
      .catch((err) => {
        if (mounted) setError(err instanceof Error ? err.message : '加载足迹失败');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [footprintId, isEditing]);

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('需要权限', '请允许访问相册后再上传图片。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;
    try {
      const selectedUris = await Promise.all(result.assets.map((asset) => persistFootprintImageUri(asset.uri)));
      setForm((current) => ({ ...current, image_urls: imageList([...current.image_urls, ...selectedUris]) }));
    } catch (err) {
      Alert.alert('保存照片失败', err instanceof Error ? err.message : '请稍后重试。');
    }
  };

  const removeImage = (uri: string) => {
    setForm((current) => ({ ...current, image_urls: current.image_urls.filter((item) => item !== uri) }));
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const imageUrls = imageList(form.image_urls);
      // 记录只写元数据：图片全部由 asset 承担
      const basePayload = {
        location: form.location.trim(),
        coordinate: form.coordinate.trim() || null,
        visit_date: form.visit_date,
        notes: form.notes.trim() || null,
        rating: 5,
      };

      // 先写记录拿到 id，再把图片对齐到 asset（本地文件会改名为 <assetId>.<ext>）
      let savedId: string;
      if (isEditing && typeof footprintId === 'string') {
        savedId = footprintId;
        await updateFootprintCached(savedId, basePayload);
      } else {
        savedId = (await createFootprintCached(basePayload)).id;
      }

      await rebuildAssetsForFootprint(savedId, imageUrls);
      onBack();
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : '足迹保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!isEditing || typeof footprintId !== 'string') return;
    confirmRemove(form.location || '足迹', async () => {
      await deleteFootprintCached(footprintId);
      onBack();
    });
  };

  return (
    <ScreenShell title={title} onBack={onBack}>
      <ScrollView
        alwaysBounceVertical={false}
        bounces={false}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        style={styles.noScrollBounce}
      >
        <StateView loading={loading} error={error} onRetry={() => undefined} />
        {!loading && !error ? (
          <>
            <Field
              sheet={false}
              label="地点"
              value={form.location}
              placeholder="例如：故宫博物院"
              onChangeText={(value) => setForm((current) => ({ ...current, location: value }))}
            />
            <Field
              sheet={false}
              label="城市 / 坐标"
              value={form.coordinate}
              placeholder="例如：北京"
              onChangeText={(value) => setForm((current) => ({ ...current, coordinate: value }))}
            />
            <DateField
              label="日期"
              value={form.visit_date}
              onChangeText={(value) => setForm((current) => ({ ...current, visit_date: value || today() }))}
            />
            {takenAtChoices.length ? (
              <View style={{ marginTop: -spacing.md }}>
                <Text style={styles.formLabel}>照片拍摄日期</Text>
                <View style={styles.pills}>
                  {takenAtChoices.map((option) => {
                    const selected = option.date === form.visit_date;
                    return (
                      <Pressable
                        key={option.takenAt}
                        accessibilityLabel={`把日期填成 ${option.label}`}
                        accessibilityRole="button"
                        onPress={() => setForm((current) => ({ ...current, visit_date: option.date }))}
                        style={[styles.pill, selected && styles.pillSelected]}
                      >
                        <Text style={[styles.pillText, selected && styles.pillTextSelected]}>{option.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
            <View>
              <Text style={styles.formLabel}>记录见闻</Text>
              <SheetTextInput
                sheet={false}
                value={form.notes}
                multiline
                placeholder="记录沿途见闻"
                placeholderTextColor={colors.faint}
                scrollEnabled={false}
                onChangeText={(value) => setForm((current) => ({ ...current, notes: value }))}
                style={[styles.input, styles.footprintNotesInput]}
              />
            </View>
            {form.image_urls.length ? (
              <View style={styles.footprintImageGrid}>
                {form.image_urls.map((uri, index) => {
                  const displayUri = buildAssetUrl(uri) || uri;
                  return (
                    <View key={`${uri}-${index}`} style={styles.footprintImageTile}>
                      <Pressable
                        accessibilityLabel="放大足迹照片"
                        accessibilityRole="imagebutton"
                        onPress={() => setPreviewIndex(index)}
                        style={{ flex: 1 }}
                      >
                        <CachedFootprintImage uri={displayUri} style={{ height: '100%', width: '100%' }} />
                      </Pressable>
                      <Pressable
                        accessibilityLabel="移除照片"
                        onPress={(event) => {
                          event.stopPropagation();
                          removeImage(uri);
                        }}
                        style={styles.imageRemoveButton}
                      >
                        <Ionicons name="close" size={14} color="#fff" />
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ) : null}
            <Pressable
              onPress={() => void pickImage()}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: colors.primarySoft,
                  borderRadius: 26, // capsule style
                  minHeight: 52,
                  width: '100%',
                  gap: 8,
                  marginTop: 4,
                  marginBottom: 16,
                },
                pressed && { opacity: 0.8 },
              ]}
            >
              <Ionicons name="camera" size={20} color={colors.primary} />
              <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '700' }}>
                {form.image_urls.length ? '继续添加照片' : '选择照片'}
              </Text>
            </Pressable>
            <View style={styles.formActions}>
              {isEditing ? <PrimaryButton label="删除" tone="danger" onPress={remove} /> : null}
              <PrimaryButton label="取消" tone="plain" onPress={onBack} />
              <View style={styles.flex}>
                <PrimaryButton
                  label={saving ? '保存中...' : isEditing ? '保存修改' : '保存'}
                  icon={saving ? undefined : 'checkmark'}
                  disabled={!canSave}
                  onPress={() => void save()}
                />
              </View>
            </View>
          </>
        ) : null}
      </ScrollView>
      <FootprintImagePreviewModal
        initialIndex={previewIndex ?? 0}
        items={previewIndex === null ? [] : previewItems}
        onClose={() => setPreviewIndex(null)}
      />
    </ScreenShell>
  );
}
