import { Image as ExpoImage, type ImageSource } from 'expo-image';

import type { Item } from '@/src/features/daily/_shared/ReplicatedScreens';
import { buildAssetUrl } from '@/src/shared/api';

const footprintImageSourceCache = new Map<string, ImageSource>();
const prefetchedFootprintImageUris = new Set<string>();

export function footprintImageUris(item: Item) {
  return imageList(item.image_urls, item.image_url);
}

export function footprintDisplayImageUri(uri: string) {
  return buildAssetUrl(uri) || uri;
}

export function imageSourceFor(uri: string) {
  const cached = footprintImageSourceCache.get(uri);
  if (cached) return cached;
  const source = /^https?:\/\//i.test(uri) ? { uri, cacheKey: uri } : { uri };
  footprintImageSourceCache.set(uri, source);
  return source;
}

// 图片统一用原图地址：服务端 imgproxy 解不了 10 位 HDR HEIC（返回 422），
// 而本地模式下本来就是直接读本地文件、由 expo-image 缩放显示，
// 所以干脆三个页面都用同一个地址，缓存也能共用。详见 docs/footprint-thumbnails.md
export function prefetchFootprintImages(items: Item[]) {
  const remoteUris = items
    .flatMap(footprintImageUris)
    // 预取的和列表/相册真正显示的地址是一回事（都是原图），否则预取了也用不上
    .map(footprintDisplayImageUri)
    .filter((uri) => /^https?:\/\//i.test(uri))
    .filter((uri) => {
      if (prefetchedFootprintImageUris.has(uri)) return false;
      prefetchedFootprintImageUris.add(uri);
      return true;
    });

  if (!remoteUris.length) return;

  void ExpoImage.prefetch(remoteUris, 'memory-disk').then((ok) => {
    if (ok) return;
    remoteUris.forEach((uri) => prefetchedFootprintImageUris.delete(uri));
  }).catch(() => {
    remoteUris.forEach((uri) => prefetchedFootprintImageUris.delete(uri));
  });
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
