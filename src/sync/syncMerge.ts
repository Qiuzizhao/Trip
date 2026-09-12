export type SyncRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};

function timestamp(value: string | null | undefined) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function changeTimestamp(record: SyncRecord) {
  return Math.max(timestamp(record.updated_at), timestamp(record.deleted_at));
}

function chooseRecord<T extends SyncRecord>(local: T, remote: T) {
  const localChangedAt = changeTimestamp(local);
  const remoteChangedAt = changeTimestamp(remote);
  if (local.deleted_at && localChangedAt >= remoteChangedAt) return local;
  if (remote.deleted_at && remoteChangedAt >= localChangedAt) return remote;
  return remoteChangedAt >= localChangedAt ? remote : local;
}

export function mergeSyncRecords<T extends SyncRecord>(localRecords: T[], remoteRecords: T[]) {
  const merged = new Map<string, T>();

  for (const record of localRecords) {
    merged.set(record.id, record);
  }

  for (const remote of remoteRecords) {
    const local = merged.get(remote.id);
    merged.set(remote.id, local ? chooseRecord(local, remote) : remote);
  }

  return [...merged.values()].sort((a, b) => {
    const diff = changeTimestamp(b) - changeTimestamp(a);
    if (diff !== 0) return diff;
    return b.id.localeCompare(a.id);
  });
}
