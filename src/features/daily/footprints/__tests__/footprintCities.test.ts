import { describe, expect, it } from '@jest/globals';

import { cityKey, collectCityCounts, filterFootprints, itemHasCity, normalizeCity } from '../footprintCities';

const items = [
  { id: '1', coordinate: ' 北京 ', location: '故宫', notes: '看日落', tags: ['周末'] },
  { id: '2', coordinate: '北京', location: '颐和园', notes: '', tags: ['亲子'] },
  { id: '3', coordinate: '上海', location: '外滩', notes: '周末旅行', tags: ['周末'] },
  { id: '4', coordinate: null, location: '未填城市', notes: '', tags: [] },
];

describe('城市分类', () => {
  it('从已有城市字段统计频次，忽略空值和已删除记录', () => {
    expect(collectCityCounts([...items, { coordinate: '广州', deleted_at: '2026-10-12' }])).toEqual([
      { city: '北京', count: 2 }, { city: '上海', count: 1 },
    ]);
  });

  it('英文城市忽略大小写，并保留完整多词城市名称', () => {
    expect(collectCityCounts([{ coordinate: 'New York' }, { coordinate: ' new york ' }])).toEqual([
      { city: 'New York', count: 2 },
    ]);
    expect(normalizeCity(' New York ')).toBe('New York');
    expect(normalizeCity(null)).toBe('');
    expect(cityKey(' NEW YORK ')).toBe('new york');
  });

  it('分类按完整城市匹配，全部城市不过滤', () => {
    expect(itemHasCity({ coordinate: '北京' }, '北京')).toBe(true);
    expect(itemHasCity({ coordinate: '北京周边' }, '北京')).toBe(false);
    expect(itemHasCity({ coordinate: 'New York' }, 'new york')).toBe(true);
    expect(itemHasCity({ coordinate: null }, null)).toBe(true);
  });

  it('城市、标签、搜索取交集，保留原有足迹顺序', () => {
    expect(filterFootprints(items, { city: '北京', tag: null, search: '' }).map((item) => item.id)).toEqual(['1', '2']);
    expect(filterFootprints(items, { city: '北京', tag: '周末', search: '日落' }).map((item) => item.id)).toEqual(['1']);
    expect(filterFootprints(items, { city: '上海', tag: '親子', search: '' })).toEqual([]);
  });

  it('解除城市筛选保留标签筛选，搜索仍支持城市和标签', () => {
    expect(filterFootprints(items, { city: null, tag: '周末', search: '' }).map((item) => item.id)).toEqual(['1', '3']);
    expect(filterFootprints(items, { city: null, tag: null, search: '北京' }).map((item) => item.id)).toEqual(['1', '2']);
    expect(filterFootprints(items, { city: null, tag: null, search: '亲子' }).map((item) => item.id)).toEqual(['2']);
    expect(filterFootprints(items, { city: null, tag: null, search: '' })).toEqual(items);
  });
});
