import React from 'react';
import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { persistFootprintImageUri } from '../footprintImageFiles';
import { ImagePickerRecoveryHandler, readPickerRecovery, persistPickedImages, finishImagePicker } from '../imagePickerRecovery';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRootNavigationState: () => ({ key: 'ready' }), useRouter: () => ({ replace: mockReplace }) }));
jest.mock('expo-image-picker', () => ({ getPendingResultAsync: jest.fn() }));
jest.mock('../footprintImageFiles', () => ({ persistFootprintImageUri: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({ deleteAsync: jest.fn(async () => undefined) }));
const originalOS = Object.getOwnPropertyDescriptor(Platform, 'OS');
let tree;
beforeEach(async () => {
  await finishImagePicker(); await AsyncStorage.clear(); jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
});
afterEach(async () => { if (tree) await act(async () => { tree.unmount(); }); tree = undefined; });
afterAll(() => Object.defineProperty(Platform, 'OS', originalOS));

test('activity recreation restores picked photos with the original unsaved form and footprint', async () => {
  const form = { location: '未保存地点', notes: '原来的见闻', image_urls: ['file:///old.jpg'] };
  await AsyncStorage.setItem('trip:pending-image-picker', JSON.stringify({ id: 'recovery-1', footprintId: 'fp-1', form }));
  const photo = { uri: 'file:///picker/new.jpeg', mimeType: 'image/heic', fileName: 'original.heic' };
  ImagePicker.getPendingResultAsync.mockResolvedValue({ canceled: false, assets: [photo] });
  persistFootprintImageUri.mockResolvedValue('file:///documents/new.heic');
  await act(async () => { tree = create(<ImagePickerRecoveryHandler />); });
  expect(mockReplace).toHaveBeenCalledWith({ pathname: '/daily/footprint-edit', params: { id: 'fp-1', recoveryDraft: 'recovery-1' } });
  expect(await readPickerRecovery('recovery-1')).toEqual({ ...form, image_urls: ['file:///old.jpg', 'file:///documents/new.heic'] });
  expect(persistFootprintImageUri).toHaveBeenCalledWith(photo.uri, photo);
});
test('cancelled picker after activity recreation restores unsaved fields without adding photos', async () => {
  const form = { location: '保留地点', image_urls: [] };
  await AsyncStorage.setItem('trip:pending-image-picker', JSON.stringify({ id: 'recovery-2', form }));
  ImagePicker.getPendingResultAsync.mockResolvedValue({ canceled: true, assets: null });
  await act(async () => { tree = create(<ImagePickerRecoveryHandler />); });
  expect(await readPickerRecovery('recovery-2')).toEqual(form);
  expect(persistFootprintImageUri).not.toHaveBeenCalled();
});
test('one failed photo rolls back the complete batch', async () => {
  persistFootprintImageUri.mockResolvedValueOnce('file:///documents/first.jpg').mockRejectedValueOnce(new Error('copy failed'));
  await expect(persistPickedImages([{ uri: 'file:///one.jpg' }, { uri: 'file:///two.jpg' }])).rejects.toThrow('copy failed');
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///documents/first.jpg', { idempotent: true });
});
