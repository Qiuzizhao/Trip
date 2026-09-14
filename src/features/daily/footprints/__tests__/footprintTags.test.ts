import { describe, expect, it } from '@jest/globals';

import {
  MAX_FOOTPRINT_TAGS,
  collectTagCounts,
  formatTagsInput,
  itemHasTag,
  normalizeTags,
  parseTagInput,
} from '../footprintTags';

describe('parseTagInput', () => {
  it('中英文逗号、顿号、分号、空白都当分隔符', () => {
    expect(parseTagInput('海边, 周末；日落')).toEqual(['海边', '周末', '日落']);
    expect(parseTagInput('海边，周末、日落 夜景')).toEqual(['海边', '周末', '日落', '夜景']);
  });

  it('去掉空项、首尾空格和重复（大小写不敏感，保留首次写法）', () => {
    expect(parseTagInput('  海边 ,, 海边，HAIKU, haiku  ')).toEqual(['海边', 'HAIKU']);
  });

  it('以 # 开头也能识别（从别处粘过来的习惯写法）', () => {
    expect(parseTagInput('#海边 #周末')).toEqual(['海边', '周末']);
  });

  it('空输入得到空数组', () => {
    expect(parseTagInput('')).toEqual([]);
    expect(parseTagInput('   ,  、 ')).toEqual([]);
  });

  it('最多保留固定条数', () => {
    const many = Array.from({ length: MAX_FOOTPRINT_TAGS + 5 }, (_, index) => `tag${index}`).join(',');
    expect(parseTagInput(many)).toHaveLength(MAX_FOOTPRINT_TAGS);
  });
});

describe('normalizeTags', () => {
  it('兼容数组、字符串与空值', () => {
    expect(normalizeTags(['海边', ' 海边 ', ''])).toEqual(['海边']);
    expect(normalizeTags('海边,周末')).toEqual(['海边', '周末']);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe('formatTagsInput', () => {
  it('拼成可以直接放回输入框的文本', () => {
    expect(formatTagsInput(['海边', '周末'])).toBe('海边, 周末');
    expect(formatTagsInput([])).toBe('');
  });
});

describe('collectTagCounts', () => {
  it('统计出现次数并按次数倒序', () => {
    const counts = collectTagCounts([
      { tags: ['海边', '周末'] },
      { tags: ['海边'] },
      { tags: [] },
      { tags: '日落' },
    ]);
    expect(counts).toEqual([
      { tag: '海边', count: 2 },
      // 次数相同按拼音排（rìluò < zhōumò）
      { tag: '日落', count: 1 },
      { tag: '周末', count: 1 },
    ]);
  });
});

describe('itemHasTag', () => {
  it('大小写不敏感，tag 为空时不过滤', () => {
    expect(itemHasTag({ tags: ['海边'] }, '海边')).toBe(true);
    expect(itemHasTag({ tags: ['HAIKU'] }, 'haiku')).toBe(true);
    expect(itemHasTag({ tags: ['海边'] }, '山里')).toBe(false);
    expect(itemHasTag({ tags: [] }, null)).toBe(true);
    expect(itemHasTag({ tags: [] }, '')).toBe(true);
  });
});
