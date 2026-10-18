import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { listAllAssets, subscribeAssetsLocal } from '@/src/local/repositories/assetRepository';
import { listFootprintsLocal, subscribeFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { getJson, setJson } from '@/src/local/storage';
import { resolveAssetUri } from '../assetResolver';
import { photoAlbumNative } from './native';
import { getSystemAlbumState, startSystemAlbumSync, syncSystemAlbum } from './sync';

jest.mock('./native', () => ({ photoAlbumNative: {
  permission: jest.fn(), snapshot: jest.fn(), hashFile: jest.fn(), save: jest.fn(),
} }));
jest.mock('@/src/local/repositories/assetRepository', () => ({ listAllAssets: jest.fn(), subscribeAssetsLocal: jest.fn() }));
jest.mock('@/src/local/repositories/footprintsRepository', () => ({ listFootprintsLocal: jest.fn(), subscribeFootprintsLocal: jest.fn() }));
jest.mock('@/src/local/repositories/assetMigration', () => ({ migrateFootprintImagesToAssets: jest.fn() }));
jest.mock('@/src/local/storage', () => ({ getJson: jest.fn(), setJson: jest.fn() }));
jest.mock('../assetResolver', () => ({ resolveAssetUri: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/', makeDirectoryAsync: jest.fn(), downloadAsync: jest.fn(), deleteAsync: jest.fn(),
}));
const native = photoAlbumNative;
const mock = (fn) => fn;

beforeEach(() => {
  jest.resetAllMocks();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mock(listFootprintsLocal).mockResolvedValue([{ id: 'old' }]);
  mock(listAllAssets).mockResolvedValue([{ id: 'one', footprintId: 'old', blobUpdatedTime: 1 }]);
  mock(resolveAssetUri).mockResolvedValue('file:///photos/one.heic');
  mock(getJson).mockResolvedValue({});
  mock(native.permission).mockResolvedValue('authorized');
  mock(native.snapshot).mockResolvedValue([]);
  mock(native.hashFile).mockResolvedValue('hash-one');
  mock(native.save).mockResolvedValue(true);
  mock(FileSystem.deleteAsync).mockResolvedValue(undefined);
});

test('backfills legacy records and downloads remote originals, cleaning temporary files', async () => {
  mock(listAllAssets).mockResolvedValue([]);
  mock(listFootprintsLocal).mockResolvedValue([{ id: 'old', image_urls: ['https://example.com/old.heic'] }]);
  mock(FileSystem.downloadAsync).mockResolvedValue({ status: 200, uri: 'file:///cache/trip-system-album/original.heic' });
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledWith('file:///cache/trip-system-album/original.heic', 'hash-one');
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
  expect(getSystemAlbumState()).toMatchObject({ phase: 'done', completed: 1 });
});

test('identical content under different asset IDs is exported once', async () => {
  mock(listAllAssets).mockResolvedValue([
    { id: 'one', footprintId: 'old', blobUpdatedTime: 1 },
    { id: 'two', footprintId: 'old', blobUpdatedTime: 2 },
  ]);
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
  expect(getSystemAlbumState().completed).toBe(2);
});

test('a Photos transaction completed before app interruption is found by content hash', async () => {
  mock(native.snapshot).mockResolvedValue(['hash-one']);
  await syncSystemAlbum();
  expect(native.hashFile).toHaveBeenCalled();
  expect(native.save).not.toHaveBeenCalled();
  expect(setJson).toHaveBeenCalled();
});

test('checkpoint plus existing album skips original download; deleted album is restored', async () => {
  mock(getJson).mockResolvedValue({ 'asset:one:1': 'hash-one' });
  mock(native.snapshot).mockResolvedValue(['hash-one']);
  await syncSystemAlbum();
  expect(resolveAssetUri).not.toHaveBeenCalled();
  mock(native.snapshot).mockResolvedValue([]);
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
});

test('denied and limited access never write photos', async () => {
  for (const permission of ['denied', 'limited']) {
    mock(native.permission).mockResolvedValue(permission);
    await syncSystemAlbum();
    expect(getSystemAlbumState()).toMatchObject({ phase: 'permission', permission });
  }
  expect(native.save).not.toHaveBeenCalled();
});

test('one remote failure does not block other photos and remains retryable', async () => {
  mock(listAllAssets).mockResolvedValue([]);
  mock(listFootprintsLocal).mockResolvedValue([{ id: 'old', image_urls: ['https://example.com/a.jpg', 'file:///b.jpg'] }]);
  mock(FileSystem.downloadAsync).mockResolvedValue({ status: 404 });
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
  expect(getSystemAlbumState()).toMatchObject({ phase: 'error', failed: 1, completed: 1 });
  mock(FileSystem.downloadAsync).mockResolvedValue({ status: 200, uri: 'file:///download.jpg' });
  await syncSystemAlbum();
  expect(getSystemAlbumState()).toMatchObject({ phase: 'done', failed: 0, completed: 2 });
});


test('saved photo changes trigger automatic export, while orphaned drafts are ignored', async () => {
  jest.useFakeTimers();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mock(subscribeAssetsLocal).mockReturnValue(jest.fn());
  mock(subscribeFootprintsLocal).mockReturnValue(jest.fn());
  mock(listFootprintsLocal).mockResolvedValue([]);
  const stop = startSystemAlbumSync();
  try {
    await jest.advanceTimersByTimeAsync(1500);
    expect(native.permission).not.toHaveBeenCalled();
    expect(native.save).not.toHaveBeenCalled();
    mock(listFootprintsLocal).mockResolvedValue([{ id: 'old' }]);
    mock(subscribeAssetsLocal).mock.calls[0][0]();
    await jest.advanceTimersByTimeAsync(1500);
    expect(native.save).toHaveBeenCalledTimes(1);
  } finally { stop(); jest.useRealTimers(); }
});
