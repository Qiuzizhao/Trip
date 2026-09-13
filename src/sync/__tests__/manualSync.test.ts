import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/src/local/repositories/footprintsRepository', () => ({
  listFootprintsForSync: jest.fn(),
  replaceFootprintsFromSync: jest.fn(),
}));

jest.mock('@/src/local/repositories/assetMigration', () => ({
  migrateFootprintImagesToAssets: jest.fn(async () => ({ created: 0, skipped: true })),
}));

jest.mock('@/src/local/repositories/assetRepository', () => ({
  listAllAssets: jest.fn(async () => []),
}));

jest.mock('@/src/local/syncMetadataRepository', () => ({
  getSyncMetadata: jest.fn(),
  saveSyncMetadata: jest.fn(),
}));

jest.mock('../assetQueue', () => ({ runAssetSync: jest.fn() }));
jest.mock('../assetRepair', () => ({ repairEmptyAssetObjects: jest.fn() }));

jest.mock('../supabaseClient', () => ({
  getCurrentSession: jest.fn(),
  getSupabaseClient: jest.fn(),
  isSupabaseConfigured: jest.fn(() => true),
}));

jest.mock('../supabase/fileApiFactory', () => ({
  SUPABASE_SYNC_TARGET_ID: 100,
  createSupabaseFileApi: jest.fn(async () => ({})),
}));

jest.mock('../supabase/syncBackend', () => ({
  createSupabaseSyncBackend: jest.fn(() => ({})),
  SYNC_ITEMS_TABLE: 'trip_sync_items',
}));

import * as footprintsRepository from '@/src/local/repositories/footprintsRepository';
import * as syncMetadataRepository from '@/src/local/syncMetadataRepository';
import { repairEmptyAssetObjects } from '../assetRepair';
import { runAssetSync } from '../assetQueue';
import { runManualSync } from '../manualSync';
import * as supabaseClient from '../supabaseClient';

const USER_ID = 'user-1';

const repository = jest.mocked(footprintsRepository);
const metadataRepository = jest.mocked(syncMetadataRepository);
const runAssetSyncMock = runAssetSync as jest.MockedFunction<typeof runAssetSync>;
const repairMock = repairEmptyAssetObjects as jest.MockedFunction<typeof repairEmptyAssetObjects>;
const supabase = jest.mocked(supabaseClient);

function localRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fp-1',
    location: '测试地点',
    coordinate: '31.2,121.5',
    visit_date: '2026-09-13',
    notes: null,
    rating: null,
    created_at: '2026-09-13T00:00:00.000Z',
    updated_at: '2026-09-13T00:00:00.000Z',
    deleted_at: null,
    sync_status: 'pending' as const,
    ...overrides,
  };
}

function fakeSupabase({ remoteFootprints = [] as Record<string, unknown>[] } = {}) {
  const upserts: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      upsert: async (rows: Record<string, unknown>[]) => {
        upserts.push(...rows);
        return { error: null };
      },
      select: () => ({
        eq: async () => ({ data: remoteFootprints, error: null }),
      }),
    }),
  };
  return { client, upserts };
}

beforeEach(() => {
  jest.clearAllMocks();
  repository.listFootprintsForSync.mockResolvedValue([localRecord()] as never);
  repository.replaceFootprintsFromSync.mockResolvedValue([] as never);
  metadataRepository.getSyncMetadata.mockResolvedValue({ last_synced_at: null });
  metadataRepository.saveSyncMetadata.mockImplementation(async (value) => value as never);
  supabase.isSupabaseConfigured.mockReturnValue(true);
  supabase.getCurrentSession.mockResolvedValue({ user: { id: USER_ID } } as never);
  runAssetSyncMock.mockResolvedValue({
    uploaded: 2,
    published: 0,
    downloaded: 1,
    failed: 0,
    deleted: 0,
    touchedFootprintIds: [],
  });
  repairMock.mockResolvedValue({ repaired: 0, failed: 0, unchecked: 0 });
});

describe('runManualSync（资产模型：记录只同步元数据）', () => {
  it('记录 upsert 不再包含 image_url / image_urls', async () => {
    const { client, upserts } = fakeSupabase();
    supabase.getSupabaseClient.mockReturnValue(client as never);

    await runManualSync();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ id: 'fp-1', location: '测试地点', user_id: USER_ID });
    expect(upserts[0]).not.toHaveProperty('image_url');
    expect(upserts[0]).not.toHaveProperty('image_urls');
  });

  it('合并后的本地记录不再带图片字段（图片由 asset 承担）', async () => {
    const { client } = fakeSupabase({
      remoteFootprints: [{
        id: 'fp-1',
        location: '测试地点',
        coordinate: null,
        visit_date: '2026-09-13',
        notes: null,
        rating: null,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:01.000Z',
        deleted_at: null,
      }],
    });
    supabase.getSupabaseClient.mockReturnValue(client as never);

    await runManualSync();

    const [saved] = repository.replaceFootprintsFromSync.mock.calls[0] as unknown as [Record<string, unknown>[]];
    const record = saved.find((item) => item.id === 'fp-1') as Record<string, unknown>;
    expect(record).not.toHaveProperty('image_url');
    expect(record).not.toHaveProperty('image_urls');
    expect(record.sync_status).toBe('synced');
  });

  it('资产队列结果会汇总到同步结果里', async () => {
    const { client } = fakeSupabase();
    supabase.getSupabaseClient.mockReturnValue(client as never);

    const result = await runManualSync();

    expect(result).toMatchObject({ status: 'synced', uploadedAssets: 2, downloadedAssets: 1, failedAssets: 0 });
  });

  it('历史 0 字节对象修复每次同步都会尝试（可自愈，不会被过早置位的标记挡住）', async () => {
    const { client } = fakeSupabase();
    supabase.getSupabaseClient.mockReturnValue(client as never);
    repairMock.mockResolvedValue({ repaired: 1, failed: 0, unchecked: 0 });

    const first = await runManualSync();
    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ repairedAssetObjects: 1 });

    jest.clearAllMocks();
    repository.listFootprintsForSync.mockResolvedValue([localRecord({ sync_status: 'synced' })] as never);
    repository.replaceFootprintsFromSync.mockResolvedValue([] as never);
    supabase.getSupabaseClient.mockReturnValue(client as never);
    supabase.getCurrentSession.mockResolvedValue({ user: { id: USER_ID } } as never);
    metadataRepository.getSyncMetadata.mockResolvedValue({ last_synced_at: null });
    metadataRepository.saveSyncMetadata.mockImplementation(async (value) => value as never);
    runAssetSyncMock.mockResolvedValue({
      uploaded: 0, published: 0, downloaded: 0, failed: 0, deleted: 0, touchedFootprintIds: [],
    });
    repairMock.mockResolvedValue({ repaired: 0, failed: 1, unchecked: 0 });

    const second = await runManualSync();
    expect(repairMock).toHaveBeenCalledTimes(1); // 仍然会尝试
    expect(second).toMatchObject({ repairedAssetObjects: 0 });
  });

  it('资产队列整体失败时，记录级同步仍然成功', async () => {
    const { client } = fakeSupabase();
    supabase.getSupabaseClient.mockReturnValue(client as never);
    runAssetSyncMock.mockRejectedValue(new Error('network down'));

    const result = await runManualSync();

    expect(result).toMatchObject({ status: 'synced', uploadedFootprints: 1, uploadedAssets: 0 });
  });
});
