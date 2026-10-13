import { afterAll, beforeEach, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

const mockNativeRead = jest.fn<(uri: string) => Promise<{ dateTime: string; offset: string } | null>>();
const mockArrayBuffer = jest.fn<() => Promise<ArrayBuffer>>();
const mockFile = { size: 1024, arrayBuffer: mockArrayBuffer };
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => ({ readImageDateMetadata: (uri: string) => mockNativeRead(uri) }) }));
jest.mock('expo-file-system', () => ({ File: jest.fn(() => mockFile) }));

import { MAX_METADATA_FALLBACK_BYTES, readTakenAtFromFile } from '../imageMetadata';
const originalOS = Object.getOwnPropertyDescriptor(Platform, 'OS')!;
const setOS = (value: 'ios' | 'android') => Object.defineProperty(Platform, 'OS', { configurable: true, value });
beforeEach(() => {
  jest.clearAllMocks(); setOS('ios'); mockFile.size = 1024;
  mockNativeRead.mockResolvedValue({ dateTime: '2026:10:13 09:30:00', offset: '+08:00' });
  mockArrayBuffer.mockResolvedValue(new ArrayBuffer(0));
});
afterAll(() => { Object.defineProperty(Platform, 'OS', originalOS); });

it('iOS reads only native metadata and never allocates original photo bytes in JS', async () => {
  expect(await readTakenAtFromFile('file:///photo.heic')).toBe(Date.UTC(2026, 9, 13, 1, 30));
  expect(mockNativeRead).toHaveBeenCalledWith('file:///photo.heic');
  expect(mockArrayBuffer).not.toHaveBeenCalled();
});

it('many photos are processed one at a time across simultaneous callers', async () => {
  let active = 0; let peak = 0;
  mockNativeRead.mockImplementation(async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1; return null;
  });
  await Promise.all(Array.from({ length: 30 }, (_, i) => readTakenAtFromFile(`file:///photo-${i}.heic`)));
  expect(peak).toBe(1);
  expect(mockNativeRead).toHaveBeenCalledTimes(30);
});

it('failed metadata reads do not load originals and do not block later photos', async () => {
  mockNativeRead.mockRejectedValueOnce(new Error('damaged metadata'));
  expect(await readTakenAtFromFile('file:///bad.heic')).toBeNull();
  expect(await readTakenAtFromFile('file:///good.heic')).not.toBeNull();
  expect(mockArrayBuffer).not.toHaveBeenCalled();
});

it('fallback skips oversized files rather than allocating them', async () => {
  setOS('android'); mockFile.size = MAX_METADATA_FALLBACK_BYTES + 1;
  expect(await readTakenAtFromFile('file:///large.jpg')).toBeNull();
  expect(mockArrayBuffer).not.toHaveBeenCalled();
});

it('does not fetch remote originals for metadata', async () => {
  expect(await readTakenAtFromFile('https://example.com/photo.jpg')).toBeNull();
  expect(mockNativeRead).not.toHaveBeenCalled();
  expect(mockArrayBuffer).not.toHaveBeenCalled();
});
