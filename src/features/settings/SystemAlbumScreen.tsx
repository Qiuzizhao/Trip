import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { photoAlbumNative } from '@/src/features/daily/footprints/systemAlbum/native';
import { getSystemAlbumState, restoreSystemAlbum, subscribeSystemAlbum } from '@/src/features/daily/footprints/systemAlbum/sync';
import { Header, IconButton, PrimaryButton, Screen } from '@/src/shared/components';
import { colors, radius, spacing } from '@/src/shared/theme';

export function SystemAlbumScreen() {
  const [album, setAlbum] = useState(getSystemAlbumState);
  const [searchEntireLibrary, setSearchEntireLibrary] = useState(false);
  // Opening either Settings page only displays state. No Photos query starts here.
  useEffect(() => subscribeSystemAlbum(setAlbum), []);
  const busy = album.phase === 'checking' || album.phase === 'syncing';

  return <Screen>
    <Header title="Trip 系统相簿" action={<IconButton name="chevron-back" label="返回设置" transparent onPress={() => router.back()} />} />
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.text}>点击下方按钮才开始核对和恢复。默认核对 Trip 相簿，并按已有保存记录定向确认照片，不遍历整个系统图库。</Text>
      <View style={styles.row}>
        <View style={styles.details}>
          <Text style={styles.title}>本次恢复查找整个系统图库</Text>
          <Text style={styles.muted}>相簿已删除、或旧照片没有保存在 Trip 相簿时可开启。照片较多时需要更长时间。</Text>
        </View>
        <Switch accessibilityLabel="本次恢复查找整个系统图库" value={searchEntireLibrary}
          disabled={busy} onValueChange={setSearchEntireLibrary} />
      </View>
      <Text style={styles.muted}>已从系统图库删除的历史照片，重新保存时会把当前足迹地点加入文件名。仍存在的照片直接加回相簿，保留原文件名。</Text>
      <PrimaryButton label={busy ? '处理中…' : '开始核对并恢复'} icon="images-outline"
        disabled={busy || !photoAlbumNative?.reconcileAlbum}
        onPress={() => { void restoreSystemAlbum(searchEntireLibrary); }} />
      {busy && <View style={styles.progress}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.muted}>{album.phase === 'checking' ? '正在核对已保存照片…' : `正在保存 ${album.completed} / ${album.total} 张足迹照片`}</Text>
      </View>}
      {album.phase === 'done' && <Text style={styles.text}>已处理 {album.completed} 张足迹照片。</Text>}
      {album.phase === 'error' && <Text style={styles.text}>核对或保存未完成，请重试。</Text>}
      {Boolean(album.needsLibraryScan) && <Text style={styles.text}>有 {album.needsLibraryScan} 张历史照片需要开启全图库查找，才能确认是否仍然存在。本次已保留这些保存记录，避免重复导入。</Text>}
      {album.phase === 'permission' && <>
        <Text style={styles.text}>请允许 Trip 完整访问照片，再手动开始核对。</Text>
        <PrimaryButton label="照片访问设置" icon="settings-outline" onPress={() => { void Linking.openSettings(); }} />
      </>}
    </ScrollView>
  </Screen>;
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, backgroundColor: colors.surface, borderRadius: radius.lg },
  details: { flex: 1, gap: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  text: { color: colors.text, fontSize: 15, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
