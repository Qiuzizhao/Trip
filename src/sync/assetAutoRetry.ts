// 资产级自动重试（计划 4.3 的 AsyncActionQueue 接线）。
// 触发源：App 启动、从后台回到前台。多个触发会被 AsyncActionQueue 去抖合并成一次执行。
// 只跑资产队列（上传/下载/删除），不做记录级合并——记录同步仍然由用户手动触发。
import { AppState } from 'react-native';

import { listAssetsNeedingUpload, listAllAssets } from '@/src/local/repositories/assetRepository';
import { isLocalOnlyMode } from '@/src/local/repositories/appSettingsRepository';
import AsyncActionQueue from '@/src/vendor/joplin/AsyncActionQueue';
import { runAssetSync } from './assetQueue';
import { createSupabaseFileApi, SUPABASE_SYNC_TARGET_ID } from './supabase/fileApiFactory';
import { getCurrentSession } from './supabaseClient';

let queue: AsyncActionQueue<void> | null = null;
let running = false;
let appStateSubscription: { remove: () => void } | null = null;
let unsubscribeAssets: (() => void) | null = null;

function getQueue() {
  if (!queue) {
    // 100ms 去抖：启动 + 前台事件在很短时间内连续到来时只跑一次
    queue = new AsyncActionQueue<void>(100);
  }
  return queue;
}

export type AssetRetryResult = { ran: boolean; uploaded: number; downloaded: number; failed: number } | null;

// 是否值得跑一次：有未上传的资产，或本地 asset 数量为 0 但……
// 这里只检查「有待上传」，避免在没有资产时白白发请求。
async function hasPendingWork() {
  const pending = await listAssetsNeedingUpload();
  return pending.length > 0;
}

export async function runAssetRetryNow(): Promise<AssetRetryResult> {
  if (running) return null;
  running = true;
  try {
    // 本地模式：不做任何网络同步（含上传与下载）
    if (await isLocalOnlyMode()) return null;
    const session = await getCurrentSession();
    if (!session?.user) return null;
    if (!(await hasPendingWork())) return null;

    const fileApi = await createSupabaseFileApi();
    const result = await runAssetSync({ fileApi, userId: session.user.id, syncTargetId: SUPABASE_SYNC_TARGET_ID });
    return { ran: true, uploaded: result.uploaded, downloaded: result.downloaded, failed: result.failed };
  } catch {
    // 自动重试失败保持静默，等下一个触发源
    return null;
  } finally {
    running = false;
  }
}

export function scheduleAssetRetry() {
  getQueue().push(async () => {
    await runAssetRetryNow();
  });
  return getQueue().waitForAllDone();
}

// 在根布局调用一次：挂上 AppState 监听（回到前台时重试）
export function startAssetAutoRetry() {
  if (appStateSubscription) return;

  void scheduleAssetRetry();

  appStateSubscription = AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') void scheduleAssetRetry();
  });
}

export function stopAssetAutoRetry() {
  appStateSubscription?.remove();
  appStateSubscription = null;
  unsubscribeAssets?.();
  unsubscribeAssets = null;
}

// 测试与调试用：直接看当前是否有待上传资产
export async function countPendingAssets() {
  const [pending, all] = await Promise.all([listAssetsNeedingUpload(), listAllAssets()]);
  return { pending: pending.length, total: all.length };
}
