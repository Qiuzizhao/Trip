import { describe, expect, it } from '@jest/globals';

import { isImageBase64Head } from '../imageValidation';

describe('isImageBase64Head', () => {
  it('接受常见图片格式的文件头', () => {
    expect(isImageBase64Head('/9j/4AAQSkZJRgABAQ')).toBe(true); // JPEG
    expect(isImageBase64Head('iVBORw0KGgoAAAANSUhEUg')).toBe(true); // PNG
    expect(isImageBase64Head('R0lGODlhAQABAIAAAA')).toBe(true); // GIF
    expect(isImageBase64Head('UklGRiQAAABXRUJQVlA4')).toBe(true); // WebP
    expect(isImageBase64Head('AAAAIGZ0eXBoZWljAAAAAG1p')).toBe(true); // HEIC (ftyp)
  });

  it('拒绝错误响应体（JSON）与空内容', () => {
    expect(isImageBase64Head('eyJzdGF0dXNDb2RlIjoiNDA0') /* {"statusCode":"404" */).toBe(false);
    expect(isImageBase64Head('<html><body>Not')).toBe(false);
    expect(isImageBase64Head('')).toBe(false);
  });
});
