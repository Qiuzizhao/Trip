import { AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { listAllAssets, subscribeAssetsLocal } from '@/src/local/repositories/assetRepository';
import { listFootprintsLocal, subscribeFootprintsLocal } from '@/src/local/repositories/footprintsRepository';
import { getJson, setJson } from '@/src/local/storage';
import { resolveAssetUri } from '../assetResolver';
import { photoAlbumNative } from './native';
import { getSystemAlbumState, startSystemAlbumSync, syncSystemAlbum, restoreSystemAlbum } from './sync';

jest.mock('./native', () => ({ photoAlbumNative: {
  permission: jest.fn(), reconcileAlbum: jest.fn(), rememberSavedHashes: jest.fn(), snapshot: jest.fn(), hashFile: jest.fn(), save: jest.fn(),
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
  const stored = new Map();
  mock(getJson).mockImplementation(async (key, fallback) => stored.has(key) ? stored.get(key) : fallback);
  mock(setJson).mockImplementation(async (key, value) => { stored.set(key, value); });
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
  expect(native.save).toHaveBeenCalledWith('file:///cache/trip-system-album/original.heic', 'hash-one', '');
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

test('HEIF successful receipts prevent repeat writes when Photos returns no original filenames', async () => {
  mock(getJson).mockImplementation(async (key, fallback) => key.endsWith('hashes.v1')
    ? { 'asset:one:1': 'hash-one' } : fallback);
  mock(native.snapshot).mockResolvedValue([]);
  await syncSystemAlbum();
  await syncSystemAlbum();
  await syncSystemAlbum();
  expect(native.snapshot).not.toHaveBeenCalled();
  expect(native.hashFile).not.toHaveBeenCalled();
  expect(native.save).not.toHaveBeenCalled();
});

test('HEIF resource rename and source ID changes keep content receipts across retries', async () => {
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
  mock(listAllAssets).mockResolvedValue([{ id: 'renamed', footprintId: 'old', blobUpdatedTime: 99 }]);
  mock(native.snapshot).mockResolvedValue([]);
  await syncSystemAlbum();
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
  expect(native.rememberSavedHashes).toHaveBeenCalledWith(['hash-one']);
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
    mock(subscribeAssetsLocal).mock.calls[0][0]([{ id: 'one', footprintId: 'old', fileName: 'one.heif' }]);
    await jest.advanceTimersByTimeAsync(1500);
    expect(native.save).toHaveBeenCalledTimes(1);
  } finally { stop(); jest.useRealTimers(); }
});


test('opening settings subscribes to status without scheduling a new scan', () => {
  const { subscribeSystemAlbum } = require('./sync');
  const stop = subscribeSystemAlbum(jest.fn());
  expect(native.permission).not.toHaveBeenCalled();
  expect(native.snapshot).not.toHaveBeenCalled();
  expect(native.save).not.toHaveBeenCalled();
  stop();
});

test('metadata, upload completion, and cover reordering do not restart album scanning', async () => {
  jest.useFakeTimers();
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  mock(subscribeAssetsLocal).mockReturnValue(jest.fn());
  mock(subscribeFootprintsLocal).mockReturnValue(jest.fn());
  const stop = startSystemAlbumSync();
  try {
    const event = mock(subscribeAssetsLocal).mock.calls[0][0];
    const asset = { id: 'one', footprintId: 'old', fileName: 'one.heif', position: 0 };
    event([asset]);
    await jest.advanceTimersByTimeAsync(1500);
    const scans = native.snapshot.mock.calls.length;
    event([{ ...asset, position: 1, takenAt: 100, syncTime: 200, fetchStatus: 2 }]);
    await jest.advanceTimersByTimeAsync(1500);
    expect(native.snapshot).toHaveBeenCalledTimes(scans);
    expect(native.save).toHaveBeenCalledTimes(1);
  } finally { stop(); jest.useRealTimers(); }
});

test('passes the footprint location to Photos and does not resave after a location edit', async () => {
  mock(listFootprintsLocal).mockResolvedValue([{ id: 'old', location: '  故宫  ' }]);
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledWith('file:///photos/one.heic', 'hash-one', '故宫');
  mock(listFootprintsLocal).mockResolvedValue([{ id: 'old', location: '天坛' }]);
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
});

test('manual restore retires deleted Photos receipts and saves missing photos once', async () => {
  await setJson('trip.system-photo-album.hashes.v1', { 'asset:one:1': 'hash-one' });
  await setJson('trip.system-photo-album.receipts.v2', ['hash-one']);
  mock(native.reconcileAlbum).mockResolvedValueOnce({ hashes: [], unresolved: 0 }).mockResolvedValue({ hashes: ['hash-one'], unresolved: 0 });
  await restoreSystemAlbum();
  expect(native.reconcileAlbum).toHaveBeenCalledTimes(1);
  expect(native.save).toHaveBeenCalledTimes(1);
  await restoreSystemAlbum();
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
});

test('manual restore reuses Photos assets when only the album was removed', async () => {
  await setJson('trip.system-photo-album.hashes.v1', { 'asset:one:1': 'hash-one' });
  mock(native.reconcileAlbum).mockResolvedValue({ hashes: ['hash-one'], unresolved: 0 });
  await restoreSystemAlbum();
  expect(native.reconcileAlbum).toHaveBeenCalledTimes(1);
  expect(native.hashFile).not.toHaveBeenCalled();
  expect(native.save).not.toHaveBeenCalled();
});

test('failed or permission-limited reconciliation never clears saved receipts or reimports', async () => {
  const saved = { 'asset:one:1': 'hash-one' };
  await setJson('trip.system-photo-album.hashes.v1', saved);
  mock(native.reconcileAlbum).mockRejectedValue(new Error('Photos unavailable'));
  await restoreSystemAlbum();
  expect(getSystemAlbumState().phase).toBe('error');
  expect(await getJson('trip.system-photo-album.hashes.v1', {})).toEqual(saved);
  expect(native.save).not.toHaveBeenCalled();
  mock(native.permission).mockResolvedValue('limited');
  await restoreSystemAlbum();
  expect(native.reconcileAlbum).toHaveBeenCalledTimes(1);
  expect(await getJson('trip.system-photo-album.hashes.v1', {})).toEqual(saved);
});

test('automatic background sync never reconciles or resets historical receipts', async () => {
  await syncSystemAlbum();
  expect(native.reconcileAlbum).not.toHaveBeenCalled();
});

test('restores deleted historical photos using their current footprint location', async () => {
  mock(listAllAssets).mockResolvedValue([]);
  mock(listFootprintsLocal).mockResolvedValue([{ id: 'old', location: '故宫', image_urls: ['file:///old/IMG_0001.heic'] }]);
  await setJson('trip.system-photo-album.hashes.v1', { 'legacy:file:///old/IMG_0001.heic': 'hash-one' });
  await setJson('trip.system-photo-album.receipts.v2', ['hash-one']);
  mock(native.reconcileAlbum).mockResolvedValue({ hashes: [], unresolved: 0 });
  await restoreSystemAlbum(true);
  expect(native.reconcileAlbum).toHaveBeenCalledWith(true);
  expect(native.save).toHaveBeenCalledWith('file:///old/IMG_0001.heic', 'hash-one', '故宫');
  await syncSystemAlbum();
  expect(native.save).toHaveBeenCalledTimes(1);
});

test('default restoration is scoped and preserves unresolved legacy receipts', async () => {
  await setJson('trip.system-photo-album.hashes.v1', { 'asset:one:1': 'hash-one' });
  mock(native.reconcileAlbum).mockResolvedValue({ hashes: ['hash-one'], unresolved: 1 });
  await restoreSystemAlbum();
  expect(native.reconcileAlbum).toHaveBeenCalledWith(false);
  expect(native.save).not.toHaveBeenCalled();
  expect(getSystemAlbumState().needsLibraryScan).toBe(1);
});
