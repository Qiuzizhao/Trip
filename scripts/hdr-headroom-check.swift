#!/usr/bin/env swift
// iOS 照片 HDR 余量检测（macOS 侧跑，不需要真机）
//
// 用法：xcrun swift scripts/hdr-headroom-check.swift <照片.heic>
//
// 作用：判断一张图是不是真 HDR，以及各条解码/重绘路径还能不能保住 HDR。
//   contentHeadroom > 1.0 才有 XDR 余量；等于 1.0 表示已经被压回 SDR。
// 对应文档：docs/ios-hdr-patch.md
//
// 注意：模拟器没有 XDR 屏，那里读到的 contentHeadroom 不可信，只能用这个脚本或真机判断。

import Foundation
import ImageIO
import CoreGraphics

guard CommandLine.arguments.count > 1 else {
  print("用法：xcrun swift scripts/hdr-headroom-check.swift <照片.heic>")
  exit(1)
}

let path = CommandLine.arguments[1]
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else {
  print("打不开这个文件：\(path)")
  exit(1)
}

func headroom(_ image: CGImage) -> String {
  // CGImage.contentHeadroom 在 macOS 15.1+ 才有
  if #available(macOS 15.1, *) {
    return String(format: "%.4f", image.contentHeadroom)
  }
  return "n/a"
}

func describe(_ image: CGImage) -> String {
  let space = (image.colorSpace?.name as String?) ?? "nil"
  return "\(image.width)x\(image.height) bpc=\(image.bitsPerComponent) headroom=\(headroom(image)) space=\(space)"
}

// 1. 源文件自带的 HDR 余量
let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
let sourceHeadroom = properties["Headroom" as CFString] ?? "nil"
print("源文件             : Headroom=\(sourceHeadroom)")

// 2. 两条解码路径：SDR（老构建走的）与 HDR（补丁后走的）
for decodeToHDR in [false, true] {
  var options: [CFString: Any] = [kCGImageSourceShouldCache: false]
  options[kCGImageSourceDecodeRequest] = decodeToHDR ? kCGImageSourceDecodeToHDR : kCGImageSourceDecodeToSDR
  guard let image = CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary) else {
    print("\(decodeToHDR ? "HDR" : "SDR") 解码          : 失败")
    continue
  }
  print("\(decodeToHDR ? "HDR" : "SDR") 解码          : \(describe(image))")
}

// 3. ImageIO 缩略图解码（预览大图现在走这条路，见 enforceEarlyResizing）
var thumbnailOptions: [CFString: Any] = [
  kCGImageSourceShouldCache: false,
  kCGImageSourceDecodeRequest: kCGImageSourceDecodeToHDR,
  kCGImageSourceCreateThumbnailFromImageAlways: true,
  kCGImageSourceCreateThumbnailWithTransform: true,
  kCGImageSourceThumbnailMaxPixelSize: 1179
]
if let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) {
  print("ImageIO 缩略图解码  : \(describe(thumbnail))")
} else {
  print("ImageIO 缩略图解码  : 失败")
}

// 4. 用 8-bit sRGB 上下文重绘（等价于没设扩展色域的 UIGraphicsImageRenderer）
guard let full = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
      let sRGB = CGColorSpace(name: CGColorSpace.sRGB) else {
  print("8bit sRGB 重绘      : 跳过（解码失败或没有 sRGB 色彩空间）")
  exit(0)
}
let width = 1179
let height = Int(Double(width) * Double(full.height) / Double(full.width))
if let context = CGContext(
  data: nil,
  width: width,
  height: height,
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: sRGB,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) {
  context.interpolationQuality = .high
  context.draw(full, in: CGRect(x: 0, y: 0, width: width, height: height))
  if let redrawn = context.makeImage() {
    print("8bit sRGB 重绘      : \(describe(redrawn))")
  }
}
