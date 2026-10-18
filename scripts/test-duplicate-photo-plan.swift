import Foundation

@main
struct DuplicatePhotoPlanRegression {
  static func main() {
    func item(_ id: String, _ hash: String = "heif", owned: Bool = true, protected: Bool = false, time: Double = 0) -> DuplicatePhotoCandidate {
      DuplicatePhotoCandidate(id: id, hash: hash, owned: owned, protected: protected, createdAt: time)
    }
    let sameHEIF = planDuplicatePhotos([item("first", time: 1), item("second", time: 2), item("third", time: 3)])
    precondition(sameHEIF.count == 1 && sameHEIF[0].keep == ["first"] && sameHEIF[0].remove == ["second", "third"])
    let originals = planDuplicatePhotos([item("user-original", owned: false), item("trip-copy-1"), item("trip-copy-2")])
    precondition(originals[0].keep == ["user-original"] && originals[0].remove.count == 2)
    let favorite = planDuplicatePhotos([item("favorite", protected: true), item("duplicate")])
    precondition(favorite[0].keep == ["favorite"] && favorite[0].remove == ["duplicate"])
    precondition(planDuplicatePhotos([item("unknown-a", owned: false), item("unknown-b", owned: false)]).isEmpty)
    precondition(planDuplicatePhotos([item("different-a", "hash-a"), item("different-b", "hash-b")]).isEmpty)
    precondition(planDuplicatePhotos([item("only-one")]).isEmpty)
    let allProtected = planDuplicatePhotos([item("protected-a", protected: true), item("protected-b", protected: true)])
    precondition(allProtected.isEmpty)
    print("PASS: exact HEIF grouping, retain one, preserve user originals/favorites, skip unknown sources and different content")
  }
}
