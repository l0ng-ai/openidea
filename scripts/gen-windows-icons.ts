import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const icons = join(root, "src-tauri", "icons");
const tempRoot = realpathSync(tmpdir());
const output = mkdtempSync(join(tempRoot, "openidea-windows-icons-"));
function removeOutput() {
  // Only remove the unique directory this invocation created inside the system temp directory.
  if (dirname(realpathSync(output)) !== tempRoot) throw new Error("Unexpected icon output directory");
  rmSync(output, { recursive: true, force: true });
}
try {
  const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  const result = spawnSync(
    process.execPath,
    [cli, "icon", join(icons, "source", "openidea-windows.svg"), "--output", output],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed (${result.status})`);
  for (const name of [
    "icon.ico",
    "StoreLogo.png",
    ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((size) => `Square${size}x${size}Logo.png`),
  ]) {
    copyFileSync(join(output, name), join(icons, name));
  }
} finally {
  removeOutput();
}
