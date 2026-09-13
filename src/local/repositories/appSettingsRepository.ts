// 应用设置（本地保存，不参与同步）
import { getJson, setJson } from '../storage';

const settingsKey = 'trip-footprints.settings';

export type AppSettings = {
  /** 本地模式：图片只保存在本机，不进行任何上传；同步入口隐藏 */
  localOnlyMode: boolean;
};

export const defaultAppSettings: AppSettings = {
  localOnlyMode: false,
};

let settingsCache: AppSettings | null = null;
const settingsListeners = new Set<(settings: AppSettings) => void>();

export function subscribeAppSettings(listener: (settings: AppSettings) => void) {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

export async function getAppSettings(): Promise<AppSettings> {
  if (!settingsCache) {
    const stored = await getJson<Partial<AppSettings>>(settingsKey, {});
    settingsCache = { ...defaultAppSettings, ...stored };
  }
  return settingsCache;
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getAppSettings()), ...patch };
  settingsCache = next;
  await setJson(settingsKey, next);
  settingsListeners.forEach((listener) => listener(next));
  return next;
}

/** 本地模式是否开启（上传相关逻辑统一从这里判断） */
export async function isLocalOnlyMode() {
  return (await getAppSettings()).localOnlyMode;
}

export function resetAppSettingsCacheForTests() {
  settingsCache = null;
}
