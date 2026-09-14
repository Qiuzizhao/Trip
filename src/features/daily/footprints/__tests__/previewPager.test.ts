import { describe, expect, it } from '@jest/globals';

import {
  buildPreviewPages,
  isClonePage,
  previewRealIndex,
  previewVisualIndex,
} from '../previewPager';

describe('buildPreviewPages', () => {
  it('首尾各补一张克隆，让两个方向都能滑出动画', () => {
    expect(buildPreviewPages(['a', 'b', 'c'])).toEqual(['c', 'a', 'b', 'c', 'a']);
  });

  it('只有一张（或没有）时不循环', () => {
    expect(buildPreviewPages(['a'])).toEqual(['a']);
    expect(buildPreviewPages([])).toEqual([]);
  });
});

describe('索引映射', () => {
  const count = 3;

  it('真实下标与 Gallery 位置一一对应', () => {
    expect(previewVisualIndex(0, count)).toBe(1);
    expect(previewVisualIndex(1, count)).toBe(2);
    expect(previewVisualIndex(2, count)).toBe(3);
  });

  it('克隆项折回真实项（首尾各一个）', () => {
    expect(previewRealIndex(0, count)).toBe(2);   // 最前面的克隆 = 最后一张
    expect(previewRealIndex(4, count)).toBe(0);   // 最后面的克隆 = 第一张
  });

  it('真实位置不偏移', () => {
    for (let real = 0; real < count; real += 1) {
      expect(previewRealIndex(previewVisualIndex(real, count), count)).toBe(real);
    }
  });

  it('只有一张时不做映射', () => {
    expect(previewVisualIndex(0, 1)).toBe(0);
    expect(previewRealIndex(0, 1)).toBe(0);
    expect(isClonePage(0, 1)).toBe(false);
  });
});

describe('isClonePage', () => {
  it('只有首尾两个克隆位置需要跳回', () => {
    expect(isClonePage(0, 3)).toBe(true);
    expect(isClonePage(4, 3)).toBe(true);
    expect(isClonePage(1, 3)).toBe(false);
    expect(isClonePage(3, 3)).toBe(false);
  });
});
