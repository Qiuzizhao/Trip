#!/usr/bin/env node
// 资产对账脚本
//
// 用法：SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/audit-assets.mjs [--json]
//
// 检查四类问题：
//   1) 远端对象 size = 0（历史上传 bug 的残留）
//   2) 远端对象没有任何引用（不在任何资产元数据项的 remoteKey 里）
//   3) 资产元数据项指向的对象不存在
//   4) 元数据记录的大小与对象实际大小不一致（跳过 size=0 的未校验记录）
//
// 退出码：0 = 无问题；1 = 发现问题；2 = 配置/请求错误。
import { BUCKET, createStore } from './lib/syncStore.mjs';

const asJson = process.argv.includes('--json');

async function main() {
  const store = createStore();
  const [objects, items, footprints] = await Promise.all([
    store.listAllObjects(),
    store.rest('trip_sync_items?select=path,item_id,body,deleted_at'),
    store.rest('trip_footprints?select=id'),
  ]);

  const { referenced, metadataAssets } = store.referencedKeysFromItems(items);
  const objectPaths = new Set(objects.map((object) => object.path));
  const objectSizes = new Map(objects.map((object) => [object.path, object.size]));

  const zeroByte = objects.filter((object) => object.size === 0);
  const orphans = objects.filter((object) => !referenced.has(object.path));
  const missingObjects = metadataAssets.filter((asset) => !objectPaths.has(asset.remoteKey));
  const sizeMismatch = metadataAssets.filter((asset) => {
    if (!asset.size) return false;
    const actual = objectSizes.get(asset.remoteKey);
    return actual !== undefined && actual !== asset.size;
  });

  const report = {
    bucket: BUCKET,
    totals: {
      objects: objects.length,
      metadataAssets: metadataAssets.length,
      referencedObjects: objects.filter((object) => referenced.has(object.path)).length,
      footprints: footprints.length,
    },
    zeroByteObjects: zeroByte.map((object) => object.path),
    orphanObjects: orphans.map((object) => object.path),
    metadataWithoutObject: missingObjects.map((asset) => ({ path: asset.path, remoteKey: asset.remoteKey })),
    sizeMismatch: sizeMismatch.map((asset) => ({
      path: asset.path,
      remoteKey: asset.remoteKey,
      metadataSize: asset.size,
      objectSize: objectSizes.get(asset.remoteKey),
    })),
  };

  const problemCount = zeroByte.length + orphans.length + missingObjects.length + sizeMismatch.length;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`bucket: ${report.bucket}`);
    console.log(`对象 ${report.totals.objects} 个，其中被引用 ${report.totals.referencedObjects} 个；资产元数据项 ${report.totals.metadataAssets} 个；足迹记录 ${report.totals.footprints} 条`);
    console.log('');
    console.log(`1) 0 字节对象：${zeroByte.length}`);
    zeroByte.slice(0, 20).forEach((object) => console.log(`   - ${object.path}`));
    console.log(`2) 孤儿对象（无任何引用）：${orphans.length}`);
    orphans.slice(0, 20).forEach((object) => console.log(`   - ${object.path} (${object.size} B)`));
    console.log(`3) 元数据指向的对象不存在：${missingObjects.length}`);
    missingObjects.slice(0, 20).forEach((asset) => console.log(`   - ${asset.path} -> ${asset.remoteKey}`));
    console.log(`4) 大小不一致：${sizeMismatch.length}`);
    sizeMismatch.slice(0, 20).forEach((asset) => console.log(`   - ${asset.path}: 元数据 ${asset.size} vs 对象 ${asset.objectSize}`));
  }

  process.exit(problemCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
