import * as FileSystem from 'expo-file-system/legacy';

export const FOOTPRINT_IMAGE_DIR = 'trip-footprint-images';
const IMAGE_DIR = FOOTPRINT_IMAGE_DIR;

type FileSystemModule = typeof import('expo-file-system/legacy');

function normalizeFileName(value: string | null | undefined) {
  if (!value) return null;
  const cleanValue = value.split('?')[0].split('#')[0];
  const fileName = cleanValue.split('/').filter(Boolean).pop();
  if (!fileName) return null;
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

function unique(values: (string | null | undefined)[]) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isRemoteUri(uri: string) {
  return /^https?:\/\//i.test(uri);
}

function isLocalUri(uri: string) {
  return /^(file|content):\/\//i.test(uri);
}

function extensionForUri(uri: string) {
  const fileName = normalizeFileName(uri) || '';
  const rawExt = fileName.split('.').pop()?.toLowerCase() || '';
  if (/^[a-z0-9]{2,5}$/.test(rawExt)) return rawExt;
  return 'jpg';
}

function createImageFileName(uri: string) {
  const ext = extensionForUri(uri);
  return `footprint-image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
}

export function footprintImageFileNameFromUri(uri: string | null | undefined) {
  return normalizeFileName(uri);
}

// Stable hash of a stored image path. The upload path embeds it so a remote object
// can be traced back to the local file it was uploaded from.
export function footprintImageHash(uri: string) {
  let hash = 0;
  for (let index = 0; index < uri.length; index += 1) {
    hash = ((hash << 5) - hash + uri.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export async function ensureFootprintImageDirectory(): Promise<{ FileSystem: FileSystemModule; dir: string } | null> {
  try {
    if (!FileSystem.documentDirectory) return null;
    const dir = `${FileSystem.documentDirectory}${IMAGE_DIR}/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return { FileSystem, dir };
  } catch {
    return null;
  }
}

// Maps `footprintImageHash(uri)` -> uri for every image already stored on this device,
// so uploaded objects can be repaired from their original local file.
export async function listPersistedFootprintImageHashes(): Promise<Map<string, string>> {
  const fileContext = await ensureFootprintImageDirectory();
  if (!fileContext) return new Map();

  const { FileSystem, dir } = fileContext;
  try {
    const names = await FileSystem.readDirectoryAsync(dir);
    const entries = names.map((name) => {
      const uri = `${dir}${name}`;
      return [footprintImageHash(uri), uri] as const;
    });
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export async function persistFootprintImageUri(uri: string) {
  if (!isLocalUri(uri) || isRemoteUri(uri)) return uri;

  const fileContext = await ensureFootprintImageDirectory();
  if (!fileContext) throw new Error('当前设备不支持本地图片文件存储。');

  const { FileSystem, dir } = fileContext;
  const targetUri = `${dir}${createImageFileName(uri)}`;
  const existing = await FileSystem.getInfoAsync(targetUri);
  if (existing.exists) await FileSystem.deleteAsync(targetUri, { idempotent: true });
  await FileSystem.copyAsync({ from: uri, to: targetUri });
  return targetUri;
}

export async function resolveExistingFootprintImageUri(uri: string | null | undefined, fallbackFileName?: string | null) {
  if (!uri) return null;
  if (isRemoteUri(uri)) return uri;

  const fileName = normalizeFileName(uri) || normalizeFileName(fallbackFileName);
  const fileContext = await ensureFootprintImageDirectory();
  if (!fileContext) return uri;

  const { FileSystem, dir } = fileContext;
  const candidates = unique([
    uri,
    fileName ? `${dir}${fileName}` : null,
  ]);

  for (const candidate of candidates) {
    try {
      const info = await FileSystem.getInfoAsync(candidate);
      if (info.exists) return candidate;
    } catch {
      // Some URI schemes cannot be checked by FileSystem. Try the next repair candidate.
    }
  }

  return null;
}

function imageList(values?: unknown, fallback?: unknown) {
  const list = Array.isArray(values)
    ? values
    : typeof values === 'string'
      ? [values]
      : typeof fallback === 'string'
        ? [fallback]
        : [];
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)));
}

export async function repairFootprintImageReferences<T extends { image_url?: unknown; image_urls?: unknown; deleted_at?: unknown }>(item: T) {
  if (item.deleted_at) return item;

  const images = imageList(item.image_urls, item.image_url);
  if (!images.length) return item;

  const repairedImages = await Promise.all(images.map(async (uri) => {
    if (isRemoteUri(uri)) return uri;
    const repaired = await resolveExistingFootprintImageUri(uri, footprintImageFileNameFromUri(uri));
    return repaired || uri;
  }));

  const changed = repairedImages.some((uri, index) => uri !== images[index]);
  if (!changed) return item;

  return {
    ...item,
    image_url: repairedImages[0] || null,
    image_urls: repairedImages.length ? repairedImages : null,
  };
}
