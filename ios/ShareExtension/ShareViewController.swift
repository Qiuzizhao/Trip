import UIKit
import UniformTypeIdentifiers

// Images are copied sequentially, preserving selection order and original EXIF/HEIC data.
class ShareViewController: UIViewController {
  private let groupIdentifier = "group.com.qiuzizhao.tripfootprints"
  private let scheme = "tripfootprints"
  private var started = false

  private struct SharedImage: Codable {
    let path: String
    let fileName: String
    let mimeType: String
    let type = 0
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    Task { @MainActor in
      var copied: [URL] = []
      do {
        let attachments = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
          .flatMap { $0.attachments ?? [] }
          .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        guard !attachments.isEmpty,
          let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupIdentifier),
          let defaults = UserDefaults(suiteName: groupIdentifier)
        else { throw ShareError.unavailable }
        let inbox = container.appendingPathComponent("TripSharedPhotos", isDirectory: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        var images: [SharedImage] = []
        for attachment in attachments {
          let url = try await copyImage(attachment, into: inbox)
          copied.append(url)
          images.append(SharedImage(path: url.absoluteString, fileName: url.lastPathComponent,
            mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/jpeg"))
        }
        defaults.set(try JSONEncoder().encode(images), forKey: "\(scheme)ShareKey")
        defaults.synchronize()
        openTrip()
      } catch {
        for url in copied { try? FileManager.default.removeItem(at: url) }
        let alert = UIAlertController(title: "分享照片失败", message: "照片未能完整导入，请返回相册重试。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in
          self.extensionContext?.cancelRequest(withError: error)
        })
        present(alert, animated: true)
      }
    }
  }

  private func copyImage(_ provider: NSItemProvider, into container: URL) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      // The provider's temporary URL only lives during this callback; copy it here.
      provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { source, error in
        guard let source else {
          continuation.resume(throwing: error ?? ShareError.unavailable)
          return
        }
        do {
          let ext = source.pathExtension.isEmpty ? "jpg" : source.pathExtension
          let destination = container.appendingPathComponent("\(UUID().uuidString).\(ext)")
          try FileManager.default.copyItem(at: source, to: destination)
          continuation.resume(returning: destination)
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  private func openTrip() {
    guard let url = URL(string: "\(scheme)://dataUrl=\(scheme)ShareKey#media") else { return }
    var responder: UIResponder? = self
    while let current = responder {
      if let application = current as? UIApplication {
        application.open(url, options: [:]) { opened in
          if opened {
            self.extensionContext?.completeRequest(returningItems: [])
          } else {
            self.showOpenError()
          }
        }
        return
      }
      responder = current.next
    }
    showOpenError()
  }

  private func showOpenError() {
    let alert = UIAlertController(title: "无法打开 Trip", message: "请返回相册重新分享。", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "好", style: .default) { _ in
      self.extensionContext?.cancelRequest(withError: ShareError.unavailable)
    })
    present(alert, animated: true)
  }

  private enum ShareError: Error { case unavailable }
}
