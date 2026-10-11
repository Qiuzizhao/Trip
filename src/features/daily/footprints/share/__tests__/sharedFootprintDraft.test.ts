import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { persistFootprintImageUri } from '../../footprintImageFiles';
import { createSharedFootprintDraft, readSharedFootprintDraft, sharedImageUris } from '../sharedFootprintDraft';
import { redirectSystemPath } from '../../../../../../app/+native-intent';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(), getItem: jest.fn(), removeItem: jest.fn(),
}));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../footprintImageFiles', () => ({ persistFootprintImageUri: jest.fn() }));
const file = (path: string, mimeType = 'image/jpeg', fileName = 'photo.jpg') => ({ path, mimeType, fileName });

beforeEach(() => { jest.clearAllMocks(); });

it('keeps ordered local images including HEIC and excludes videos/remote files', () => {
  expect(sharedImageUris([
    file('/private/var/photo.heic', 'application/octet-stream', 'photo.heic'),
    file('file:///shared/second.jpg'), file('file:///shared/second.jpg'),
    file('file:///shared/movie.mov', 'video/quicktime', 'movie.mov'), file('https://example.com/photo.jpg'),
  ])).toEqual(['file:///private/var/photo.heic', 'file:///shared/second.jpg']);
});

it('persists all photos in order before making the draft available', async () => {
  jest.mocked(persistFootprintImageUri).mockImplementation(async (uri) => uri.replace('/shared/', '/documents/'));
  const id = await createSharedFootprintDraft([file('file:///shared/one.jpg'), file('file:///shared/two.jpg')]);
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(`trip:shared-footprint:${id}`, JSON.stringify(['file:///documents/one.jpg', 'file:///documents/two.jpg']));
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(['file:///documents/one.jpg', 'file:///documents/two.jpg']));
  expect(await readSharedFootprintDraft(id)).toEqual(['file:///documents/one.jpg', 'file:///documents/two.jpg']);
});

it('rolls back copied files when one image fails instead of dropping it silently', async () => {
  jest.mocked(persistFootprintImageUri).mockResolvedValueOnce('file:///documents/one.jpg').mockRejectedValueOnce(new Error('copy failed'));
  await expect(createSharedFootprintDraft([file('file:///shared/one.jpg'), file('file:///shared/two.jpg')])).rejects.toThrow('copy failed');
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///documents/one.jpg', { idempotent: true });
});

it('rejects missing drafts and shares without photos', async () => {
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  await expect(readSharedFootprintDraft('missing')).rejects.toThrow('没有找到');
  await expect(createSharedFootprintDraft(null)).rejects.toThrow('没有收到');
});

it('maps native inbox URLs to a real screen while leaving other routes intact', () => {
  expect(redirectSystemPath({ path: 'tripfootprints://dataUrl=tripfootprintsShareKey#media', initial: true })).toBe('/');
  expect(redirectSystemPath({ path: '/daily/footprint-edit?id=abc', initial: false })).toBe('/daily/footprint-edit?id=abc');
});
