import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import AsyncStorage from '@react-native-async-storage/async-storage';

const mockFiles = new Map<string, number>();

jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  documentDirectory: 'file:///app/Documents/',
  EncodingType: { UTF8: 'utf8', Base64: 'base64' },
  getInfoAsync: jest.fn(async (uri: string) => (
    mockFiles.has(uri) ? { exists: true, size: mockFiles.get(uri) } : { exists: false }
  )),
  makeDirectoryAsync: jest.fn(async () => undefined),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (!mockFiles.has(from)) throw new Error(`missing ${from}`);
    mockFiles.set(to, mockFiles.get(from) as number);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (!mockFiles.has(from)) throw new Error(`missing ${from}`);
    mockFiles.set(to, mockFiles.get(from) as number);
    mockFiles.delete(from);
  }),
  deleteAsync: jest.fn(async (uri: string) => { mockFiles.delete(uri); }),
  // vendored/本地校验会读文件头判断是不是图片，这里返回 PNG 头
  readAsStringAsync: jest.fn(async () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'),
  writeAsStringAsync: jest.fn(async () => undefined),
  downloadAsync: jest.fn(async () => ({ uri: '' })),
}));

// vendored FileApi 在 put(source=file) 前用 shim.fsDriver().exists() 做检查
jest.mock('@/src/vendor/joplin/shim', () => ({
  __esModule: true,
  rnFsDriver: { exists: async () => true, readFile: async () => 'FAKE-BYTES' },
  default: {
    isReactNative: () => true,
    isNode: () => false,
    fetchMaxRetrySet: () => 0,
    fsDriver: () => ({ exists: async () => true, readFile: async () => 'FAKE-BYTES' }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  },
}));

import { FileApi } from '@/src/vendor/joplin/file-api';
import { resolveAssetUri } from '@/src/features/daily/footprints/assetResolver';
import {
  createAssetFromLocalFile,
  listAllAssets,
  listAssetsByFootprint,
  resetAssetCacheForTests,
} from '@/src/local/repositories/assetRepository';
import { runAssetSync } from '@/src/sync/assetQueue';
import { resetAppSettingsCacheForTests, updateAppSettings } from '@/src/local/repositories/appSettingsRepository';
import { SupabaseFileApiDriver } from '@/src/sync/supabase/fileApiDriver';
import type { SyncBackend, SyncItemRow } from '@/src/sync/supabase/syncBackend';

const USER_ID = 'user-1';
const SYNC_TARGET_ID = 100;
const PICKED_URI = 'file:///tmp/ImagePicker/picked.jpg';
const ASSETS_DIR = 'file:///app/Documents/trip-footprint-images/';

function createBackend() {
  const rows = new Map<string, SyncItemRow>();
  const uploads: { objectKey: string; localUri: string }[] = [];
  const downloads: { objectKey: string; destUri: string }[] = [];

  const backend: SyncBackend = {
    async listItems(prefix) {
      return [...rows.values()].filter((row) => row.path.startsWith(prefix));
    },
    async getItem(path) {
      return rows.get(path) ?? null;
    },
    async upsertItem(row) {
      const existing = rows.get(row.path);
      rows.set(row.path, { ...row, updatedAt: existing ? existing.updatedAt + 1 : Date.now() });
    },
    async tombstoneItem(path) {
      const existing = rows.get(path);
      if (existing) rows.set(path, { ...existing, deletedAt: Date.now() });
    },
    async listSizes() {
      return new Map<string, number>();
    },
    async uploadBlob(objectKey, localUri) {
      uploads.push({ objectKey, localUri });
      return 1024; // 服务端存下的字节数
    },
    async downloadBlob(objectKey, destUri) {
      downloads.push({ objectKey, destUri });
      mockFiles.set(destUri, 2048); // 模拟下载落盘
    },
  };

  const fileApi = new FileApi('', new SupabaseFileApiDriver(backend, USER_ID));
  fileApi.setSyncTargetId(SYNC_TARGET_ID);
  (fileApi as unknown as { requestRepeatCount_: number }).requestRepeatCount_ = 0;

  return { backend, downloads, fileApi, rows, uploads };
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockFiles.clear();
  resetAssetCacheForTests();
  resetAppSettingsCacheForTests();
  await AsyncStorage.clear();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
});

describe('runAssetSync', () => {
  it('本地模式下不做任何上传或下载', async () => {
    await updateAppSettings({ localOnlyMode: true });
    mockFiles.set(PICKED_URI, 1024);
    await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    const { fileApi, uploads } = createBackend();

    const result = await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });

    expect(result).toMatchObject({ uploaded: 0, downloaded: 0, published: 0 });
    expect(uploads).toHaveLength(0);
    expect((await listAssetsByFootprint('fp-1'))[0].remoteKey).toBeNull();
  });

  it('把本地图片上传到 Storage 并发布 <assetId>.md 元数据', async () => {
    mockFiles.set(PICKED_URI, 1024);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    const { fileApi, rows, uploads } = createBackend();

    const result = await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });

    expect(result).toMatchObject({ uploaded: 1, failed: 0 });
    expect(uploads).toEqual([{
      objectKey: `${USER_ID}/assets/${asset.id}`,
      localUri: `${ASSETS_DIR}${asset.fileName}`,
    }]);

    const metadataRow = rows.get(`${USER_ID}/${asset.id}.md`);
    expect(metadataRow).toBeTruthy();
    const metadata = JSON.parse(String(metadataRow?.body));
    expect(metadata).toMatchObject({
      id: asset.id,
      footprintId: 'fp-1',
      remoteKey: `${USER_ID}/assets/${asset.id}`,
    });

    const [stored] = await listAssetsByFootprint('fp-1');
    expect(stored.remoteKey).toBe(`${USER_ID}/assets/${asset.id}`);
    expect(stored.syncTime).toBeGreaterThan(0);
  });

  it('本地字节缺失时拒绝上传并标记失败（不会发空 body）', async () => {
    mockFiles.set(PICKED_URI, 1024);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    mockFiles.delete(`${ASSETS_DIR}${asset.fileName}`); // 模拟文件被删
    const { fileApi, uploads } = createBackend();

    const result = await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });

    expect(result.failed).toBe(1);
    expect(uploads).toHaveLength(0);
    const [stored] = await listAssetsByFootprint('fp-1');
    expect(stored.remoteKey).toBeNull();
    expect(stored.fetchError).toBeTruthy();
  });

  it('第二次运行不重复上传（内容未变）', async () => {
    mockFiles.set(PICKED_URI, 1024);
    await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    const { fileApi, uploads } = createBackend();

    await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });
    const second = await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });

    expect(second.uploaded).toBe(0);
    expect(second.published).toBe(0); // 元数据已存在，不再重复发布
    expect(uploads).toHaveLength(1);
  });

  it('上传失败后，本地文件恢复即可重试成功', async () => {
    mockFiles.set(PICKED_URI, 1024);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    const { fileApi, uploads } = createBackend();

    // 第一次：本地文件被清空 -> 失败
    mockFiles.set(`${ASSETS_DIR}${asset.fileName}`, 0);
    const failed = await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });
    expect(failed.failed).toBe(1);
    expect((await listAssetsByFootprint('fp-1'))[0].remoteKey).toBeNull();

    // 修复本地文件 -> 重试成功
    mockFiles.set(`${ASSETS_DIR}${asset.fileName}`, 1024);
    const retried = await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });
    expect(retried.uploaded).toBe(1);
    expect(uploads).toHaveLength(1);
    expect((await listAssetsByFootprint('fp-1'))[0].remoteKey).toBe(`${USER_ID}/assets/${asset.id}`);
  });

  it('清空本地数据后能从远端元数据把图片拉回来', async () => {
    mockFiles.set(PICKED_URI, 1024);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    const { backend, fileApi } = createBackend();
    await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });

    // 模拟「清空 App 本地数据」：asset、游标、本地文件全部消失（远端保留）
    await AsyncStorage.clear();
    resetAssetCacheForTests();
    mockFiles.clear();
    expect(await listAllAssets()).toHaveLength(0);

    const restored = new FileApi('', new SupabaseFileApiDriver(backend, USER_ID));
    restored.setSyncTargetId(SYNC_TARGET_ID);
    (restored as unknown as { requestRepeatCount_: number }).requestRepeatCount_ = 0;

    const result = await runAssetSync({ fileApi: restored, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });

    expect(result.downloaded).toBe(1);
    const [restoredAsset] = await listAssetsByFootprint('fp-1');
    expect(restoredAsset.id).toBe(asset.id);
    expect(restoredAsset.size).toBe(2048);
    expect(mockFiles.has(`${ASSETS_DIR}${restoredAsset.fileName}`)).toBe(true);
    expect(await resolveAssetUri(restoredAsset)).toBe(`${ASSETS_DIR}${restoredAsset.fileName}`);
  });

  it('远端删除资产后，本地副本会被清理', async () => {
    mockFiles.set(PICKED_URI, 1024);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    const { backend, fileApi } = createBackend();

    await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });
    expect(await listAllAssets()).toHaveLength(1);

    // 另一台设备删除了这个资产 -> 远端写墓碑
    await backend.tombstoneItem(`${USER_ID}/${asset.id}.md`);

    const result = await runAssetSync({ fileApi, userId: USER_ID, syncTargetId: SYNC_TARGET_ID });

    expect(result.deleted).toBe(1);
    expect(await listAllAssets()).toHaveLength(0);
    expect(mockFiles.has(`${ASSETS_DIR}${asset.fileName}`)).toBe(false);
  });
});
