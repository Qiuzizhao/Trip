import { getJson, setJson } from '../storage';

const listCache = new Map<string, unknown[]>();
const listLoadPromises = new Map<string, Promise<unknown[]>>();

export async function getCachedList<T>(key: string, fallback: T[] = []) {
  if (listCache.has(key)) return listCache.get(key) as T[];

  const existing = listLoadPromises.get(key) as Promise<T[]> | undefined;
  if (existing) return existing;

  const promise = getJson<T[]>(key, fallback)
    .then((items) => {
      listCache.set(key, items);
      return items;
    })
    .finally(() => {
      listLoadPromises.delete(key);
    });
  listLoadPromises.set(key, promise);
  return promise;
}

export async function setCachedList<T>(key: string, items: T[]) {
  listCache.set(key, items);
  await setJson<T[]>(key, items);
}
