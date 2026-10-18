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
    print("PASS: native receipts survive restarts, HEIF filename changes, and legacy receipt migration")
  }
}
