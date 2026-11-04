import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import { persistFootprintImageUri } from './footprintImageFiles';

const key = 'trip:pending-image-picker';
type Context = { id: string; footprintId?: string | null; form: Record<string, unknown>; ready?: boolean; assets?: ImagePicker.ImagePickerAsset[] };
let picking = false;
export async function beginImagePicker(footprintId: string | null | undefined, form: Record<string, unknown>) {
  picking = true;
  try { await AsyncStorage.setItem(key, JSON.stringify({ id: `${Date.now()}`, footprintId, form })); }
  catch (error) { picking = false; throw error; }
}
export async function finishImagePicker() {
  try { await AsyncStorage.removeItem(key); } finally { picking = false; }
}
export async function readPickerRecovery(id: string) {
  const raw = await AsyncStorage.getItem(key);
  const context: Context | null = raw ? JSON.parse(raw) : null;
  if (!context?.ready || context.id !== id) throw new Error('选图恢复草稿不存在，请重新选择照片。');
  return context.form;
}
export async function persistPickedImages(assets: ImagePicker.ImagePickerAsset[]) {
  const images: string[] = [];
  try {
    for (const asset of assets) images.push(await persistFootprintImageUri(asset.uri, asset));
    return images;
  } catch (error) {
    await Promise.all(images.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)));
    throw error;
  }
}

export function ImagePickerRecoveryHandler() {
  const navigation = useRootNavigationState();
  const router = useRouter();
  const busy = useRef(false);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android' || !navigation?.key) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = async (attempt = 0): Promise<void> => {
      if (!active || picking || busy.current) return;
      busy.current = true;
      try {
        const raw = await AsyncStorage.getItem(key);
        if (!raw) return;
        const context: Context = JSON.parse(raw);
        if (opened.current === context.id) return;
        if (!context.ready) {
          if (!context.assets) {
            const result = await ImagePicker.getPendingResultAsync();
            if (!result) {
              if (attempt < 10) timer = setTimeout(() => { void recover(attempt + 1); }, 500);
              return;
            }
            if ('code' in result) throw new Error(result.message || '无法恢复选图结果');
            context.assets = result.canceled ? [] : result.assets;
            // Preserve native results before copying, so a failed copy can be retried.
            await AsyncStorage.setItem(key, JSON.stringify(context));
          }
          const images = await persistPickedImages(context.assets);
          const previous = Array.isArray(context.form.image_urls) ? context.form.image_urls : [];
          context.form.image_urls = [...new Set([...previous, ...images])];
          context.ready = true;
          delete context.assets;
          await AsyncStorage.setItem(key, JSON.stringify(context));
        }
        if (!active) return;
        opened.current = context.id;
        router.replace({ pathname: '/daily/footprint-edit', params: {
          ...(context.footprintId ? { id: context.footprintId } : {}), recoveryDraft: context.id,
        } });
      } catch (error) {
        if (active) Alert.alert('恢复选图失败', error instanceof Error ? error.message : '请重新选择照片。');
      } finally { busy.current = false; }
    };
    void recover();
    const event = AppState.addEventListener('change', (state) => { if (state === 'active') void recover(); });
    return () => { active = false; clearTimeout(timer); event.remove(); };
  }, [navigation?.key, router]);
  return null;
}
