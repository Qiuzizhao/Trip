import type { Item } from '@/src/features/daily/_shared/ReplicatedScreens';
import { repairFootprintImageReferences } from '@/src/features/daily/footprints/footprintImageFiles';
import { localKeys } from '../keys';
import { getCachedList, setCachedList } from './localListCache';

export type SyncStatus = 'pending' | 'synced' | 'failed';
export type FootprintItem = Item & {
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  sync_status?: SyncStatus;
};

type FootprintListener = (items: FootprintItem[]) => void;

const footprintListeners = new Set<FootprintListener>();

export async function listFootprintsLocal() {
  const items = await loadNormalizedFootprints();
  return sortFootprints(items.filter((item) => !item.deleted_at));
}

export async function listFootprintsForSync() {
  return loadNormalizedFootprints();
}

export function subscribeFootprintsLocal(listener: FootprintListener) {
  footprintListeners.add(listener);
  return () => {
    footprintListeners.delete(listener);
  };
}

async function persistFootprints(items: FootprintItem[]) {
  const nextItems = sortFootprints(items);
  await setCachedList(localKeys.footprints, nextItems);
  footprintListeners.forEach((listener) => listener(nextItems.filter((item) => !item.deleted_at)));
  return nextItems;
}

export async function createFootprintCached(payload: Record<string, unknown>) {
  const items = await listFootprintsForSync();
  const now = new Date().toISOString();
  const item: FootprintItem = {
    id: createLocalId(),
    created_at: now,
    updated_at: now,
    deleted_at: null,
    sync_status: 'pending',
    ...payload,
  };
  await persistFootprints([item, ...items]);
  return item;
}

export async function updateFootprintCached(id: string, payload: Record<string, unknown>) {
  const items = await listFootprintsForSync();
  let nextItem: FootprintItem | null = null;
  await persistFootprints(items.map((item) => {
    if (item.id !== id) return item;
    nextItem = {
      ...item,
      ...payload,
      updated_at: new Date().toISOString(),
      sync_status: 'pending',
    };
    return nextItem;
  }));
  return nextItem;
}

export async function deleteFootprintCached(id: string) {
  const items = await listFootprintsForSync();
  const now = new Date().toISOString();
  await persistFootprints(items.map((item) => (
    item.id === id
      ? { ...item, deleted_at: now, updated_at: now, sync_status: 'pending' as const }
      : item
  )));
}

export async function markFootprintFailed(id: string) {
  const items = await listFootprintsForSync();
  await persistFootprints(items.map((item) => (
    item.id === id ? { ...item, sync_status: 'failed' as const } : item
  )));
}

export async function replaceFootprintsFromSync(items: FootprintItem[]) {
  return persistFootprints(items.map((item) => normalizeFootprint(item, 'synced')));
}

export async function clearFootprintsLocal() {
  await persistFootprints([]);
  return [];
}

function sortFootprints<T extends FootprintItem>(items: T[]) {
  return [...items].sort((a, b) => {
    const dateCompare = String(b.visit_date || '').localeCompare(String(a.visit_date || ''));
    if (dateCompare !== 0) return dateCompare;
    return timestamp(b.updated_at || b.created_at) - timestamp(a.updated_at || a.created_at);
  });
}

async function loadNormalizedFootprints() {
  const rawItems = await getCachedList<Record<string, unknown>>(localKeys.footprints);
  const normalized = rawItems.map((item) => normalizeFootprint(item));
  const repaired = await Promise.all(normalized.map((item) => repairFootprintImageReferences(item)));
  const needsRewrite = rawItems.some((item, index) => (
    item.id !== repaired[index]?.id ||
    item.created_at !== repaired[index]?.created_at ||
    item.updated_at !== repaired[index]?.updated_at ||
    item.deleted_at !== repaired[index]?.deleted_at ||
    item.sync_status !== repaired[index]?.sync_status ||
    item.image_url !== repaired[index]?.image_url ||
    JSON.stringify(item.image_urls ?? null) !== JSON.stringify(repaired[index]?.image_urls ?? null)
  ));
  if (needsRewrite) {
    await setCachedList(localKeys.footprints, sortFootprints(repaired));
  }
  return sortFootprints(repaired);
}

function normalizeFootprint(value: Record<string, unknown>, fallbackStatus: SyncStatus = 'pending'): FootprintItem {
  const now = new Date().toISOString();
  const id = typeof value.id === 'string' && value.id
    ? value.id
    : `legacy_${String(value.id || Date.now())}`;

  return {
    ...value,
    id,
    created_at: typeof value.created_at === 'string' ? value.created_at : now,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : now,
    deleted_at: typeof value.deleted_at === 'string' ? value.deleted_at : null,
    sync_status: isSyncStatus(value.sync_status) ? value.sync_status : fallbackStatus,
  } as FootprintItem;
}

function isSyncStatus(value: unknown): value is SyncStatus {
  return value === 'pending' || value === 'synced' || value === 'failed';
}

function createLocalId() {
  return `footprint_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function timestamp(value?: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
