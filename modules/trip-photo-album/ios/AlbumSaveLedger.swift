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

  var savedAssets: [String: String] { entries.filter { $0.value != "legacy-receipt" } }
  // Only explicit Photos reconciliation may retire historical receipts.
  func replaceWithVerifiedAssets(_ verified: [String: String], retainingUnverified: Set<String> = []) throws {
    var next = verified
    for hash in retainingUnverified where next[hash] == nil { next[hash] = entries[hash] }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(next).write(to: url, options: .atomic)
    entries = next
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

// Location is descriptive only; the embedded content hash remains the identity.
func tripPhotoFilename(hash: String, location: String, extension ext: String) -> String {
  let forbidden = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\:*?\"<>|"))
  let cleaned = location.components(separatedBy: forbidden).joined(separator: " ")
    .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  var place = ""
  for character in cleaned {
    if place.utf8.count + String(character).utf8.count > 120 { break }
    place.append(character)
  }
  return "\(place.isEmpty ? "" : place + "_")trip-\(hash).\(ext)"
}

func tripPhotoHash(from filename: String) -> String? {
  let pattern = #"(?:^|_)trip-([a-f0-9]{64})\.[^.]+$"#
  guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
    let match = regex.firstMatch(in: filename, range: NSRange(filename.startIndex..., in: filename)),
    let range = Range(match.range(at: 1), in: filename) else { return nil }
  return String(filename[range]).lowercased()
}
