import { Image as ExpoImage, type ImageStyle } from 'expo-image';
import React from 'react';
import type { StyleProp } from 'react-native';

import { imageSourceFor } from './imageCache';

/**
 * 足迹图片的小图统一用它加载。
 *
 * 两点约定：
 * 1. 首页列表、相册页、编辑页共用它，保证**三处用的图片地址完全一致**——
 *    地址一致才会命中同一份磁盘缓存，否则会出现「首页看过的图，进详情页又加载一遍」。
 * 2. 直接用**原图地址**，不再让服务端 imgproxy 生成缩略图：imgproxy 解不了
 *    10 位 HDR HEIC（会返回 422 Invalid source image），而缩小本来就由 expo-image
 *    在本地完成（本地模式下一直就是这么显示的）。取舍理由见 docs/footprint-thumbnails.md。
 * 3. 打开 `enforceEarlyResizing`：把控件尺寸告诉解码器，让它**直接解出小图**，
 *    而不是先解出整张 24MP 位图再缩放。实测同一张 5712×4284 的 HDR HEIC：
 *    全尺寸解码 + 缩放约 1073ms / 93MB，直接解缩略图约 126ms / 0.5MB，
 *    两者都保留 HDR（contentHeadroom 2.30）。
 */
export function FootprintThumbnail({
  uri,
  style,
  contentFit = 'cover',
}: {
  /** 原图地址（本地 file:// 或远端 object/public 地址） */
  uri: string;
  style: StyleProp<ImageStyle>;
  contentFit?: 'cover' | 'contain';
}) {
  return (
    <ExpoImage
      cachePolicy="memory-disk"
      contentFit={contentFit}
      enforceEarlyResizing
      priority="high"
      source={imageSourceFor(uri)}
      style={style}
      transition={0}
    />
  );
}
