import { itemHasTag, normalizeTags } from './footprintTags';

// Keep a city as one complete value: e.g. "New York" is not two tags.
export function normalizeCity(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function cityKey(value: unknown): string {
  return normalizeCity(value).toLowerCase();
}

export function collectCityCounts(items: ReadonlyArray<Record<string, unknown>>): { city: string; count: number }[] {
  const counts = new Map<string, { city: string; count: number }>();
  for (const item of items) {
    if (item.deleted_at) continue;
    const city = normalizeCity(item.coordinate);
    if (!city) continue;
    const key = cityKey(city);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { city, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, 'zh-Hans-CN'));
}

export function itemHasCity(item: Record<string, unknown>, city: string | null): boolean {
  return !cityKey(city) || cityKey(item.coordinate) === cityKey(city);
}

export function filterFootprints<T extends Record<string, unknown>>(
  items: ReadonlyArray<T>,
  { city, tag, search }: { city: string | null; tag: string | null; search: string },
): T[] {
  const query = search.trim().toLowerCase();
  return items.filter((item) => {
    if (!itemHasCity(item, city) || !itemHasTag(item, tag)) return false;
    if (!query) return true;
    return [item.location, item.notes, item.coordinate, ...normalizeTags(item.tags)]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
}
