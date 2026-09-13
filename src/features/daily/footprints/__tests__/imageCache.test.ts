import { describe, expect, it } from '@jest/globals';

import { thumbnailUrlFor } from '../imageCache';

const PUBLIC_URL = 'https://supabase.example.com/storage/v1/object/public/trip-footprint-images/user-1/fp-1/1-abc.png';

describe('thumbnailUrlFor', () => {
  it('把 Storage 公共 URL 换成 imgproxy 缩略图地址', () => {
    expect(thumbnailUrlFor(PUBLIC_URL)).toBe(
      'https://supabase.example.com/storage/v1/render/image/public/trip-footprint-images/user-1/fp-1/1-abc.png?width=400&quality=70',
    );
  });

  it('保留原有查询参数（例如修复后加的版本号）', () => {
    expect(thumbnailUrlFor(`${PUBLIC_URL}?v=abc123`)).toBe(
      'https://supabase.example.com/storage/v1/render/image/public/trip-footprint-images/user-1/fp-1/1-abc.png?width=400&quality=70&v=abc123',
    );
  });

  it('本地文件与非本桶地址原样返回', () => {
    expect(thumbnailUrlFor('file:///app/Documents/trip-footprint-images/a.png')).toBe('file:///app/Documents/trip-footprint-images/a.png');
    expect(thumbnailUrlFor('https://example.com/a.png')).toBe('https://example.com/a.png');
  });
});
