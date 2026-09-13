// 同步后端抽象：driver 只依赖这个接口，便于单测注入内存实现，也便于将来换存储。
import * as FileSystem from 'expo-file-system/legacy';

import { TRIP_FOOTPRINT_IMAGES_BUCKET } from '@/src/sync/storageConstants';
import { getCurrentSession, getSupabaseClient } from '@/src/sync/supabaseClient';
import { isImageFile } from '@/src/features/daily/footprints/imageValidation';

export const SYNC_ITEMS_TABLE = 'trip_sync_items';

export type SyncItemRow = {
  path: string; // 数据库中的完整 path（含 <user_id>/ 前缀）
  itemId: string;
  type: number;
  body: string | null;
  jopUpdatedTime: number;
  updatedAt: number; // 毫秒时间戳，由服务端 now() 写入
  deletedAt: number | null;
};

export interface SyncBackend {
  listItems(prefix: string): Promise<SyncItemRow[]>;
  getItem(path: string): Promise<SyncItemRow | null>;
  upsertItem(row: Omit<SyncItemRow, 'updatedAt'>): Promise<void>;
  tombstoneItem(path: string): Promise<void>;
  /** 列出某个目录下对象的大小；读取失败返回 null（调用方据此区分「0 字节」与「未知」） */
  listSizes(folder: string): Promise<Map<string, number> | null>;
  /** 返回服务端实际存储的字节数（0 表示上传后为空） */
  uploadBlob(objectKey: string, localUri: string, contentType: string): Promise<number>;
  downloadBlob(objectKey: string, destUri: string): Promise<void>;
}

function toRow(row: Record<string, unknown>): SyncItemRow {
  return {
    path: String(row.path),
    itemId: String(row.item_id),
    type: Number(row.type_ ?? 0),
    body: (row.body as string | null) ?? null,
    jopUpdatedTime: Number(row.jop_updated_time ?? 0),
    updatedAt: row.updated_at ? Date.parse(String(row.updated_at)) : 0,
    deletedAt: row.deleted_at ? Date.parse(String(row.deleted_at)) : null,
  };
}

export function createSupabaseSyncBackend(): SyncBackend {
  const supabase = getSupabaseClient();
  const bucket = TRIP_FOOTPRINT_IMAGES_BUCKET;
  const columns = 'path,item_id,type_,body,jop_updated_time,updated_at,deleted_at';

  return {
    async listItems(prefix) {
      const { data, error } = await supabase
        .from(SYNC_ITEMS_TABLE)
        .select(columns)
        .like('path', `${prefix}%`)
        .limit(1000);
      if (error) throw error;
      return (data ?? []).map((row) => toRow(row as Record<string, unknown>));
    },

    async getItem(path) {
      const { data, error } = await supabase
        .from(SYNC_ITEMS_TABLE)
        .select(columns)
        .eq('path', path)
        .maybeSingle();
      if (error) throw error;
      return data ? toRow(data as Record<string, unknown>) : null;
    },

    async upsertItem(row) {
      // 不写 updated_at：由数据库触发器写入服务端时间（basicDelta 依赖它单调递增）
      const { error } = await supabase
        .from(SYNC_ITEMS_TABLE)
        .upsert({
          path: row.path,
          item_id: row.itemId,
          type_: row.type,
          body: row.body,
          jop_updated_time: row.jopUpdatedTime,
          deleted_at: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
        }, { onConflict: 'path' });
      if (error) throw error;
    },

    async tombstoneItem(path) {
      const { error } = await supabase
        .from(SYNC_ITEMS_TABLE)
        .update({ deleted_at: new Date().toISOString() })
        .eq('path', path);
      if (error) throw error;
    },

    async listSizes(folder) {
      try {
        const { data, error } = await supabase.storage.from(bucket).list(folder, { limit: 1000 });
        if (error) return null;
        const sizes = new Map<string, number>();
        for (const entry of data ?? []) {
          const size = Number((entry.metadata as { size?: number } | null)?.size);
          if (Number.isFinite(size)) sizes.set(entry.name, size);
        }
        return sizes;
      } catch {
        return null;
      }
    },

    async uploadBlob(objectKey, localUri, contentType) {
      const info = await FileSystem.getInfoAsync(localUri);
      const size = (info as { size?: number }).size ?? 0;
      if (!info.exists) throw new Error(`File not found: ${localUri}`);
      if (size <= 0) throw new Error(`Empty local file: ${localUri}`);

      const session = await getCurrentSession();
      const token = session?.access_token;
      const base = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
      if (!token || !base) throw new Error('同步后端未登录或未配置 Supabase URL');

      const result = await FileSystem.uploadAsync(
        `${base}/storage/v1/object/${bucket}/${objectKey}`,
        localUri,
        {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': contentType,
            'Content-Length': String(size),
            'x-upsert': 'true',
            'cache-control': 'max-age=31536000',
          },
        },
      );
      if (result.status >= 400) throw new Error(`上传失败 ${result.status}: ${result.body}`);

      // 回读校验：避免再次出现「200 但 0 字节」
      const folder = objectKey.split('/').slice(0, -1).join('/');
      const fileName = objectKey.split('/').pop() as string;
      const { data, error } = await supabase.storage.from(bucket).list(folder, { limit: 100 });
      if (error) throw error;
      const entry = (data ?? []).find((item) => item.name === fileName);
      const storedSize = Number((entry?.metadata as { size?: number } | null)?.size ?? 0);
      return storedSize;
    },

    async downloadBlob(objectKey, destUri) {
      const { data } = supabase.storage.from(bucket).getPublicUrl(objectKey);
      const result = await FileSystem.downloadAsync(data.publicUrl, destUri);

      // 不能只看「文件存在且非 0 字节」：错误响应体（例如 404 的 JSON）也会被写进目标文件。
      const headers = (result.headers ?? {}) as Record<string, string>;
      const status = result.status ?? 0;
      const contentType = String(headers['content-type'] ?? '').toLowerCase();
      const contentLength = Number(headers['content-length'] ?? NaN);

      const fail = async (message: string) => {
        await FileSystem.deleteAsync(destUri, { idempotent: true }).catch(() => undefined);
        throw new Error(message);
      };

      if (status >= 400) await fail(`下载失败 ${status}：${objectKey}`);
      if (Number.isFinite(contentLength) && contentLength <= 0) await fail(`远端对象为空（content-length=0）：${objectKey}`);
      if (contentType && !contentType.startsWith('image/')) {
        await fail(`远端对象不是图片（content-type=${contentType}）：${objectKey}`);
      }

      const info = await FileSystem.getInfoAsync(destUri);
      const size = (info as { size?: number }).size ?? 0;
      if (!info.exists || size <= 0) await fail(`下载后文件为空：${objectKey}`);
      // 内容也必须是真图片：错误页面/占位内容即使 content-type 正确也要拦下
      if (!(await isImageFile(destUri))) await fail(`下载内容不是有效图片：${objectKey}`);
    },
  };
}
