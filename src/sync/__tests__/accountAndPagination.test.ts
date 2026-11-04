import { beforeEach, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///audit/', EncodingType: { Base64: 'base64', UTF8: 'utf8' }, FileSystemUploadType: { BINARY_CONTENT: 0 },
  makeDirectoryAsync: jest.fn(async () => undefined), getInfoAsync: jest.fn(async () => ({ exists: true, size: 1024 })),
  readAsStringAsync: jest.fn(async () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'),
  uploadAsync: jest.fn(async () => ({ status: 200, body: '{}' })), deleteAsync: jest.fn(async () => undefined),
}));
let mockRows: any[] = [];
const mockList = jest.fn<(...args: any[]) => Promise<any>>();
const mockClient = {
  storage: { from: () => ({ list: mockList }) },
  from: () => ({ select: () => {
    let after = ''; let count = 500;
    const query = {
      like: () => query, order: () => query,
      limit: (n: number) => { count = n; return query; },
      gt: (_: string, value: string) => { after = value; return query; },
      then: (resolve: any) => resolve({ data: mockRows.filter((row) => row.path > after).slice(0, count), error: null }),
    };
    return query;
  } }),
};
jest.mock('@/src/sync/supabaseClient', () => ({
  getSupabaseClient: () => mockClient, getCurrentSession: async () => ({ access_token: 'test-token' }),
}));
import { clearAccountLocalData } from '@/src/local/localDataRepository';
import { ASSET_DONE, upsertAsset, listAllAssets, resetAssetCacheForTests, type Asset } from '@/src/local/repositories/assetRepository';
import { resetAppSettingsCacheForTests } from '@/src/local/repositories/appSettingsRepository';
import { runAssetSync } from '../assetQueue';
import { withAccountDataLock } from '../accountDataLock';
import { createSupabaseSyncBackend } from '../supabase/syncBackend';
import { SupabaseFileApiDriver } from '../supabase/fileApiDriver';

const id = '11111111111111111111111111111111';
const asset: Asset = { id, footprintId: 'account-a-footprint', position: 0, fileName: id + '.jpg', size: 1024,
  mime: 'image/jpeg', blobUpdatedTime: 1, remoteKey: null, fetchStatus: ASSET_DONE, fetchError: null, syncTime: 0, forceSync: false };
beforeEach(async () => {
  await AsyncStorage.clear(); resetAssetCacheForTests(); resetAppSettingsCacheForTests();
  jest.clearAllMocks(); mockRows = [];
});
it('logout removes pending photos and all account cursors before the next account sync', async () => {
  await upsertAsset(asset);
  await AsyncStorage.setItem('trip-footprints.syncContext.100', JSON.stringify({ from: 'a' }));
  await AsyncStorage.setItem('trip-footprints.syncContext.100.a', JSON.stringify({ from: 'a' }));
  await clearAccountLocalData();
  expect(await listAllAssets()).toEqual([]);
  expect((await AsyncStorage.getAllKeys()).filter((key) => key.startsWith('trip-footprints.syncContext.'))).toEqual([]);
  const put = jest.fn(async () => undefined);
  const result = await runAssetSync({ fileApi: { put, delta: async () => ({ items: [], context: null }), stat: async () => null } as any,
    userId: 'b', syncTargetId: 100 });
  expect(result.uploaded).toBe(0); expect(put).not.toHaveBeenCalled();
});
it('logout waits for running sync, including its final local writes', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sync = withAccountDataLock(async () => { await gate; await upsertAsset(asset); });
  const logout = withAccountDataLock(clearAccountLocalData);
  release(); await Promise.all([sync, logout]);
  expect(await listAllAssets()).toEqual([]);
});
it('checks the uploaded object by name beyond the first 100 directory entries', async () => {
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://test.invalid';
  mockList.mockImplementation(async (_folder, options) => ({
    data: options.search === 'new-photo' ? [{ name: 'new-photo', metadata: { size: 1024 } }] : [], error: null,
  }));
  expect(await createSupabaseSyncBackend().uploadBlob('b/assets/new-photo', 'file:///audit/photo.jpg', 'image/jpeg')).toBe(1024);
  expect(mockList).toHaveBeenCalledWith('b/assets', expect.objectContaining({ search: 'new-photo' }));
});
it('lists every remote row before deletion detection and drains every delta page', async () => {
  mockRows = Array.from({ length: 1001 }, (_, i) => ({ path: 'b/' + i.toString(16).padStart(32, '0') + '.md',
    item_id: i.toString(16).padStart(32, '0'), updated_at: '2026-11-04T00:00:00Z', deleted_at: null }));
  const backend = createSupabaseSyncBackend();
  expect(await backend.listItems('b/')).toHaveLength(1001);
  const lastId = (1000).toString(16).padStart(32, '0');
  const driver = new SupabaseFileApiDriver(backend, 'b');
  const result = await driver.delta('', { context: null, allItemIdsHandler: async () => [lastId],
    allItemMetadataHandler: async () => new Map(), wipeOutFailSafe: false } as any);
  expect(result.items.some((item: any) => item.isDeleted)).toBe(false);
});
it('runAssetSync follows hasMore instead of stopping after 50 photos', async () => {
  const second = '22222222222222222222222222222222';
  const delta = jest.fn<(...args: any[]) => Promise<any>>()
    .mockResolvedValueOnce({ items: [{ path: id + '.md' }], context: { page: 1 }, hasMore: true })
    .mockResolvedValueOnce({ items: [{ path: second + '.md' }], context: { page: 2 }, hasMore: false });
  const fileApi = { delta, stat: async () => null, put: async () => undefined,
    get: async (path: string) => path.startsWith('resources/') ? null : JSON.stringify({ ...asset,
      id: path.slice(0, -3), fileName: path.slice(0, -3) + '.jpg', remoteKey: 'b/assets/' + path.slice(0, -3) }) };
  const result = await runAssetSync({ fileApi: fileApi as any, userId: 'b', syncTargetId: 100 });
  expect(delta).toHaveBeenCalledTimes(2); expect(result.downloaded).toBe(2);
  expect(JSON.parse((await AsyncStorage.getItem('trip-footprints.syncContext.100.b'))!)).toEqual({ page: 2 });
});
it('storage size inventory includes all pages', async () => {
  mockList.mockImplementation(async (_folder, options) => ({ error: null, data:
    options.offset < 1001 ? Array.from({ length: Math.min(500, 1001 - options.offset) }, (_, i) => ({ name: 'photo-' + (options.offset + i), metadata: { size: 1024 } })) : [] }));
  expect((await createSupabaseSyncBackend().listSizes('b/assets'))?.size).toBe(1001);
});
