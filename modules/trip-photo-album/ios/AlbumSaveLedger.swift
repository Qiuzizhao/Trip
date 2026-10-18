import Foundation

// Accessed only on the module's serial queue. Receipts survive Photos resource renaming,
// iCloud visibility delays, JS reloads, and changes to Trip's source asset timestamps.
final class AlbumSaveLedger {
  private let url: URL
  private var entries: [String: String]

  init(url: URL) {
    self.url = url
    if let data = try? Data(contentsOf: url),
       let saved = try? JSONDecoder().decode([String: String].self, from: data) {
      entries = saved
    } else { entries = [:] }
  }

  var assetIdentifiers: Set<String> { Set(entries.values.filter { $0 != "legacy-receipt" }) }
  var hashes: Set<String> { Set(entries.keys) }
  func contains(_ hash: String) -> Bool { entries[hash] != nil }

  func remember(_ hashes: [String]) throws {
    for hash in hashes where entries[hash] == nil { entries[hash] = "legacy-receipt" }
    try persist()
  }

  func record(_ hash: String, assetIdentifier: String) throws {
    entries[hash] = assetIdentifier
    try persist()
  }

  private func persist() throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(entries).write(to: url, options: .atomic)
  }
}
