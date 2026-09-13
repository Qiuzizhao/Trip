import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import AsyncStorage from '@react-native-async-storage/async-storage';

// 内存文件系统替身：uri -> size
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
  readAsStringAsync: jest.fn(async () => ''),
  writeAsStringAsync: jest.fn(async () => undefined),
}));

jest.mock('@react-native-async-storage/async-storage', () => (
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
));

jest.mock('@/src/local/repositories/footprintsRepository', () => ({
  listFootprintsForSync: jest.fn(),
}));

import { objectKeyFromPublicUrl, resolveAssetUri } from '@/src/features/daily/footprints/assetResolver';
import * as footprintsRepository from '@/src/local/repositories/footprintsRepository';
import {
  ASSET_DONE,
  createAssetFromLocalFile,
  listAssetsByFootprint,
  listAssetsNeedingUpload,
  markAssetFailed,
  markAssetUploaded,
  resetAssetCacheForTests,
  subscribeAssetsLocal,
} from '@/src/local/repositories/assetRepository';
import { migrateFootprintImagesToAssets } from '@/src/local/repositories/assetMigration';
import { mirrorUrisForFootprint, rebuildAssetsForFootprint } from '@/src/local/repositories/assetSync';
import { auditLocalAssets } from '@/src/local/repositories/assetAudit';

const repository = jest.mocked(footprintsRepository);
const PICKED_URI = 'file:///tmp/ImagePicker/picked-photo.jpg';
const ASSETS_DIR = 'file:///app/Documents/trip-footprint-images/';

function seedPickedFile(size = 12345) {
  mockFiles.set(PICKED_URI, size);
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockFiles.clear();
  resetAssetCacheForTests();
  await AsyncStorage.clear();
  // assetResolver 通过 env 拼公共 URL（与 supabaseClient 读取的是同一个变量）
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
});

describe('assetRepository', () => {
  it('资产变化会通知订阅方（UI 依赖它刷新展示）', async () => {
    seedPickedFile(1024);
    const seen: number[] = [];
    const unsubscribe = subscribeAssetsLocal((assets) => seen.push(assets.length));

    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });
    await markAssetUploaded({ assetId: asset.id, remoteKey: `user-1/assets/${asset.id}` });
    unsubscribe();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('选图后把文件复制成 <assetId>.<ext> 并记录大小/类型', async () => {
    seedPickedFile(12345);

    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });

    expect(asset.id).toMatch(/^[0-9a-f]{32}$/); // 32 位 hex，符合 Joplin isSystemPath
    expect(asset.fileName).toBe(`${asset.id}.jpg`);
    expect(asset.size).toBe(12345);
    expect(asset.mime).toBe('image/jpeg');
    expect(asset.fetchStatus).toBe(ASSET_DONE);
    expect(mockFiles.has(`${ASSETS_DIR}${asset.fileName}`)).toBe(true);
    expect(mockFiles.has(PICKED_URI)).toBe(true); // 原文件仍在（复制而非移动）
  });

  it('按 footprint 查询并按 position 排序；待上传列表排除已上传项', async () => {
    seedPickedFile(100);
    const second = 'file:///tmp/ImagePicker/second.png';
    mockFiles.set(second, 200);

    const first = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 1, localUri: PICKED_URI });
    const other = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: second });

    const list = await listAssetsByFootprint('fp-1');
    expect(list.map((asset) => asset.position)).toEqual([0, 1]);
    expect((await listAssetsNeedingUpload()).length).toBe(2);

    await markAssetUploaded({ assetId: first.id, remoteKey: `user/fp-1/${first.fileName}` });
    const pending = await listAssetsNeedingUpload();
    expect(pending.map((asset) => asset.id)).toEqual([other.id]);
  });

  it('上传失败会记录错误状态', async () => {
    seedPickedFile(100);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });

    await markAssetFailed({ assetId: asset.id, error: 'network down' });

    const [updated] = await listAssetsByFootprint('fp-1');
    expect(updated.fetchError).toBe('network down');
  });

  it('本地优先、其次远端：本地文件缺失时回退到远端 URL', async () => {
    seedPickedFile(100);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });

    expect(await resolveAssetUri(asset)).toBe(`${ASSETS_DIR}${asset.fileName}`);

    mockFiles.delete(`${ASSETS_DIR}${asset.fileName}`);
    const uploaded = { ...asset, remoteKey: `user-1/fp-1/${asset.fileName}` };
    const resolved = await resolveAssetUri(uploaded);
    expect(resolved).toContain(`/storage/v1/object/public/trip-footprint-images/user-1/fp-1/${asset.fileName}`);
  });
});

describe('assetMigration', () => {
  const remoteUrl = 'https://supabase.example.com/storage/v1/object/public/trip-footprint-images/user-1/fp-9/1-abcdef.png';

  it('本地文件会被改名成 asset 文件，远端 URL 只登记引用', async () => {
    mockFiles.set(PICKED_URI, 999);
    repository.listFootprintsForSync.mockResolvedValue([{
      id: 'fp-1',
      image_url: PICKED_URI,
      image_urls: [PICKED_URI],
      created_at: '2026-09-13T00:00:00.000Z',
      updated_at: '2026-09-13T00:00:00.000Z',
    }] as never);

    const result = await migrateFootprintImagesToAssets();
    expect(result).toEqual({ created: 1, skipped: false });

    const [asset] = await listAssetsByFootprint('fp-1');
    expect(asset.fileName).toBe(`${asset.id}.jpg`);
    expect(mockFiles.has(`${ASSETS_DIR}${asset.fileName}`)).toBe(true);
    expect(mockFiles.has(PICKED_URI)).toBe(false); // 迁移用 move，不保留旧文件名
  });

  it('远端 URL 解析成 remoteKey，并且二次运行会跳过', async () => {
    repository.listFootprintsForSync.mockResolvedValue([{
      id: 'fp-9',
      image_url: remoteUrl,
      image_urls: [remoteUrl],
      created_at: '2026-09-13T00:00:00.000Z',
      updated_at: '2026-09-13T00:00:00.000Z',
    }] as never);

    const first = await migrateFootprintImagesToAssets();
    expect(first).toEqual({ created: 1, skipped: false });

    const [asset] = await listAssetsByFootprint('fp-9');
    expect(asset.remoteKey).toBe('user-1/fp-9/1-abcdef.png');

    const second = await migrateFootprintImagesToAssets();
    expect(second).toEqual({ created: 0, skipped: true });
  });

  it('objectKeyFromPublicUrl 只接受本桶的公共 URL', () => {
    expect(objectKeyFromPublicUrl(remoteUrl)).toBe('user-1/fp-9/1-abcdef.png');
    expect(objectKeyFromPublicUrl('https://example.com/other/1.png')).toBeNull();
  });
});

describe('assetSync', () => {
  it('保存时把本地图片对齐成 asset 并回写镜像路径；重复保存不再改文件名', async () => {
    seedPickedFile(500);

    const mirrored = await rebuildAssetsForFootprint('fp-1', [PICKED_URI]);
    const [asset] = await listAssetsByFootprint('fp-1');
    expect(mirrored).toEqual([`${ASSETS_DIR}${asset.fileName}`]);
    expect(mockFiles.has(`${ASSETS_DIR}${asset.fileName}`)).toBe(true);
    expect(mockFiles.has(PICKED_URI)).toBe(false); // 用 move，不留旧文件

    const again = await rebuildAssetsForFootprint('fp-1', mirrored);
    expect(again).toEqual(mirrored);
    expect((await listAssetsByFootprint('fp-1')).length).toBe(1);
  });

  it('远端 URL 会被登记为带 remoteKey 的 asset，镜像路径保持不变', async () => {
    const remoteUrl = 'https://supabase.example.com/storage/v1/object/public/trip-footprint-images/user-1/fp-1/1-abcdef.png';

    const mirrored = await rebuildAssetsForFootprint('fp-1', [remoteUrl]);

    expect(mirrored).toEqual([remoteUrl]);
    const [asset] = await listAssetsByFootprint('fp-1');
    expect(asset.remoteKey).toBe('user-1/fp-1/1-abcdef.png');
  });

  it('镜像字段：未上传时是本地路径，上传后变成稳定的远端 URL', async () => {
    seedPickedFile(2048);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });

    expect(await mirrorUrisForFootprint('fp-1')).toEqual([`${ASSETS_DIR}${asset.fileName}`]);

    await markAssetUploaded({ assetId: asset.id, remoteKey: `user-1/assets/${asset.id}` });

    expect(await mirrorUrisForFootprint('fp-1')).toEqual([
      `https://supabase.example.com/storage/v1/object/public/trip-footprint-images/user-1/assets/${asset.id}`,
    ]);
  });
});

describe('auditLocalAssets', () => {
  it('报告未上传、本地文件缺失与大小不一致', async () => {
    seedPickedFile(1024);
    const asset = await createAssetFromLocalFile({ footprintId: 'fp-1', position: 0, localUri: PICKED_URI });

    // 未上传
    let issues = await auditLocalAssets();
    expect(issues.map((issue) => issue.kind)).toContain('not-uploaded');

    // 本地文件缺失
    mockFiles.delete(`${ASSETS_DIR}${asset.fileName}`);
    issues = await auditLocalAssets();
    expect(issues.map((issue) => issue.kind)).toContain('missing-local-file');

    // 大小不一致
    mockFiles.set(`${ASSETS_DIR}${asset.fileName}`, 999999);
    issues = await auditLocalAssets();
    expect(issues.map((issue) => issue.kind)).toContain('size-mismatch');
  });
});
