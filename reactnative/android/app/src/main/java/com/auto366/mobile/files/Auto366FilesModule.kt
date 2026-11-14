package com.auto366.mobile.files

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * The file picker / opener the Electron `dialog` and `shell` shims need.
 *
 * Android has no "save dialog that returns a writable path": the Storage
 * Access Framework hands out `content://` URIs, which the Node `fs` shim
 * cannot write to. The module therefore bridges both worlds:
 *
 *  - [pickFiles] copies the picked documents into the app cache and returns
 *    ordinary file paths, so the ported code can `readFile` them;
 *  - [pickSaveTarget] opens the system "create document" dialog and returns the
 *    target URI, which `fs` writes to once the caller saved the file
 *    ([writeToUri]);
 *  - [openFile] / [shareFile] expose a private file to other apps through a
 *    `FileProvider` (required since Android 7, `file://` URIs are rejected).
 */
class Auto366FilesModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var pickPromise: Promise? = null
  private var savePromise: Promise? = null
  private var saveName: String = "file"

  init {
    reactContext.addActivityEventListener(
      object : BaseActivityEventListener() {
        override fun onActivityResult(
          activity: Activity,
          requestCode: Int,
          resultCode: Int,
          data: Intent?,
        ) {
          when (requestCode) {
            REQUEST_PICK -> finishPick(resultCode, data)
            REQUEST_SAVE -> finishSave(resultCode, data)
          }
        }
      },
    )
  }

  override fun getName(): String = NAME

  /** Opens the document picker and copies the result into the app cache. */
  @ReactMethod
  fun pickFiles(options: ReadableMap?, promise: Promise) {
    if (pickPromise != null) {
      promise.reject("E_BUSY", "a picker is already open")
      return
    }
    val multiple = options?.hasKey("multiple") == true && options.getBoolean("multiple")
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "the application has no foreground activity")
      return
    }
    pickPromise = promise
    activity.startActivityForResult(intent, REQUEST_PICK)
  }

  /** Opens the "create document" dialog; the caller writes through [writeToUri]. */
  @ReactMethod
  fun pickSaveTarget(fileName: String, mimeType: String?, promise: Promise) {
    if (savePromise != null) {
      promise.reject("E_BUSY", "a save dialog is already open")
      return
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "the application has no foreground activity")
      return
    }
    saveName = fileName
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = mimeType ?: guessMimeType(fileName)
      putExtra(Intent.EXTRA_TITLE, fileName)
      addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    savePromise = promise
    activity.startActivityForResult(intent, REQUEST_SAVE)
  }

  /** Writes `base64` into a URI returned by [pickSaveTarget]. */
  @ReactMethod
  fun writeToUri(uri: String, base64: String, promise: Promise) {
    try {
      val target = Uri.parse(uri)
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      openForWrite(target)?.use { stream ->
        stream.write(bytes)
        stream.flush()
      } ?: run {
        promise.reject("E_WRITE", "could not open $uri for writing")
        return
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_WRITE", error)
    }
  }

  /**
   * Opens a SAF document for writing.
   *
   * `"wt"` truncates the document, but the `t` flag only exists from API 29;
   * older providers throw instead of ignoring it, so fall back to plain `"w"`.
   * The caller always writes a freshly created document there, so a leftover
   * tail is not a concern on those devices.
   */
  private fun openForWrite(uri: Uri): OutputStream? {
    val resolver = reactContext.contentResolver
    return try {
      resolver.openOutputStream(uri, "wt")
    } catch (_: Exception) {
      resolver.openOutputStream(uri, "w")
    }
  }

  /** Saves a private file into the public `Download/Auto366` folder. */
  @ReactMethod
  fun saveToDownloads(path: String, fileName: String, mimeType: String?, promise: Promise) {
    try {
      val source = File(path)
      if (!source.exists()) {
        promise.reject("ENOENT", "file not found: $path")
        return
      }
      val directory = File(
        android.os.Environment.getExternalStoragePublicDirectory(
          android.os.Environment.DIRECTORY_DOWNLOADS,
        ),
        "Auto366",
      )
      directory.mkdirs()
      val target = File(directory, sanitize(fileName))
      source.inputStream().use { input ->
        FileOutputStream(target).use { output -> input.copyTo(output) }
      }
      promise.resolve(target.absolutePath)
    } catch (error: Exception) {
      promise.reject("E_SAVE", error)
    }
  }

  /** Opens a private file with the app the user picks. */
  @ReactMethod
  fun openFile(path: String, mimeType: String?, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists()) {
        promise.reject("ENOENT", "file not found: $path")
        return
      }
      val uri = FileProvider.getUriForFile(reactContext, "${reactContext.packageName}.fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mimeType ?: guessMimeType(file.name))
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      val chooser = Intent.createChooser(intent, file.name).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(chooser)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_OPEN", error)
    }
  }

  /** Shares a private file through the system share sheet. */
  @ReactMethod
  fun shareFile(path: String, mimeType: String?, promise: Promise) {
    try {
      val file = File(path)
      if (!file.exists()) {
        promise.reject("ENOENT", "file not found: $path")
        return
      }
      val uri = FileProvider.getUriForFile(reactContext, "${reactContext.packageName}.fileprovider", file)
      val intent = Intent(Intent.ACTION_SEND).apply {
        type = mimeType ?: guessMimeType(file.name)
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      val chooser = Intent.createChooser(intent, file.name).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      reactContext.startActivity(chooser)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_SHARE", error)
    }
  }

  private fun finishPick(resultCode: Int, data: Intent?) {
    val promise = pickPromise ?: return
    pickPromise = null
    if (resultCode != Activity.RESULT_OK || data == null) {
      promise.resolve(Arguments.createArray())
      return
    }
    try {
      val uris = mutableListOf<Uri>()
      val clip = data.clipData
      if (clip != null) {
        for (index in 0 until clip.itemCount) {
          uris.add(clip.getItemAt(index).uri)
        }
      }
      data.data?.let { uris.add(it) }

      val result = Arguments.createArray()
      for (uri in uris) {
        val name = queryDisplayName(uri) ?: "picked-${System.currentTimeMillis()}"
        val copied = copyToCache(uri, name)
        result.pushMap(
          Arguments.createMap().apply {
            putString("path", copied.absolutePath)
            putString("name", copied.name)
            putDouble("size", copied.length().toDouble())
            putString("uri", uri.toString())
          },
        )
      }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("E_PICK", error)
    }
  }

  private fun finishSave(resultCode: Int, data: Intent?) {
    val promise = savePromise ?: return
    savePromise = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) {
      promise.resolve(null)
      return
    }
    promise.resolve(
      Arguments.createMap().apply {
        putString("uri", uri.toString())
        putString("name", queryDisplayName(uri) ?: saveName)
      },
    )
  }

  private fun copyToCache(uri: Uri, name: String): File {
    val directory = File(reactContext.cacheDir, "imports").apply { mkdirs() }
    val target = File(directory, sanitize(name))
    reactContext.contentResolver.openInputStream(uri)?.use { input ->
      FileOutputStream(target).use { output -> input.copyTo(output) }
    } ?: throw IllegalStateException("could not read $uri")
    return target
  }

  private fun queryDisplayName(uri: Uri): String? {
    return try {
      reactContext.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
      }
    } catch (_: Exception) {
      null
    }
  }

  /** Keeps the file name usable as a real path. */
  private fun sanitize(name: String): String {
    val cleaned = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
    return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "file" else cleaned
  }

  private fun guessMimeType(name: String): String {
    val extension = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "*/*"
  }

  companion object {
    private const val NAME = "Auto366Files"
    private const val REQUEST_PICK = 41201
    private const val REQUEST_SAVE = 41202
  }
}
