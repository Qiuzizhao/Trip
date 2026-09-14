import { Stack } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

import { prewarmFootprintScreenData } from '@/src/local/homePreload';
import { startAssetAutoRetry } from '@/src/sync/assetAutoRetry';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  useEffect(() => {
    // 允许横屏只是为了「图片预览」里手动横过来看（见 FootprintImagePreviewModal），
    // App 本体仍然锁竖屏，不会跟着手机转。
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
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
      {/* 设置入口在左上角，所以从左侧滑入（与手势方向一致） */}
      <Stack.Screen name="settings/index" options={{ animation: 'slide_from_left' }} />
      {/* 账号页同样从设置/左上角进入，保持一致从左侧滑入 */}
      <Stack.Screen name="auth" options={{ animation: 'slide_from_left' }} />
    </Stack>
  );
}
