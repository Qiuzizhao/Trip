import { beforeEach, expect, it, jest } from '@jest/globals';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { shareFootprintImage } from '../download';
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' },
  readAsStringAsync: jest.fn(), copyAsync: jest.fn(async () => undefined) }));
beforeEach(() => { jest.clearAllMocks(); });
it('shares original HEIC with matching filename and MIME even if the stored suffix was JPEG', async () => {
  jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue(Buffer.from('\x00\x00\x00\x20ftypheic\x00\x00\x00\x00mif1','binary').toString('base64'));
  await shareFootprintImage('file:///documents/old.jpeg');
  expect(FileSystem.copyAsync).toHaveBeenCalledWith({ from: 'file:///documents/old.jpeg', to: expect.stringMatching(/\.heic$/) });
  expect(Sharing.shareAsync).toHaveBeenCalledWith(expect.stringMatching(/\.heic$/), expect.objectContaining({ mimeType: 'image/heic' }));
});
it('shares an already correctly named JPEG without copying it', async () => {
  jest.mocked(FileSystem.readAsStringAsync).mockResolvedValue('/9j/4A==');
  await shareFootprintImage('file:///documents/photo.jpg');
  expect(FileSystem.copyAsync).not.toHaveBeenCalled();
  expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///documents/photo.jpg', expect.objectContaining({ mimeType: 'image/jpeg' }));
});
