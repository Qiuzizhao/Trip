import { expect, it } from '@jest/globals';
import { imageExtension, imageExtensionFromHeader, imageMimeType } from '../imageFormat';
const header = (text: string) => Buffer.from(text, 'binary').toString('base64');
it('recognizes original HEIC/AVIF bytes even when a picker labels the file JPEG', () => {
  expect(imageExtensionFromHeader(header('\x00\x00\x00\x20ftypheic\x00\x00\x00\x00mif1'))).toBe('heic');
  expect(imageExtensionFromHeader(header('\x00\x00\x00\x20ftypavif\x00\x00\x00\x00mif1'))).toBe('avif');
  expect(imageExtensionFromHeader(header('\xff\xd8\xff\xe0'))).toBe('jpg');
  expect(imageExtensionFromHeader(header('\x89PNG\r\n'))).toBe('png');
});
it('uses provider MIME when there is no display name or a content URI has no suffix', () => {
  expect(imageExtension('content://provider/42', { mimeType: 'image/heic' })).toBe('heic');
  expect(imageExtension('file:///cached.jpeg', { mimeType: 'image/avif' })).toBe('avif');
  expect(imageMimeType('avif')).toBe('image/avif');
});
