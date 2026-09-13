import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  getAppSettings,
  isLocalOnlyMode,
  resetAppSettingsCacheForTests,
  subscribeAppSettings,
  updateAppSettings,
} from '@/src/local/repositories/appSettingsRepository';

beforeEach(async () => {
  jest.clearAllMocks();
  resetAppSettingsCacheForTests();
  await AsyncStorage.clear();
});

describe('appSettingsRepository', () => {
  it('默认关闭本地模式', async () => {
    expect(await isLocalOnlyMode()).toBe(false);
  });

  it('切换后持久化，并通知订阅方', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeAppSettings((settings) => seen.push(settings.localOnlyMode));

    await updateAppSettings({ localOnlyMode: true });
    expect(await isLocalOnlyMode()).toBe(true);
    unsubscribe();

    // 重新读取（模拟重启 App）
    resetAppSettingsCacheForTests();
    expect(await isLocalOnlyMode()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('只更新传入的字段', async () => {
    await updateAppSettings({ localOnlyMode: true });
    const settings = await getAppSettings();
    expect(settings).toEqual({ localOnlyMode: true });
  });
});
