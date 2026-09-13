// 一次性迁移：把历史记录里的 image_url(s) 变成 asset 行。
// 迁移期间记录里的 image_urls 仍然保留（作为同步与旧版本的镜像），asset 是新增的真相层。
import { ensureFootprintImageDirectory } from '@/src/features/daily/footprints/footprintImageFiles';
import { objectKeyFromPublicUrl } from '@/src/features/daily/footprints/assetResolver';
import { getJson, setJson } from '../storage';
import { createAssetFromExistingFile, listAllAssets } from './assetRepository';
import { listFootprintsForSync } from './footprintsRepository';

const migratedKey = 'trip-footprints.assetsMigratedAt';

function imageList(values?: unknown, fallback?: unknown) {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? [values]
      : typeof fallback === 'string'
        ? [fallback]
        : [];
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)));
}

function isRemoteUri(uri: string) {
  return /^https?:\/\//i.test(uri);
}

function isLocalUri(uri: string) {
  return /^(file|content):\/\//i.test(uri);
}

export async function migrateFootprintImagesToAssets() {
  const alreadyMigrated = await getJson<string | null>(migratedKey, null);
  if (alreadyMigrated) return { created: 0, skipped: true };

  const records = await listFootprintsForSync();
  const existingAssets = await listAllAssets();
  const context = await ensureFootprintImageDirectory();
  let created = 0;

  for (const record of records) {
    if (record.deleted_at) continue;

    const uris = imageList(record.image_urls, record.image_url);
    if (!uris.length) continue;

    const existingCount = existingAssets.filter((asset) => asset.footprintId === record.id).length;
    if (existingCount >= uris.length) continue; // 幂等：这条已迁移过

    for (let index = existingCount; index < uris.length; index += 1) {
      const uri = uris[index];
      try {
        if (isLocalUri(uri)) {
          if (!context) continue;
          const info = await context.FileSystem.getInfoAsync(uri);
          if (!info.exists) continue;
          await createAssetFromExistingFile({ footprintId: record.id, position: index, existingUri: uri });
          created += 1;
        } else if (isRemoteUri(uri)) {
          const remoteKey = objectKeyFromPublicUrl(uri);
          if (!remoteKey) continue;
          // 远端已有对象、本地没有文件：只登记引用，size 未知（0），交给后续校验
          await createAssetFromExistingFile({
            footprintId: record.id,
            position: index,
            existingUri: uri,
            remoteKey,
            size: 0,
            syncTime: 0,
          });
          created += 1;
        }
      } catch {
        // 单条失败不影响其它记录
      }
    }
  }

  await setJson(migratedKey, new Date().toISOString());
  return { created, skipped: false };
}
