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
const receiptsKey = 'trip.system-photo-album.receipts.v2';
type Source = { key: string; resolve: () => Promise<string | null> };
let running: Promise<void> | null = null;
let rerun = false;
let pauseDepth = 0;
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
  if (!items.length) { publish({ phase: 'done', total: 0, completed: 0, failed: 0 }); return; }
  // Only the OS's first prompt is automatic; denied/limited access is handled in Settings.
  const manifest = await getJson<Record<string, string>>(manifestKey, {});
  const receipts = await getJson<string[]>(receiptsKey, []);
  // A committed save is authoritative even if Photos cannot currently enumerate its
  // original filename. Migrate v1 acknowledgements before considering any new writes.
  const hashes = new Set([...receipts, ...Object.values(manifest)]);
  if (hashes.size !== new Set(receipts).size) {
    await native.rememberSavedHashes?.(Array.from(hashes));
    await setJson(receiptsKey, Array.from(hashes));
  }
  const acknowledged = (item: Source) => manifest[item.key];
  if (items.every((item) => acknowledged(item))) {
    publish({ phase: 'done', total: items.length, completed: items.length, failed: 0 });
    return;
  }
  publish({ total: items.length, completed: 0, failed: 0 });
  const permission = await native.permission(requestPermission);
  publish({ permission });
  if (permission !== 'authorized') { publish({ phase: 'permission' }); return; }
  publish({ phase: 'syncing' });
  await setJson(receiptsKey, Array.from(hashes));
  await native.rememberSavedHashes?.(Array.from(hashes));
  for (const hash of await native.snapshot()) hashes.add(hash);
  await setJson(receiptsKey, Array.from(hashes));
  const nextManifest: Record<string, string> = {};
  let failed = 0;
  let completed = 0;
  for (const item of items) {
    if (AppState.currentState !== 'active' || pauseDepth > 0) break;
    let temporary: string | null = null;
    try {
      const previousHash = manifest[item.key];
      if (previousHash) {
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
          await setJson(receiptsKey, Array.from(hashes));
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
  await setJson(manifestKey, { ...manifest, ...nextManifest });
  publish({ phase: failed ? 'error' : completed === items.length ? 'done' : 'idle', completed, failed });
}

export function syncSystemAlbum(requestPermission = true): Promise<void> {
  if (!photoAlbumNative || pauseDepth > 0) return Promise.resolve();
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
  if (pauseDepth > 0) return;
  timer = setTimeout(() => {
    if (AppState.currentState === 'active') void syncSystemAlbum();
  }, 1500);
}

export function startSystemAlbumSync() {
  if (!photoAlbumNative) return () => {};
  let assetSignature: string | undefined;
  let recordSignature: string | undefined;
  const unsubscribeAssets = subscribeAssetsLocal((assets) => {
    const next = assets.map((asset) => `${asset.footprintId}:${asset.id}:${asset.fileName}`).sort().join('|');
    if (assetSignature !== next) { assetSignature = next; schedule(); }
  });
  const unsubscribeFootprints = subscribeFootprintsLocal((records) => {
    const next = records.map((record) => JSON.stringify([record.id, record.deleted_at,
      record.image_urls ?? record.image_url ?? null])).sort().join('|');
    if (recordSignature !== next) { recordSignature = next; schedule(); }
  });
  const appState = AppState.addEventListener('change', (next) => { if (next === 'active') schedule(); });
  schedule();
  return () => {
    clearTimeout(timer);
    unsubscribeAssets();
    unsubscribeFootprints();
    appState.remove();
  };
}


// A duplicate preview must stay stable while the user reviews and confirms it.
export function pauseSystemAlbumSync() {
  pauseDepth += 1;
  clearTimeout(timer);
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    pauseDepth = Math.max(0, pauseDepth - 1);
    if (!pauseDepth) schedule();
  };
}
