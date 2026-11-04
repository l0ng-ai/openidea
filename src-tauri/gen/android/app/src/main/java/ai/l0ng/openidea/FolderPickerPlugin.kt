package ai.l0ng.openidea

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import android.webkit.WebView
import android.widget.EditText
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class PickFolderArgs {
  var title: String? = null
  var defaultPath: String? = null
}

/**
 * Folder picker for Android, where tauri-plugin-dialog cannot pick folders.
 * Shows a path field (type a path) with a "Browse…" button (the system folder picker).
 * The backend works on file paths, so a picked tree URI is mapped back to a path.
 */
@TauriPlugin
class FolderPickerPlugin(private val activity: Activity) : Plugin(activity) {

  // The IDE reads and auto-saves projects anywhere on shared storage.
  override fun load(webView: WebView) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
      activity.startActivity(
        Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:${activity.packageName}"))
      )
    }
  }

  @Command
  fun pickFolder(invoke: Invoke) {
    val args = invoke.parseArgs(PickFolderArgs::class.java)
    activity.runOnUiThread {
      val input = EditText(activity).apply {
        setSingleLine()
        setText(args.defaultPath ?: Environment.getExternalStorageDirectory().path)
      }
      AlertDialog.Builder(activity)
        .setTitle(args.title ?: "Select Folder")
        .setView(input)
        .setPositiveButton("Open") { _, _ -> finish(invoke, input.text.toString().trim().ifEmpty { null }) }
        .setNeutralButton("Browse…") { _, _ ->
          startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "onTreePicked")
        }
        .setNegativeButton("Cancel") { _, _ -> finish(invoke, null) }
        .setOnCancelListener { finish(invoke, null) }
        .show()
    }
  }

  @ActivityCallback
  fun onTreePicked(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) return finish(invoke, null)
    val path = treePath(uri) ?: return invoke.reject("Cannot open $uri: pick a folder on device storage")
    finish(invoke, path)
  }

  private fun finish(invoke: Invoke, path: String?) {
    if (path != null && !File(path).canRead()) {
      return invoke.reject("OpenIDEA cannot read $path. Allow \"All files access\", or use a folder on shared storage.")
    }
    invoke.resolve(JSObject().put("path", path))
  }

  /** Tree URI to file path: external storage volumes, or providers whose ids are paths (e.g. Termux). */
  private fun treePath(uri: Uri): String? {
    val id = DocumentsContract.getTreeDocumentId(uri)
    if (uri.authority == "com.android.externalstorage.documents") {
      val volume = id.substringBefore(':')
      val relative = id.substringAfter(':', "")
      val root = if (volume == "primary") Environment.getExternalStorageDirectory().path else "/storage/$volume"
      return if (relative.isEmpty()) root else "$root/$relative"
    }
    return id.takeIf { it.startsWith("/") }
  }
}
