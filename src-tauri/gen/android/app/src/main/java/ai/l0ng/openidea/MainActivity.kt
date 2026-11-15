package ai.l0ng.openidea

import android.os.Bundle
import android.system.Os
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Android sets no HOME: `~` (SSH keys, known_hosts) is the app's data directory.
    // Before super.onCreate, which starts the Rust side.
    Os.setenv("HOME", applicationInfo.dataDir, true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge (enforced from Android 15) draws the page under the status bar, the navigation
    // bar / taskbar, cutouts and the keyboard: keep the IDE inside them.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
