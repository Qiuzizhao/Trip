import { describe, expect, it } from '@jest/globals';

import { tagColorFor } from '../tagColors';

describe('tagColorFor', () => {
  it('同一个标签永远得到同一个颜色', () => {
    expect(tagColorFor('海边')).toEqual(tagColorFor('海边'));
    expect(tagColorFor('露营').color).toBe(tagColorFor('露营').color);
  });

  it('大小写不同视为同一个标签', () => {
    expect(tagColorFor('HAIKU').color).toBe(tagColorFor('haiku').color);
  });

  it('底色是同色 + 低透明度', () => {
    const { color, backgroundColor } = tagColorFor('随便一个标签');
    expect(backgroundColor).toBe(`${color}24`);
  });

  it('常见标签用指定色，其余按哈希落到色板里', () => {
    expect(tagColorFor('海边').color).toBe('#1098AD');
    expect(tagColorFor('日落').color).toBe('#F08C00');
    expect(tagColorFor('一个不常见的中文标签').color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('不同标签不会都撞成同一个颜色', () => {
    const tags = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    expect(new Set(tags.map((tag) => tagColorFor(tag).color)).size).toBeGreaterThan(1);
  });
});
