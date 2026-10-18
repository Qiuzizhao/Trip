import ExpoModulesCore
import Photos
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

public class TripPhotoAlbumModule: Module {
  private let queue = DispatchQueue(label: "com.trip.photo-album", qos: .utility)

  public func definition() -> ModuleDefinition {
    Name("TripPhotoAlbum")

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

    AsyncFunction("snapshot") { () -> [String] in
      try self.requirePermission()
      guard let album = self.findAlbum() else { return [] }
      var hashes = Set<String>()
      PHAsset.fetchAssets(in: album, options: nil).enumerateObjects { asset, _, _ in
        for resource in PHAssetResource.assetResources(for: asset) {
          let name = resource.originalFilename
          if name.hasPrefix("trip-") {
            let hash = String(name.dropFirst(5).split(separator: ".").first ?? "")
            if hash.count == 64 { hashes.insert(hash) }
          }
        }
      }
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

    AsyncFunction("save") { (uri: String, hash: String, promise: Promise) in
      do {
        try self.requirePermission()
        let url = try self.fileURL(uri)
        guard hash.count == 64 && hash.allSatisfy({ $0.isHexDigit }) else {
          throw AlbumError.invalidFile
        }
        // Remote object URLs can omit the extension. Read the file header, without decoding pixels.
        guard let imageSource = CGImageSourceCreateWithURL(url as CFURL,
          [kCGImageSourceShouldCache: false] as CFDictionary),
          let imageType = CGImageSourceGetType(imageSource) else { throw AlbumError.invalidFile }
        let typeIdentifier = imageType as String
        let ext = UTType(typeIdentifier)?.preferredFilenameExtension ?? url.pathExtension
        let existingAlbum = self.findAlbum()
        PHPhotoLibrary.shared().performChanges({
          let asset = PHAssetCreationRequest.forAsset()
          let options = PHAssetResourceCreationOptions()
          options.uniformTypeIdentifier = typeIdentifier
          options.originalFilename = "trip-\(hash).\(ext.isEmpty ? "jpg" : ext)"
          asset.addResource(with: .photo, fileURL: url, options: options)
          // Album + photo insertion is a single Photos transaction, including first creation.
          let albumRequest: PHAssetCollectionChangeRequest?
          if let album = existingAlbum {
            albumRequest = PHAssetCollectionChangeRequest(for: album)
          } else {
            albumRequest = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: "Trip")
          }
          if let placeholder = asset.placeholderForCreatedAsset {
            albumRequest?.addAssets([placeholder] as NSArray)
          }
        }) { success, error in
          if success { promise.resolve(true) }
          else { promise.reject("ERR_PHOTO_ALBUM", error?.localizedDescription ?? "无法保存照片") }
        }
      } catch {
        promise.reject("ERR_PHOTO_ALBUM", error.localizedDescription)
      }
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
