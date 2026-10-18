import Foundation

struct DuplicatePhotoCandidate {
  let id: String
  let hash: String
  let owned: Bool
  let protected: Bool
  let createdAt: TimeInterval
}
struct DuplicatePhotoGroup {
  let hash: String
  let keep: [String]
  let remove: [String]
}

// Only byte-identical originals can share a group. User-added / protected assets
// are anchors, never deletion candidates. Every group retains at least one asset.
func planDuplicatePhotos(_ candidates: [DuplicatePhotoCandidate]) -> [DuplicatePhotoGroup] {
  Dictionary(grouping: candidates, by: \.hash).compactMap { hash, matches in
    let photos = matches.sorted {
      $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
    }
    guard photos.count > 1 else { return nil }
    var keep = photos.filter { !$0.owned || $0.protected }.map(\.id)
    if keep.isEmpty, let first = photos.first { keep = [first.id] }
    let kept = Set(keep)
    let remove = photos.filter { $0.owned && !$0.protected && !kept.contains($0.id) }.map(\.id)
    guard !remove.isEmpty else { return nil }
    return DuplicatePhotoGroup(hash: hash, keep: keep, remove: remove)
  }.sorted { $0.hash < $1.hash }
}
