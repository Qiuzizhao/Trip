// 足迹标签配色。
//
// 做法和「简笔（Notes）」里的标签一致：按标签文本算一个**稳定**的颜色
// （同一个标签在任何页面都是同一个颜色，不会每次渲染乱跳），
// 底色用同一个颜色的低透明度版本，所以一张卡片上多个标签也不会互相打架。
//
// 色板是挑过的：去掉了原色板里偏灰、偏暗的几支，保证在白卡片上干净好看。

/** 标签主色（文字色）。底色由它加透明度生成 */
const TAG_COLORS = [
  '#3A82F8', // 蓝
  '#4C6EF5', // 靛
  '#1098AD', // 青
  '#0CA678', // 青绿
  '#37B24D', // 绿
  '#82C91E', // 黄绿
  '#F08C00', // 橙
  '#E8590C', // 珊瑚
  '#F06595', // 粉
  '#D6336C', // 玫红
  '#7048E8', // 紫
  '#AE3EC9', // 紫罗兰
];

/** 底色 = 主色 + 约 14% 透明度（8 位 hex 的后两位） */
const TAG_SOFT_ALPHA = '24';

/**
 * 少数常见标签直接给一个更贴切、更好看的颜色，
 * 其余走哈希分配（同一标签永远得到同一个颜色）。
 */
const CURATED_TAG_COLORS: Record<string, string> = {
  海边: '#1098AD',
  海岛: '#1098AD',
  日落: '#F08C00',
  夜景: '#4C6EF5',
  徒步: '#37B24D',
  爬山: '#37B24D',
  露营: '#0CA678',
  美食: '#E8590C',
  咖啡: '#C08A5A',
  周末: '#37B24D',
  假期: '#7048E8',
  家人: '#F06595',
  朋友: '#7048E8',
  出差: '#4C6EF5',
};

export type TagColor = {
  /** 文字色 */
  color: string;
  /** 底色（同色低透明度） */
  backgroundColor: string;
};

export function tagColorFor(tag: string): TagColor {
  const color = primaryColorFor(tag);
  return { color, backgroundColor: `${color}${TAG_SOFT_ALPHA}` };
}

function primaryColorFor(tag: string) {
  const label = String(tag ?? '').trim();
  const curated = CURATED_TAG_COLORS[label];
  if (curated) return curated;
  return TAG_COLORS[Math.abs(hashLabel(label.toLowerCase())) % TAG_COLORS.length];
}

/** 与 Notes 里同一个哈希写法，保证同名标签跨 App 也是同一个颜色 */
function hashLabel(label: string) {
  let hash = 0;
  for (const char of label) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }
  return hash;
}
