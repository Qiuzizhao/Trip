import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';

import { listAllAssets, subscribeAssetsLocal } from '@/src/local/repositories/assetRepository';
import { migrateFootprintImagesToAssets } from '@/src/local/repositories/assetMigration';
import { listFootprintsLocal, subscribeFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { getJson, setJson } from '@/src/local/storage';
import { resolveAssetUri } from '../assetResolver';
import { photoAlbumNative, type AlbumPermission } from './native';

export type AlbumState = {
  phase: 'idle' | 'syncing' | 'done' | 'permission' | 'error';
  permission?: AlbumPermission;
  total: number;
  completed: number;
  failed: number;
};
let state: AlbumState = { phase: 'idle', total: 0, completed: 0, failed: 0 };
const listeners = new Set<(next: AlbumState) => void>();
export const getSystemAlbumState = () => state;
export function subscribeSystemAlbum(listener: (next: AlbumState) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(patch: Partial<AlbumState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener(state));
}

const manifestKey = 'trip.system-photo-album.hashes.v1';
type Source = { key: string; resolve: () => Promise<string | null> };
let running: Promise<void> | null = null;
let rerun = false;
let timer: ReturnType<typeof setTimeout> | undefined;

async function sources(): Promise<Source[]> {
  // The old migration moves files: wait for it before reading any historical path.
  await migrateFootprintImagesToAssets();
  const records = await listFootprintsLocal();
  const assets = await listAllAssets();
  return records.flatMap((record) => {
    const pictures = assets.filter((asset) => asset.footprintId === record.id);
    if (pictures.length) return pictures.map((asset) => ({
      key: `asset:${asset.id}:${asset.blobUpdatedTime}`,
      resolve: () => resolveAssetUri(asset),
    }));
    const old = Array.isArray(record.image_urls) ? record.image_urls
      : typeof record.image_urls === 'string' ? [record.image_urls] : [record.image_url];
    return [...new Set(old.filter((uri): uri is string => typeof uri === 'string' && Boolean(uri)))].map((uri) => ({
      key: `legacy:${uri}`,
      resolve: async () => uri,
    }));
  });
}

async function sync(requestPermission: boolean) {
  const native = photoAlbumNative;
  if (!native) return;
  const items = await sources();
  publish({ total: items.length, completed: 0, failed: 0 });
  if (!items.length) { publish({ phase: 'done' }); return; }
  // Only the OS's first prompt is automatic; denied/limited access is handled in Settings.
  const permission = await native.permission(requestPermission);
  publish({ permission });
  if (permission !== 'authorized') { publish({ phase: 'permission' }); return; }
  publish({ phase: 'syncing' });
  const hashes = new Set(await native.snapshot());
  const manifest = await getJson<Record<string, string>>(manifestKey, {});
  const nextManifest: Record<string, string> = {};
  let failed = 0;
  let completed = 0;
  for (const item of items) {
    if (AppState.currentState !== 'active') break;
    let temporary: string | null = null;
    try {
      const previousHash = manifest[item.key];
      if (previousHash && hashes.has(previousHash)) {
        nextManifest[item.key] = previousHash;
      } else {
        let uri = await item.resolve();
        if (!uri) throw new Error('图片不可用');
        if (/^https?:\/\//i.test(uri)) {
          if (!FileSystem.cacheDirectory) throw new Error('缓存目录不可用');
          const ext = uri.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/)?.[1] || 'jpg';
          const directory = `${FileSystem.cacheDirectory}trip-system-album/`;
          await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
          temporary = `${directory}original.${ext}`;
          const result = await FileSystem.downloadAsync(uri, temporary);
          if (result.status < 200 || result.status >= 300) throw new Error('下载失败');
          uri = result.uri;
        }
        const hash = await native.hashFile(uri);
        if (!hashes.has(hash)) {
          await native.save(uri, hash);
          hashes.add(hash);
        }
        nextManifest[item.key] = hash;
        // Checkpoint every photo; interrupted exports resume without creating duplicate assets.
        await setJson(manifestKey, { ...manifest, ...nextManifest });
      }
      completed += 1;
    } catch {
      failed += 1;
    } finally {
      if (temporary) await FileSystem.deleteAsync(temporary, { idempotent: true }).catch(() => undefined);
    }
    publish({ completed, failed });
  }
  // Keep untouched checkpoints when backgrounded. A complete pass discards stale source keys.
  await setJson(manifestKey, completed + failed === items.length ? nextManifest : { ...manifest, ...nextManifest });
  publish({ phase: failed ? 'error' : completed === items.length ? 'done' : 'idle', completed, failed });
}

export function syncSystemAlbum(requestPermission = true): Promise<void> {
  if (!photoAlbumNative) return Promise.resolve();
  if (running) { rerun = true; return running; }
  running = sync(requestPermission).catch(() => {
    publish({ phase: 'error', failed: Math.max(1, state.failed) });
  }).finally(() => {
    running = null;
    if (rerun) { rerun = false; schedule(); }
  });
  return running;
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (AppState.currentState === 'active') void syncSystemAlbum();
  }, 1500);
}

export function startSystemAlbumSync() {
  if (!photoAlbumNative) return () => {};
  const unsubscribeAssets = subscribeAssetsLocal(schedule);
  const unsubscribeFootprints = subscribeFootprintsLocal(schedule);
  const appState = AppState.addEventListener('change', (next) => { if (next === 'active') schedule(); });
  schedule();
  return () => {
    clearTimeout(timer);
    unsubscribeAssets();
    unsubscribeFootprints();
    appState.remove();
  };
}
