import type { Item } from '@/src/features/daily/_shared/ReplicatedScreens';
import { prefetchFootprintImages } from '@/src/features/daily/footprints/imageCache';
import { listFootprintsLocal } from './repositories/footprintsRepository';

export const homePreloadKeys = {
  footprints: 'home:footprints',
} as const;

const preloadCache = new Map<string, unknown>();
const preloadPromises = new Map<string, Promise<unknown>>();

export function getPreloadedData<T>(key: string) {
  return preloadCache.get(key) as T | undefined;
}

export function setPreloadedData<T>(key: string, value: T) {
  preloadCache.set(key, value);
}

export function prewarmData<T>(key: string, loader: () => Promise<T>) {
  const existing = preloadPromises.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = loader()
    .then((value) => {
      setPreloadedData(key, value);
      return value;
    })
    .finally(() => {
      preloadPromises.delete(key);
    });
  preloadPromises.set(key, promise);
  return promise;
}

export function prewarmFootprintScreenData() {
  return prewarmData<Item[]>(homePreloadKeys.footprints, async () => {
    const items = await listFootprintsLocal();
    setPreloadedData(homePreloadKeys.footprints, items);
    prefetchFootprintImages(items);
    return items;
  });
}
