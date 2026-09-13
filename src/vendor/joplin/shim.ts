// 本地替身：上游 packages/lib/shim.ts（636 行，Node/Electron 导向）。
// 这里只实现被 vendor 代码真正调用到的能力：fetchMaxRetrySet / fsDriver / 定时器 / fetch。
import * as FileSystem from 'expo-file-system/legacy';

type FileEncoding = 'utf8' | 'base64' | 'Buffer';

const encodingMap: Record<FileEncoding, FileSystem.EncodingType> = {
  utf8: FileSystem.EncodingType.UTF8,
  base64: FileSystem.EncodingType.Base64,
  Buffer: FileSystem.EncodingType.Base64,
};

export const rnFsDriver = {
  async exists(path: string) {
    try {
      return (await FileSystem.getInfoAsync(path)).exists;
    } catch {
      return false;
    }
  },

  async stat(path: string) {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) throw new Error(`File not found: ${path}`);
    return {
      path,
      isDir: false,
      size: (info as { size?: number }).size ?? 0,
      updated_time: Date.now(),
    };
  },

  async readFile(path: string, encoding: FileEncoding = 'utf8') {
    return FileSystem.readAsStringAsync(path, { encoding: encodingMap[encoding] });
  },

  async writeFile(path: string, content: string) {
    await FileSystem.writeAsStringAsync(path, content, { encoding: FileSystem.EncodingType.UTF8 });
  },

  // base64 字符串按二进制解码写入（对应上游 fs.writeFile(path, Buffer.from(content, 'base64'))）
  async writeFileBase64(path: string, base64: string) {
    await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });
  },

  async unlink(path: string) {
    await FileSystem.deleteAsync(path, { idempotent: true });
  },

  async mkdir(path: string) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true }).catch(() => undefined);
  },
};

export default {
  isReactNative: () => true,
  isNode: () => false,
  // 重试由 vendored 的 tryAndRepeat 统一控制，底层 fetch 不做内建重试
  fetchMaxRetrySet: (_count: number) => 0,
  fsDriver: () => rnFsDriver,
  fetch: (url: string, options?: RequestInit) => fetch(url, options),
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
};
