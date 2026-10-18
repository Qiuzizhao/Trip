import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Linking, StyleSheet, Text, View } from 'react-native';

import { photoAlbumNative as native, type DuplicatePreview } from '@/src/features/daily/footprints/systemAlbum/native';
import { pauseSystemAlbumSync } from '@/src/features/daily/footprints/systemAlbum/sync';
import { Header, IconButton, PrimaryButton, Screen } from '@/src/shared/components';
import { colors, radius, spacing } from '@/src/shared/theme';

export function PhotoCleanupScreen() {
  const [preview, setPreview] = useState<DuplicatePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const resume = pauseSystemAlbumSync();
    const event = native?.addListener?.('duplicateScanProgress', (next) => {
      if (alive.current) setProgress(next);
    });
    return () => {
      alive.current = false;
      native?.cancelDuplicateScan?.();
      event?.remove();
      resume();
    };
  }, []);

  const scan = async () => {
    if (!native?.findDuplicates || busy) return;
    setBusy(true);
    setPreview(null);
    setMessage('');
    setProgress({ scanned: 0, total: 0 });
    try {
      const permission = await native.permission(true);
      if (permission !== 'authorized') {
        Alert.alert('需要完整访问照片', '请允许 Trip 完整访问照片，才能扫描专用相簿。', [
          { text: '取消', style: 'cancel' }, { text: '去设置', onPress: () => { void Linking.openSettings(); } },
        ]);
        return;
      }
      const result = await native.findDuplicates();
      if (alive.current) {
        setPreview(result);
        if (!result.removeCount) setMessage('未发现可安全清理的 Trip 重复副本。');
      }
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? error.message : '扫描失败，请重试');
    } finally { if (alive.current) setBusy(false); }
  };

  const remove = () => {
    if (!preview?.removeCount || !native?.deleteDuplicates || busy) return;
    const current = preview;
    Alert.alert(`删除 ${current.removeCount} 张重复副本？`,
      '每组至少保留一张，收藏、已编辑及无法确认来源的照片会保留。删除也会影响这些副本所在的其他相簿，并同步到 iCloud；照片会进入系统“最近删除”。', [
        { text: '取消', style: 'cancel' },
        { text: '继续', style: 'destructive', onPress: () => {
          setBusy(true);
          setDeleting(true);
          void native!.deleteDuplicates!(current.token).then((count) => {
            if (alive.current) {
              setPreview(null);
              setMessage(`已清理 ${count} 张重复副本。可在系统相册“最近删除”中恢复。`);
            }
          }).catch((error: unknown) => {
            if (alive.current) {
              setPreview(null);
              setMessage(error instanceof Error ? error.message : '未完成删除，请重新扫描');
            }
          }).finally(() => { if (alive.current) { setBusy(false); setDeleting(false); } });
        } },
      ]);
  };

  return <Screen>
    <Header title="清理重复照片" action={<IconButton name="chevron-back" label="返回设置" transparent onPress={() => router.back()} />} />
    <FlatList
      data={preview?.groups ?? []}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.content}
      ListHeaderComponent={<View style={styles.header}>
        <Text style={styles.explanation}>只扫描系统相册的 Trip 相簿。核对原文件内容完全一致后，仅清理可确认由 Trip 生成的重复副本，每组至少保留一张。</Text>
        <Text style={styles.muted}>收藏、已编辑、来源不明及暂时无法读取的照片会保留。删除前还会弹出系统确认。</Text>
        <PrimaryButton label={busy ? (deleting ? '等待系统删除确认…' : '扫描中…') : '扫描 Trip 重复照片'}
          icon="search-outline" disabled={busy || !native?.findDuplicates} onPress={() => { void scan(); }} />
        {busy && <View style={styles.progress}><ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>{deleting ? '请在系统弹窗中确认' : `正在核对 ${progress.scanned} / ${progress.total} 张照片`}</Text>
        </View>}
        {message ? <Text style={styles.explanation}>{message}</Text> : null}
        {preview && <Text style={styles.explanation}>发现 {preview.groups.length} 组重复照片，可清理 {preview.removeCount} 张副本。
          {preview.skipped ? ` ${preview.skipped} 张照片无法核对或不参与清理，已保留。` : ''}</Text>}
      </View>}
      renderItem={({ item }) => <View style={styles.group}>
        {item.thumbnailUri ? <Image source={{ uri: item.thumbnailUri }} style={styles.thumbnail} /> : <View style={styles.thumbnail} />}
        <View style={styles.details}>
          <Text style={styles.title}>内容一致的 {item.copies} 张照片</Text>
          <Text style={styles.muted}>保留 {item.keepCount} 张，清理 {item.removeCount} 张副本</Text>
        </View>
      </View>}
      ListFooterComponent={preview?.removeCount ? <PrimaryButton label={`确认清理 ${preview.removeCount} 张副本`}
        icon="trash-outline" tone="danger" disabled={busy} onPress={remove} /> : null}
    />
  </Screen>;
}
const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  header: { gap: spacing.md },
  explanation: { color: colors.text, fontSize: 15, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  group: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  thumbnail: { width: 74, height: 74, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  details: { flex: 1, gap: spacing.xs },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
});
