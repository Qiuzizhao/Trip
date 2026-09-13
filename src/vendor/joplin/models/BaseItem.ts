// 本地替身：上游 models/BaseItem.ts（1123 行，绑定 BaseModel/数据库）。
// 这里只保留 file-api.ts 用到的三个纯函数与一个类型，源码抄自上游 BaseItem.ts:46-50、174-253。
export interface RemoteItemMetadata {
  item_id: string;
  updated_time: number;
  sync_time: number;
}

export function systemPath(itemOrId: { id: string } | string, extension = 'md') {
  if (typeof itemOrId === 'string') return `${itemOrId}.${extension}`;
  return `${itemOrId.id}.${extension}`;
}

export function isSystemPath(path: string) {
  // 规则：<32 位十六进制>.md
  if (!path || !path.length) return false;
  const parts = path.split('/');
  const last = parts[parts.length - 1];
  const p = last.split('.');
  if (p.length !== 2) return false;
  return p[0].length === 32 && p[1] === 'md';
}

export function pathToId(path: string): string {
  const p = path.split('/');
  const s = p[p.length - 1].split('.');
  const name = s[0];
  if (!name) return name;
  const parts = name.split('-');
  return parts[parts.length - 1];
}

export default { systemPath, isSystemPath, pathToId };
