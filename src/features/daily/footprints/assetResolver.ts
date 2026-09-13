// 显示用：本地文件优先，其次远端对象；不把 URL 存进记录里。
import * as FileSystem from 'expo-file-system/legacy';

import type { Asset } from '@/src/local/repositories/assetRepository';
import { TRIP_FOOTPRINT_IMAGES_BUCKET } from '@/src/sync/storageConstants';
import { ensureFootprintImageDirectory, FOOTPRINT_IMAGE_DIR } from './footprintImageFiles';

export function publicUrlForObjectKey(objectKey: string) {
  const base = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) return null;
  return `${base}/storage/v1/object/public/${TRIP_FOOTPRINT_IMAGES_BUCKET}/${objectKey}`;
}

// http(s)://…/storage/v1/object/public/<bucket>/<key> -> <key>
export function objectKeyFromPublicUrl(uri: string) {
  const marker = `/storage/v1/object/public/${TRIP_FOOTPRINT_IMAGES_BUCKET}/`;
  const markerIndex = uri.indexOf(marker);
  if (markerIndex < 0) return null;
  const key = decodeURIComponent(uri.slice(markerIndex + marker.length).split('?')[0] || '');
  return key || null;
}

// 同步版本：文件名是确定的，渲染/保存时不需要 await
export function assetLocalUriSync(asset: Asset) {
  const dir = FileSystem.documentDirectory;
  if (!dir) return null;
  return `${dir}${FOOTPRINT_IMAGE_DIR}/${asset.fileName}`;
}

export async function localUriForAsset(asset: Asset) {
  const context = await ensureFootprintImageDirectory();
  if (!context) return null;
  const uri = `${context.dir}${asset.fileName}`;
  try {
    const info = await context.FileSystem.getInfoAsync(uri);
    return info.exists ? uri : null;
  } catch {
    return null;
  }
}

export async function resolveAssetUri(asset: Asset): Promise<string | null> {
  const localUri = await localUriForAsset(asset);
  if (localUri) return localUri;
  if (asset.remoteKey) return publicUrlForObjectKey(asset.remoteKey);
  return null;
}

export type PreviewImage = {
  uri: string;
  /** 拍摄时间（毫秒）；未知为 null */
  takenAt?: number | null;
};

// 预览用：返回图片 URI + 拍摄时间。拍摄时间优先用已缓存的，其次从本地文件读一次 EXIF 并缓存。
export async function resolveFootprintImages(footprintId: string, fallbackUris: string[]): Promise<PreviewImage[]> {
  const { listAssetsByFootprint, setAssetTakenAt } = await import('@/src/local/repositories/assetRepository');
  const { readTakenAtFromFile } = await import('./imageMetadata');

  const assets = await listAssetsByFootprint(footprintId);
  if (!assets.length) return fallbackUris.map((uri) => ({ uri }));

  return Promise.all(assets.map(async (asset) => {
    const uri = await resolveAssetUri(asset);
    if (!uri) return null;

    let takenAt = asset.takenAt ?? null;
    if (takenAt === null && uri.startsWith('file://')) {
      // 只对本地文件读 EXIF（远端图在预览时才会下载，暂不做额外请求）
      const parsed = await readTakenAtFromFile(uri);
      if (parsed !== null) {
        takenAt = parsed;
        await setAssetTakenAt(asset.id, parsed).catch(() => undefined);
      }
    }

    return { uri, takenAt } as PreviewImage;
  })).then((items) => items.filter((item): item is PreviewImage => Boolean(item)));
}

// 展示用：优先 asset（本地文件存在则用本地，否则用远端对象），没有 asset 时回退到记录里的 image_urls。
// 这样「本地文件被删但远端还在」时不会再显示灰块。
export async function resolveFootprintImageUris(footprintId: string, fallbackUris: string[]): Promise<string[]> {
  const { listAssetsByFootprint } = await import('@/src/local/repositories/assetRepository');
  const assets = await listAssetsByFootprint(footprintId);
  if (!assets.length) return fallbackUris;

  const resolved = (await Promise.all(assets.map((asset) => resolveAssetUri(asset))))
    .filter((uri): uri is string => Boolean(uri));
  return resolved.length ? resolved : fallbackUris;
}
