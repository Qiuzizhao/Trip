import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert } from 'react-native';

import { FootprintScreen } from '@/src/features/daily/footprints';
import { IconButton } from '@/src/shared/components';
import { colors } from '@/src/shared/theme';
import { getLocalMergeSummary } from '@/src/local/localDataRepository';
import { runManualSync } from '@/src/sync/manualSync';
import { getCurrentSession } from '@/src/sync/supabaseClient';

export default function IndexRoute() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  const finishManualSync = async () => {
    const result = await runManualSync();
    if (result.status === 'signedOut') {
      router.push('/auth' as never);
      return;
    }
    Alert.alert('同步完成', `上传 ${result.uploadedFootprints} 条，本地更新 ${result.downloadedFootprints} 条。`);
  };

  const syncFootprints = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const session = await getCurrentSession();
      if (!session?.user) {
        router.push('/auth' as never);
        return;
      }

      const summary = await getLocalMergeSummary();
      if (summary.shouldConfirm) {
        setSyncing(false);
        Alert.alert('合并本机足迹？', `本机有 ${summary.footprintCount} 条未同步足迹。合并后会上传到当前账号。`, [
          { text: '取消', style: 'cancel' },
          {
            text: '合并并同步',
            onPress: () => {
              setSyncing(true);
              void finishManualSync()
                .catch((err) => Alert.alert('同步失败', err instanceof Error ? err.message : '请稍后再试'))
                .finally(() => setSyncing(false));
            },
          },
        ]);
        return;
      }

      await finishManualSync();
    } catch (err) {
      Alert.alert('同步失败', err instanceof Error ? err.message : '请稍后再试');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <FootprintScreen
      onSettings={() => router.push('/settings' as never)}
      onCreate={() => router.push('/daily/footprint-edit')}
      onEdit={(item) => router.push({ pathname: '/daily/footprint-edit', params: { id: String(item.id) } })}
      onPressCard={(item) => router.push({ pathname: '/daily/footprint-album', params: { id: String(item.id) } })}
      rightAction={syncing ? <ActivityIndicator color={colors.text} /> : <IconButton name="sync-outline" label="手动同步足迹" transparent onPress={syncFootprints} />}
    />
  );
}
