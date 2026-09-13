import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/src/local/repositories/assetRepository', () => ({
  listAssetsNeedingUpload: jest.fn(),
  listAllAssets: jest.fn(),
}));

jest.mock('../assetQueue', () => ({
  runAssetSync: jest.fn(),
}));

jest.mock('../supabase/fileApiFactory', () => ({
  SUPABASE_SYNC_TARGET_ID: 100,
  createSupabaseFileApi: jest.fn(async () => ({})),
}));

jest.mock('../supabaseClient', () => ({
  getCurrentSession: jest.fn(),
}));

import * as assetRepository from '@/src/local/repositories/assetRepository';
import { runAssetSync } from '../assetQueue';
import { scheduleAssetRetry } from '../assetAutoRetry';
import { createSupabaseFileApi } from '../supabase/fileApiFactory';
import { getCurrentSession } from '../supabaseClient';

const repository = jest.mocked(assetRepository);
const runAssetSyncMock = runAssetSync as jest.MockedFunction<typeof runAssetSync>;
const getSessionMock = getCurrentSession as jest.MockedFunction<typeof getCurrentSession>;

beforeEach(() => {
  jest.clearAllMocks();
  repository.listAssetsNeedingUpload.mockResolvedValue([{ id: 'a' }] as never);
  repository.listAllAssets.mockResolvedValue([{ id: 'a' }] as never);
  getSessionMock.mockResolvedValue({ user: { id: 'user-1' } } as never);
  runAssetSyncMock.mockResolvedValue({
    uploaded: 1,
    published: 0,
    downloaded: 0,
    failed: 0,
    deleted: 0,
    touchedFootprintIds: ['fp-1'],
  });
});

describe('scheduleAssetRetry', () => {
  it('短时间内的多次触发会被合并成一次资产同步', async () => {
    const first = scheduleAssetRetry();
    const second = scheduleAssetRetry();
    await Promise.all([first, second]);

    expect(createSupabaseFileApi).toHaveBeenCalled();
    expect(runAssetSyncMock).toHaveBeenCalledTimes(1);
  });

  it('没有待上传资产时不发请求', async () => {
    repository.listAssetsNeedingUpload.mockResolvedValue([] as never);

    await scheduleAssetRetry();

    expect(createSupabaseFileApi).not.toHaveBeenCalled();
    expect(runAssetSyncMock).not.toHaveBeenCalled();
  });
});
