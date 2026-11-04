import * as FileSystem from 'expo-file-system/legacy';

const formats: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff',
};
export type ImageFileHint = { mimeType?: string | null; fileName?: string | null };
export function imageExtension(uri: string, hint?: ImageFileHint): string {
  const mime = hint?.mimeType?.toLowerCase();
  const fromMime = Object.keys(formats).find((ext) => formats[ext] === mime);
  if (fromMime) return fromMime;
  const ext = (hint?.fileName || uri).split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext === 'tiff' ? 'tif' : ext && formats[ext] ? ext : 'jpg';
}
export const imageMimeType = (ext: string) => formats[ext === 'jpeg' ? 'jpg' : ext] || 'application/octet-stream';

export function imageExtensionFromHeader(encoded: string): string | null {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let bits = 0; let value = 0;
  for (const char of encoded) {
    const next = chars.indexOf(char);
    if (next < 0) continue;
    value = (value << 6) | next; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
  }
  const ascii = (start: number, count: number) => String.fromCharCode(...bytes.slice(start, start + count));
  if (bytes[0] === 255 && bytes[1] === 216) return 'jpg';
  if (bytes[0] === 137 && ascii(1, 3) === 'PNG') return 'png';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'tif';
  if (ascii(4, 4) === 'ftyp') {
    const brands = ascii(8, 56);
    if (/avif|avis/.test(brands)) return 'avif';
    if (/heic|heix|hevc|hevx|MiHB|MiHA/.test(brands)) return 'heic';
    return 'heif';
  }
  return null;
}

export async function readImageExtension(uri: string): Promise<string | null> {
  try {
    const header = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64, position: 0, length: 64,
    });
    return imageExtensionFromHeader(header);
  } catch { return null; }
}
