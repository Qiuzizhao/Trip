package com.qiuzizhao.tripphotoalbum

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.content.ContentValues
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.interfaces.permissions.PermissionsResponseListener
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

class TripPhotoAlbumModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private val resolver get() = context.contentResolver
  private val preferences get() = context.getSharedPreferences("trip-photo-album", 0)
  private val lock = Any()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val cancelled = AtomicBoolean(false)
  private data class Photo(val uri: Uri, val name: String, val added: Long, val favorite: Boolean,
    val owned: Boolean, val inAlbum: Boolean)
  private data class Checked(val photo: Photo, val hash: String)
  private data class Group(val hash: String, val keep: List<Checked>, val remove: List<Checked>)
  private var preview: Pair<String, List<Group>>? = null
  private var deletion: Pair<Promise, Int>? = null
  private val deleteRequestCode = 5816

  override fun definition() = ModuleDefinition {
    Name("TripPhotoAlbum")
    Events("duplicateScanProgress")
    AsyncFunction("permission") { request: Boolean, promise: Promise ->
      val status = permissionStatus()
      if (request && status == "undetermined") {
        val manager = appContext.permissions ?: throw IllegalStateException("照片权限服务不可用")
        preferences.edit().putBoolean("asked", true).apply()
        manager.askForPermissions(PermissionsResponseListener { promise.resolve(permissionStatus()) }, *requiredPermissions())
      } else promise.resolve(status)
    }
    AsyncFunction("readImageDateMetadata") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        try {
          open(Uri.parse(uri)).use { input ->
            val exif = ExifInterface(input)
            val date = exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
              ?: exif.getAttribute(ExifInterface.TAG_DATETIME_DIGITIZED)
              ?: exif.getAttribute(ExifInterface.TAG_DATETIME)
            date?.let { mapOf("dateTime" to it, "offset" to
              (exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_ORIGINAL)
                ?: exif.getAttribute(ExifInterface.TAG_OFFSET_TIME_DIGITIZED)
                ?: exif.getAttribute(ExifInterface.TAG_OFFSET_TIME) ?: "")) }
          }
        } catch (_: Exception) { null }
      }
    }
    AsyncFunction("hashFile") Coroutine { uri: String -> withContext(Dispatchers.IO) { digestFile(Uri.parse(uri)) } }
    AsyncFunction("rememberSavedHashes") Coroutine { hashes: List<String> ->
      withContext(Dispatchers.IO) { synchronized(lock) {
        val saved = ledger()
        hashes.filter(::validHash).forEach { if (!saved.has(it)) saved.put(it, "") }
        storeLedger(saved)
      } }
    }
    AsyncFunction("snapshot") Coroutine { -> withContext(Dispatchers.IO) { synchronized(lock) {
      requirePermission()
      val saved = ledger()
      photos(true).forEach { photo -> taggedHash(photo.name)?.let { if (!saved.has(it)) saved.put(it, photo.uri.toString()) } }
      storeLedger(saved)
      saved.keys().asSequence().toList()
    } } }
    AsyncFunction("save") Coroutine { uri: String, hash: String, location: String ->
      withContext(Dispatchers.IO) { synchronized(lock) {
        requirePermission()
        require(validHash(hash)) { "照片内容标识无效" }
        val saved = ledger()
        if (!saved.has(hash)) { saved.put(hash, copyToAlbum(Uri.parse(uri), hash, location).toString()); storeLedger(saved) }
        true
      } }
    }
    AsyncFunction("reconcileAlbum") Coroutine { searchEntireLibrary: Boolean ->
      withContext(Dispatchers.IO) { synchronized(lock) { reconcile(searchEntireLibrary) } }
    }
    Function("cancelDuplicateScan") { cancelled.set(true) }
    AsyncFunction("findDuplicates") Coroutine { -> withContext(Dispatchers.IO) { synchronized(lock) { scan() } } }
    AsyncFunction("deleteDuplicates") { token: String, promise: Promise ->
      scope.launch {
        try {
          val uris = synchronized(lock) { validatedDeletions(token) }
          if (uris.isEmpty()) { promise.resolve(0); return@launch }
          if (Build.VERSION.SDK_INT >= 30) {
            val request = MediaStore.createTrashRequest(resolver, uris, true)
            withContext(Dispatchers.Main) {
              check(deletion == null) { "正在等待系统确认" }
              val activity = appContext.currentActivity ?: error("请返回 Trip 后再清理")
              deletion = promise to uris.size
              try { activity.startIntentSenderForResult(request.intentSender, deleteRequestCode, null, 0, 0, 0) }
              catch (error: Exception) { deletion = null; throw error }
            }
          } else {
            // Older Android has no trash API. Only app-owned, byte-identical copies are eligible.
            var count = 0
            for (uri in uris) count += resolver.delete(uri, null, null)
            promise.resolve(count)
          }
        } catch (error: Exception) { promise.reject("TRIP_DELETE", error.message, error) }
      }
    }
    OnActivityResult { _, result ->
      if (result.requestCode == deleteRequestCode) {
        val current = deletion
        deletion = null
        current?.first?.resolve(if (result.resultCode == Activity.RESULT_OK) current.second else 0)
      }
    }
    OnDestroy {
      cancelled.set(true)
      scope.cancel()
      deletion?.first?.reject("TRIP_CLOSED", "清理已中断，请重新扫描", null)
      deletion = null
    }
  }

  private fun requiredPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
    Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
    Build.VERSION.SDK_INT >= 29 -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE)
  }
  private fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
  private fun permissionStatus(): String {
    val read = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
    if (granted(read) && (Build.VERSION.SDK_INT >= 29 || granted(Manifest.permission.WRITE_EXTERNAL_STORAGE))) return "authorized"
    if (Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)) return "limited"
    return if (preferences.getBoolean("asked", false)) "denied" else "undetermined"
  }
  private fun requirePermission() { check(permissionStatus() == "authorized") { "请允许 Trip 完整访问照片" } }
  private fun ledger() = JSONObject(preferences.getString("saved", "{}") ?: "{}")
  private fun storeLedger(saved: JSONObject) { check(preferences.edit().putString("saved", saved.toString()).commit()) { "照片保存记录写入失败" } }
  private fun validHash(value: String) = value.matches(Regex("[a-f0-9]{64}"))
  private fun taggedHash(name: String): String? = Regex("(?:^|_)trip-([a-f0-9]{64})\\.[^.]+$", RegexOption.IGNORE_CASE)
    .find(name)?.groupValues?.get(1)?.lowercase()
  private fun open(uri: Uri): InputStream = if (uri.scheme == "file") File(requireNotNull(uri.path)).inputStream()
    else resolver.openInputStream(uri) ?: error("照片文件不可用")
  private fun digestFile(uri: Uri): String = open(uri).use { input ->
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(256 * 1024)
    while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
    digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
  }
  private fun imageFormat(uri: Uri): Pair<String, String> {
    val bytes = open(uri).use { input -> val b = ByteArray(64); val n = input.read(b); b.copyOf(n.coerceAtLeast(0)) }
    val ascii = String(bytes, Charsets.ISO_8859_1)
    val ext = when {
      bytes.size >= 2 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() -> "jpg"
      ascii.startsWith("\u0089PNG") -> "png"
      ascii.startsWith("GIF") -> "gif"
      ascii.startsWith("RIFF") && ascii.contains("WEBP") -> "webp"
      ascii.startsWith("BM") -> "bmp"
      ascii.startsWith("II*\u0000") || ascii.startsWith("MM\u0000*") -> "tif"
      ascii.length >= 12 && ascii.substring(4, 8) == "ftyp" -> when {
        ascii.contains("avif") || ascii.contains("avis") -> "avif"
        Regex("heic|heix|hevc|hevx|MiHB|MiHA").containsMatchIn(ascii) -> "heic"
        else -> "heif"
      }
      else -> error("原文件不是可识别的照片")
    }
    return ext to (MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "image/$ext")
  }
  private fun filename(hash: String, location: String, ext: String): String {
    val clean = location.replace(Regex("[\\p{Cntrl}/\\\\:*?\"<>|]"), " ").trim().replace(Regex("\\s+"), " ")
    val place = clean.codePoints().toArray().fold("") { text, cp ->
      val next = text + String(Character.toChars(cp)); if (next.toByteArray().size <= 120) next else text
    }
    return (if (place.isEmpty()) "" else "${place}_") + "trip-$hash.$ext"
  }
  private fun copyToAlbum(source: Uri, hash: String, location: String): Uri {
    val (ext, mime) = imageFormat(source)
    val name = filename(hash, location, ext)
    var legacyFile: File? = null
    val values = ContentValues().apply {
      put(MediaStore.Images.Media.DISPLAY_NAME, name)
      put(MediaStore.Images.Media.MIME_TYPE, mime)
      if (Build.VERSION.SDK_INT >= 29) {
        put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Trip/")
        put(MediaStore.Images.Media.IS_PENDING, 1)
      } else {
        val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Trip").apply { mkdirs() }
        legacyFile = File(directory, name)
        // Never overwrite a user's existing file, even when its filename matches.
        if (legacyFile!!.exists()) legacyFile = File(directory, "${UUID.randomUUID()}_$name")
        put(MediaStore.Images.Media.DATA, legacyFile!!.absolutePath)
      }
    }
    val target = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: error("无法创建 Trip 相簿照片")
    try {
      open(source).use { input -> requireNotNull(resolver.openOutputStream(target)).use { output -> input.copyTo(output) } }
      check(digestFile(target) == hash) { "照片复制后校验失败" }
      if (Build.VERSION.SDK_INT >= 29) resolver.update(target, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
      legacyFile?.let { MediaScannerConnection.scanFile(context, arrayOf(it.absolutePath), arrayOf(mime), null) }
      return target
    } catch (error: Exception) { resolver.delete(target, null, null); throw error }
  }
  private fun photos(albumOnly: Boolean): List<Photo> {
    val projection = mutableListOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.DATE_ADDED)
    projection += if (Build.VERSION.SDK_INT >= 29) MediaStore.Images.Media.RELATIVE_PATH else MediaStore.Images.Media.DATA
    if (Build.VERSION.SDK_INT >= 29) projection += MediaStore.Images.Media.OWNER_PACKAGE_NAME
    if (Build.VERSION.SDK_INT >= 30) projection += MediaStore.Images.Media.IS_FAVORITE
    val column = if (Build.VERSION.SDK_INT >= 29) MediaStore.Images.Media.RELATIVE_PATH else MediaStore.Images.Media.DATA
    val selection = if (!albumOnly) null else if (Build.VERSION.SDK_INT >= 29) "$column = ?" else "$column LIKE ?"
    val args = if (!albumOnly) null else arrayOf(if (Build.VERSION.SDK_INT >= 29) "Pictures/Trip/" else "%/Pictures/Trip/%")
    val saved = ledger()
    val ownedUris = saved.keys().asSequence().map { saved.optString(it) }.toSet()
    val result = mutableListOf<Photo>()
    resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection.toTypedArray(), selection, args, "${MediaStore.Images.Media._ID} ASC")?.use { cursor ->
      while (cursor.moveToNext()) {
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cursor.getLong(0))
        val name = cursor.getString(1) ?: ""
        val path = cursor.getString(3) ?: ""
        val owner = if (Build.VERSION.SDK_INT >= 29) cursor.getString(4) else null
        val favorite = Build.VERSION.SDK_INT >= 30 && cursor.getInt(5) != 0
        result += Photo(uri, name, cursor.getLong(2), favorite,
          owner == context.packageName || ownedUris.contains(uri.toString()),
          if (Build.VERSION.SDK_INT >= 29) path == "Pictures/Trip/" else File(path).parentFile?.name == "Trip")
      }
    }
    return result
  }
  private fun reconcile(entireLibrary: Boolean): Map<String, Any> {
    requirePermission()
    val saved = ledger()
    val verified = JSONObject()
    val matches = mutableMapOf<String, Photo>()
    var unreadable = false
    // Hash each candidate once. A failed read cannot prove a historical photo is gone.
    for (photo in photos(!entireLibrary)) {
      try {
        val value = digestFile(photo.uri)
        if (saved.has(value) || taggedHash(photo.name) == value) {
          if (photo.inAlbum) verified.put(value, photo.uri.toString())
          else matches.putIfAbsent(value, photo)
        }
      } catch (_: Exception) { unreadable = true }
    }
    var unresolved = 0
    for (value in saved.keys().asSequence().toList()) {
      if (verified.has(value)) continue
      val known = saved.optString(value)
      var uncertain = entireLibrary && unreadable
      var found = matches[value]
      if (found == null && !entireLibrary && known.isNotEmpty()) {
        val uri = Uri.parse(known)
        try {
          resolver.query(uri, arrayOf(MediaStore.Images.Media._ID), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
              uncertain = true
              if (digestFile(uri) == value) { found = Photo(uri, "", 0, false, true, false); uncertain = false }
            }
          }
        } catch (_: Exception) { uncertain = true }
      }
      if (found != null) {
        val photo = found!!
        // Android albums are directories: copy into Trip, never move a user's original.
        verified.put(value, copyToAlbum(photo.uri, value, photo.name.substringBefore("_trip-", "")).toString())
      } else if (uncertain || (!entireLibrary && known.isEmpty())) {
        verified.put(value, known); unresolved++
      }
    }
    storeLedger(verified)
    return mapOf("hashes" to verified.keys().asSequence().toList(), "unresolved" to unresolved)
  }
  private fun scan(): Map<String, Any> {
    requirePermission()
    cancelled.set(false)
    preview = null
    val entries = photos(true)
    val checked = mutableListOf<Checked>()
    var skipped = 0
    entries.forEachIndexed { index, photo ->
      check(!cancelled.get()) { "扫描已取消" }
      try { checked += Checked(photo, digestFile(photo.uri)) } catch (_: Exception) { skipped++ }
      if (index % 4 == 0 || index == entries.lastIndex) sendEvent("duplicateScanProgress", mapOf("scanned" to index + 1, "total" to entries.size))
    }
    val groups = checked.groupBy { it.hash }.mapNotNull { (hash, copies) ->
      if (copies.size < 2) return@mapNotNull null
      val safe = copies.sortedWith(compareBy({ it.photo.added }, { it.photo.uri.toString() }))
      val protected = safe.filter { !it.photo.owned || it.photo.favorite || taggedHash(it.photo.name) != hash }
      val keep = protected.ifEmpty { listOf(safe.first()) }
      val remove = safe.filter { it !in keep }
      if (remove.isEmpty()) null else Group(hash, keep, remove)
    }
    val token = UUID.randomUUID().toString()
    preview = token to groups
    return mapOf("token" to token, "scanned" to entries.size, "skipped" to skipped,
      "removeCount" to groups.sumOf { it.remove.size }, "groups" to groups.map { group ->
        mapOf("id" to group.hash, "copies" to group.keep.size + group.remove.size,
          "keepCount" to group.keep.size, "removeCount" to group.remove.size,
          "thumbnailUri" to group.keep.first().photo.uri.toString())
      })
  }
  private fun validatedDeletions(token: String): List<Uri> {
    requirePermission()
    val current = preview ?: error("预览已失效，请重新扫描")
    check(current.first == token) { "预览已失效，请重新扫描" }
    preview = null
    val now = photos(true).associateBy { it.uri }
    val uris = mutableListOf<Uri>()
    for (group in current.second) {
      for (item in group.keep + group.remove) {
        val photo = now[item.photo.uri] ?: error("照片已变化，请重新扫描")
        check(digestFile(photo.uri) == group.hash) { "照片已变化，请重新扫描" }
        if (item in group.remove) {
          check(photo.owned && !photo.favorite && taggedHash(photo.name) == group.hash) { "照片已变化，请重新扫描" }
          uris += photo.uri
        }
      }
    }
    return uris
  }
}
