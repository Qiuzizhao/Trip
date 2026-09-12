import type { SupabaseClient } from '@supabase/supabase-js';

import { footprintImageFileNameFromUri, resolveExistingFootprintImageUri } from '@/src/features/daily/footprints/footprintImageFiles';
import type { FootprintItem } from '@/src/local/repositories/footprintsRepository';

export const TRIP_FOOTPRINT_IMAGES_BUCKET = 'trip-footprint-images';

export class MissingFootprintImageError extends Error {
  constructor(uri: string) {
    super(`本地图片文件不存在，无法上传：${uri}`);
    this.name = 'MissingFootprintImageError';
  }
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

function isRemoteUri(uri: string) {
  return /^https?:\/\//i.test(uri);
}

function isUploadableLocalUri(uri: string) {
  return /^(file|content):\/\//i.test(uri);
}

function extensionForUri(uri: string) {
  const cleanUri = uri.split('?')[0]?.split('#')[0] || '';
  const rawExt = cleanUri.split('.').pop()?.toLowerCase() || '';
  if (/^[a-z0-9]{2,5}$/.test(rawExt)) return rawExt;
  return 'jpg';
}

function contentTypeForExtension(ext: string) {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    default:
      return 'application/octet-stream';
  }
}

function safePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'item';
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

async function blobForUri(uri: string) {
  const response = await fetch(uri);
  if (/^https?:\/\//i.test(uri) && !response.ok) {
    throw new Error(`图片读取失败：${uri}`);
  }
  return response.blob();
}

async function uploadImageUri({
  supabase,
  userId,
  footprintId,
  uri,
  index,
}: {
  supabase: SupabaseClient;
  userId: string;
  footprintId: string;
  uri: string;
  index: number;
}) {
  if (isRemoteUri(uri) || !isUploadableLocalUri(uri)) return uri;

  const localUri = await resolveExistingFootprintImageUri(uri, footprintImageFileNameFromUri(uri));
  if (!localUri) throw new MissingFootprintImageError(uri);

  const ext = extensionForUri(localUri);
  const path = [
    safePathPart(userId),
    safePathPart(footprintId),
    `${index + 1}-${hashString(localUri)}.${ext}`,
  ].join('/');
  const blob = await blobForUri(localUri);
  const { error } = await supabase.storage
    .from(TRIP_FOOTPRINT_IMAGES_BUCKET)
    .upload(path, blob, {
      cacheControl: '31536000',
      contentType: contentTypeForExtension(ext),
      upsert: true,
    });

  if (error) throw error;

  const { data } = supabase.storage.from(TRIP_FOOTPRINT_IMAGES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function uploadFootprintImagesForSync({
  footprint,
  userId,
  supabase,
}: {
  footprint: FootprintItem;
  userId: string;
  supabase: SupabaseClient;
}) {
  const images = imageList(footprint.image_urls, footprint.image_url);
  if (!images.some(isUploadableLocalUri)) return footprint;

  const uploadedImages = await Promise.all(
    images.map((uri, index) => uploadImageUri({ supabase, userId, footprintId: footprint.id, uri, index })),
  );

  return {
    ...footprint,
    image_url: uploadedImages[0] || null,
    image_urls: uploadedImages.length ? uploadedImages : null,
  };
}
