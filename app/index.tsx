import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { FootprintScreen } from '@/src/features/daily/footprints';
import { IconButton } from '@/src/shared/components';
import { colors } from '@/src/shared/theme';
import { getLocalMergeSummary } from '@/src/local/localDataRepository';
import { getAppSettings, subscribeAppSettings } from '@/src/local/repositories/appSettingsRepository';
import { runManualSync } from '@/src/sync/manualSync';
import { getCurrentSession } from '@/src/sync/supabaseClient';

export default function IndexRoute() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getAppSettings().then((settings) => {
      if (mounted) setLocalOnly(settings.localOnlyMode);
    });
    const unsubscribe = subscribeAppSettings((settings) => setLocalOnly(settings.localOnlyMode));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const finishManualSync = async () => {
    const result = await runManualSync();
    if (result.status === 'signedOut') {
      router.push('/auth' as never);
      return;
    }
    const repairNote = result.repairedAssetObjects > 0 ? `\n已修复 ${result.repairedAssetObjects} 张之前上传失败的图片。` : '';
    const assetNote = result.uploadedAssets > 0 || result.downloadedAssets > 0
      ? `\n图片：上传 ${result.uploadedAssets} 张，恢复 ${result.downloadedAssets} 张${result.failedAssets > 0 ? `，${result.failedAssets} 张待重试` : ''}。`
      : '';
    Alert.alert('同步完成', `上传 ${result.uploadedFootprints} 条，本地更新 ${result.downloadedFootprints} 条。${assetNote}${repairNote}`);
  };

  const syncFootprints = async () => {
    if (localOnly) return; // 本地模式：不提供任何上传入口
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
      rightAction={localOnly ? (
        // 本地模式：隐藏同步按钮，只留一个不可点的状态提示
        <View style={{ alignItems: 'center', height: 40, justifyContent: 'center', width: 40 }}>
          <Ionicons name="cloud-offline-outline" size={21} color={colors.muted} />
        </View>
      ) : syncing ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <IconButton name="sync-outline" label="手动同步足迹" transparent onPress={syncFootprints} />
      )}
    />
  );
}
