import { describe, expect, it } from '@jest/globals';

import {
  dateStringFromTakenAt,
  formatTakenDate,
  formatTakenAt,
  parseExifDateTime,
  readTakenAtFromBytes,
  takenAtOptions,
} from '../imageMetadata';

// 构造一个最小的 JPEG（SOI + APP1/Exif + EOI），IFD0 里放 DateTime。
// 用来验证「真实 EXIF 字节 → 时间戳」这条链路，而不是只测正则。
function buildExifJpeg(dateTime: string): ArrayBuffer {
  const ascii = Buffer.from(`${dateTime}\0`, 'ascii');
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + ascii.length);
  tiff.write('II', 0, 'ascii'); // 小端
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 偏移
  tiff.writeUInt16LE(1, 8); // 1 个条目
  tiff.writeUInt16LE(0x0132, 10); // DateTime
  tiff.writeUInt16LE(2, 12); // ASCII
  tiff.writeUInt32LE(ascii.length, 14);
  tiff.writeUInt32LE(26, 18); // 数据偏移
  tiff.writeUInt32LE(0, 22); // 没有下一个 IFD
  ascii.copy(tiff, 26);

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe1]),
      length,
      payload,
      Buffer.from([0xff, 0xd9]),
    ]),
  ).buffer;
}

describe('parseExifDateTime', () => {
  it('带时区偏移时按偏移换算成绝对时间', () => {
    // 2026-09-05 17:56:07 +08:00 == 09:56:07Z
    expect(parseExifDateTime('2026:09:05 17:56:07', '+08:00')).toBe(Date.UTC(2026, 8, 5, 9, 56, 7));
  });

  it('没有时区时按设备本地时间解释', () => {
    const parsed = parseExifDateTime('2018:03:30 12:14:19');
    expect(parsed).toBe(new Date(2018, 2, 30, 12, 14, 19).getTime());
  });

  it('接受 T 分隔符，拒绝非法输入', () => {
    expect(parseExifDateTime('2026:09:05T17:56:07')).toBe(new Date(2026, 8, 5, 17, 56, 7).getTime());
    expect(parseExifDateTime(undefined)).toBeNull();
    expect(parseExifDateTime('')).toBeNull();
    expect(parseExifDateTime('0000:00:00 00:00:00')).toBeNull();
    expect(parseExifDateTime('not-a-date')).toBeNull();
  });

  it('非法时区偏移会被忽略，不产生 Invalid Date', () => {
    expect(parseExifDateTime('2026:09:05 17:56:07', '+8')).toBe(new Date(2026, 8, 5, 17, 56, 7).getTime());
  });
});

describe('readTakenAtFromBytes', () => {
  it('能从真实 EXIF 字节里读出拍摄时间', () => {
    expect(readTakenAtFromBytes(buildExifJpeg('2026:09:05 17:56:07')))
      .toBe(new Date(2026, 8, 5, 17, 56, 7).getTime());
  });

  it('没有 EXIF 的图片返回 null（不抛错）', () => {
    expect(readTakenAtFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toBeNull();
    expect(readTakenAtFromBytes(new ArrayBuffer(0))).toBeNull();
  });
});

describe('formatTakenAt', () => {
  it('格式化成 年月日 时分', () => {
    expect(formatTakenAt(new Date(2026, 8, 5, 17, 56, 7).getTime())).toBe('2026年9月5日 17:56');
    expect(formatTakenAt(new Date(2026, 11, 31, 9, 5).getTime())).toBe('2026年12月31日 09:05');
  });

  it('没有时间时返回 null', () => {
    expect(formatTakenAt(null)).toBeNull();
    expect(formatTakenAt(undefined)).toBeNull();
    expect(formatTakenAt(0)).toBeNull();
    expect(formatTakenAt(Number.NaN)).toBeNull();
  });
});

describe('dateStringFromTakenAt', () => {
  it('按本地时间给出 YYYY-MM-DD，不会因 UTC 偏移掉到前一天', () => {
    // 东八区凌晨：toISOString() 会变成前一天，这里必须还是 5 号
    expect(dateStringFromTakenAt(new Date(2026, 8, 5, 0, 30).getTime())).toBe('2026-09-05');
    expect(dateStringFromTakenAt(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31');
  });
});

describe('formatTakenDate', () => {
  it('格式化成 年月日', () => {
    expect(formatTakenDate(new Date(2026, 8, 5, 17, 56).getTime())).toBe('2026年9月5日');
    expect(formatTakenDate(new Date(2026, 11, 31, 9, 5).getTime())).toBe('2026年12月31日');
  });
});

describe('takenAtOptions', () => {
  const at = (y: number, m: number, d: number, h: number, min: number, s = 0) =>
    new Date(y, m - 1, d, h, min, s).getTime();

  it('按日期先后排序，气泡只显示日期', () => {
    expect(takenAtOptions([at(2026, 9, 6, 9, 12), at(2026, 9, 5, 17, 56)])).toEqual([
      { takenAt: at(2026, 9, 5, 17, 56), date: '2026-09-05', label: '2026年9月5日' },
      { takenAt: at(2026, 9, 6, 9, 12), date: '2026-09-06', label: '2026年9月6日' },
    ]);
  });

  it('同一天的多张照片只留一个气泡，并用当天最早的一张排序', () => {
    const options = takenAtOptions([
      at(2026, 9, 5, 17, 56, 7),
      at(2026, 9, 5, 9, 12, 30),
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({
      takenAt: at(2026, 9, 5, 9, 12, 30),
      date: '2026-09-05',
      label: '2026年9月5日',
    });
  });

  it('跨天时按日期先后排列', () => {
    const options = takenAtOptions([
      at(2026, 9, 6, 8, 0),
      at(2026, 9, 5, 23, 30),
      at(2026, 9, 6, 19, 45),
    ]);
    expect(options.map((option) => option.date)).toEqual(['2026-09-05', '2026-09-06']);
  });

  it('跳过读不到时间的照片，全读不到时返回空数组', () => {
    expect(takenAtOptions([null, undefined, Number.NaN])).toEqual([]);
    expect(takenAtOptions([null, at(2026, 9, 5, 17, 56)])).toHaveLength(1);
  });
});
