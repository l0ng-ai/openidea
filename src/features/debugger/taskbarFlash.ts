/**
 * IDEA-style taskbar flash while a breakpoint holds this window in the background:
 * the shell flashes the native window (`window_flash_taskbar`, which never flashes a
 * focused window), this side decides when to ask — on a breakpoint stop while the
 * window is unfocused — and stops the flash when the window is focused again or the
 * paused session resumes or ends.
 */
import { call, commands, isTauri } from "@/platform/ipc";

/** Whether this window started a flash that nothing has stopped yet. */
let flashing = false;
/** The reset listener is attached once per page, on the first flash request. */
let listening = false;

/** Stops the flash this window started (no-op when none is running: no extra IPC). */
export function stopTaskbarFlash() {
  if (!flashing) return;
  flashing = false;
  if (!isTauri()) return;
  void call(commands.windowFlashTaskbar(false)).catch(() => undefined);
}

/**
 * Asks the shell to flash the taskbar for a breakpoint hit in a background window.
 * While already flashing, further hits do not re-request attention; a window that
 * is focused right now (or became focused while the request was in flight) never
 * flashes.
 */
export function flashTaskbarForBreakpoint() {
  if (!isTauri()) return;
  if (!listening) {
    listening = true;
    window.addEventListener("focus", stopTaskbarFlash);
  }
  if (flashing || document.hasFocus()) return;
  flashing = true;
  void call(commands.windowFlashTaskbar(true)).catch(() => {
    flashing = false;
  });
}
