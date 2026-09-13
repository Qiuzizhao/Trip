// 本地替身：上游 SyncTargetRegistry.ts 是同步目标注册表。
// vendor 代码只用 nameToId() 与 Setting.value('sync.target') 做相等比较；我们不使用这些分支。
const ids: Record<string, number> = {
  filesystem: 2,
  webdav: 6,
};

export default {
  nameToId(name: string) {
    return ids[name] ?? 0;
  },
};
