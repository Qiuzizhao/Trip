import { useRootNavigationState, useRouter } from 'expo-router';
import { useShareIntent } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Text, View } from 'react-native';

import { createSharedFootprintDraft } from './sharedFootprintDraft';

export function ShareIntentHandler() {
  const router = useRouter();
  const navigation = useRootNavigationState();
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent({
    disabled: Platform.OS !== 'ios', resetOnBackground: false, scheme: 'tripfootprints',
  });
  const busy = useRef(false);
  const handled = useRef<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!hasShareIntent) { handled.current = null; return; }
    if (!navigation?.key || busy.current) return;
    const signature = JSON.stringify(shareIntent.files);
    if (handled.current === signature) return;
    busy.current = true;
    handled.current = signature;
    setImporting(true);
    void createSharedFootprintDraft(shareIntent.files)
      .then((shareDraft) => {
        resetShareIntent();
        router.push({ pathname: '/daily/footprint-edit', params: { shareDraft } });
      })
      .catch((err) => {
        resetShareIntent();
        Alert.alert('导入照片失败', err instanceof Error ? err.message : '请在相册中重新分享。');
      })
      .finally(() => { busy.current = false; setImporting(false); });
  }, [hasShareIntent, shareIntent, navigation?.key, resetShareIntent, router]);

  useEffect(() => {
    if (!error) return;
    resetShareIntent();
    Alert.alert('接收照片失败', '请回到相册，重新将照片分享到 Trip。');
  }, [error, resetShareIntent]);

  if (!importing) return null;
  return (
    <View accessibilityViewIsModal style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.94)', alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="large" color="#9A6A15" />
      <Text style={{ marginTop: 16, color: '#70552E' }}>正在导入照片…</Text>
    </View>
  );
}
