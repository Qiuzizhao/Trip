// 纯函数：由对象名/文件名推断 Content-Type（driver 与后端共用的最小依赖）
export function contentTypeForObjectKey(objectKey: string) {
  const ext = objectKey.split('?')[0].split('.').pop()?.toLowerCase() || '';
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
