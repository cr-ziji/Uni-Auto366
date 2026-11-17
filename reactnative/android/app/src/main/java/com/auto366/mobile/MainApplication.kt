package com.auto366.mobile

import android.app.Application
import com.auto366.mobile.files.Auto366FilesPackage
import com.auto366.mobile.net.Auto366NetPackage
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // 自研原生传输层（代理 / TLS 中间人 / HTTP 客户端）
          add(Auto366NetPackage())
          // 文件选择 / 保存 / 打开（Electron dialog & shell 的移动端实现）
          add(Auto366FilesPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
