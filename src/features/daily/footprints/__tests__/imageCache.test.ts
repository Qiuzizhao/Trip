import { describe, expect, it } from '@jest/globals';

import { footprintDisplayImageUri, footprintImageUris } from '../imageCache';

// 说明：列表/相册/编辑页现在统一用原图地址（不再走服务端 imgproxy），
// 所以这里只覆盖地址的组装规则。

describe('footprintImageUris', () => {
  it('image_urls 优先，兼容单值 image_url', () => {
    expect(footprintImageUris({ id: 'a', image_urls: ['u1', 'u2'] })).toEqual(['u1', 'u2']);
    expect(footprintImageUris({ id: 'a', image_url: 'u1' })).toEqual(['u1']);
    // image_urls 是数组时以它为准（空数组也不会回落到 image_url，这是既有行为）
    expect(footprintImageUris({ id: 'a', image_urls: [], image_url: 'u1' })).toEqual([]);
  });

  it('去重、去空、去首尾空格', () => {
    expect(footprintImageUris({ id: 'a', image_urls: ['u1', ' u1 ', '', 'u2'] })).toEqual(['u1', 'u2']);
  });

  it('没有图片时返回空数组', () => {
    expect(footprintImageUris({ id: 'a' })).toEqual([]);
  });
});

describe('footprintDisplayImageUri', () => {
  it('原样返回可用地址（相对 key 也交给上层处理）', () => {
    expect(footprintDisplayImageUri('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(footprintDisplayImageUri('file:///app/a.png')).toBe('file:///app/a.png');
    expect(footprintDisplayImageUri('3c7c8470/assets/a.heic')).toBe('3c7c8470/assets/a.heic');
  });
});
