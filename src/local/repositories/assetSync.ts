// 编辑保存时重建某条记录的 asset，并返回「镜像用的 image_urls」。
// 迁移期 image_urls 仍然保留：现有同步路径与旧版本都依赖它。
import {
  assetLocalUriSync,
  objectKeyFromPublicUrl,
  publicUrlForObjectKey,
  resolveAssetUri,
} from '@/src/features/daily/footprints/assetResolver';
import {
  createAssetFromExistingFile,
  deleteAssetsByFootprint,
  listAssetsByFootprint,
} from './assetRepository';

function isRemoteUri(uri: string) {
  return /^https?:\/\//i.test(uri);
}

function isLocalUri(uri: string) {
  return /^(file|content):\/\//i.test(uri);
}

// 记录里的镜像字段优先写「稳定的远端 URL」：本地路径是设备相关的，换设备或清理数据后就失效了。
// 还没上传的资产才退回本地路径。
export async function mirrorUrisForFootprint(footprintId: string): Promise<string[]> {
  const assets = await listAssetsByFootprint(footprintId);
  return assets
    .map((asset) => {
      const local = assetLocalUriSync(asset);
      const remote = asset.remoteKey ? publicUrlForObjectKey(asset.remoteKey) : null;
      return remote || local || '';
    })
    .filter(Boolean);
}

// 把记录里的图片列表与 asset 对齐，返回应当写回记录的镜像路径列表。
// 已经对齐时直接返回原列表（避免每次保存都改文件名）。
export async function rebuildAssetsForFootprint(footprintId: string, imageUris: string[]): Promise<string[]> {
  const existing = await listAssetsByFootprint(footprintId);
  if (existing.length === imageUris.length) {
    const existingUris = await Promise.all(existing.map((asset) => resolveAssetUri(asset)));
    const aligned = existingUris.every((uri, index) => uri === imageUris[index]);
    if (aligned) return imageUris;
  }

  await deleteAssetsByFootprint(footprintId);

  const mirrored: string[] = [];
  for (let index = 0; index < imageUris.length; index += 1) {
    const uri = imageUris[index];
    try {
      if (isRemoteUri(uri)) {
        const remoteKey = objectKeyFromPublicUrl(uri);
        await createAssetFromExistingFile({
          footprintId,
          position: index,
          existingUri: uri,
          remoteKey,
          size: 0,
          syncTime: 0,
        });
        mirrored.push(uri);
      } else if (isLocalUri(uri)) {
        const asset = await createAssetFromExistingFile({ footprintId, position: index, existingUri: uri });
        // 已上传过的资产镜像成远端 URL（稳定）；未上传的退回本地路径
        const remote = asset.remoteKey ? publicUrlForObjectKey(asset.remoteKey) : null;
        mirrored.push(remote || assetLocalUriSync(asset) || uri);
      } else {
        mirrored.push(uri);
      }
    } catch {
      // 单个文件不可用时保留原路径，交给同步阶段重试
      mirrored.push(uri);
    }
  }

  return mirrored;
}
