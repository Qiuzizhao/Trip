import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { FileApi } from '@/src/vendor/joplin/file-api';
import { SupabaseFileApiDriver } from '../supabase/fileApiDriver';
import type { SyncBackend, SyncItemRow } from '../supabase/syncBackend';

// vendored FileApi 在 put(source=file) 前会调用 shim.fsDriver().exists() 做存在性检查
jest.mock('@/src/vendor/joplin/shim', () => ({
  __esModule: true,
  rnFsDriver: { exists: async () => true },
  default: {
    isReactNative: () => true,
    isNode: () => false,
    fetchMaxRetrySet: () => 0,
    fsDriver: () => ({ exists: async () => true }),
    fetch: (url: string, options?: RequestInit) => fetch(url, options),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  },
}));

const USER_ID = 'user-1';
const ITEM_ID = '1b175bb38bba47baac22b0b47f778113';
const RESOURCE_ID = 'c0ffee00c0ffee00c0ffee00c0ffee00';

type UploadCall = { objectKey: string; localUri: string; contentType: string };
type DownloadCall = { objectKey: string; destUri: string };

// 内存后端：等价于 Supabase 表 + Storage，且像触发器一样由「服务端」写 updated_at
function createMemoryBackend({ uploadSize = 1024 } = {}) {
  const rows = new Map<string, SyncItemRow>();
  const uploads: UploadCall[] = [];
  const downloads: DownloadCall[] = [];

  const backend: SyncBackend = {
    async listItems(prefix) {
      return [...rows.values()].filter((row) => row.path.startsWith(prefix));
    },
    async getItem(path) {
      return rows.get(path) ?? null;
    },
    async upsertItem(row) {
      const existing = rows.get(row.path);
      rows.set(row.path, {
        ...row,
        // 触发器语义：每次写入都刷新服务端时间
        updatedAt: existing ? existing.updatedAt + 1 : Date.now(),
      });
    },
    async tombstoneItem(path) {
      const existing = rows.get(path);
      if (!existing) return;
      rows.set(path, { ...existing, deletedAt: Date.now(), updatedAt: Date.now() + 1 });
    },
    async listSizes() {
      return new Map<string, number>();
    },
    async uploadBlob(objectKey, localUri, contentType) {
      uploads.push({ objectKey, localUri, contentType });
      return uploadSize;
    },
    async downloadBlob(objectKey, destUri) {
      downloads.push({ objectKey, destUri });
    },
  };

  return { backend, downloads, rows, uploads };
}

function createApi(options: { uploadSize?: number } = {}) {
  const memory = createMemoryBackend(options);
  const fileApi = new FileApi('', new SupabaseFileApiDriver(memory.backend, USER_ID));
  fileApi.setSyncTargetId(100);
  // 关闭 tryAndRepeat 退避（1s + 4s + 7s），否则失败用例要等 12 秒
  (fileApi as unknown as { requestRepeatCount_: number }).requestRepeatCount_ = 0;
  return { ...memory, fileApi };
}

function deltaOptions(context: unknown) {
  return {
    context,
    allItemIdsHandler: async () => [ITEM_ID],
    allItemMetadataHandler: async () => new Map(),
    wipeOutFailSafe: false,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SupabaseFileApiDriver（经 vendored FileApi）', () => {
  it('put 会把用户的 path 加上 <user_id>/ 前缀后落库（RLS 要求）', async () => {
    const { fileApi, rows } = createApi();

    await fileApi.put(`${ITEM_ID}.md`, JSON.stringify({ location: '测试' }));

    expect([...rows.keys()]).toEqual([`${USER_ID}/${ITEM_ID}.md`]);
    expect(rows.get(`${USER_ID}/${ITEM_ID}.md`)?.body).toContain('测试');
  });

  it('stat / get / list 返回 Joplin 形状的相对路径', async () => {
    const { fileApi } = createApi();
    await fileApi.put(`${ITEM_ID}.md`, 'v1');

    const stat = await fileApi.stat(`${ITEM_ID}.md`);
    expect(stat?.path).toBe(`${ITEM_ID}.md`);
    expect(stat?.isDir).toBe(false);

    expect(await fileApi.get(`${ITEM_ID}.md`)).toBe('v1');

    const list = await fileApi.list();
    expect(list.items.map((item) => String(item.path))).toEqual([`${ITEM_ID}.md`]);
  });

  it('delete 写墓碑：stat 返回 null，basicDelta 报 isDeleted', async () => {
    const { fileApi } = createApi();
    await fileApi.put(`${ITEM_ID}.md`, 'v1');
    const first = await fileApi.delta('', deltaOptions(null));
    expect(first.items.length).toBeGreaterThan(0);

    await fileApi.delete(`${ITEM_ID}.md`);
    expect(await fileApi.stat(`${ITEM_ID}.md`)).toBeNull();

    const afterDelete = await fileApi.delta('', deltaOptions(first.context));
    expect(afterDelete.items.some((item: { isDeleted?: boolean }) => item.isDeleted)).toBe(true);
  });

  it('basicDelta 复用 context：没有新变化时不重复返回', async () => {
    const { fileApi } = createApi();
    await fileApi.put(`${ITEM_ID}.md`, 'v1');

    const first = await fileApi.delta('', deltaOptions(null));
    const second = await fileApi.delta('', deltaOptions(first.context));
    expect(second.items.length).toBe(0);
  });

  it('put(source=file) 走 blob 上传，object key 为 <user>/assets/<name>', async () => {
    const { fileApi, uploads } = createApi();

    await fileApi.put(`resources/${RESOURCE_ID}`, null, {
      source: 'file',
      path: 'file:///app/Documents/trip-footprint-images/abc.png',
      contentType: 'image/png',
    } as never);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toEqual({
      objectKey: `${USER_ID}/assets/${RESOURCE_ID}`,
      localUri: 'file:///app/Documents/trip-footprint-images/abc.png',
      contentType: 'image/png',
    });
  });

  it('上传后服务端为 0 字节时抛错（不允许静默成功）', async () => {
    const { fileApi } = createApi({ uploadSize: 0 });

    await expect(fileApi.put(`resources/${RESOURCE_ID}`, null, {
      source: 'file',
      path: 'file:///app/Documents/trip-footprint-images/abc.png',
      contentType: 'image/png',
    } as never)).rejects.toThrow(/为空/);
  });

  it('get(target=file) 会从 Storage 下载到指定路径', async () => {
    const { downloads, fileApi } = createApi();

    await fileApi.get(`resources/${RESOURCE_ID}`, {
      target: 'file',
      path: 'file:///tmp/out.png',
    } as never);

    expect(downloads).toEqual([{
      objectKey: `${USER_ID}/assets/${RESOURCE_ID}`,
      destUri: 'file:///tmp/out.png',
    }]);
  });
});
