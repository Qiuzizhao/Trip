import Foundation
import Photos

// This operation is only invoked by the explicit Settings repair action.
final class AlbumRestorer {
  func restore(ledger: AlbumSaveLedger) throws -> [String] {
    let saved = ledger.savedAssets
    let savedByID = Dictionary(grouping: saved.keys, by: { saved[$0]! })
    var verified: [String: String] = [:]
    var photosByID: [String: PHAsset] = [:]
    let libraryOptions = PHFetchOptions()
    libraryOptions.includeHiddenAssets = true
    libraryOptions.includeAllBurstAssets = true
    PHAsset.fetchAssets(with: .image, options: libraryOptions).enumerateObjects { asset, _, _ in
      autoreleasepool {
        // PHAsset identifiers survive album deletion and resource filename changes.
        var hashes = Set(savedByID[asset.localIdentifier] ?? [])
        for resource in PHAssetResource.assetResources(for: asset) where resource.type == .photo {
          if let hash = tripPhotoHash(from: resource.originalFilename) { hashes.insert(hash) }
        }
        if !hashes.isEmpty {
          photosByID[asset.localIdentifier] = asset
          for hash in hashes where verified[hash] == nil { verified[hash] = asset.localIdentifier }
        }
      }
    }
    let existing = findAlbum()
    var members = Set<String>()
    if let existing = existing {
      PHAsset.fetchAssets(in: existing, options: nil).enumerateObjects { asset, _, _ in members.insert(asset.localIdentifier) }
    }
    let missing = Set(verified.values).subtracting(members).compactMap { photosByID[$0] }
    if !missing.isEmpty {
      try PHPhotoLibrary.shared().performChangesAndWait {
        let request = existing.flatMap { PHAssetCollectionChangeRequest(for: $0) }
          ?? PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: "Trip")
        request.addAssets(missing as NSArray)
      }
    }
    // Keep this after the Photos transaction. Ordinary background sync never resets receipts.
    try ledger.replaceWithVerifiedAssets(verified)
    return Array(verified.keys)
  }

  private func findAlbum() -> PHAssetCollection? {
    let options = PHFetchOptions()
    options.predicate = NSPredicate(format: "title = %@", "Trip")
    return PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: options).firstObject
  }
}
