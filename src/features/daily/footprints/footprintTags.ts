// 足迹标签：解析、归一化、统计。
//
// 存储形态是字符串数组（服务端列是 text[]，本地记录直接存数组），
// 编辑时用一个输入框，逗号（中英文）/顿号/分号/空白都当分隔符。
// 这里全是纯函数，UI 与仓库层共用，方便单测。

/** 一条足迹最多保留的标签数，防止输入框里粘进一大串 */
export const MAX_FOOTPRINT_TAGS = 12;

/** 输入框文本 → 标签数组 */
export function parseTagInput(value: string): string[] {
  return normalizeTagList(String(value ?? '').split(/[,，、;；#\s]+/));
}

/**
 * 任意来源的标签值 → 标签数组。
 * 兼容三种历史形态：数组、逗号分隔字符串、空值（同步下来的旧记录可能没有这一列）。
 */
export function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeTagList(value.map((item) => String(item ?? '')));
  if (typeof value === 'string') return parseTagInput(value);
  return [];
}

/** 标签数组 → 输入框文本 */
export function formatTagsInput(tags: string[]): string {
  return tags.join(', ');
}

export type TagCount = {
  tag: string;
  count: number;
};

/** 统计所有记录里出现过的标签（用于列表筛选与编辑页的常用标签），按出现次数排序 */
export function collectTagCounts(items: ReadonlyArray<Record<string, unknown>>): TagCount[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();

  for (const item of items) {
    for (const tag of normalizeTags(item.tags)) {
      const key = tagKey(tag);
      if (!labels.has(key)) labels.set(key, tag);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([key, count]) => ({ tag: labels.get(key) ?? key, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-Hans-CN'));
}

/** 记录是否带某个标签（大小写不敏感）；tag 为空时视为不过滤 */
export function itemHasTag(item: Record<string, unknown>, tag: string | null): boolean {
  if (!tag) return true;
  const key = tagKey(tag);
  if (!key) return true;
  return normalizeTags(item.tags).some((value) => tagKey(value) === key);
}

function normalizeTagList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of values) {
    const tag = String(raw ?? '').trim();
    if (!tag) continue;
    const key = tagKey(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= MAX_FOOTPRINT_TAGS) break;
  }

  return result;
}

function tagKey(tag: string) {
  return String(tag ?? '').trim().toLowerCase();
}
