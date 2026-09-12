import { listFootprintsForSync, markFootprintFailed, replaceFootprintsFromSync, type FootprintItem } from '@/src/local/repositories/footprintsRepository';
import { getSyncMetadata, saveSyncMetadata } from '@/src/local/syncMetadataRepository';
import { uploadFootprintImagesForSync } from './footprintImageStorage';
import { mergeSyncRecords } from './syncMerge';
import { getCurrentSession, getSupabaseClient, isSupabaseConfigured } from './supabaseClient';

type RemoteFootprint = {
  id: string;
  user_id: string;
  location: string;
  coordinate: string | null;
  visit_date: string;
  notes: string | null;
  rating: number | null;
  image_url: string | null;
  image_urls: string[] | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ManualSyncResult =
  | {
      status: 'signedOut';
    }
  | {
      status: 'synced';
      uploadedFootprints: number;
      downloadedFootprints: number;
      syncedAt: string;
    };

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

function toRemoteFootprint(footprint: FootprintItem, userId: string): RemoteFootprint {
  const images = imageList(footprint.image_urls, footprint.image_url);
  return {
    id: footprint.id,
    user_id: userId,
    location: String(footprint.location || ''),
    coordinate: footprint.coordinate ? String(footprint.coordinate) : null,
    visit_date: String(footprint.visit_date || ''),
    notes: footprint.notes ? String(footprint.notes) : null,
    rating: typeof footprint.rating === 'number' ? footprint.rating : null,
    image_url: images[0] || null,
    image_urls: images.length ? images : null,
    created_at: footprint.created_at,
    updated_at: footprint.updated_at,
    deleted_at: footprint.deleted_at ?? null,
  };
}

function toLocalFootprint(footprint: RemoteFootprint): FootprintItem {
  return {
    id: footprint.id,
    location: footprint.location,
    coordinate: footprint.coordinate,
    visit_date: footprint.visit_date,
    notes: footprint.notes,
    rating: footprint.rating,
    image_url: footprint.image_url,
    image_urls: footprint.image_urls ?? null,
    created_at: footprint.created_at,
    updated_at: footprint.updated_at,
    deleted_at: footprint.deleted_at,
    sync_status: 'synced',
  };
}

export async function runManualSync(): Promise<ManualSyncResult> {
  if (!isSupabaseConfigured()) {
    throw new Error('还没有配置 Supabase。请设置 EXPO_PUBLIC_SUPABASE_URL 和 EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY。');
  }

  const session = await getCurrentSession();
  if (!session?.user) return { status: 'signedOut' };

  const supabase = getSupabaseClient();
  const userId = session.user.id;
  const syncedAt = new Date().toISOString();
  const localFootprints = await listFootprintsForSync();
  const pendingFootprints = localFootprints.filter((footprint) => footprint.sync_status === 'pending' || footprint.sync_status === 'failed');
  const uploadReadyFootprints: FootprintItem[] = [];
  const failedFootprintIds = new Set<string>();

  for (const footprint of pendingFootprints) {
    try {
      uploadReadyFootprints.push(await uploadFootprintImagesForSync({ footprint, userId, supabase }));
    } catch {
      failedFootprintIds.add(footprint.id);
      await markFootprintFailed(footprint.id);
    }
  }

  if (uploadReadyFootprints.length > 0) {
    const { error } = await supabase
      .from('trip_footprints')
      .upsert(uploadReadyFootprints.map((footprint) => toRemoteFootprint(footprint, userId)), { onConflict: 'id' });
    if (error) throw error;
  }

  const { data: remoteFootprintsData, error: remoteFootprintsError } = await supabase
    .from('trip_footprints')
    .select('id,user_id,location,coordinate,visit_date,notes,rating,image_url,image_urls,created_at,updated_at,deleted_at')
    .eq('user_id', userId);
  if (remoteFootprintsError) throw remoteFootprintsError;

  const remoteFootprints = ((remoteFootprintsData ?? []) as RemoteFootprint[]).map(toLocalFootprint);
  const uploadReadyById = new Map(uploadReadyFootprints.map((footprint) => [footprint.id, footprint]));
  const mergedFootprints = mergeSyncRecords(
    localFootprints.map((footprint) => ({
      ...(uploadReadyById.get(footprint.id) ?? footprint),
      sync_status: failedFootprintIds.has(footprint.id)
        ? 'failed' as const
        : uploadReadyById.has(footprint.id)
          ? 'synced' as const
          : footprint.sync_status,
    })),
    remoteFootprints,
  ).map((footprint) => ({ ...footprint, sync_status: footprint.sync_status === 'failed' ? 'failed' as const : 'synced' as const }));

  await replaceFootprintsFromSync(mergedFootprints);
  await saveSyncMetadata({ ...(await getSyncMetadata()), last_synced_at: syncedAt });

  return {
    status: 'synced',
    uploadedFootprints: uploadReadyFootprints.length,
    downloadedFootprints: remoteFootprints.length,
    syncedAt,
  };
}
