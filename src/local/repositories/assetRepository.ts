// 资产层：记录「一张图」的本地文件与远端对象，不参与记录级同步。
// 状态常量与字段设计参考 Joplin models/Resource.ts:62-65 与 resource_local_states 表。
import { ensureFootprintImageDirectory, footprintImageFileNameFromUri } from '@/src/features/daily/footprints/footprintImageFiles';
import { getJson, setJson } from '../storage';

export const ASSET_IDLE = 0;
export const ASSET_STARTED = 1;
export const ASSET_DONE = 2;
export const ASSET_ERROR = 3;

export type Asset = {
  id: string; // 32 位 hex（同时是同步项 id 的基础）
  footprintId: string;
  position: number;
  fileName: string; // 沙盒文件名 = `${id}.${ext}`
  size: number;
  mime: string;
  blobUpdatedTime: number; // 内容变更时间；只改标题/备注不会变
  takenAt?: number | null; // 照片拍摄时间（EXIF，毫秒）；未知为 null
  remoteKey: string | null;
  fetchStatus: number;
  fetchError: string | null;
  syncTime: number; // 上次成功同步时间
  forceSync: boolean;
};

const assetsKey = 'trip-footprints.assets';

let assetCache: Asset[] | null = null;
const assetListeners = new Set<(assets: Asset[]) => void>();

// 资产变化订阅：UI（列表/相册）依赖它刷新展示用 URI 与「待上传」角标
export function subscribeAssetsLocal(listener: (assets: Asset[]) => void) {
  assetListeners.add(listener);
  return () => {
    assetListeners.delete(listener);
  };
}

function mimeForExtension(ext: string) {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    default:
      return 'application/octet-stream';
  }
}

function extensionFromUri(uri: string) {
  const fileName = footprintImageFileNameFromUri(uri) || '';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg';
}

// 32 位 hex：vendored Joplin 的 isSystemPath() 要求该格式
export function createAssetId() {
  let output = '';
  while (output.length < 32) {
    output += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  }
  return output.slice(0, 32);
}

function sortAssets(assets: Asset[]) {
  return [...assets].sort((a, b) => (
    a.footprintId === b.footprintId
      ? a.position - b.position
      : a.footprintId.localeCompare(b.footprintId)
  ));
}

async function loadAssets() {
  if (assetCache) return assetCache;
  assetCache = await getJson<Asset[]>(assetsKey, []);
  return assetCache;
}

async function persistAssets(next: Asset[]) {
  assetCache = sortAssets(next);
  await setJson(assetsKey, assetCache);
  assetListeners.forEach((listener) => listener(assetCache as Asset[]));
  return assetCache;
}

export function resetAssetCacheForTests() {
  assetCache = null;
}

export async function listAllAssets() {
  return [...(await loadAssets())];
}

export async function listAssetsByFootprint(footprintId: string) {
  return (await loadAssets())
    .filter((asset) => asset.footprintId === footprintId)
    .sort((a, b) => a.position - b.position);
}

// 待上传 = 还没有远端对象，且当前没有正在进行的上传。
// 失败（ERROR）与未开始（IDLE/DONE）都要参与，否则一次失败就永远不会再重试。
export async function listAssetsNeedingUpload() {
  return (await loadAssets()).filter((asset) => !asset.remoteKey && asset.fetchStatus !== ASSET_STARTED);
}

// 供列表展示「待上传」角标：哪些足迹还有未同步完成的图片
export async function listFootprintIdsWithPendingAssets() {
  const ids = new Set<string>();
  for (const asset of await loadAssets()) {
    if (asset.fetchStatus !== ASSET_DONE || !asset.remoteKey) ids.add(asset.footprintId);
  }
  return ids;
}

export async function upsertAsset(asset: Asset) {
  const all = await loadAssets();
  await persistAssets([...all.filter((item) => item.id !== asset.id), asset]);
  return asset;
}

// 选图后调用：把文件复制进沙盒并命名为 <assetId>.<ext>
export async function createAssetFromLocalFile({
  footprintId,
  position,
  localUri,
}: {
  footprintId: string;
  position: number;
  localUri: string;
}): Promise<Asset> {
  const context = await ensureFootprintImageDirectory();
  if (!context) throw new Error('当前设备不支持本地图片文件存储。');

  const { FileSystem, dir } = context;
  const id = createAssetId();
  const fileName = `${id}.${extensionFromUri(localUri)}`;
  const targetUri = `${dir}${fileName}`;

  const existing = await FileSystem.getInfoAsync(targetUri);
  if (existing.exists) await FileSystem.deleteAsync(targetUri, { idempotent: true });
  await FileSystem.copyAsync({ from: localUri, to: targetUri });

  const info = await FileSystem.getInfoAsync(targetUri);
  if (!info.exists) throw new Error(`图片保存失败：${localUri}`);

  const now = Date.now();
  return upsertAsset({
    id,
    footprintId,
    position,
    fileName,
    size: (info as { size?: number }).size ?? 0,
    mime: mimeForExtension(extensionFromUri(localUri)),
    blobUpdatedTime: now,
    remoteKey: null,
    fetchStatus: ASSET_DONE,
    fetchError: null,
    syncTime: 0,
    forceSync: false,
  });
}

export type CreateAssetFromExistingFileInput = {
  footprintId: string;
  position: number;
  existingUri: string;
  remoteKey?: string | null;
  size?: number;
  syncTime?: number;
};

// 迁移专用：本地文件已存在，只需改名成 <assetId>.<ext>（不复制）
export async function createAssetFromExistingFile({
  footprintId,
  position,
  existingUri,
  remoteKey = null,
  size,
  syncTime = 0,
}: CreateAssetFromExistingFileInput): Promise<Asset> {
  const context = await ensureFootprintImageDirectory();
  if (!context) throw new Error('当前设备不支持本地图片文件存储。');

  const { FileSystem, dir } = context;
  const id = createAssetId();
  const fileName = `${id}.${extensionFromUri(existingUri)}`;
  const targetUri = `${dir}${fileName}`;
  let finalSize = size ?? 0;
  let fetchStatus = ASSET_DONE;

  try {
    if (existingUri !== targetUri) {
      await FileSystem.moveAsync({ from: existingUri, to: targetUri });
    }
    const info = await FileSystem.getInfoAsync(targetUri);
    if (info.exists) finalSize = (info as { size?: number }).size ?? finalSize;
  } catch {
    // 远端已有对象、本地文件不可用时，保留远端引用
    if (!remoteKey) throw new Error(`图片文件不可用：${existingUri}`);
    fetchStatus = ASSET_IDLE;
  }

  return upsertAsset({
    id,
    footprintId,
    position,
    fileName,
    size: finalSize,
    mime: mimeForExtension(extensionFromUri(existingUri)),
    blobUpdatedTime: Date.now(),
    remoteKey,
    fetchStatus,
    fetchError: null,
    syncTime,
    forceSync: false,
  });
}

async function patchAsset(assetId: string, patch: Partial<Asset>) {
  const all = await loadAssets();
  const target = all.find((asset) => asset.id === assetId);
  if (!target) return null;
  const next = { ...target, ...patch };
  await persistAssets([...all.filter((asset) => asset.id !== assetId), next]);
  return next;
}

export async function markAssetUploaded({ assetId, remoteKey }: { assetId: string; remoteKey: string }) {
  return patchAsset(assetId, {
    remoteKey,
    fetchStatus: ASSET_DONE,
    fetchError: null,
    syncTime: Date.now(),
    forceSync: false,
  });
}

export async function markAssetFailed({ assetId, error }: { assetId: string; error: string }) {
  return patchAsset(assetId, { fetchStatus: ASSET_ERROR, fetchError: error });
}

export async function markAssetCannotSync({ assetId, reason }: { assetId: string; reason: string }) {
  return patchAsset(assetId, { fetchStatus: ASSET_ERROR, fetchError: reason });
}

export async function setAssetBlobUpdated(assetId: string, timestamp: number) {
  return patchAsset(assetId, { blobUpdatedTime: timestamp });
}

export async function setAssetTakenAt(assetId: string, takenAt: number | null) {
  return patchAsset(assetId, { takenAt });
}

export async function deleteAssetsByFootprint(footprintId: string) {
  const all = await loadAssets();
  await persistAssets(all.filter((asset) => asset.footprintId !== footprintId));
}

// 远端删除联动：移除本地 asset 行，并删除它对应的本地文件（文件才是这张图在本机的副本）
export async function deleteAssetById(assetId: string) {
  const all = await loadAssets();
  const target = all.find((asset) => asset.id === assetId);
  if (!target) return null;

  const context = await ensureFootprintImageDirectory();
  if (context) {
    await context.FileSystem.deleteAsync(`${context.dir}${target.fileName}`, { idempotent: true }).catch(() => undefined);
  }

  await persistAssets(all.filter((asset) => asset.id !== assetId));
  return target.footprintId;
}

export async function clearAssets() {
  await persistAssets([]);
}
