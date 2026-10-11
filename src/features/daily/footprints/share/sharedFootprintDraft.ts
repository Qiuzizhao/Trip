import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import { persistFootprintImageUri } from '../footprintImageFiles';

type SharedFile = { path: string; mimeType: string; fileName: string };
const draftKey = (id: string) => `trip:shared-footprint:${id}`;

export function sharedImageUris(files: SharedFile[] | null): string[] {
  return [...new Set((files ?? [])
    .filter((file) => file.mimeType?.startsWith('image/') || /\.(heic|heif|jpe?g|png|gif|webp|tiff?|bmp|avif)$/i.test(file.fileName ?? ''))
    .map((file) => file.path.startsWith('/') ? `file://${file.path}` : file.path)
    .filter((uri) => uri.startsWith('file://')))];
}

// Copy every image before clearing the native inbox: never open an incomplete draft.
export async function createSharedFootprintDraft(files: SharedFile[] | null): Promise<string> {
  const sources = sharedImageUris(files);
  if (!sources.length) throw new Error('没有收到可导入的照片，请在相册中重新分享。');
  const images: string[] = [];
  try {
    for (const source of sources) images.push(await persistFootprintImageUri(source));
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(draftKey(id), JSON.stringify(images));
    // The extension inbox can be cleared only after the durable draft is written.
    await Promise.all(sources.filter((uri) => uri.includes('/TripSharedPhotos/'))
      .map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)));
    return id;
  } catch (error) {
    await Promise.all(images.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)));
    throw error;
  }
}

export async function readSharedFootprintDraft(id: string): Promise<string[]> {
  const raw = await AsyncStorage.getItem(draftKey(id));
  if (!raw) throw new Error('没有找到分享的照片，请在相册中重新分享。');
  const images: unknown = JSON.parse(raw);
  if (!Array.isArray(images) || !images.length || !images.every((uri) => typeof uri === 'string' && uri.startsWith('file://'))) {
    throw new Error('分享的照片无法读取，请在相册中重新分享。');
  }
  return images;
}

export async function clearSharedFootprintDraft(id: string) {
  await AsyncStorage.removeItem(draftKey(id));
}
