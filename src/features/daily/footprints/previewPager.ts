// 预览的"无限循环"分页映射（纯函数，方便单测）。
//
// Gallery 是线性滚动，做不到"从最后一张滑回第一张"的滑动动画——直接 setIndex 是硬切闪烁。
// 做法是最经典的首尾克隆：数据排成 [最后一张, ...原本, 第一张]，
// 于是两个方向都能滑出完整的滑动动画；滑到克隆项后再"无声"跳回对应的真实项
// （克隆项和真实项内容完全一致，看不到跳）。

/** 首尾各补一张克隆（少于 2 张时不做循环） */
export function buildPreviewPages(uris: string[]): string[] {
  if (uris.length < 2) return uris;
  return [uris[uris.length - 1], ...uris, uris[0]];
}

/** 真实下标 → Gallery 里的位置 */
export function previewVisualIndex(realIndex: number, count: number): number {
  return count > 1 ? realIndex + 1 : realIndex;
}

/** Gallery 里的位置 → 真实下标（克隆项会折回真实项） */
export function previewRealIndex(visualIndex: number, count: number): number {
  if (count <= 1) return visualIndex;
  return ((visualIndex - 1) % count + count) % count;
}

/** 这个位置是不是克隆项（滑到它之后要无声跳回真实项） */
export function isClonePage(visualIndex: number, count: number): boolean {
  return count > 1 && (visualIndex <= 0 || visualIndex >= count + 1);
}
