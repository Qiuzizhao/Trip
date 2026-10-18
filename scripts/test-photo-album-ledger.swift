// swiftc modules/trip-photo-album/ios/AlbumSaveLedger.swift scripts/test-photo-album-ledger.swift -o /tmp/trip-album-ledger-test
import Foundation

@main
struct AlbumLedgerRegression {
  static func main() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("saved.json")
    let heifHash = String(repeating: "a", count: 64)
    let jpegHash = String(repeating: "b", count: 64)
    let oldReceipt = String(repeating: "c", count: 64)
    let firstLaunch = AlbumSaveLedger(url: url)
    try firstLaunch.record(heifHash, assetIdentifier: "HEIF-PHOTOS-ID/L0/001")
    try firstLaunch.record(jpegHash, assetIdentifier: "JPEG-PHOTOS-ID/L0/001")
    let secondLaunch = AlbumSaveLedger(url: url)
    precondition(secondLaunch.contains(heifHash), "HEIF must stay saved after restart / Photos resource rename")
    precondition(secondLaunch.contains(jpegHash))
    try secondLaunch.remember([oldReceipt, heifHash])
    let persisted = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
    precondition(persisted[heifHash] == "HEIF-PHOTOS-ID/L0/001", "Migrating v1 receipts must preserve native Photos IDs")
    precondition(persisted[oldReceipt] == "legacy-receipt")
    precondition(AlbumSaveLedger(url: url).hashes.count == 3)
    let name = tripPhotoFilename(hash: heifHash, location: "  故宫/午门:\n 北京  ", extension: "heif")
    precondition(name == "故宫 午门 北京_trip-\(heifHash).heif")
    precondition(tripPhotoHash(from: name) == heifHash)
    precondition(tripPhotoHash(from: "trip-\(heifHash).heif") == heifHash)
    precondition(tripPhotoHash(from: "trip-\(heifHash.uppercased()).HEIC") == heifHash)
    precondition(tripPhotoHash(from: "user-original.heif") == nil)
    precondition(tripPhotoFilename(hash: heifHash, location: "", extension: "heif") == "trip-\(heifHash).heif")
    precondition(tripPhotoFilename(hash: heifHash, location: String(repeating: "🏖️故宫", count: 100), extension: "heif").utf8.count < 255)
    try secondLaunch.replaceWithVerifiedAssets([heifHash: "HEIF-PHOTOS-ID/L0/001"])
    let reconciled = AlbumSaveLedger(url: url)
    precondition(reconciled.contains(heifHash))
    precondition(!reconciled.contains(jpegHash) && !reconciled.contains(oldReceipt))
    precondition(reconciled.savedAssets[heifHash] == "HEIF-PHOTOS-ID/L0/001")
    print("PASS: explicit reconciliation retires missing receipts and preserves existing Photos IDs")
    print("PASS: location filename sanitization, size limits, and new/legacy hash recognition")
    print("PASS: native receipts survive restarts, HEIF filename changes, and legacy receipt migration")
  }
}
