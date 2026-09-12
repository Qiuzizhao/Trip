import { clearFootprintsLocal, listFootprintsLocal } from './repositories/footprintsRepository';
import { clearSyncMetadata, getSyncMetadata, type SyncMetadata } from './syncMetadataRepository';

export type LocalMergeSummary = {
  shouldConfirm: boolean;
  footprintCount: number;
};

export function buildLocalMergeSummary(footprints: { deleted_at?: string | null }[], metadata: SyncMetadata): LocalMergeSummary {
  const footprintCount = footprints.filter((footprint) => !footprint.deleted_at).length;
  return {
    shouldConfirm: !metadata.last_synced_at && footprintCount > 0,
    footprintCount,
  };
}

export async function getLocalMergeSummary() {
  const [footprints, metadata] = await Promise.all([listFootprintsLocal(), getSyncMetadata()]);
  return buildLocalMergeSummary(footprints, metadata);
}

export async function clearAccountLocalData() {
  const [, metadata] = await Promise.all([
    clearFootprintsLocal(),
    clearSyncMetadata(),
  ]);
  return { metadata };
}
