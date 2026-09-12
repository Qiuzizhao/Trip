import { getJson, setJson } from './storage';

const syncMetadataKey = 'trip-footprints.syncMetadata';
const defaultSyncMetadata: SyncMetadata = { last_synced_at: null };

export type SyncMetadata = {
  last_synced_at: string | null;
};

export async function getSyncMetadata() {
  return getJson<SyncMetadata>(syncMetadataKey, defaultSyncMetadata);
}

export async function saveSyncMetadata(metadata: SyncMetadata) {
  await setJson(syncMetadataKey, metadata);
  return metadata;
}

export async function clearSyncMetadata() {
  await setJson(syncMetadataKey, defaultSyncMetadata);
  return defaultSyncMetadata;
}
