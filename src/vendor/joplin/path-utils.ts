// 本地替身：上游 path-utils.ts 依赖 locale 与 @joplin/utils/path。
// vendor 代码只用到 isHidden（用于过滤列表项）。
export function isHidden(filePath: string) {
  const base = String(filePath || '').split('/').filter(Boolean).pop() || '';
  return base.startsWith('.');
}
