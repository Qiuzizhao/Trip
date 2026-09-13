#!/usr/bin/env node
// 同步项与对象清理脚本
//
// 默认 dry-run（只打印将要做什么），加 --apply 才真正执行。
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/gc-assets.mjs [--apply] [--days=30]
//
// 做什么：
//   1) 清理超过 N 天的墓碑项（trip_sync_items.deleted_at）
//   2) 清理孤儿对象（不在任何资产元数据项的 remoteKey 里）
//
// 注意：image_url / image_urls 已于 2026-09-13 退役，引用关系只来自 trip_sync_items；
// 已删除记录遗留的旧图片会被列为孤儿，确认后可清理。
import { createStore } from './lib/syncStore.mjs';

const apply = process.argv.includes('--apply');
const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
const days = daysArg ? Number(daysArg.split('=')[1]) : 30;

if (!Number.isFinite(days) || days <= 0) {
  console.error('--days 必须是正整数');
  process.exit(2);
}

async function main() {
  const store = createStore();
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const [items, objects] = await Promise.all([
    store.rest('trip_sync_items?select=path,body,deleted_at'),
    store.listAllObjects(),
  ]);

  const staleTombstones = items.filter((item) => item.deleted_at && item.deleted_at < cutoff);
  const { referenced } = store.referencedKeysFromItems(items);
  const orphans = objects.filter((object) => !referenced.has(object.path));

  console.log(`${apply ? '执行' : '试运行（--apply 才会真正删除）'}`);
  console.log(`1) 超过 ${days} 天的墓碑项：${staleTombstones.length}`);
  staleTombstones.slice(0, 10).forEach((item) => console.log(`   - ${item.path} (deleted_at=${item.deleted_at})`));
  console.log(`2) 孤儿对象：${orphans.length}`);
  orphans.slice(0, 10).forEach((object) => console.log(`   - ${object.path} (${object.size} B)`));

  if (!apply) {
    console.log('\n试运行结束。确认清单后加 --apply 执行。');
    return;
  }

  if (staleTombstones.length) {
    const paths = staleTombstones.map((item) => item.path);
    await store.rest(`trip_sync_items?path=in.(${paths.map((p) => `"${p}"`).join(',')})`, { method: 'DELETE' });
    console.log(`已删除 ${paths.length} 条墓碑项`);
  }

  let deleted = 0;
  for (const object of orphans) {
    await store.deleteObject(object.path);
    deleted += 1;
  }
  console.log(`已删除 ${deleted} 个孤儿对象`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
