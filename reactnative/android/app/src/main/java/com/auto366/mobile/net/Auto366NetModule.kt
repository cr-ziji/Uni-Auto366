package com.auto366.mobile.net

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.IOException
import java.net.IDN
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.KeyStore
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket

/**
 * 原生 TCP / TLS 传输层。
 *
 * 这个模块只负责字节管道，不解析 HTTP：
 *
 *  - `listen()`：普通 `ServerSocket`；传入 `tlsResource` 时额外在
 *    `127.0.0.1` 上启动一个原生 `SSLServerSocket`，供 CONNECT 中间人使用；
 *  - `tunnel()`：把一条已经 hijack 的客户端连接桥接到本机 TLS 服务端
 *    （HTTPS 解密）或目标主机（盲隧道），整个搬运过程不经过 JS；
 *  - `connect()`：普通 / TLS 客户端连接，TLS 使用系统信任库，并发送 SNI；
 *  - `write()` / `shutdown()` / `close()`：字节读写与半关闭。
 *
 * 证书直接从 APK 的 `res/raw` 读取 PKCS#12，因此不再需要第三方
 * TCP/TLS 库或其补丁，也不需要在 JS 侧搭建 TLS 服务端。
 */
class Auto366NetModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val DEFAULT_CONNECT_TIMEOUT = 15_000
    private const val READ_BUFFER_SIZE = 32 * 1024
  }

  private val servers = ConcurrentHashMap<String, ProxyServer>()
  private val connections = ConcurrentHashMap<String, Connection>()
  private val sslContexts = ConcurrentHashMap<String, SSLContext>()
  private val io = Executors.newCachedThreadPool()
  private val sequence = AtomicLong(0)

  override fun getName(): String = "Auto366Net"

  @ReactMethod
  fun addListener(eventName: String) {
    // NativeEventEmitter 在 iOS 需要；Android 保留空实现以保持接口一致。
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // 同上。
  }

  @ReactMethod
  fun listen(
    serverId: String,
    host: String,
    port: Int,
    tlsResource: String?,
    tlsPassword: String?,
    promise: Promise,
  ) {
    servers.remove(serverId)?.close()
    val server = ProxyServer(serverId, host, port, tlsResource, tlsPassword)
    servers[serverId] = server
    io.execute {
      try {
        server.start()
        val result = Arguments.createMap().apply {
          putInt("port", server.port)
          putInt("tlsPort", server.tlsPort)
          putBoolean("hasTls", server.tlsPort > 0)
        }
        promise.resolve(result)
      } catch (error: Exception) {
        servers.remove(serverId)
        server.close()
        promise.reject("ELISTEN", error.message ?: "listen failed", error)
      }
    }
  }

  @ReactMethod
  fun closeServer(serverId: String, promise: Promise) {
    val server = servers.remove(serverId)
    io.execute {
      try {
        server?.close()
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("ECLOSESERVER", error.message ?: "close failed", error)
      }
    }
  }

  @ReactMethod
  fun connect(
    socketId: String,
    host: String,
    port: Int,
    tls: Boolean,
    servername: String?,
    timeoutMs: Int,
    promise: Promise,
  ) {
    io.execute {
      try {
        val raw = Socket()
        try {
          raw.tcpNoDelay = true
        } catch (_: Exception) {
          // 忽略
        }
        val timeout = if (timeoutMs > 0) timeoutMs else DEFAULT_CONNECT_TIMEOUT
        raw.connect(InetSocketAddress(host, port), timeout)
        val socket: Socket = if (tls) {
          val context = SSLContext.getInstance("TLS")
          context.init(null, null, SecureRandom())
          val ssl = context.socketFactory.createSocket(raw, host, port, true) as SSLSocket
          ssl.useClientMode = true
          applyServerName(ssl, servername ?: host)
          try {
            val parameters = ssl.sslParameters
            parameters.endpointIdentificationAlgorithm = "HTTPS"
            ssl.sslParameters = parameters
          } catch (_: Exception) {
            // 老系统可能不支持 hostname 校验参数，保持默认。
          }
          ssl.startHandshake()
          ssl
        } else {
          raw
        }
        val connection = Connection(socketId, "", socket, tls)
        connections[socketId] = connection
        // 等 JS 挂好监听后再开始读，避免首包丢失。
        promise.resolve(null)
      } catch (error: Exception) {
        try {
          // 上面的 raw / ssl 已在局部作用域，交给 GC / 对端关闭。
        } catch (_: Exception) {
          // 忽略
        }
        promise.reject("ECONNECT", error.message ?: "connect failed", error)
      }
    }
  }

  /** JS 侧挂好事件监听后调用，开始读取连接。 */
  @ReactMethod
  fun resume(socketId: String, promise: Promise) {
    val connection = connections[socketId]
    if (connection == null) {
      promise.reject("ENOSOCKET", "unknown socket: $socketId")
      return
    }
    connection.resume()
    promise.resolve(null)
  }

  /** CONNECT 前让读循环先暂停，新到的字节排队等隧道挂上后回放。 */
  @ReactMethod
  fun suspend(socketId: String) {
    connections[socketId]?.suspendForTunnel()
  }

  @ReactMethod
  fun write(socketId: String, base64: String) {
    val connection = connections[socketId] ?: return
    val data = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
      return
    }
    connection.write(data)
  }

  /**
   * 异步写入：分片写完后 resolve。
   *
   * JS 侧靠它给大响应（ZIP）做流控，避免一次性把上百 MB 的 base64 字符串
   * 塞进 bridge 队列。
   */
  @ReactMethod
  fun writeAsync(socketId: String, base64: String, promise: Promise) {
    val connection = connections[socketId]
    if (connection == null) {
      promise.reject("ENOSOCKET", "unknown socket: $socketId")
      return
    }
    val data = try {
      Base64.decode(base64, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
      promise.reject("EWRITE", "invalid base64 payload")
      return
    }
    connection.writeAsync(data, promise)
  }

  /** 半关闭写方向（HTTP 响应结束，等待客户端读到 EOF）。 */
  @ReactMethod
  fun shutdown(socketId: String) {
    connections[socketId]?.shutdown()
  }

  @ReactMethod
  fun close(socketId: String) {
    connections.remove(socketId)?.close()
  }

  @ReactMethod
  fun setTimeout(socketId: String, milliseconds: Int) {
    connections[socketId]?.setTimeout(milliseconds)
  }

  @ReactMethod
  fun setNoDelay(socketId: String, value: Boolean) {
    connections[socketId]?.setNoDelay(value)
  }

  /**
   * CONNECT 隧道。
   *
   * `useTls = true` 时连接到本服务端启动的 loopback TLS 端口，TLS 在原生层
   * 终止；否则直接连接目标主机做盲隧道。`rest` 是 CONNECT 首部之后同一批
   * 到达的字节（例如 TLS ClientHello），会先写给目标端。
   */
  @ReactMethod
  fun tunnel(
    socketId: String,
    host: String,
    port: Int,
    restBase64: String?,
    useTls: Boolean,
    promise: Promise,
  ) {
    val connection = connections[socketId]
    if (connection == null) {
      promise.reject("ENOSOCKET", "unknown socket: $socketId")
      return
    }
    // 从这一刻起，读线程把新到的字节放进 pending 队列，等远端连接好再回放。
    connection.suspendForTunnel()
    io.execute {
      try {
        val server = servers[connection.serverId]
        val remote = Socket()
        try {
          remote.tcpNoDelay = true
        } catch (_: Exception) {
          // 忽略
        }
        if (useTls && server != null && server.tlsPort > 0) {
          remote.connect(InetSocketAddress(InetAddress.getByName("127.0.0.1"), server.tlsPort), DEFAULT_CONNECT_TIMEOUT)
        } else {
          remote.connect(InetSocketAddress(host, port), DEFAULT_CONNECT_TIMEOUT)
        }
        val rest = if (restBase64.isNullOrEmpty()) {
          ByteArray(0)
        } else {
          Base64.decode(restBase64, Base64.DEFAULT)
        }
        if (rest.isNotEmpty()) {
          remote.getOutputStream().write(rest)
          remote.getOutputStream().flush()
        }
        connection.attachTunnel(remote)
        io.execute { pump(remote, connection) }
        promise.resolve(null)
      } catch (error: Exception) {
        connection.cancelTunnel()
        connection.close()
        promise.reject("ETUNNEL", error.message ?: "tunnel failed", error)
      }
    }
  }

  override fun invalidate() {
    try {
      servers.values.forEach { it.close() }
    } catch (_: Exception) {
      // 忽略
    }
    servers.clear()
    try {
      connections.values.forEach { it.close() }
    } catch (_: Exception) {
      // 忽略
    }
    connections.clear()
    io.shutdownNow()
    super.invalidate()
  }

  private fun pump(remote: Socket, client: Connection) {
    val buffer = ByteArray(READ_BUFFER_SIZE)
    try {
      val input = remote.getInputStream()
      while (!client.isClosed()) {
        val count = input.read(buffer)
        if (count < 0) {
          break
        }
        if (count == 0) {
          continue
        }
        client.writeToClient(buffer.copyOf(count))
      }
    } catch (_: Exception) {
      // 连接关闭 / 出错都按关闭处理。
    } finally {
      try {
        remote.close()
      } catch (_: Exception) {
        // 忽略
      }
      client.close()
    }
  }

  private fun register(socket: Socket, server: ProxyServer, isSSL: Boolean) {
    try {
      socket.tcpNoDelay = true
    } catch (_: Exception) {
      // 忽略
    }
    val id = "sock-" + sequence.incrementAndGet()
    val connection = Connection(id, server.id, socket, isSSL)
    connections[id] = connection
    emit(
      "Auto366Net.connection",
      Arguments.createMap().apply {
        putString("serverId", server.id)
        putString("socketId", id)
        putBoolean("isSSL", isSSL)
      },
    )
    // 读线程由 JS 的 resume() 启动。
  }

  private fun applyServerName(ssl: SSLSocket, serverName: String) {
    val name = serverName.trim()
    if (name.isEmpty() || isIpLiteral(name)) {
      return
    }
    try {
      val parameters = ssl.sslParameters
      parameters.serverNames = listOf(SNIHostName(IDN.toASCII(name)))
      ssl.sslParameters = parameters
    } catch (_: Exception) {
      // IP 字面量或平台不支持 SNI 时忽略。
    }
  }

  private fun isIpLiteral(value: String): Boolean {
    if (value.startsWith("[") || value.contains(':')) {
      return true
    }
    return value.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))
  }

  private fun getSslContext(resource: String, password: String): SSLContext {
    val key = "$resource:$password"
    sslContexts[key]?.let { return it }
    val context = reactContext
    val resourceId = if (resource.matches(Regex("^\\d+$"))) {
      resource.toInt()
    } else {
      context.resources.getIdentifier(resource, "raw", context.packageName)
    }
    if (resourceId == 0) {
      throw IOException("找不到原生证书资源 res/raw/$resource")
    }
    val keyStore = KeyStore.getInstance("PKCS12")
    context.resources.openRawResource(resourceId).use { stream ->
      keyStore.load(stream, password.toCharArray())
    }
    val keyManagerFactory = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
    keyManagerFactory.init(keyStore, password.toCharArray())
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(keyManagerFactory.keyManagers, null, SecureRandom())
    sslContexts[key] = sslContext
    return sslContext
  }

  private fun emit(name: String, payload: WritableMap) {
    try {
      if (!reactContext.hasActiveReactInstance()) {
        return
      }
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(name, payload)
    } catch (_: Exception) {
      // React 实例已经销毁时忽略。
    }
  }

  /** 一个监听端口 +（可选）一个 loopback TLS 监听端口。 */
  private inner class ProxyServer(
    val id: String,
    private val host: String,
    private val requestedPort: Int,
    private val tlsResource: String?,
    private val tlsPassword: String?,
  ) {
    private val plain = ServerSocket()
    private var tlsServer: SSLServerSocket? = null
    @Volatile private var running = true

    @Volatile
    var port: Int = 0
      private set

    @Volatile
    var tlsPort: Int = 0
      private set

    fun start() {
      plain.reuseAddress = true
      plain.bind(InetSocketAddress(host, requestedPort), 128)
      port = plain.localPort

      if (!tlsResource.isNullOrEmpty()) {
        try {
          val sslContext = getSslContext(tlsResource, tlsPassword ?: "")
          val socket = sslContext.serverSocketFactory.createServerSocket(
            0,
            128,
            InetAddress.getByName("127.0.0.1"),
          ) as SSLServerSocket
          socket.needClientAuth = false
          tlsServer = socket
          tlsPort = socket.localPort
          io.execute { acceptLoop(socket, true) }
        } catch (error: Exception) {
          // TLS 服务端起不来不影响明文代理：CONNECT 会退回盲隧道。
          Log.w("Auto366Net", "TLS listener unavailable", error)
          tlsServer = null
          tlsPort = 0
        }
      }
      io.execute { acceptLoop(plain, false) }
    }

    private fun acceptLoop(serverSocket: ServerSocket, isSSL: Boolean) {
      while (running) {
        val socket = try {
          serverSocket.accept()
        } catch (_: Exception) {
          break
        }
        io.execute {
          if (isSSL) {
            val ssl = socket as? SSLSocket
            if (ssl == null) {
              try {
                socket.close()
              } catch (_: Exception) {
                // 忽略
              }
              return@execute
            }
            try {
              ssl.soTimeout = DEFAULT_CONNECT_TIMEOUT
              ssl.startHandshake()
              ssl.soTimeout = 0
            } catch (_: Exception) {
              try {
                ssl.close()
              } catch (_: Exception) {
                // 忽略
              }
              return@execute
            }
          }
          register(socket, this, isSSL)
        }
      }
    }

    fun close() {
      running = false
      try {
        plain.close()
      } catch (_: Exception) {
        // 忽略
      }
      try {
        tlsServer?.close()
      } catch (_: Exception) {
        // 忽略
      }
      connections.values
        .filter { it.serverId == id }
        .forEach { it.close() }
    }
  }

  /** 单条连接：异步读写 + 可选的 CONNECT 隧道。 */
  private inner class Connection(
    val id: String,
    val serverId: String,
    private val socket: Socket,
    val isSSL: Boolean,
  ) {
    private val readExecutor = Executors.newSingleThreadExecutor()
    private val writeExecutor = Executors.newSingleThreadExecutor()
    private val input = socket.getInputStream()
    private val output = socket.getOutputStream()
    private val pending = ConcurrentLinkedQueue<ByteArray>()
    private val lock = Any()

    @Volatile private var closed = false
    @Volatile private var resumed = false
    @Volatile private var suspended = false
    @Volatile private var bridge: Socket? = null

    fun resume() {
      if (resumed || closed) {
        return
      }
      resumed = true
      readExecutor.execute { readLoop() }
    }

    private fun readLoop() {
      val buffer = ByteArray(READ_BUFFER_SIZE)
      while (!closed) {
        val count = try {
          input.read(buffer)
        } catch (timeout: SocketTimeoutException) {
          emit(
            "Auto366Net.timeout",
            Arguments.createMap().apply { putString("socketId", id) },
          )
          continue
        } catch (_: Exception) {
          break
        }
        if (count < 0) {
          break
        }
        if (count == 0) {
          continue
        }
        val data = buffer.copyOf(count)
        val target: Socket?
        val queued: Boolean
        synchronized(lock) {
          target = bridge
          queued = target == null && suspended
          if (queued) {
            pending.add(data)
          }
        }
        if (target != null) {
          if (!writeFully(target, data)) {
            break
          }
        } else if (!queued) {
          emitData(data)
        }
      }
      close()
    }

    private fun emitData(data: ByteArray) {
      emit(
        "Auto366Net.data",
        Arguments.createMap().apply {
          putString("socketId", id)
          putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
        },
      )
    }

    fun write(data: ByteArray) {
      if (closed || data.isEmpty()) {
        return
      }
      writeExecutor.execute {
        if (closed) {
          return@execute
        }
        try {
          output.write(data)
          output.flush()
        } catch (_: Exception) {
          close()
        }
      }
    }

    /** 异步写入：真正写进 socket 后 resolve，供 JS 侧做背压。 */
    fun writeAsync(data: ByteArray, promise: Promise) {
      if (closed || data.isEmpty()) {
        promise.resolve(null)
        return
      }
      writeExecutor.execute {
        if (closed) {
          promise.resolve(null)
          return@execute
        }
        try {
          output.write(data)
          output.flush()
          promise.resolve(null)
        } catch (error: Exception) {
          close()
          promise.reject("EWRITE", error.message ?: "write failed", error)
        }
      }
    }

    fun writeToClient(data: ByteArray) {
      write(data)
    }

    fun shutdown() {
      if (closed) {
        return
      }
      writeExecutor.execute {
        try {
          output.flush()
          socket.shutdownOutput()
        } catch (_: Exception) {
          // 对端已经关闭时忽略。
        }
      }
    }

    fun setTimeout(milliseconds: Int) {
      try {
        socket.soTimeout = milliseconds
      } catch (_: Exception) {
        // 忽略
      }
    }

    fun setNoDelay(value: Boolean) {
      try {
        socket.tcpNoDelay = value
      } catch (_: Exception) {
        // 忽略
      }
    }

    /** CONNECT：暂停把新数据发给 JS，先缓存。 */
    fun suspendForTunnel() {
      synchronized(lock) {
        suspended = true
      }
    }

    /** 远端连接建立后挂上隧道并回放缓存。 */
    fun attachTunnel(remote: Socket) {
      val rest = ArrayList<ByteArray>()
      synchronized(lock) {
        bridge = remote
        while (true) {
          val chunk = pending.poll() ?: break
          rest.add(chunk)
        }
        suspended = false
      }
      for (chunk in rest) {
        if (!writeFully(remote, chunk)) {
          close()
          return
        }
      }
    }

    fun cancelTunnel() {
      synchronized(lock) {
        suspended = false
        pending.clear()
      }
    }

    fun isClosed(): Boolean = closed

    fun close() {
      if (closed) {
        return
      }
      closed = true
      val remote: Socket?
      synchronized(lock) {
        remote = bridge
        bridge = null
        pending.clear()
        suspended = false
      }
      try {
        remote?.close()
      } catch (_: Exception) {
        // 忽略
      }
      try {
        input.close()
      } catch (_: Exception) {
        // 忽略
      }
      try {
        output.close()
      } catch (_: Exception) {
        // 忽略
      }
      try {
        socket.close()
      } catch (_: Exception) {
        // 忽略
      }
      connections.remove(id)
      emit(
        "Auto366Net.close",
        Arguments.createMap().apply { putString("socketId", id) },
      )
      writeExecutor.shutdownNow()
      readExecutor.shutdownNow()
    }
  }

  /**
   * 完整写出一段字节。`OutputStream.write` 本身会处理部分写入，这里只需要
   * 处理异常；失败时返回 false，调用方负责关闭连接。
   */
  private fun writeFully(socket: Socket, data: ByteArray): Boolean {
    return try {
      socket.getOutputStream().write(data)
      socket.getOutputStream().flush()
      true
    } catch (_: Exception) {
      false
    }
  }
}
