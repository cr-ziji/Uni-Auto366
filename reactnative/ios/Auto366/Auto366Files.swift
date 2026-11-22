import Foundation
import UIKit
import UniformTypeIdentifiers

/**
 * iOS 版文件选择 / 保存 / 打开 / 分享，与 Android `Auto366FilesModule` 同一套 JS 协议。
 *
 * iOS 没有 Android 的 Storage Access Framework，等价能力由 `UIDocumentPicker` 提供：
 *
 *  - [pickFiles]：`UIDocumentPickerViewController(forOpeningContentTypes:asCopy:)`
 *    让用户选文件，系统把副本放进临时目录，这里再复制进 `Caches/imports`，
 *    返回普通沙盒路径，让移植过来的 `fs.readFileSync` 能读到；
 *  - [pickSaveTarget]：系统的「新建文稿」对话框在 iOS 不存在，改用**文件夹**
 *    选择器（`forOpeningContentTypes: [.folder]`）拿到用户选定的目录，再把
 *    「目录 + 文件名」作为目标 URI 返回；[writeToUri] 在真正写盘时才用到它，
 *    语义与 Android 的 `ACTION_CREATE_DOCUMENT` 一致（先选位置、后写内容，
 *    用户取消则整条链路都取消）；
 *  - [openFile] / [shareFile]：`UIDocumentInteractionController` 的「用其他
 *    应用打开」菜单与系统分享面板，对应 Android 的 `ACTION_VIEW` 选择器；
 *  - [readFileBase64Sync]：同步读沙盒文件，供 `fs` polyfill 按需取字节，
 *    避免启动时把整个数据目录搬进内存。
 *
 * 证书 / 网络不在这里，见 `Auto366Net.swift`。
 */
@objc(Auto366Files)
final class Auto366Files: NSObject {
  /** 当前挂起的原生选择器（Promise 只能被 settle 一次）。 */
  private enum Pending: Equatable {
    case pick
    case saveTarget
  }

  private let lock = NSLock()
  private var pending: Pending?
  private var pickResolver: RCTPromiseResolveBlock?
  private var pickRejecter: RCTPromiseRejectBlock?
  private var saveResolver: RCTPromiseResolveBlock?
  private var saveRejecter: RCTPromiseRejectBlock?
  private var saveFileName = "file"
  /**
   * [pickSaveTarget] 返回的目标 URI -> 用户选中的目录 URL。
   *
   * `UIDocumentPicker` 给出的 URL 对象上挂着 sandbox extension，重新用字符串拼
   * 一个 URL 去 `startAccessingSecurityScopedResource()` 未必能拿到同一份授权，
   * 所以这里保留原始对象，写完再释放。
   */
  private var saveDirectories: [String: URL] = [:]
  /** `UIDocumentInteractionController` 必须被持有，否则菜单弹出后立刻释放。 */
  private var openController: UIDocumentInteractionController?

  /** 不导出常量、也不碰 UI，可以后台构造。 */
  @objc static func requiresMainQueueSetup() -> Bool {
    false
  }

  // MARK: - 选择文件

  /**
   * 打开系统文件选择器，并把选中的文件复制进 `Caches/imports`。
   *
   * 取消时返回空数组（Android 同样返回空数组），调用方据此判断 `canceled`。
   */
  @objc(pickFiles:resolver:rejecter:)
  func pickFiles(
    _ options: NSDictionary?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let multiple = (options?["multiple"] as? Bool) ?? false
    guard begin(.pick, resolve: resolve, reject: reject) else {
      reject("E_BUSY", "a picker is already open", nil)
      return
    }
    DispatchQueue.main.async {
      guard let presenter = Self.presenter() else {
        self.finishPick(.failure(NSError(
          domain: "Auto366Files",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "the application has no foreground view controller"]
        )))
        return
      }
      // `asCopy: true` 让系统直接给出临时副本，不需要 security-scoped 访问。
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
      picker.allowsMultipleSelection = multiple
      picker.delegate = self
      presenter.present(picker, animated: true)
    }
  }

  // MARK: - 保存文件

  /**
   * 打开文件夹选择器，返回「所选目录 + 建议文件名」的目标 URI。
   *
   * 返回 `nil` 表示用户取消。真正的字节由 [writeToUri] 在打包完成后写入，
   * 因此用户不会得到一个空文件。
   */
  @objc(pickSaveTarget:mimeType:resolver:rejecter:)
  func pickSaveTarget(
    _ fileName: String,
    mimeType: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    let name = Self.sanitize(fileName)
    guard begin(.saveTarget, resolve: resolve, reject: reject) else {
      reject("E_BUSY", "a save dialog is already open", nil)
      return
    }
    lock.lock()
    saveFileName = name
    lock.unlock()
    DispatchQueue.main.async {
      guard let presenter = Self.presenter() else {
        self.finishSave(.failure(NSError(
          domain: "Auto366Files",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "the application has no foreground view controller"]
        )))
        return
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
      picker.delegate = self
      // 默认落在应用自己的文稿目录，用户也能切到「我的 iPhone」其他位置或 iCloud。
      picker.directoryURL = Self.documentsDirectory
      presenter.present(picker, animated: true)
    }
  }

  /**
   * 把 `base64` 写进 [pickSaveTarget] 返回的 URI。
   *
   * 目录是用户通过系统选择器授权的 security-scoped 资源，写之前要显式开始访问，
   * 写完立即释放（iOS 对同时持有的 scope 数量有限制）。
   */
  @objc(writeToUri:base64:resolver:rejecter:)
  func writeToUri(
    _ uri: String,
    base64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      guard let target = URL(string: uri), target.isFileURL else {
        reject("E_WRITE", "not a file uri: \(uri)", nil)
        return
      }
      guard let data = Data(base64Encoded: base64) else {
        reject("E_WRITE", "invalid base64 payload", nil)
        return
      }
      self.lock.lock()
      let picked = self.saveDirectories[uri]
      self.lock.unlock()
      let directory = picked ?? target.deletingLastPathComponent()
      let scoped = directory.startAccessingSecurityScopedResource()
      defer {
        if scoped {
          directory.stopAccessingSecurityScopedResource()
        }
        // 目标只用一次：地址已经写进文件，没必要继续持有授权。
        self.lock.lock()
        self.saveDirectories.removeValue(forKey: uri)
        self.lock.unlock()
      }
      do {
        try data.write(to: target, options: .atomic)
        resolve(true)
      } catch {
        reject("E_WRITE", error.localizedDescription, error)
      }
    }
  }

  /**
   * 把沙盒文件复制到应用文稿目录下的 `Downloads/Auto366`。
   *
   * iOS 没有全局可写的「下载」文件夹，这个目录在 Info.plist 打开
   * `UIFileSharingEnabled` / `LSSupportsOpeningDocumentsInPlace` 后会出现在
   * 「文件」App 的「我的 iPhone / Auto366」里，是平台上最接近的等价物。
   */
  @objc(saveToDownloads:fileName:mimeType:resolver:rejecter:)
  func saveToDownloads(
    _ path: String,
    fileName: String,
    mimeType: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .utility).async {
      let source = URL(fileURLWithPath: path)
      guard FileManager.default.fileExists(atPath: source.path) else {
        reject("ENOENT", "file not found: \(path)", nil)
        return
      }
      do {
        let directory = Self.documentsDirectory
          .appendingPathComponent("Downloads", isDirectory: true)
          .appendingPathComponent("Auto366", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent(Self.sanitize(fileName))
        if FileManager.default.fileExists(atPath: target.path) {
          try FileManager.default.removeItem(at: target)
        }
        try FileManager.default.copyItem(at: source, to: target)
        resolve(target.path)
      } catch {
        reject("E_SAVE", error.localizedDescription, error)
      }
    }
  }

  // MARK: - 打开 / 分享

  /** 「用其他应用打开」：没有应用能处理该类型时 reject，调用方会退到分享面板。 */
  @objc(openFile:mimeType:resolver:rejecter:)
  func openFile(
    _ path: String,
    mimeType: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard FileManager.default.fileExists(atPath: path) else {
        reject("ENOENT", "file not found: \(path)", nil)
        return
      }
      guard let presenter = Self.presenter() else {
        reject("E_OPEN", "the application has no foreground view controller", nil)
        return
      }
      let controller = UIDocumentInteractionController(url: URL(fileURLWithPath: path))
      self.openController = controller
      let anchor = Self.anchor(in: presenter.view)
      if controller.presentOpenInMenu(from: anchor, in: presenter.view, animated: true) {
        resolve(true)
      } else {
        reject("E_OPEN", "no application can open this file", nil)
      }
    }
  }

  /** 系统分享面板。 */
  @objc(shareFile:mimeType:resolver:rejecter:)
  func shareFile(
    _ path: String,
    mimeType: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard FileManager.default.fileExists(atPath: path) else {
        reject("ENOENT", "file not found: \(path)", nil)
        return
      }
      guard let presenter = Self.presenter() else {
        reject("E_SHARE", "the application has no foreground view controller", nil)
        return
      }
      let activity = UIActivityViewController(
        activityItems: [URL(fileURLWithPath: path)],
        applicationActivities: nil
      )
      if let popover = activity.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = Self.anchor(in: presenter.view)
        popover.permittedArrowDirections = []
      }
      presenter.present(activity, animated: true) {
        resolve(true)
      }
    }
  }

  // MARK: - 同步读

  /**
   * 同步读一个沙盒文件，返回 base64（空串表示不存在 / 读不了）。
   *
   * RN 没有同步文件 API，`fs` polyfill 的镜像只能覆盖启动阶段真正用同步 API
   * 的小文件；其余文件在第一次 `readFileSync` 时通过这里按需取，语义与桌面端
   * 一致，启动时也不必把几十 MB 的数据搬过 bridge。
   *
   * 必须返回非 void（RN 的 TurboModule interop 要求「同步 <=> 非 void」）。
   */
  @objc(readFileBase64Sync:)
  func readFileBase64Sync(_ path: String) -> String {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
          !isDirectory.boolValue else {
      return ""
    }
    // `.mappedIfSafe` 让大文件走 mmap，base64 编码前不必先整块读进堆。
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .mappedIfSafe) else {
      return ""
    }
    return data.base64EncodedString()
  }

  // MARK: - Promise 状态

  /** 占住「有选择器打开」的位置；被占用时返回 false。 */
  private func begin(
    _ kind: Pending,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard pending == nil else { return false }
    pending = kind
    switch kind {
    case .pick:
      pickResolver = resolve
      pickRejecter = reject
    case .saveTarget:
      saveResolver = resolve
      saveRejecter = reject
    }
    return true
  }

  private func takePick() -> (RCTPromiseResolveBlock, RCTPromiseRejectBlock)? {
    lock.lock()
    defer { lock.unlock() }
    guard pending == .pick, let resolve = pickResolver, let reject = pickRejecter else {
      return nil
    }
    pending = nil
    pickResolver = nil
    pickRejecter = nil
    return (resolve, reject)
  }

  private func takeSave() -> (RCTPromiseResolveBlock, RCTPromiseRejectBlock)? {
    lock.lock()
    defer { lock.unlock() }
    guard pending == .saveTarget, let resolve = saveResolver, let reject = saveRejecter else {
      return nil
    }
    pending = nil
    saveResolver = nil
    saveRejecter = nil
    return (resolve, reject)
  }

  private func finishPick(_ result: Result<[[String: Any]], Error>) {
    guard let (resolve, reject) = takePick() else { return }
    switch result {
    case .success(let files):
      resolve(files)
    case .failure(let error):
      reject("E_PICK", error.localizedDescription, error)
    }
  }

  private func finishSave(_ result: Result<[String: Any]?, Error>) {
    guard let (resolve, reject) = takeSave() else { return }
    switch result {
    case .success(let target):
      resolve(target)
    case .failure(let error):
      reject("E_SAVE", error.localizedDescription, error)
    }
  }

  private func finishSaveCancelled() {
    guard let (resolve, _) = takeSave() else { return }
    resolve(nil)
  }

  // MARK: - 工具

  private static var documentsDirectory: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  private static func presenter() -> UIViewController? {
    RCTPresentedViewController()
  }

  /** iPad 上的 popover 需要一个锚点矩形。 */
  private static func anchor(in view: UIView) -> CGRect {
    CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
  }

  /** 让文件名可以真正当路径用（与 Android 的 sanitize 保持一致）。 */
  private static func sanitize(_ name: String) -> String {
    let invalid = CharacterSet(charactersIn: "\\/:*?\"<>|")
      .union(.controlCharacters)
    let cleaned = name
      .components(separatedBy: invalid)
      .joined(separator: "_")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if cleaned.isEmpty || cleaned == "." || cleaned == ".." {
      return "file"
    }
    return cleaned
  }

  /** 复制选中的文件到 `Caches/imports`，返回可读写的沙盒路径。 */
  private static func copyIntoCache(_ url: URL, name: String) throws -> URL {
    let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("imports", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let target = directory.appendingPathComponent(sanitize(name))
    if FileManager.default.fileExists(atPath: target.path) {
      try FileManager.default.removeItem(at: target)
    }
    try FileManager.default.copyItem(at: url, to: target)
    return target
  }

  private static func fileSize(_ url: URL) -> Int64 {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
  }
}

// MARK: - UIDocumentPickerDelegate

extension Auto366Files: UIDocumentPickerDelegate {
  func documentPicker(
    _ controller: UIDocumentPickerViewController,
    didPickDocumentsAt urls: [URL]
  ) {
    lock.lock()
    let kind = pending
    let name = saveFileName
    lock.unlock()

    guard let kind = kind, let first = urls.first else {
      finishCancelled()
      return
    }

    switch kind {
    case .saveTarget:
      // 用户选了目录：目标文件 = 目录 + 建议文件名，等 JS 打包完成后写入。
      let target = first.appendingPathComponent(name)
      lock.lock()
      // 只保留最近几个目标，避免用户反复取消留下无限多个 security scope。
      if saveDirectories.count >= 8 {
        saveDirectories.removeAll()
      }
      saveDirectories[target.absoluteString] = first
      lock.unlock()
      finishSave(.success(["uri": target.absoluteString, "name": name]))
    case .pick:
      do {
        let entries = try urls.map { url -> [String: Any] in
          let picked = try Self.copyIntoCache(url, name: url.lastPathComponent)
          return [
            "path": picked.path,
            "name": picked.lastPathComponent,
            "size": Self.fileSize(picked),
            "uri": url.absoluteString,
          ]
        }
        finishPick(.success(entries))
      } catch {
        finishPick(.failure(error))
      }
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finishCancelled()
  }

  private func finishCancelled() {
    lock.lock()
    let kind = pending
    lock.unlock()
    switch kind {
    case .saveTarget:
      finishSaveCancelled()
    case .pick, .none:
      finishPick(.success([]))
    }
  }
}
