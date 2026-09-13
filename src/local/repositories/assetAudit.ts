// 客户端资产对账（阶段 5 的第 3/4 类问题）：
//   3) 本地有 asset 但远端没有对象（remoteKey 为空）
//   4) 本地文件缺失或与记录的大小不一致
import { listAllAssets } from '@/src/local/repositories/assetRepository';
import { localUriForAsset } from '@/src/features/daily/footprints/assetResolver';
import { ensureFootprintImageDirectory } from '@/src/features/daily/footprints/footprintImageFiles';

export type LocalAssetIssue = {
  assetId: string;
  footprintId: string;
  kind: 'missing-local-file' | 'size-mismatch' | 'not-uploaded';
  detail: string;
};

export async function auditLocalAssets(): Promise<LocalAssetIssue[]> {
  const issues: LocalAssetIssue[] = [];
  const context = await ensureFootprintImageDirectory();

  for (const asset of await listAllAssets()) {
    if (!asset.remoteKey) {
      issues.push({ assetId: asset.id, footprintId: asset.footprintId, kind: 'not-uploaded', detail: '尚无远端对象' });
    }

    const localUri = await localUriForAsset(asset);
    if (!localUri) {
      issues.push({ assetId: asset.id, footprintId: asset.footprintId, kind: 'missing-local-file', detail: asset.fileName });
      continue;
    }

    if (context && asset.size > 0) {
      const info = await context.FileSystem.getInfoAsync(localUri);
      const size = (info as { size?: number }).size ?? 0;
      if (info.exists && size !== asset.size) {
        issues.push({
          assetId: asset.id,
          footprintId: asset.footprintId,
          kind: 'size-mismatch',
          detail: `记录 ${asset.size} vs 实际 ${size}`,
        });
      }
    }
  }

  return issues;
}

export function summarizeAssetIssues(issues: LocalAssetIssue[]) {
  return issues.reduce<Record<string, number>>((accumulator, issue) => {
    accumulator[issue.kind] = (accumulator[issue.kind] ?? 0) + 1;
    return accumulator;
  }, {});
}
