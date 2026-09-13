// 本地文件是不是「真图片」：靠文件头魔数判断。
// 起因：下载失败时错误响应体（例如 404 的 JSON）会被写成文件，
// 之前只看「文件存在且非 0 字节」，结果把 JSON 当成原图又传回服务器。
import { ensureFootprintImageDirectory } from './footprintImageFiles';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// 把 base64 头部解码成前若干字节（不依赖 atob，Hermes/Jest 都可用）
export function base64HeadToBytes(base64Head: string, maxBytes = 16) {
  const clean = String(base64Head || '').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < clean.length && bytes.length < maxBytes; index += 4) {
    const codes = [0, 1, 2, 3].map((offset) => {
      const char = clean[index + offset];
      return char ? BASE64_CHARS.indexOf(char) : -1;
    });
    if (codes[0] < 0 || codes[1] < 0) break;
    bytes.push(((codes[0] << 2) | (codes[1] >> 4)) & 0xff);
    if (codes[2] >= 0) bytes.push(((codes[1] << 4) | (codes[2] >> 2)) & 0xff);
    if (codes[3] >= 0) bytes.push(((codes[2] << 6) | codes[3]) & 0xff);
  }
  return bytes;
}

function bytesToAscii(bytes: number[], start: number, length: number) {
  return bytes.slice(start, start + length).map((byte) => String.fromCharCode(byte)).join('');
}

export function isImageBase64Head(base64Head: string) {
  const bytes = base64HeadToBytes(base64Head, 16);
  if (bytes.length < 4) return false;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytesToAscii(bytes, 1, 3) === 'PNG') return true;
  // GIF: 47 49 46
  if (bytesToAscii(bytes, 0, 3) === 'GIF') return true;
  // WebP: RIFF....WEBP
  if (bytesToAscii(bytes, 0, 4) === 'RIFF' && bytesToAscii(bytes, 8, 4) === 'WEBP') return true;
  // HEIC/HEIF: 容器开头是 ftyp box（'ftyp' 在偏移 4）
  if (bytesToAscii(bytes, 4, 4) === 'ftyp') return true;

  return false;
}

export async function isImageFile(uri: string) {
  const context = await ensureFootprintImageDirectory();
  if (!context) return false;
  try {
    const head = await context.FileSystem.readAsStringAsync(uri, {
      encoding: context.FileSystem.EncodingType.Base64,
      length: 24,
      position: 0,
    });
    return isImageBase64Head(head);
  } catch {
    return false;
  }
}
