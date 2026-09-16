// 资产同步队列（阶段 4）：
//   1) 待上传的本地图片 -> Storage（blob）+ 元数据项（<assetId>.md）
//   2) 只有内容变了才重新上传（Joplin Synchronizer.ts:785 等价）
//   3) 本地没有字节时拒绝上传（Joplin Synchronizer.ts:735-767 等价）
//   4) 远端有元数据、本地没有 blob -> 下载回来（清空本地后可恢复）
import { getJson, setJson } from '@/src/local/storage';
import { isLocalOnlyMode } from '@/src/local/repositories/appSettingsRepository';
import {
  ASSET_ERROR,
  ASSET_DONE,
  listAllAssets,
  listAssetsNeedingUpload,
  markAssetCannotSync,
  markAssetFailed,
  markAssetUploaded,
  deleteAssetById,
  upsertAsset,
  type Asset,
} from '@/src/local/repositories/assetRepository';
import { ensureFootprintImageDirectory } from '@/src/features/daily/footprints/footprintImageFiles';
import { localUriForAsset } from '@/src/features/daily/footprints/assetResolver';
import { isImageFile } from '@/src/features/daily/footprints/imageValidation';
import type { FileApi } from '@/src/vendor/joplin/file-api';
import TaskQueue from '@/src/vendor/joplin/TaskQueue';

// 并发上限：vendored TaskQueue 默认读 Setting（我们的替身返回 3）
export const ASSET_UPLOAD_CONCURRENCY = 3;

export type AssetSyncResult = {
  uploaded: number;
  published: number;
  downloaded: number;
  failed: number;
  deleted: number;
  // 本次同步动过的足迹 id（用于刷新记录里的镜像字段）
  touchedFootprintIds: string[];
};

type RemoteAssetMetadata = {
  id: string;
  footprintId: string;
  position: number;
  fileName: string;
  size: number;
  mime: string;
  blobUpdatedTime: number;
  remoteKey: string;
};

function contextKeyFor(syncTargetId: number) {
  return `trip-footprints.syncContext.${syncTargetId}`;
}

// 判定 1：只有内容变了（或从未上传）才需要上传
export function shouldUploadAsset(asset: Asset) {
  return !asset.remoteKey || asset.syncTime < asset.blobUpdatedTime || asset.forceSync;
}

// 判定 2：本地字节必须存在且大小一致，否则拒绝上传
export async function canUploadAsset(asset: Asset) {
  const localUri = await localUriForAsset(asset);
  if (!localUri) return false;
  const context = await ensureFootprintImageDirectory();
  if (!context) return false;
  const info = await context.FileSystem.getInfoAsync(localUri);
  const size = (info as { size?: number }).size ?? 0;
  if (!info.exists || size <= 0) return false;
  if (asset.size > 0 && size !== asset.size) return false;
  // 必须是真正的图片文件（避免把下载错误留下的 JSON 之类传上去）
  return isImageFile(localUri);
}

export function assetMetadataBody(asset: Asset, remoteKey: string): RemoteAssetMetadata {
  return {
    id: asset.id,
    footprintId: asset.footprintId,
    position: asset.position,
    fileName: asset.fileName,
    size: asset.size,
    mime: asset.mime,
    blobUpdatedTime: asset.blobUpdatedTime,
    remoteKey,
  };
}

function parseMetadata(body: string | null | undefined): RemoteAssetMetadata | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as RemoteAssetMetadata;
    if (!parsed?.id || !parsed?.remoteKey || !parsed?.fileName) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function publishAssetMetadata(fileApi: FileApi, asset: Asset, remoteKey: string) {
  await fileApi.put(`${asset.id}.md`, JSON.stringify(assetMetadataBody(asset, remoteKey)));
}

// 从远端拉取「自上次游标以来的资产元数据」；顺带持久化游标
async function fetchRemoteAssets(fileApi: FileApi, syncTargetId: number) {
  const context = await getJson<unknown>(contextKeyFor(syncTargetId), null);
  // 只有「曾经同步成功过」的资产才参与远端删除检测。
  // 从未上传成功的资产如果也算进去，basicDelta 会误判为「远端已删除」并把本地副本清掉。
  // （Joplin 同样以 sync_time > 0 的项为准，见 models/BaseItem.ts remoteItemMetadata）
  const localIds = (await listAllAssets())
    .filter((asset) => Boolean(asset.remoteKey) || asset.syncTime > 0)
    .map((asset) => asset.id);

  const result = await fileApi.delta('', {
    context,
    allItemIdsHandler: async () => localIds,
    allItemMetadataHandler: async () => new Map(),
    wipeOutFailSafe: false,
  } as never);

  if (result.context) {
    await setJson(contextKeyFor(syncTargetId), result.context);
  }

  const assets: RemoteAssetMetadata[] = [];
  const deletedIds: string[] = [];
  for (const item of result.items as { path?: string; isDeleted?: boolean }[]) {
    if (!item.path) continue;
    if (item.isDeleted) {
      // '<hex>.md' -> '<hex>'
      const name = item.path.split('/').pop() || '';
      const id = name.replace(/\.[^.]+$/, '');
      if (id) deletedIds.push(id);
      continue;
    }
    const body = await fileApi.get(item.path);
    const metadata = parseMetadata(typeof body === 'string' ? body : null);
    if (metadata) assets.push(metadata);
  }
  return { assets, deletedIds };
}

export async function runAssetSync({
  fileApi,
  userId,
  syncTargetId,
  onProgress,
}: {
  fileApi: FileApi;
  userId: string;
  syncTargetId: number;
  /** 资产阶段进度：stage='upload' 是上传队列，stage='download' 是下载恢复 */
  onProgress?: (done: number, total: number, stage: 'upload' | 'download') => void;
}): Promise<AssetSyncResult> {
  const result: AssetSyncResult = {
    uploaded: 0,
    published: 0,
    downloaded: 0,
    failed: 0,
    deleted: 0,
    touchedFootprintIds: [],
  };

  // 本地模式：图片只保存在本机，不做任何网络同步（防御性检查，正常入口已隐藏）
  if (await isLocalOnlyMode()) return result;

  const touch = (footprintId: string) => {
    if (footprintId && !result.touchedFootprintIds.includes(footprintId)) {
      result.touchedFootprintIds.push(footprintId);
    }
  };

  // --- 1) 上传本地待同步的图片 ---
  const uploadTargets = (await listAssetsNeedingUpload()).filter(shouldUploadAsset);
  let uploadedCount = 0;
  onProgress?.(0, uploadTargets.length, 'upload');

  const uploadQueue = new TaskQueue('assetUpload');
  uploadQueue.setConcurrency(ASSET_UPLOAD_CONCURRENCY);

  for (const asset of uploadTargets) {
    uploadQueue.push(asset.id, async () => {
      try {
        if (!(await canUploadAsset(asset))) {
          await markAssetCannotSync({ assetId: asset.id, reason: '本地图片不可用或大小不一致' });
          result.failed += 1;
          return;
        }

        const localUri = await localUriForAsset(asset);
        const objectKey = `${userId}/assets/${asset.id}`;
        await fileApi.put(`resources/${asset.id}`, null, {
          source: 'file',
          path: localUri,
          contentType: asset.mime,
        } as never);

        await markAssetUploaded({ assetId: asset.id, remoteKey: objectKey });
        await publishAssetMetadata(fileApi, { ...asset, remoteKey: objectKey }, objectKey);
        result.uploaded += 1;
        touch(asset.footprintId);
      } catch (error) {
        await markAssetFailed({
          assetId: asset.id,
          error: error instanceof Error ? error.message : String(error),
        });
        result.failed += 1;
      } finally {
        uploadedCount += 1;
        onProgress?.(uploadedCount, uploadTargets.length, 'upload');
      }
    });
  }
  await uploadQueue.waitForAll();

  // --- 2) 远端元数据 ---
  const { assets: remoteAssets, deletedIds } = await fetchRemoteAssets(fileApi, syncTargetId);

  // --- 2.5) 远端已删除的资产 -> 删除本地副本 ---
  for (const deletedId of deletedIds) {
    const footprintId = await deleteAssetById(deletedId);
    if (footprintId) {
      result.deleted += 1;
      touch(footprintId);
    }
  }

  // --- 3) 本地已有 blob 但远端没有元数据 -> 补发布 ---
  // 注意：basicDelta 只返回「自上次游标以来变化」的项，不能用来判断存在性，
  // 因此这里对每个资产单独 stat（1 次请求），避免重复发布与无谓的 updated_at 变更。
  for (const asset of await listAllAssets()) {
    if (!asset.remoteKey) continue;
    try {
      if (await fileApi.stat(`${asset.id}.md`)) continue;
      await publishAssetMetadata(fileApi, asset, asset.remoteKey);
      result.published += 1;
      touch(asset.footprintId);
    } catch (error) {
      await markAssetFailed({
        assetId: asset.id,
        error: error instanceof Error ? error.message : String(error),
      });
      result.failed += 1;
    }
  }

  // --- 4) 远端有元数据、本地没有图片 -> 下载恢复 ---
  const context = await ensureFootprintImageDirectory();
  if (context) {
    let scanned = 0;
    onProgress?.(0, remoteAssets.length, 'download');
    for (const metadata of remoteAssets) {
      const local = (await listAllAssets()).find((asset) => asset.id === metadata.id);
      const localUri = local ? await localUriForAsset(local) : null;
      if (localUri) {
        scanned += 1;
        onProgress?.(scanned, remoteAssets.length, 'download');
        continue;
      }

      try {
        const destUri = `${context.dir}${metadata.fileName}`;
        await fileApi.get(`resources/${metadata.id}`, { target: 'file', path: destUri } as never);

        const info = await context.FileSystem.getInfoAsync(destUri);
        const size = (info as { size?: number }).size ?? 0;
        if (!info.exists || size <= 0) throw new Error(`下载后文件为空：${destUri}`);

        await upsertAsset({
          id: metadata.id,
          footprintId: metadata.footprintId,
          position: metadata.position,
          fileName: metadata.fileName,
          size,
          mime: metadata.mime,
          blobUpdatedTime: metadata.blobUpdatedTime,
          remoteKey: metadata.remoteKey,
          fetchStatus: ASSET_DONE,
          fetchError: null,
          syncTime: Date.now(),
          forceSync: false,
        });
        result.downloaded += 1;
        touch(metadata.footprintId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await context.FileSystem.deleteAsync(`${context.dir}${metadata.fileName}`, { idempotent: true }).catch(() => undefined);
        // 记录一条失败资产，让 UI 能显示「待处理」而不是静默灰块
        await upsertAsset({
          id: metadata.id,
          footprintId: metadata.footprintId,
          position: metadata.position,
          fileName: metadata.fileName,
          size: 0,
          mime: metadata.mime,
          blobUpdatedTime: metadata.blobUpdatedTime,
          remoteKey: metadata.remoteKey,
          fetchStatus: ASSET_ERROR,
          fetchError: message,
          syncTime: 0,
          forceSync: false,
        });
        result.failed += 1;
      } finally {
        scanned += 1;
        onProgress?.(scanned, remoteAssets.length, 'download');
      }
    }
  }

  return result;
}
