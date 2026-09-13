// 读取照片的拍摄时间（EXIF）。
//
// 为什么用 exifreader 而不是 exifr：iPhone 的 **HDR 照片**（HEIC，ftyp brand 为 MiHB/MiHA）
// exifr 会报 "Unknown file format"，exifreader 能正常解析（实测同一批文件）。
// 另外 exifreader 支持 HEIC/HEIF/JPEG/PNG 等多种容器。
import ExifReader from 'exifreader';

/** 把 EXIF 的 "2026:09:05 17:56:07" + "+08:00" 解析成毫秒时间戳；解析失败返回 null */
export function parseExifDateTime(dateTime?: string | null, offset?: string | null): number | null {
  if (!dateTime) return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(dateTime).trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const timezone = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : null;
  // 没有时区信息时按设备本地时间处理（EXIF 本身不带时区）
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${timezone ?? ''}`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

type ExifTags = {
  exif?: Record<string, { description?: string } | undefined>;
  tiff?: Record<string, { description?: string } | undefined>;
};

/**
 * 从图片字节里读拍摄时间；没有 EXIF 或解析失败返回 null。
 * 按优先级取：ExifIFD 的 DateTimeOriginal → DateTimeDigitized → IFD0 的 DateTime。
 * （iPhone 照片三种都有且一致；只带 IFD0 DateTime 的图也能显示。）
 */
export function readTakenAtFromBytes(buffer: ArrayBuffer): number | null {
  try {
    const tags = ExifReader.load(buffer, { expanded: true }) as unknown as ExifTags;
    const exif = tags.exif ?? {};
    const tiff = tags.tiff ?? {};
    const candidates: Array<[string | null | undefined, string | null | undefined]> = [
      [exif.DateTimeOriginal?.description, exif.OffsetTimeOriginal?.description ?? exif.OffsetTime?.description],
      [exif.DateTimeDigitized?.description, exif.OffsetTimeDigitized?.description ?? exif.OffsetTime?.description],
      [exif.CreateDate?.description, exif.OffsetTime?.description],
      [exif.DateTime?.description, null],
      [tiff.DateTime?.description, null],
    ];

    for (const [dateTime, offset] of candidates) {
      const parsed = parseExifDateTime(dateTime, offset);
      if (parsed !== null) return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 读本地文件字节。
 * 主路径用 expo-file-system 的 File.arrayBuffer()（原生读文件，稳定）；
 * 失败时退回 fetch(uri)（远端 http 图或沙盒差异时兜底）。
 */
async function readImageBytes(uri: string): Promise<ArrayBuffer | null> {
  if (uri.startsWith('file://')) {
    try {
      const { File } = await import('expo-file-system');
      const buffer = await new File(uri).arrayBuffer();
      if (buffer?.byteLength) return buffer;
    } catch {
      // 落到 fetch 兜底
    }
  }

  try {
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();
    return buffer?.byteLength ? buffer : null;
  } catch {
    return null;
  }
}

/** 从本地文件读拍摄时间（只读元数据，不上传、不落盘） */
export async function readTakenAtFromFile(uri: string): Promise<number | null> {
  const buffer = await readImageBytes(uri);
  if (!buffer) return null;
  return readTakenAtFromBytes(buffer);
}

/** 展示用格式：2026年9月5日 17:56 */
export function formatTakenAt(takenAt?: number | null) {
  if (!takenAt) return null;
  const date = new Date(takenAt);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 毫秒时间戳 → 表单用的本地日期字符串（YYYY-MM-DD）。
 * 和 `today()` / `visit_date` 同格式；刻意不走 toISOString——那是 UTC，东八区凌晨的照片会掉到前一天。
 */
export function dateStringFromTakenAt(takenAt: number): string {
  const date = new Date(takenAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 气泡文案用的本地日期：2026年9月5日 */
export function formatTakenDate(takenAt: number): string {
  const date = new Date(takenAt);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export type TakenAtOption = {
  /** 这一天最早一张的毫秒时间戳，用于排序 */
  takenAt: number;
  /** 可直接写入 visit_date 的 YYYY-MM-DD */
  date: string;
  /** 气泡文案，如 2026年9月5日 */
  label: string;
};

/**
 * 把一组照片的拍摄时间整理成可点选的候选：
 * 读不到时间的丢掉、**按日期去重**（同一天的照片只留一个气泡）、按日期先后排序。
 */
export function takenAtOptions(times: Array<number | null | undefined>): TakenAtOption[] {
  const unique = new Map<string, TakenAtOption>();
  for (const takenAt of times) {
    if (typeof takenAt !== 'number' || !Number.isFinite(takenAt)) continue;
    const date = dateStringFromTakenAt(takenAt);
    const existing = unique.get(date);
    // 同一天只保留一个气泡，取当天最早的那张作为排序依据
    if (existing) {
      if (takenAt < existing.takenAt) existing.takenAt = takenAt;
      continue;
    }
    unique.set(date, { takenAt, date, label: formatTakenDate(takenAt) });
  }
  return Array.from(unique.values()).sort((a, b) => a.takenAt - b.takenAt);
}
