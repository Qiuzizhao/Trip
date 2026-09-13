// 修复历史上传产生的 0 字节对象（基于 asset，不再依赖记录里的 image_urls）。
//
// 两类对象都能修：
//   1) 新命名 <user>/assets/<hex>            -> 本地源文件就是资产自己的文件
//   2) 旧命名 <user>/<footprint>/<n>-<hash>.<ext> -> 本地源文件按对象名里的 hash 反查
import type { Asset } from '@/src/local/repositories/assetRepository';
import { markAssetFailed } from '@/src/local/repositories/assetRepository';
import { footprintImageHash } from '@/src/features/daily/footprints/footprintImageFiles';
import { listPersistedFootprintImageHashes } from '@/src/features/daily/footprints/footprintImageFiles';
import { localUriForAsset } from '@/src/features/daily/footprints/assetResolver';
import { isImageFile } from '@/src/features/daily/footprints/imageValidation';
import { ensureFootprintImageDirectory } from '@/src/features/daily/footprints/footprintImageFiles';
import { contentTypeForObjectKey } from './mimeTypes';
import type { SyncBackend } from './supabase/syncBackend';

export type AssetRepairResult = {
  repaired: number;
  failed: number;
  /** 无法校验（目录列表读取失败），留给下次再试 */
  unchecked: number;
};

function legacyHashFromObjectName(name: string) {
  const match = /^\d+-([a-z0-9]+)\.[a-z0-9]{1,5}$/i.exec(name);
  return match ? match[1].toLowerCase() : null;
}

export async function repairEmptyAssetObjects({
  backend,
  assets,
}: {
  backend: SyncBackend;
  assets: Asset[];
}): Promise<AssetRepairResult> {
  const candidates = assets.filter((asset) => Boolean(asset.remoteKey));
  if (!candidates.length) return { repaired: 0, failed: 0, unchecked: 0 };

  const localFilesByHash = await listPersistedFootprintImageHashes();
  const sizesByFolder = new Map<string, Map<string, number> | null>();
  let repaired = 0;
  let failed = 0;
  let unchecked = 0;

  for (const asset of candidates) {
    const objectKey = asset.remoteKey as string;
    const parts = objectKey.split('/');
    const name = parts.pop() as string;
    const folder = parts.join('/');

    if (!sizesByFolder.has(folder)) {
      sizesByFolder.set(folder, await backend.listSizes(folder));
    }
    const sizes = sizesByFolder.get(folder);
    if (!sizes) {
      unchecked += 1;
      continue;
    }

    const size = sizes.get(name);
    // 只有「对象不存在」或「对象为空」才需要修；内容正常则跳过
    if (size !== undefined && size > 0) continue;

    let localUri = await localUriForAsset(asset);
    if (!localUri) {
      const hash = legacyHashFromObjectName(name);
      if (hash) localUri = localFilesByHash.get(hash) ?? null;
    }
    if (!localUri) {
      // 没有本地原图就无法修：标记失败（UI 显示待处理），下次同步还会再试
      await markAssetFailed({ assetId: asset.id, error: '本地原图不存在，无法修复空对象' });
      failed += 1;
      continue;
    }

    // 本地文件必须真的是图片：否则只会上传一份无效内容（例如下载错误留下的 JSON）
    if (!(await isImageFile(localUri))) {
      const context = await ensureFootprintImageDirectory();
      if (context) {
        await context.FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
      }
      await markAssetFailed({ assetId: asset.id, error: '本地文件不是有效图片，已删除' });
      failed += 1;
      continue;
    }

    try {
      const storedSize = await backend.uploadBlob(objectKey, localUri, contentTypeForObjectKey(objectKey));
      if (!storedSize) throw new Error(`上传后仍为空：${objectKey}`);
      repaired += 1;
    } catch {
      failed += 1;
    }
  }

  return { repaired, failed, unchecked };
}

// 供测试/调试：某个本地文件能否被对象的 legacy hash 命中
export function hashMatchesObjectName(localUri: string, objectName: string) {
  const hash = legacyHashFromObjectName(objectName);
  return Boolean(hash) && footprintImageHash(localUri) === hash;
}
