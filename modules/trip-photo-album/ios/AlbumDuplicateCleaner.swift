import Foundation
import Photos
import CryptoKit
import UIKit
import ImageIO

final class AlbumScanCancellation {
  private let lock = NSLock()
  private var value = false
  func set(_ next: Bool) { lock.lock(); value = next; lock.unlock() }
  var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

final class AlbumDuplicateCleaner {
  private struct Plan {
    let token: String
    let groups: [DuplicatePhotoGroup]
    let dates: [String: Date]
    let createdAt: Date
  }
  private var plan: Plan?
  private let cancellation: AlbumScanCancellation
  init(cancellation: AlbumScanCancellation) { self.cancellation = cancellation }

  func scan(ownedIDs: Set<String>, progress: (Int, Int) -> Void) throws -> [String: Any] {
    plan = nil
    cancellation.set(false)
    let photos = tripPhotos()
    var candidates: [DuplicatePhotoCandidate] = []
    var dates: [String: Date] = [:]
    var skipped = 0
    for (index, photo) in photos.enumerated() {
      if cancellation.cancelled { throw CleanupError.cancelled }
      do {
        try autoreleasepool {
          guard photo.mediaType == .image, !photo.mediaSubtypes.contains(.photoLive),
                photo.sourceType.contains(.typeUserLibrary),
                let resource = PHAssetResource.assetResources(for: photo).first(where: { $0.type == .photo }) else {
            skipped += 1
            return
          }
          let resources = PHAssetResource.assetResources(for: photo)
          guard !photo.isHidden, !resources.contains(where: { $0.type == .adjustmentData }) else {
            skipped += 1
            return
          }
          let hash = try resourceHash(resource)
          let name = resource.originalFilename.lowercased()
          let taggedHash = tripPhotoHash(from: name)
          let owned = ownedIDs.contains(photo.localIdentifier) || taggedHash == hash
          let protected = photo.isFavorite || photo.isHidden || !photo.canPerform(.delete)
            || resources.contains(where: { $0.type == .adjustmentData })
          candidates.append(DuplicatePhotoCandidate(id: photo.localIdentifier, hash: hash,
            owned: owned, protected: protected, createdAt: photo.creationDate?.timeIntervalSince1970 ?? 0))
          dates[photo.localIdentifier] = photo.modificationDate ?? Date.distantPast
        }
      } catch { skipped += 1 }
      progress(index + 1, photos.count)
    }
    if cancellation.cancelled { throw CleanupError.cancelled }
    let groups = planDuplicatePhotos(candidates)
    let token = UUID().uuidString
    var reviewedGroups: [DuplicatePhotoGroup] = []
    var previews: [[String: Any]] = []
    for group in groups {
      if cancellation.cancelled { throw CleanupError.cancelled }
      guard let id = group.keep.first, let asset = photos.first(where: { $0.localIdentifier == id }),
            let uri = thumbnail(asset, token: token, hash: group.hash) else {
        skipped += group.keep.count + group.remove.count
        continue
      }
      reviewedGroups.append(group)
      previews.append(["id": group.hash, "copies": group.keep.count + group.remove.count,
        "keepCount": group.keep.count, "removeCount": group.remove.count, "thumbnailUri": uri])
    }
    plan = Plan(token: token, groups: reviewedGroups, dates: dates, createdAt: Date())
    return ["token": token, "groups": previews, "scanned": photos.count, "skipped": skipped,
      "removeCount": reviewedGroups.reduce(0) { $0 + $1.remove.count }]
  }

  func remove(token: String) throws -> Int {
    guard let plan = plan, plan.token == token, Date().timeIntervalSince(plan.createdAt) < 300 else {
      throw CleanupError.changed
    }
    let current = Dictionary(uniqueKeysWithValues: tripPhotos().map { ($0.localIdentifier, $0) })
    var deletions: [PHAsset] = []
    for group in plan.groups {
      // Every retained and deleted member must still be present and unchanged.
      for id in group.keep + group.remove {
        guard let asset = current[id], (asset.modificationDate ?? Date.distantPast) == plan.dates[id] else {
          throw CleanupError.changed
        }
      }
      for id in group.remove {
        guard let asset = current[id], !asset.isFavorite, !asset.isHidden, asset.canPerform(.delete),
              !PHAssetResource.assetResources(for: asset).contains(where: { $0.type == .adjustmentData }) else {
          throw CleanupError.changed
        }
        deletions.append(asset)
      }
    }
    guard !deletions.isEmpty else { return 0 }
    // Only this explicit, confirmed call mutates Photos. iOS presents its own deletion prompt.
    try PHPhotoLibrary.shared().performChangesAndWait {
      PHAssetChangeRequest.deleteAssets(deletions as NSArray)
    }
    self.plan = nil
    return deletions.count
  }

  private func tripPhotos() -> [PHAsset] {
    let options = PHFetchOptions()
    options.predicate = NSPredicate(format: "title = %@", "Trip")
    var assets: [String: PHAsset] = [:]
    PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: options)
      .enumerateObjects { album, _, _ in
        PHAsset.fetchAssets(in: album, options: nil).enumerateObjects { asset, _, _ in
          assets[asset.localIdentifier] = asset
        }
      }
    return assets.values.sorted { $0.localIdentifier < $1.localIdentifier }
  }

  private func resourceHash(_ resource: PHAssetResource) throws -> String {
    let completed = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var hasher = SHA256()
    var failure: Error?
    let options = PHAssetResourceRequestOptions()
    // Skip originals not available locally; never guess based on a thumbnail or filename.
    options.isNetworkAccessAllowed = false
    let manager = PHAssetResourceManager.default()
    let request = manager.requestData(for: resource, options: options, dataReceivedHandler: { data in
      lock.lock(); hasher.update(data: data); lock.unlock()
    }, completionHandler: { error in
      lock.lock(); failure = error; lock.unlock(); completed.signal()
    })
    guard completed.wait(timeout: .now() + 20) == .success else {
      manager.cancelDataRequest(request)
      throw CleanupError.unavailable
    }
    lock.lock(); defer { lock.unlock() }
    if let failure = failure { throw failure }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func thumbnail(_ asset: PHAsset, token: String, hash: String) -> String? {
    guard let resource = PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo }) else { return nil }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("trip-duplicate-previews/\(token)")
    let original = directory.appendingPathComponent("original.dat")
    defer { try? FileManager.default.removeItem(at: original) }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let completed = DispatchSemaphore(value: 0)
      let options = PHAssetResourceRequestOptions()
      options.isNetworkAccessAllowed = false
      var failure: Error?
      PHAssetResourceManager.default().writeData(for: resource, toFile: original, options: options) { error in
        failure = error
        completed.signal()
      }
      guard completed.wait(timeout: .now() + 20) == .success, failure == nil,
        let source = CGImageSourceCreateWithURL(original as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
        let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 180,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary),
        let data = UIImage(cgImage: image).jpegData(compressionQuality: 0.7) else { return nil }
      let url = directory.appendingPathComponent("\(hash).jpg")
      try data.write(to: url, options: .atomic)
      return url.absoluteString
    } catch { return nil }
  }

}

private enum CleanupError: LocalizedError {
  case changed, cancelled, unavailable
  var errorDescription: String? {
    switch self {
    case .changed: return "照片已变化或预览已过期，请重新扫描后确认"
    case .cancelled: return "扫描已取消"
    case .unavailable: return "原照片暂时不可读取，已跳过"
    }
  }
}
