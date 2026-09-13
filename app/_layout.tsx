import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

import { prewarmFootprintScreenData } from '@/src/local/homePreload';
import { startAssetAutoRetry } from '@/src/sync/assetAutoRetry';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  useEffect(() => {
    void prewarmFootprintScreenData().finally(() => {
      SplashScreen.hideAsync().catch(() => undefined);
    });
    // 启动时（以及回到前台时）自动重试未完成的图片同步；记录级同步仍由用户手动触发
    startAssetAutoRetry();
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="daily/footprint-edit" />
      <Stack.Screen name="daily/footprint-album" />
      <Stack.Screen name="settings/index" />
      <Stack.Screen name="auth" />
    </Stack>
  );
}
