import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

function fileExtensionForUri(uri: string) {
  const cleanUri = uri.split('?')[0]?.split('#')[0] || '';
  const ext = cleanUri.split('.').pop()?.toLowerCase();
  if (!ext || ext.length > 5) return 'jpg';
  if (ext === 'jpeg') return 'jpg';
  return ext;
}

async function downloadImageToCache(uri: string) {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) {
    throw new Error('无法访问本地缓存目录');
  }
  const extension = fileExtensionForUri(uri);
  const targetUri = `${cacheDir}footprint-${Date.now()}.${extension}`;
  const timeoutMs = 15000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      FileSystem.downloadAsync(uri, targetUri),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('下载超时，请稍后重试')), timeoutMs);
      }),
    ]);
  } catch (error) {
    void FileSystem.deleteAsync(targetUri, { idempotent: true }).catch(() => undefined);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function shareFootprintImage(uri: string) {
  const isSharingAvailable = await Sharing.isAvailableAsync();
  if (!isSharingAvailable) {
    throw new Error('当前设备暂不支持系统分享');
  }

  let shareUri = uri;
  if (/^https?:\/\//i.test(uri)) {
    const downloadResult = await downloadImageToCache(uri);
    shareUri = downloadResult.uri;
  }

  await Sharing.shareAsync(shareUri, {
    mimeType: `image/${fileExtensionForUri(shareUri)}`,
    dialogTitle: '下载图片',
    UTI: 'public.image',
  });
}
