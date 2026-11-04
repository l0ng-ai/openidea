package ai.l0ng.openidea

import android.os.Bundle
import android.system.Os
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Android sets no HOME: `~` (SSH keys, known_hosts) is the app's data directory.
    // Before super.onCreate, which starts the Rust side.
    Os.setenv("HOME", applicationInfo.dataDir, true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
