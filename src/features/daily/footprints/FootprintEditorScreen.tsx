import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { DateField, Field, PrimaryButton, StateView } from '@/src/shared/components';
import { buildAssetUrl } from '@/src/shared/api';
import { createFootprintCached, deleteFootprintCached, listFootprintsLocal, updateFootprintCached } from '@/src/local/repositories/footprintsRepository';
import { rebuildAssetsForFootprint } from '@/src/local/repositories/assetSync';
import { mirrorUrisForFootprint } from '@/src/local/repositories/assetSync';
import { postcardColors, styles } from '../_shared/styles';
import { Item, ScreenShell, confirmRemove, today } from '../_shared/ReplicatedScreens';
import { FootprintImagePreviewModal } from './FootprintImagePreviewModal';
import { FootprintThumbnail } from './FootprintThumbnail';
import { persistFootprintImageUri } from './footprintImageFiles';
import { collectTagCounts, formatTagsInput, normalizeTags, parseTagInput } from './footprintTags';
import { tagColorFor } from './tagColors';
import { readTakenAtFromFile, takenAtOptions } from './imageMetadata';

type FootprintForm = {
  location: string;
  coordinate: string;
  visit_date: string;
  /** 标签的原始输入文本，保存时再解析成数组 */
  tags: string;
  notes: string;
  image_urls: string[];
};

/** 明信片"地址线"画多少段 */
const RULE_DASHES = Array.from({ length: 22 }, (_, index) => index);

function imageList(values?: string[] | string | null, fallback?: string | null) {
  const list = Array.isArray(values) ? values : typeof values === 'string' ? [values] : fallback ? [fallback] : [];
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)));
}

function footprintImageUris(item: Item) {
  return imageList(item.image_urls, item.image_url);
}

/** 邮戳上的月·日（2026-09-05 → 09·05） */
function postmarkDay(visitDate?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(visitDate ?? '').trim());
  return match ? `${match[2]}·${match[3]}` : null;
}

/** 票根感的日期（2026-09-05 → 2026.09.05） */
function dottedDate(visitDate?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(visitDate ?? '').trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : String(visitDate ?? '');
}

/** 明信片的"地址线"：一段段画出来，iOS 上也稳定 */
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

function createFootprintForm(): FootprintForm {
  return { location: '', coordinate: '', visit_date: today(), tags: '', notes: '', image_urls: [] };
}

function formFromItem(item: Item): FootprintForm {
  return {
    location: item.location || '',
    coordinate: item.coordinate || '',
    visit_date: item.visit_date || today(),
    tags: formatTagsInput(normalizeTags(item.tags)),
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
  const [tagDraft, setTagDraft] = useState('');
  // uri -> 拍摄时间（毫秒）；读不到记 null，避免重复读同一个文件
  const [takenAtByUri, setTakenAtByUri] = useState<Record<string, number | null>>({});
  const [knownTags, setKnownTags] = useState<string[]>([]);
  // 「寄出」动画：0 → 1 卡片上移淡出，同时一枚邮戳盖下来
  const sendAnim = useRef(new Animated.Value(0)).current;
  const stampAnim = useRef(new Animated.Value(0)).current;
  const title = isEditing ? '编辑足迹' : '记录新足迹';
  const canSave = useMemo(() => Boolean(form.location.trim()) && !saving, [form.location, saving]);
  const previewItems = useMemo(() => form.image_urls.map((uri) => ({ uri })), [form.image_urls]);
  const takenAtChoices = useMemo(
    () => takenAtOptions(form.image_urls.map((uri) => takenAtByUri[uri])),
    [form.image_urls, takenAtByUri],
  );
  const formTags = useMemo(() => parseTagInput(form.tags), [form.tags]);
  // 常用标签：从已有记录里统计，点一下就能补进输入框
  const tagSuggestions = useMemo(
    () => knownTags.filter((tag) => !formTags.some((value) => value.toLowerCase() === tag.toLowerCase())),
    [knownTags, formTags],
  );

  const images = useMemo(() => imageList(form.image_urls), [form.image_urls]);
  const previewStamp = postmarkDay(form.visit_date);
  const previewCity = form.coordinate.trim();
  const previewSign = useMemo(() => {
    const first = form.image_urls.map((uri) => takenAtByUri[uri]).find((value) => typeof value === 'number');
    if (!first) return null;
    const date = new Date(first);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }, [form.image_urls, takenAtByUri]);

  useEffect(() => {
    void listFootprintsLocal()
      .then((items) => setKnownTags(collectTagCounts(items).map((entry) => entry.tag)))
      .catch(() => undefined);
  }, []);

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
        tags: formTags,
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

      // 「寄出」：卡片上移淡出 + 邮戳盖下，动画走完再回列表
      await new Promise<void>((resolve) => {
        Animated.sequence([
          Animated.timing(sendAnim, { duration: 360, easing: Easing.in(Easing.cubic), toValue: 1, useNativeDriver: true }),
          Animated.timing(stampAnim, { duration: 220, easing: Easing.out(Easing.back(2)), toValue: 1, useNativeDriver: true }),
        ]).start(() => resolve());
      });
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

  const addTag = (raw: string) => {
    const next = formatTagsInput(parseTagInput([...formTags, raw].filter(Boolean).join(',')));
    setForm((current) => ({ ...current, tags: next }));
    setTagDraft('');
  };

  const previewPhoto = (key: string, uri: string, style: any, index: number, overlay?: React.ReactNode) => (
    <Pressable
      key={key}
      accessibilityLabel="放大足迹照片"
      accessibilityRole="imagebutton"
      onPress={() => setPreviewIndex(index)}
      style={style}
    >
      <FootprintThumbnail uri={buildAssetUrl(uri) || uri} style={{ height: '100%', width: '100%' }} />
      {overlay}
    </Pressable>
  );

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
            {/* ① 正在写的这张明信片 */}
            <View style={styles.editPreviewWrap}>
              <Animated.View
                style={{
                  opacity: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                  transform: [
                    { translateY: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -70] }) },
                    { scale: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) },
                  ],
                }}
              >
                <View style={styles.postcardCard}>
                  {images.length === 0 ? (
                    <Pressable
                      accessibilityLabel="添加照片"
                      accessibilityRole="button"
                      onPress={() => void pickImage()}
                      style={styles.editPreviewFrame}
                    >
                      <Ionicons name="image-outline" size={26} color={postcardColors.inkFaint} />
                      <Text style={styles.editPreviewFrameText}>贴一张照片</Text>
                    </Pressable>
                  ) : images.length === 1 ? (
                    <View style={styles.editPhotoFull}>
                      {previewPhoto('main', images[0], { flex: 1 }, 0, previewStamp ? (
                        <View pointerEvents="none" style={styles.postcardStamp}>
                          <Text style={styles.postcardStampDay}>{previewStamp}</Text>
                          {previewCity ? (
                            <Text numberOfLines={1} style={styles.postcardStampCity}>{previewCity.toUpperCase()}</Text>
                          ) : null}
                        </View>
                      ) : null)}
                    </View>
                  ) : (
                    <View style={styles.postcardPhotoRow}>
                      <View style={styles.editPhotoMain}>
                        {previewPhoto('main', images[0], { flex: 1 }, 0, previewStamp ? (
                          <View pointerEvents="none" style={styles.postcardStamp}>
                            <Text style={styles.postcardStampDay}>{previewStamp}</Text>
                            {previewCity ? (
                              <Text numberOfLines={1} style={styles.postcardStampCity}>{previewCity.toUpperCase()}</Text>
                            ) : null}
                          </View>
                        ) : null)}
                      </View>
                      <View style={styles.postcardPhotoSide}>
                        {images.length === 2
                          ? previewPhoto('side-0', images[1], styles.postcardPhotoSideSquare, 1)
                          : images.slice(1, 3).map((uri, idx) => previewPhoto(
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

                  <View style={styles.postcardBody}>
                    <View style={styles.postcardPlaceRow}>
                      <Text numberOfLines={1} style={styles.postcardPlace}>
                        {form.location.trim() || '还没写地点'}
                      </Text>
                      {previewCity ? (
                        <View style={styles.postcardCityRow}>
                          <Ionicons name="location" size={12} color={postcardColors.sun} />
                          <Text numberOfLines={1} style={styles.postcardCity}>{previewCity}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text numberOfLines={2} style={styles.postcardNote}>
                      {form.notes.trim() || '写下这趟的见闻，这张明信片就完整了。'}
                    </Text>
                  </View>
                  <PostcardRule />
                  <View style={styles.postcardFoot}>
                    <View style={styles.postcardChips}>
                      {formTags.slice(0, 3).map((tag) => {
                        const tone = tagColorFor(tag);
                        return (
                          <View key={tag} style={[styles.postcardChip, { backgroundColor: tone.backgroundColor }]}>
                            <View style={[styles.postcardChipDot, { backgroundColor: tone.color }]} />
                            <Text style={[styles.postcardChipText, { color: tone.color }]}>{tag}</Text>
                          </View>
                        );
                      })}
                    </View>
                    <Text style={styles.postcardDate}>{dottedDate(form.visit_date)}</Text>
                  </View>
                </View>
              </Animated.View>

              {/* 寄出动画：一枚邮戳盖下来 */}
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.editSendOverlay,
                  {
                    opacity: stampAnim,
                    transform: [{ scale: stampAnim.interpolate({ inputRange: [0, 1], outputRange: [2.1, 1] }) }],
                  },
                ]}
              >
                <View style={styles.editSendStamp}>
                  <Ionicons name="checkmark" size={26} color={postcardColors.sun} />
                  <Text style={styles.editSendStampText}>已收进</Text>
                </View>
              </Animated.View>
            </View>
            <Text style={styles.editLiveHint}>
              正在写的这张明信片 · <Text style={styles.editLiveHintStrong}>填下面的字段，它实时长出来</Text>
            </Text>

            {/* ② 填写区：写在纸上 */}
            <View style={styles.editFormCard}>
              <View style={styles.editGroup}>
                <Field
                  sheet={false}
                  label="地点"
                  placeholder="例如：故宫博物院"
                  value={form.location}
                  variant="paper"
                  onChangeText={(value) => setForm((current) => ({ ...current, location: value }))}
                />
              </View>
              <View style={styles.editGroupDivider} />

              <View style={styles.editGroup}>
                <Field
                  sheet={false}
                  label="城市 / 坐标"
                  placeholder="例如：北京"
                  value={form.coordinate}
                  variant="paper"
                  onChangeText={(value) => setForm((current) => ({ ...current, coordinate: value }))}
                />
              </View>
              <View style={styles.editGroupDivider} />

              <View style={styles.editGroup}>
                <DateField
                  label="日期"
                  showWeekday
                  value={form.visit_date}
                  variant="paper"
                  onChangeText={(value) => setForm((current) => ({ ...current, visit_date: value || today() }))}
                />
                {takenAtChoices.length ? (
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
                ) : null}
              </View>
              <View style={styles.editGroupDivider} />

              <View style={styles.editGroup}>
                <Text style={styles.editGroupLabel}>标签</Text>
                <View style={styles.editTagRow}>
                  {formTags.map((tag) => {
                    const tone = tagColorFor(tag);
                    return (
                      <View key={tag} style={[styles.editTagChip, { backgroundColor: tone.backgroundColor }]}>
                        <Text style={[styles.editTagChipText, { color: tone.color }]}>{tag}</Text>
                        <Pressable
                          accessibilityLabel={`删除标签 ${tag}`}
                          accessibilityRole="button"
                          onPress={() => setForm((current) => ({
                            ...current,
                            tags: formatTagsInput(formTags.filter((value) => value !== tag)),
                          }))}
                        >
                          <Text style={[styles.editTagChipRemove, { color: tone.color }]}>×</Text>
                        </Pressable>
                      </View>
                    );
                  })}
                  <TextInput
                    placeholder={formTags.length ? '添加…' : '输入标签，回车确认'}
                    placeholderTextColor={postcardColors.inkFaint}
                    returnKeyType="done"
                    style={styles.editTagInput}
                    value={tagDraft}
                    onChangeText={(value) => {
                      if (/[,，]/.test(value)) {
                        addTag(value.replace(/[,，]/g, ''));
                        return;
                      }
                      setTagDraft(value);
                    }}
                    onSubmitEditing={() => {
                      if (tagDraft.trim()) addTag(tagDraft.trim());
                    }}
                  />
                </View>
                {tagSuggestions.length ? (
                  <View style={styles.pills}>
                    {tagSuggestions.map((tag) => (
                      <Pressable
                        key={tag}
                        accessibilityLabel={`添加标签 ${tag}`}
                        accessibilityRole="button"
                        onPress={() => addTag(tag)}
                        style={[styles.pill, { backgroundColor: tagColorFor(tag).backgroundColor, borderColor: tagColorFor(tag).color }]}
                      >
                        <Text style={[styles.pillText, { color: tagColorFor(tag).color }]}>{tag}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
              <View style={styles.editGroupDivider} />

              <View style={styles.editGroup}>
                <Text style={styles.editGroupLabel}>记录见闻</Text>
                <View style={styles.editNoteCard}>
                  <LinearGradient
                    colors={['#FFD9A8', '#BFE3FF']}
                    end={{ x: 0, y: 1 }}
                    pointerEvents="none"
                    start={{ x: 0, y: 0 }}
                    style={styles.editNoteBar}
                  />
                  <TextInput
                    multiline
                    placeholder="记录沿途见闻"
                    placeholderTextColor={postcardColors.inkFaint}
                    scrollEnabled={false}
                    style={styles.editNoteInput}
                    value={form.notes}
                    onChangeText={(value) => setForm((current) => ({ ...current, notes: value }))}
                  />
                  <Text style={styles.editNoteSign}>— 记于 {previewSign ?? dottedDate(form.visit_date)}</Text>
                </View>
              </View>
              <View style={styles.editGroupDivider} />

              <View style={styles.editGroup}>
                <Text style={styles.editGroupLabel}>照片{images.length ? ` · ${images.length} 张` : ''}</Text>
                <View style={styles.editThumbStrip}>
                  {images.map((uri, index) => (
                    <View key={`${uri}-${index}`} style={styles.editThumb}>
                      <Pressable
                        accessibilityLabel="放大足迹照片"
                        accessibilityRole="imagebutton"
                        onPress={() => setPreviewIndex(index)}
                        style={{ flex: 1 }}
                      >
                        <FootprintThumbnail uri={buildAssetUrl(uri) || uri} style={{ height: '100%', width: '100%' }} />
                      </Pressable>
                      <Pressable
                        accessibilityLabel="移除照片"
                        accessibilityRole="button"
                        onPress={(event) => {
                          event.stopPropagation();
                          removeImage(uri);
                        }}
                        style={styles.editThumbRemove}
                      >
                        <Ionicons name="close" size={12} color="#fff" />
                      </Pressable>
                    </View>
                  ))}
                  <Pressable
                    accessibilityLabel="添加照片"
                    accessibilityRole="button"
                    onPress={() => void pickImage()}
                    style={styles.editThumbAdd}
                  >
                    <Ionicons name="add" size={24} color={postcardColors.inkFaint} />
                  </Pressable>
                </View>
                <Pressable
                  accessibilityLabel="继续添加照片"
                  accessibilityRole="button"
                  onPress={() => void pickImage()}
                  style={styles.editAddPhoto}
                >
                  <Ionicons name="camera" size={18} color="#9A6A15" />
                  <Text style={styles.editAddPhotoText}>
                    {images.length ? '继续添加照片' : '选择照片'}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* ③ 底部操作 */}
            <View style={styles.formActions}>
              {isEditing ? <PrimaryButton label="删除" tone="danger" onPress={remove} /> : null}
              <PrimaryButton label="取消" tone="plain" onPress={onBack} />
              <View style={styles.flex}>
                <PrimaryButton
                  label={saving ? '寄出中...' : isEditing ? '保存修改' : '收进明信片'}
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
        // 编辑页的图片本来就在本机，不需要「下载」这一层
        showDownload={false}
      />
    </ScreenShell>
  );
}
