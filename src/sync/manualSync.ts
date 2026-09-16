// 手动同步（资产模型版）：
//   1) 记录级：trip_footprints 只同步元数据（图片不再随记录走）
//   2) 修复：历史上的 0 字节对象按 asset 重传（每个账号只跑一次）
//   3) 资产级：blob -> Storage + <assetId>.md 元数据项；远端有元数据而本地缺图时下载恢复
//   4) 合并远端记录
import { listAllAssets } from '@/src/local/repositories/assetRepository';
import { isLocalOnlyMode } from '@/src/local/repositories/appSettingsRepository';
import { migrateFootprintImagesToAssets } from '@/src/local/repositories/assetMigration';
import { listFootprintsForSync, replaceFootprintsFromSync, type FootprintItem } from '@/src/local/repositories/footprintsRepository';
import { getSyncMetadata, saveSyncMetadata } from '@/src/local/syncMetadataRepository';
import { normalizeTags } from '@/src/features/daily/footprints/footprintTags';
import { repairEmptyAssetObjects } from './assetRepair';
import { runAssetSync } from './assetQueue';
import { mergeSyncRecords } from './syncMerge';
import { countProgress, ratioProgress, SYNC_PROGRESS_COMPLETE, type SyncProgressListener } from './syncProgress';
import { createSupabaseFileApi, SUPABASE_SYNC_TARGET_ID } from './supabase/fileApiFactory';
import { createSupabaseSyncBackend } from './supabase/syncBackend';
import { getCurrentSession, getSupabaseClient, isSupabaseConfigured } from './supabaseClient';

export type ManualSyncResult =
  | {
      status: 'signedOut';
    }
  | {
      status: 'synced';
      uploadedFootprints: number;
      downloadedFootprints: number;
      repairedAssetObjects: number;
      uploadedAssets: number;
      downloadedAssets: number;
      failedAssets: number;
      syncedAt: string;
    };

function toRemoteFootprint(footprint: FootprintItem, userId: string) {
  return {
    id: footprint.id,
    user_id: userId,
    location: String(footprint.location || ''),
    coordinate: footprint.coordinate ? String(footprint.coordinate) : null,
    visit_date: String(footprint.visit_date || ''),
    notes: footprint.notes ? String(footprint.notes) : null,
    tags: normalizeTags(footprint.tags),
    rating: typeof footprint.rating === 'number' ? footprint.rating : null,
    created_at: footprint.created_at,
    updated_at: footprint.updated_at,
    deleted_at: footprint.deleted_at ?? null,
  };
}

function toLocalFootprint(footprint: Record<string, unknown>): FootprintItem {
  return {
    id: String(footprint.id),
    location: String(footprint.location ?? ''),
    coordinate: (footprint.coordinate as string | null) ?? null,
    visit_date: String(footprint.visit_date ?? ''),
    notes: (footprint.notes as string | null) ?? null,
    tags: normalizeTags(footprint.tags),
    rating: (footprint.rating as number | null) ?? null,
    created_at: String(footprint.created_at),
    updated_at: String(footprint.updated_at),
    deleted_at: (footprint.deleted_at as string | null) ?? null,
    sync_status: 'synced',
  };
}

// 历史上传 bug 留下的 0 字节对象：按 asset 重传（新命名用资产自己的文件，旧命名按对象名里的 hash 反查）。
// 每次同步都跑：开销只是「每个目录一次 list」，但能自愈
// （曾经的「只跑一次」标记会在资产尚未从服务器同步下来时被过早置位，导致永远不再修复）。
async function repairAssetObjectsOnce(onProgress?: (done: number, total: number) => void) {
  try {
    const result = await repairEmptyAssetObjects({
      backend: createSupabaseSyncBackend(),
      assets: await listAllAssets(),
      onProgress,
    });
    return result.repaired;
  } catch {
    // 修复失败不允许影响同步
    return 0;
  }
}

export async function runManualSync({
  onProgress,
}: {
  /** 同步进度回调：只给「同步中」弹窗用，不影响同步结果 */
  onProgress?: SyncProgressListener;
} = {}): Promise<ManualSyncResult> {
  if (!isSupabaseConfigured()) {
    throw new Error('还没有配置 Supabase。请设置 EXPO_PUBLIC_SUPABASE_URL 和 EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY。');
  }

  if (await isLocalOnlyMode()) {
    throw new Error('本地模式已开启：图片只保存在本机，不会上传。可在「设置 → 本地模式」中关闭。');
  }

  const session = await getCurrentSession();
  if (!session?.user) return { status: 'signedOut' };

  const report = onProgress;
  const supabase = getSupabaseClient();
  const userId = session.user.id;
  const syncedAt = new Date().toISOString();

  // 先确保历史记录已迁移成 asset（幂等），否则首次同步会先清掉本地的 image_urls 镜像
  await migrateFootprintImagesToAssets().catch(() => undefined);

  const localFootprints = await listFootprintsForSync();
  const pendingFootprints = localFootprints.filter(
    (footprint) => footprint.sync_status === 'pending' || footprint.sync_status === 'failed',
  );

  // 1) 记录级同步（只含元数据）
  report?.(countProgress('records', 0, pendingFootprints.length, ' 条'));
  if (pendingFootprints.length > 0) {
    const { error } = await supabase
      .from('trip_footprints')
      .upsert(pendingFootprints.map((footprint) => toRemoteFootprint(footprint, userId)), { onConflict: 'id' });
    if (error) throw error;
  }
  report?.(countProgress('records', pendingFootprints.length, pendingFootprints.length, ' 条'));

  // 2) 资产级同步
  let assetResult = {
    uploaded: 0,
    published: 0,
    downloaded: 0,
    failed: 0,
    deleted: 0,
    touchedFootprintIds: [] as string[],
  };
  report?.(ratioProgress('assets', 0, '同步照片资产…'));
  try {
    const fileApi = await createSupabaseFileApi();
    assetResult = await runAssetSync({
      fileApi,
      userId,
      syncTargetId: SUPABASE_SYNC_TARGET_ID,
      onProgress: (done, total, stage) => {
        // 资产阶段内部再分两段：上传占 0.6，下载恢复占 0.4
        const share = total > 0 ? done / total : 1;
        const label = stage === 'upload' ? '上传' : '下载';
        report?.(ratioProgress(
          'assets',
          stage === 'upload' ? share * 0.6 : 0.6 + share * 0.4,
          total > 0 ? `同步照片资产 · ${label} ${done}/${total} 张` : '同步照片资产',
          total > 0 ? `${done}/${total}` : undefined,
        ));
      },
    });
  } catch {
    // 资产队列整体不可用时（未登录/网络异常），保留记录级同步结果
  }

  // 3) 老数据修复（放在资产同步之后：这样刚从服务器同步下来的资产也能参与修复）
  report?.(ratioProgress('repair', 0, '修复历史空图…'));
  const repairedAssetObjects = await repairAssetObjectsOnce(
    (done, total) => report?.(countProgress('repair', done, total, ' 张')),
  );

  // 4) 拉取远端记录并合并
  report?.(ratioProgress('merge', 0, '拉取云端记录…'));
  const { data: remoteFootprintsData, error: remoteFootprintsError } = await supabase
    .from('trip_footprints')
    .select('id,user_id,location,coordinate,visit_date,notes,tags,rating,created_at,updated_at,deleted_at')
    .eq('user_id', userId);
  if (remoteFootprintsError) throw remoteFootprintsError;

  const remoteFootprints = ((remoteFootprintsData ?? []) as Record<string, unknown>[]).map(toLocalFootprint);
  report?.(countProgress('merge', remoteFootprints.length, remoteFootprints.length, ' 条'));
  const pendingById = new Map(pendingFootprints.map((footprint) => [footprint.id, footprint]));
  const mergedFootprints = mergeSyncRecords(
    localFootprints.map((footprint) => ({
      ...(pendingById.get(footprint.id) ?? footprint),
      sync_status: pendingById.has(footprint.id) ? 'synced' as const : footprint.sync_status,
    })),
    remoteFootprints,
  ).map((footprint) => ({ ...footprint, sync_status: 'synced' as const }));

  await replaceFootprintsFromSync(mergedFootprints);
  await saveSyncMetadata({ ...(await getSyncMetadata()), last_synced_at: syncedAt });
  report?.(SYNC_PROGRESS_COMPLETE);

  return {
    status: 'synced',
    uploadedFootprints: pendingFootprints.length,
    downloadedFootprints: remoteFootprints.length,
    repairedAssetObjects,
    uploadedAssets: assetResult.uploaded,
    downloadedAssets: assetResult.downloaded,
    failedAssets: assetResult.failed,
    syncedAt,
  };
}
