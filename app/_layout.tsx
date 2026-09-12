import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

import { prewarmFootprintScreenData } from '@/src/local/homePreload';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  useEffect(() => {
    void prewarmFootprintScreenData().finally(() => {
      SplashScreen.hideAsync().catch(() => undefined);
    });
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
