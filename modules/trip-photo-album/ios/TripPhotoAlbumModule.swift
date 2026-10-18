import ExpoModulesCore
import Photos
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

public class TripPhotoAlbumModule: Module {
  private let queue = DispatchQueue(label: "com.trip.photo-album", qos: .utility)

  private lazy var ledger = AlbumSaveLedger(url: FileManager.default.urls(for: .applicationSupportDirectory,
    in: .userDomainMask)[0].appendingPathComponent("trip-photo-album/saved.json"))

  private let scanCancellation = AlbumScanCancellation()
  private lazy var duplicateCleaner = AlbumDuplicateCleaner(cancellation: scanCancellation)

  public func definition() -> ModuleDefinition {
    Name("TripPhotoAlbum")
    Events("duplicateScanProgress")
    Function("cancelDuplicateScan") { self.scanCancellation.set(true) }
    AsyncFunction("findDuplicates") { () -> [String: Any] in
      try self.requirePermission()
      return try self.duplicateCleaner.scan(ownedIDs: self.ledger.assetIdentifiers) { scanned, total in
        self.sendEvent("duplicateScanProgress", ["scanned": scanned, "total": total])
      }
    }.runOnQueue(queue)
    AsyncFunction("deleteDuplicates") { (token: String) -> Int in
      try self.requirePermission()
      return try self.duplicateCleaner.remove(token: token)
    }.runOnQueue(queue)

    AsyncFunction("permission") { (request: Bool, promise: Promise) in
      let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
      if request && status == .notDetermined {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { next in
          promise.resolve(self.permissionName(next))
        }
      } else {
        promise.resolve(self.permissionName(status))
      }
    }

    AsyncFunction("rememberSavedHashes") { (hashes: [String]) in
      try self.ledger.remember(hashes.filter { $0.count == 64 && $0.allSatisfy(\.isHexDigit) })
    }.runOnQueue(queue)

    // User-triggered only. Whole-library enumeration requires an explicit option.
    AsyncFunction("reconcileAlbum") { (searchEntireLibrary: Bool) -> [String: Any] in
      try self.requirePermission()
      return try AlbumRestorer().restore(ledger: self.ledger, searchEntireLibrary: searchEntireLibrary)
    }.runOnQueue(queue)

    AsyncFunction("snapshot") { () -> [String] in
      try self.requirePermission()
      var hashes = self.ledger.hashes
      let options = PHFetchOptions()
      options.predicate = NSPredicate(format: "title = %@", "Trip")
      // Same-title albums can exist after iCloud reconciliation. Inspect every matching album.
      PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: options)
        .enumerateObjects { album, _, _ in
          PHAsset.fetchAssets(in: album, options: nil).enumerateObjects { asset, _, _ in
            for resource in PHAssetResource.assetResources(for: asset) {
              let name = resource.originalFilename.lowercased()
              if let hash = tripPhotoHash(from: name) { hashes.insert(hash) }
            }
          }
        }
      try self.ledger.remember(Array(hashes))
      return Array(hashes)
    }.runOnQueue(queue)

    AsyncFunction("hashFile") { (uri: String) -> String in
      let url = try self.fileURL(uri)
      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      var hasher = SHA256()
      // Stream the original file; never decode a full-resolution image or bridge bytes to JS.
      while true {
        let chunk = try autoreleasepool { try handle.read(upToCount: 256 * 1024) }
        guard let chunk = chunk, !chunk.isEmpty else { break }
        hasher.update(data: chunk)
      }
      return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }.runOnQueue(queue)

    AsyncFunction("save") { (uri: String, hash: String, location: String) -> Bool in
      guard hash.count == 64 && hash.allSatisfy(\.isHexDigit) else { throw AlbumError.invalidFile }
      // The native boundary also enforces idempotency. Never rely on a Photos filename
      // being immediately visible (in particular for HEIF/HEIC and iCloud resources).
      if self.ledger.contains(hash) { return true }
      try self.requirePermission()
      let url = try self.fileURL(uri)
      guard let imageSource = CGImageSourceCreateWithURL(url as CFURL,
        [kCGImageSourceShouldCache: false] as CFDictionary),
        let imageType = CGImageSourceGetType(imageSource) else { throw AlbumError.invalidFile }
      let typeIdentifier = imageType as String
      let ext = UTType(typeIdentifier)?.preferredFilenameExtension ?? url.pathExtension
      let existingAlbum = self.findAlbum()
      var identifier: String?
      // Block only this utility queue until commit; concurrent save calls cannot both create.
      try PHPhotoLibrary.shared().performChangesAndWait {
        let asset = PHAssetCreationRequest.forAsset()
        let options = PHAssetResourceCreationOptions()
        options.uniformTypeIdentifier = typeIdentifier
        options.originalFilename = tripPhotoFilename(hash: hash, location: location, extension: ext.isEmpty ? "jpg" : ext)
        asset.addResource(with: .photo, fileURL: url, options: options)
        let albumRequest: PHAssetCollectionChangeRequest?
        if let album = existingAlbum {
          albumRequest = PHAssetCollectionChangeRequest(for: album)
        } else {
          albumRequest = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: "Trip")
        }
        if let placeholder = asset.placeholderForCreatedAsset {
          identifier = placeholder.localIdentifier
          albumRequest?.addAssets([placeholder] as NSArray)
        }
      }
      guard let identifier = identifier else { throw AlbumError.invalidFile }
      // Persist the Photos identifier before acknowledging success to JS.
      try self.ledger.record(hash, assetIdentifier: identifier)
      return true
    }.runOnQueue(queue)
  }

  private func findAlbum() -> PHAssetCollection? {
    let options = PHFetchOptions()
    options.predicate = NSPredicate(format: "title = %@", "Trip")
    return PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: options).firstObject
  }

  private func permissionName(_ status: PHAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .limited: return "limited"
    case .notDetermined: return "undetermined"
    case .restricted: return "restricted"
    default: return "denied"
    }
  }

  private func requirePermission() throws {
    guard PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized else {
      throw AlbumError.permission
    }
  }

  private func fileURL(_ uri: String) throws -> URL {
    guard let url = URL(string: uri), url.isFileURL,
          FileManager.default.fileExists(atPath: url.path) else { throw AlbumError.invalidFile }
    return url
  }
}

private enum AlbumError: LocalizedError {
  case permission, invalidFile
  var errorDescription: String? {
    switch self {
    case .permission: return "请允许 Trip 完整访问照片，以管理 Trip 相簿"
    case .invalidFile: return "原照片文件不可用"
    }
  }
}
