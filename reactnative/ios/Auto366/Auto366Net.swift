import Foundation
import Network
import Security

/**
 * 原生 TCP / TLS 传输层（iOS）。
 *
 * 与 Android `Auto366NetModule` 保持同一套 JS 协议：
 *
 *  - `listen()`：NWListener 监听普通 TCP；传入 `tlsResource` 时额外在
 *    127.0.0.1 上启动一个 Network.framework TLS 监听，供 CONNECT 中间人使用；
 *  - `tunnel()`：把客户端连接桥接到本机 TLS 监听（HTTPS 解密）或目标主机
 *    （盲隧道），字节搬运全部在原生层；
 *  - `connect()`：普通 / TLS 客户端连接，使用系统信任库并发送 SNI。
 *
 * 证书从 App bundle 的 `auto366_mitm.p12` 读取，私钥不经过 JS。
 */
@objc(Auto366Net)
final class Auto366Net: RCTEventEmitter {
  /// 与 Android 的 `DEFAULT_CONNECT_TIMEOUT` 一致。
  private static let connectTimeoutMs = 15_000

  private let lock = NSRecursiveLock()
  private var servers: [String: NetServer] = [:]
  private var connections: [String: NetConnection] = [:]
  private let ioQueue = DispatchQueue(label: "com.auto366.net.io", attributes: .concurrent)
  private let stateQueue = DispatchQueue(label: "com.auto366.net.state")
  private var sequence: UInt64 = 0

  /**
   * TCP 选项：始终开 `noDelay`。
   *
   * Android 的每个 socket 都设了 `tcpNoDelay = true`；代理转发的是大量小报文
   * （HTTP 头、分片响应体），Nagle 会让它们多等一个 RTT。Network.framework
   * 的选项在创建连接时确定，所以这里统一在参数里打开，`setNoDelay` 只保留接口。
   */
  fileprivate static func tcpOptions() -> NWProtocolTCP.Options {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    return tcp
  }

  override class func requiresMainQueueSetup() -> Bool {
    false
  }

  override func supportedEvents() -> [String]! {
    [
      "Auto366Net.connection",
      "Auto366Net.data",
      "Auto366Net.close",
      "Auto366Net.error",
      "Auto366Net.timeout",
      "Auto366Net.serverError",
    ]
  }

  override func startObserving() {}

  override func stopObserving() {}

  private func nextSocketId() -> String {
    sequence += 1
    return "sock-\(Int(Date().timeIntervalSince1970 * 1000))-\(sequence)"
  }

  private func store(server: NetServer, id: String) {
    lock.lock()
    let previous = servers[id]
    servers[id] = server
    lock.unlock()
    // 关闭会在锁外进行：`close()` 会回收该服务端的连接并发 `close` 事件，
    // 不希望在持有模块锁时做这些事。
    previous?.close()
  }

  private func remove(serverId: String) -> NetServer? {
    lock.lock()
    defer { lock.unlock() }
    return servers.removeValue(forKey: serverId)
  }

  private func store(connection: NetConnection) {
    lock.lock()
    connections[connection.id] = connection
    lock.unlock()
  }

  private func remove(connectionId: String) -> NetConnection? {
    lock.lock()
    defer { lock.unlock() }
    return connections.removeValue(forKey: connectionId)
  }

  private func connection(id: String) -> NetConnection? {
    lock.lock()
    defer { lock.unlock() }
    return connections[id]
  }

  private func server(id: String) -> NetServer? {
    lock.lock()
    defer { lock.unlock() }
    return servers[id]
  }

  private func withConnections(_ body: (NetConnection) -> Void) {
    lock.lock()
    let snapshot = Array(connections.values)
    lock.unlock()
    snapshot.forEach(body)
  }

  // MARK: - React Native methods

  @objc(listen:host:port:tlsResource:tlsPassword:resolver:rejecter:)
  func listen(
    _ serverId: String,
    host: String,
    port: NSNumber,
    tlsResource: String?,
    tlsPassword: String?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    ioQueue.async { [weak self] in
      guard let self = self else { return }
      let result = NetServer(
        id: serverId,
        host: host,
        port: UInt16(truncating: port),
        tlsResource: tlsResource,
        tlsPassword: tlsPassword,
        module: self
      )
      self.store(server: result, id: serverId)
      result.start { outcome in
        switch outcome {
        case .success(let payload):
          resolve(payload)
        case .failure(let error):
          self.remove(serverId: serverId)?.close()
          reject("ELISTEN", error.localizedDescription, error)
        }
      }
    }
  }

  @objc(closeServer:resolver:rejecter:)
  func closeServer(
    _ serverId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    ioQueue.async { [weak self] in
      self?.remove(serverId: serverId)?.close()
      resolve(nil)
    }
  }

  @objc(connect:host:port:tls:servername:timeoutMs:resolver:rejecter:)
  func connect(
    _ socketId: String,
    host: String,
    port: NSNumber,
    tls: Bool,
    servername: String?,
    timeoutMs: NSNumber,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let nwPort = NWEndpoint.Port(rawValue: UInt16(truncating: port)) else {
      reject("ECONNECT", "invalid port \(port)", nil)
      return
    }
    let parameters: NWParameters
    if tls {
      let tlsOptions = NWProtocolTLS.Options()
      let serverName = (servername?.isEmpty == false ? servername! : host)
      serverName.withCString { pointer in
        sec_protocol_options_set_tls_server_name(
          tlsOptions.securityProtocolOptions,
          pointer
        )
      }
      sec_protocol_options_set_min_tls_protocol_version(tlsOptions.securityProtocolOptions, .TLSv12)
      parameters = NWParameters(tls: tlsOptions, tcp: Self.tcpOptions())
    } else {
      parameters = NWParameters(tls: nil, tcp: Self.tcpOptions())
    }
    let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: nwPort)
    let nw = NWConnection(to: endpoint, using: parameters)
    let handle = NetConnection(
      id: socketId,
      serverId: "",
      connection: nw,
      isSSL: tls,
      module: self
    )
    store(connection: handle)

    let settled = NSLock()
    var finished = false
    let settle: () -> Bool = {
      settled.lock()
      defer { settled.unlock() }
      if finished { return false }
      finished = true
      return true
    }

    let timeout = timeoutMs.intValue > 0 ? timeoutMs.intValue : 15_000
    let timeoutItem = DispatchWorkItem { [weak self] in
      guard settle() else { return }
      nw.stateUpdateHandler = nil
      nw.cancel()
      _ = self?.remove(connectionId: socketId)
      reject("ETIMEDOUT", "connect timed out after \(timeout) ms", nil)
    }

    nw.stateUpdateHandler = { [weak self] state in
      guard let self = self else { return }
      switch state {
      case .ready:
        if settle() {
          timeoutItem.cancel()
          nw.stateUpdateHandler = nil
          resolve(nil)
        }
      case .failed(let error):
        if settle() {
          timeoutItem.cancel()
          nw.stateUpdateHandler = nil
          _ = self.remove(connectionId: socketId)
          reject("ECONNECT", error.localizedDescription, error)
        }
      case .waiting(let error):
        // 等待网络时先不失败；连接超时由下面的 DispatchWorkItem 处理。
        NSLog("[Auto366Net] connect waiting: \(error.localizedDescription)")
      case .cancelled:
        if settle() {
          timeoutItem.cancel()
          _ = self.remove(connectionId: socketId)
          reject("ECONNECT", "connection cancelled", nil)
        }
      default:
        break
      }
    }
    ioQueue.asyncAfter(deadline: .now() + .milliseconds(timeout), execute: timeoutItem)
    nw.start(queue: ioQueue)
  }

  @objc(resume:resolver:rejecter:)
  func resume(
    _ socketId: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let handle = connection(id: socketId) else {
      reject("ENOSOCKET", "unknown socket: \(socketId)", nil)
      return
    }
    handle.resume()
    resolve(nil)
  }

  @objc(suspend:)
  func suspend(_ socketId: String) {
    connection(id: socketId)?.suspendForTunnel()
  }

  @objc(write:data:)
  func write(_ socketId: String, data base64: String) {
    guard let handle = connection(id: socketId) else { return }
    guard let data = Data(base64Encoded: base64) else { return }
    handle.write(data)
  }

  @objc(write:data:resolver:rejecter:)
  func writeAsync(
    _ socketId: String,
    data base64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let handle = connection(id: socketId) else {
      reject("ENOSOCKET", "unknown socket: \(socketId)", nil)
      return
    }
    guard let data = Data(base64Encoded: base64) else {
      reject("EWRITE", "invalid base64 payload", nil)
      return
    }
    handle.writeAsync(data) { error in
      if let error = error {
        reject("EWRITE", error.localizedDescription, error)
      } else {
        resolve(nil)
      }
    }
  }

  @objc(shutdown:)
  func shutdown(_ socketId: String) {
    connection(id: socketId)?.shutdown()
  }

  @objc(close:)
  func close(_ socketId: String) {
    remove(connectionId: socketId)?.close()
  }

  @objc(setTimeout:milliseconds:)
  func setTimeout(_ socketId: String, milliseconds: NSNumber) {
    connection(id: socketId)?.setTimeout(milliseconds.intValue)
  }

  @objc(setNoDelay:value:)
  func setNoDelay(_ socketId: String, value: Bool) {
    // Network.framework 的 TCP 选项在创建连接时确定，之后改不了；所有连接
    // 创建时已经开了 `noDelay`（见 `tcpOptions()`），这里只保持接口兼容。
  }

  @objc(tunnel:host:port:restBase64:useTls:resolver:rejecter:)
  func tunnel(
    _ socketId: String,
    host: String,
    port: NSNumber,
    restBase64: String?,
    useTls: Bool,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let client = connection(id: socketId) else {
      reject("ENOSOCKET", "unknown socket: \(socketId)", nil)
      return
    }
    client.suspendForTunnel()
    let rest = restBase64.flatMap { Data(base64Encoded: $0) } ?? Data()

    if useTls, let server = server(id: client.serverId), let tlsPort = server.tlsPort {
      connectRemote(
        host: "127.0.0.1",
        port: tlsPort,
        client: client,
        rest: rest,
        resolve: resolve,
        reject: reject
      )
      return
    }
    guard let targetPort = NWEndpoint.Port(rawValue: UInt16(truncating: port)) else {
      client.cancelTunnel()
      client.close()
      reject("ETUNNEL", "invalid port \(port)", nil)
      return
    }
    connectRemote(
      host: host,
      port: targetPort,
      client: client,
      rest: rest,
      resolve: resolve,
      reject: reject
    )
  }

  private func connectRemote(
    host: String,
    port: NWEndpoint.Port,
    client: NetConnection,
    rest: Data,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    let parameters = NWParameters(tls: nil, tcp: Self.tcpOptions())
    parameters.allowLocalEndpointReuse = true
    let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host), port: port)
    let remote = NWConnection(to: endpoint, using: parameters)
    let settled = NSLock()
    var finished = false
    let settle: () -> Bool = {
      settled.lock()
      defer { settled.unlock() }
      if finished { return false }
      finished = true
      return true
    }

    // 与 Android 一致：隧道连不上不能一直挂着，否则 JS 永远等不到 CONNECT 的
    // 结果，浏览器会一直转圈。
    let timeoutItem = DispatchWorkItem { [weak client] in
      guard settle() else { return }
      remote.stateUpdateHandler = nil
      remote.cancel()
      client?.cancelTunnel()
      client?.close()
      reject(
        "ETUNNEL",
        "tunnel connect timed out after \(Self.connectTimeoutMs) ms",
        nil
      )
    }

    remote.stateUpdateHandler = { [weak self] state in
      guard let self = self else { return }
      switch state {
      case .ready:
        if settle() {
          timeoutItem.cancel()
          remote.stateUpdateHandler = nil
          if !rest.isEmpty {
            remote.send(content: rest, completion: .contentProcessed { _ in })
          }
          client.attachTunnel(remote)
          self.pump(remote: remote, client: client)
          resolve(nil)
        }
      case .failed(let error):
        if settle() {
          timeoutItem.cancel()
          remote.stateUpdateHandler = nil
          client.cancelTunnel()
          client.close()
          reject("ETUNNEL", error.localizedDescription, error)
        }
      case .cancelled:
        if settle() {
          timeoutItem.cancel()
          remote.stateUpdateHandler = nil
          client.cancelTunnel()
          client.close()
          reject("ETUNNEL", "tunnel cancelled", nil)
        }
      default:
        break
      }
    }
    ioQueue.asyncAfter(deadline: .now() + .milliseconds(Self.connectTimeoutMs), execute: timeoutItem)
    remote.start(queue: ioQueue)
  }

  private func pump(remote: NWConnection, client: NetConnection) {
    remote.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, isComplete, error in
      guard let self = self else { return }
      if let data = data, !data.isEmpty {
        client.write(data)
      }
      if isComplete || error != nil {
        remote.cancel()
        client.close()
        return
      }
      self.pump(remote: remote, client: client)
    }
  }

  // MARK: - Called by NetServer / NetConnection

  fileprivate func register(
    connection nw: NWConnection,
    server: NetServer,
    isSSL: Bool
  ) {
    let id = nextSocketId()
    let handle = NetConnection(
      id: id,
      serverId: server.id,
      connection: nw,
      isSSL: isSSL,
      module: self
    )
    store(connection: handle)
    sendEvent(
      withName: "Auto366Net.connection",
      body: ["serverId": server.id, "socketId": id, "isSSL": isSSL]
    )
    // 读循环由 JS 的 resume() 启动。
  }

  fileprivate func emitData(_ socketId: String, data: Data) {
    sendEvent(
      withName: "Auto366Net.data",
      body: ["socketId": socketId, "data": data.base64EncodedString()]
    )
  }

  fileprivate func removeClosed(_ socketId: String) {
    _ = remove(connectionId: socketId)
  }

  /**
   * 关掉某个服务端上还活着的连接。
   *
   * Android 的 `ProxyServer.close()` 会把 `serverId` 匹配的连接一起关掉；iOS 之前
   * 只停掉监听，已经建立的客户端连接留在 `connections` 里，代理重启后 JS 侧仍
   * 持有这些 socket，表现为旧页面一直「加载中」。
   */
  fileprivate func closeConnections(serverId: String) {
    lock.lock()
    let victims = connections.values.filter { $0.serverId == serverId }
    lock.unlock()
    victims.forEach { $0.close() }
  }

  fileprivate func emitClosed(_ socketId: String) {
    sendEvent(withName: "Auto366Net.close", body: ["socketId": socketId])
  }

  fileprivate func emitTimeout(_ socketId: String) {
    sendEvent(withName: "Auto366Net.timeout", body: ["socketId": socketId])
  }
}

// MARK: - Listener

private final class NetServer {
  let id: String
  private let host: String
  private let requestedPort: UInt16
  private let tlsResource: String?
  private let tlsPassword: String?
  private weak var module: Auto366Net?
  private let queue = DispatchQueue(label: "com.auto366.net.server")
  private var plain: NWListener?
  private var tls: NWListener?
  private(set) var port: UInt16 = 0
  private(set) var tlsPort: NWEndpoint.Port?

  init(
    id: String,
    host: String,
    port: UInt16,
    tlsResource: String?,
    tlsPassword: String?,
    module: Auto366Net
  ) {
    self.id = id
    self.host = host
    self.requestedPort = port
    self.tlsResource = tlsResource
    self.tlsPassword = tlsPassword
    self.module = module
  }

  func start(completion: @escaping (Result<[String: Any], Error>) -> Void) {
    do {
      let listener = try makePlainListener()
      plain = listener

      var finished = false
      var plainReady = false
      var tlsPending = tlsResource?.isEmpty == false
      var tlsReady = false

      // Only resolve once the plain listener is ready *and* the optional TLS
      // listener settled (ready / failed). Resolving earlier would report
      // `hasTls = false` and the proxy would silently fall back to a blind
      // tunnel even though TLS is about to come up.
      let finishIfReady: () -> Void = {
        guard !finished, plainReady, !tlsPending else { return }
        finished = true
        completion(.success([
          "port": Int(self.port),
          "tlsPort": Int(self.tlsPort?.rawValue ?? 0),
          "hasTls": tlsReady,
        ]))
      }

      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          self.port = listener.port?.rawValue ?? self.requestedPort
          plainReady = true
          finishIfReady()
        case .failed(let error):
          if !finished {
            finished = true
            completion(.failure(error))
          }
        case .cancelled:
          if !finished {
            finished = true
            completion(.failure(
              NSError(
                domain: "Auto366Net",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "listener cancelled before start"]
              )
            ))
          }
        default:
          break
        }
      }
      listener.newConnectionHandler = { [weak self] connection in
        self?.accept(connection, isSSL: false)
      }
      listener.start(queue: queue)

      // TLS 监听器失败不影响明文代理：CONNECT 会退回盲隧道。
      if tlsPending, let resource = tlsResource, !resource.isEmpty {
        do {
          let tlsListener = try makeTlsListener(resource: resource, password: tlsPassword ?? "")
          tls = tlsListener
          tlsListener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection, isSSL: true)
          }
          tlsListener.stateUpdateHandler = { state in
            switch state {
            case .ready:
              self.tlsPort = tlsListener.port
              tlsReady = true
              tlsPending = false
              finishIfReady()
            case .failed(let error):
              NSLog("[Auto366Net] TLS listener failed: \(error.localizedDescription)")
              tlsPending = false
              finishIfReady()
            case .cancelled:
              tlsPending = false
              finishIfReady()
            default:
              break
            }
          }
          tlsListener.start(queue: queue)
        } catch {
          NSLog("[Auto366Net] TLS listener unavailable: \(error.localizedDescription)")
          tlsPending = false
          finishIfReady()
        }
      } else {
        tlsPending = false
      }
    } catch {
      completion(.failure(error))
    }
  }

  private func makePlainListener() throws -> NWListener {
    let parameters = NWParameters(tls: nil, tcp: Auto366Net.tcpOptions())
    parameters.allowLocalEndpointReuse = true
    let nwPort = NWEndpoint.Port(rawValue: requestedPort) ?? .any
    if host.isEmpty || host == "0.0.0.0" {
      return try NWListener(using: parameters, on: nwPort)
    }
    parameters.requiredLocalEndpoint = .hostPort(
      host: NWEndpoint.Host(host),
      port: nwPort
    )
    return try NWListener(using: parameters)
  }

  private func makeTlsListener(resource: String, password: String) throws -> NWListener {
    guard let identity = try Self.loadIdentity(resource: resource, password: password) else {
      throw NSError(
        domain: "Auto366Net",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "无法读取证书 \(resource).p12"]
      )
    }
    guard let secIdentity = sec_identity_create(identity) else {
      throw NSError(
        domain: "Auto366Net",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "无法创建 TLS identity"]
      )
    }
    let tlsOptions = NWProtocolTLS.Options()
    sec_protocol_options_set_local_identity(tlsOptions.securityProtocolOptions, secIdentity)
    sec_protocol_options_set_min_tls_protocol_version(tlsOptions.securityProtocolOptions, .TLSv12)
    let parameters = NWParameters(tls: tlsOptions, tcp: Auto366Net.tcpOptions())
    parameters.allowLocalEndpointReuse = true
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    return try NWListener(using: parameters)
  }

  private static func loadIdentity(resource: String, password: String) throws -> SecIdentity? {
    guard let url = Bundle.main.url(forResource: resource, withExtension: "p12") else {
      return nil
    }
    let data = try Data(contentsOf: url)
    var items: CFArray?
    let options: [String: Any] = [kSecImportExportPassphrase as String: password]
    let status = SecPKCS12Import(data as CFData, options as CFDictionary, &items)
    guard status == errSecSuccess else {
      throw NSError(
        domain: NSOSStatusErrorDomain,
        code: Int(status),
        userInfo: [NSLocalizedDescriptionKey: "SecPKCS12Import 失败：\(status)"]
      )
    }
    guard
      let array = items as? [[String: Any]],
      let first = array.first,
      let rawIdentity = first[kSecImportItemIdentity as String]
    else {
      return nil
    }
    return (rawIdentity as! SecIdentity)
  }

  private func accept(_ connection: NWConnection, isSSL: Bool) {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self = self else {
        connection.cancel()
        return
      }
      switch state {
      case .ready:
        connection.stateUpdateHandler = nil
        self.module?.register(connection: connection, server: self, isSSL: isSSL)
      case .failed, .cancelled:
        connection.cancel()
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  func close() {
    plain?.cancel()
    plain = nil
    tls?.cancel()
    tls = nil
    tlsPort = nil
    // 与 Android 的 ProxyServer.close() 对齐：监听停掉后也要回收这条服务端
    // 已经接进来的客户端连接。
    module?.closeConnections(serverId: id)
  }
}

// MARK: - Connection

private final class NetConnection {
  let id: String
  let serverId: String
  let isSSL: Bool
  private let connection: NWConnection
  private weak var module: Auto366Net?
  private let queue = DispatchQueue(label: "com.auto366.net.connection")
  private let lock = NSLock()
  private var bridge: NWConnection?
  private var pending: [Data] = []
  private var suspended = false
  private var started = false
  private var closed = false
  private var timeoutWorkItem: DispatchWorkItem?
  private var timeoutMs: Int = 0

  init(
    id: String,
    serverId: String,
    connection: NWConnection,
    isSSL: Bool,
    module: Auto366Net
  ) {
    self.id = id
    self.serverId = serverId
    self.connection = connection
    self.isSSL = isSSL
    self.module = module
  }

  func resume() {
    lock.lock()
    if started || closed {
      lock.unlock()
      return
    }
    started = true
    lock.unlock()
    receive()
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, isComplete, error in
      guard let self = self else { return }
      self.resetTimeout()
      if let data = data, !data.isEmpty {
        self.lock.lock()
        let bridge = self.bridge
        let suspended = self.suspended
        if bridge == nil && suspended {
          self.pending.append(data)
        }
        self.lock.unlock()
        if let bridge = bridge {
          bridge.send(content: data, completion: .contentProcessed { _ in })
        } else if !suspended {
          self.module?.emitData(self.id, data: data)
        }
      }
      if isComplete || error != nil {
        self.close()
        return
      }
      self.receive()
    }
  }

  func write(_ data: Data) {
    guard !data.isEmpty else { return }
    connection.send(
      content: data,
      completion: .contentProcessed { [weak self] error in
        if error != nil {
          self?.close()
        }
      }
    )
    resetTimeout()
  }

  /// 异步写入：数据交给系统发送缓冲后回调，供 JS 侧做背压。
  func writeAsync(_ data: Data, completion: @escaping (Error?) -> Void) {
    guard !data.isEmpty else {
      completion(nil)
      return
    }
    connection.send(
      content: data,
      completion: .contentProcessed { [weak self] error in
        if error != nil {
          self?.close()
        }
        completion(error)
      }
    )
    resetTimeout()
  }

  func shutdown() {
    // `isComplete: true` 只结束写方向；接收循环会在对端读到 EOF 后关闭。
    connection.send(content: nil, isComplete: true, completion: .contentProcessed { _ in })
  }

  func setTimeout(_ milliseconds: Int) {
    timeoutMs = milliseconds
    resetTimeout()
  }

  private func resetTimeout() {
    lock.lock()
    timeoutWorkItem?.cancel()
    timeoutWorkItem = nil
    if timeoutMs > 0 && !closed {
      let work = DispatchWorkItem { [weak self] in
        guard let self = self else { return }
        self.module?.emitTimeout(self.id)
      }
      timeoutWorkItem = work
      lock.unlock()
      queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: work)
      return
    }
    lock.unlock()
  }

  func suspendForTunnel() {
    lock.lock()
    suspended = true
    lock.unlock()
  }

  func attachTunnel(_ remote: NWConnection) {
    lock.lock()
    bridge = remote
    let queued = pending
    pending.removeAll()
    suspended = false
    lock.unlock()
    for chunk in queued {
      remote.send(content: chunk, completion: .contentProcessed { _ in })
    }
  }

  func cancelTunnel() {
    lock.lock()
    suspended = false
    pending.removeAll()
    lock.unlock()
  }

  func close() {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    closed = true
    let remote = bridge
    bridge = nil
    timeoutWorkItem?.cancel()
    timeoutWorkItem = nil
    lock.unlock()
    remote?.cancel()
    connection.cancel()
    module?.removeClosed(self.id)
    module?.emitClosed(id)
  }
}
