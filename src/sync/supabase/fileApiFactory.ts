import { FileApi } from '@/src/vendor/joplin/file-api';
import FileApiDriverMemory from '@/src/vendor/joplin/file-api-driver-memory';
import { getCurrentSession } from '@/src/sync/supabaseClient';
import { SupabaseFileApiDriver } from './fileApiDriver';
import { createSupabaseSyncBackend } from './syncBackend';

export const SUPABASE_SYNC_TARGET_ID = 100;

// 阶段 1 用内存驱动验证 vendored FileApi 能否在本地环境跑通（不联网）。
// 阶段 3 会在这里增加 createSupabaseFileApi()。
export function createMemoryFileApi() {
  const fileApi = new FileApi('/root', new FileApiDriverMemory());
  fileApi.setSyncTargetId(1);
  return fileApi;
}

// 真正的同步入口：FileApi + Supabase 驱动（path 带 <user_id>/ 前缀，满足 RLS）
export async function createSupabaseFileApi() {
  const session = await getCurrentSession();
  if (!session?.user) throw new Error('未登录，无法同步。');

  const driver = new SupabaseFileApiDriver(createSupabaseSyncBackend(), session.user.id);
  const fileApi = new FileApi('', driver);
  fileApi.setSyncTargetId(SUPABASE_SYNC_TARGET_ID);
  await fileApi.initialize();
  return fileApi;
}
