import { toBase64 } from "./base64";
import { call, callDesktop, commands, isErrorKind } from "./ipc";
import { isRemoteWindow } from "./remote";

/** Text selected in the desktop's file dialog, including in a remote window. */
export function readDesktopText(path: string): Promise<string> {
  return isRemoteWindow() ? callDesktop<string>("fs_read_text", { path }) : call(commands.fsReadText(path));
}

/** Write UTF-8 to a path already confirmed in the desktop's save dialog. */
export async function writeDesktopText(path: string, text: string): Promise<void> {
  const data = toBase64(new TextEncoder().encode(text));
  if (!isRemoteWindow()) {
    await call(commands.fsDelete(path)).catch(() => {});
    await call(commands.fsCreateFileBytes(path, data));
    return;
  }
  const kind = await callDesktop<string>("fs_entry_kind", { path }).catch((e: unknown) => {
    if (!isErrorKind(e, "notFound")) throw e;
    return null;
  });
  if (kind === "file") await callDesktop("fs_delete", { path });
  await callDesktop("fs_create_file_bytes", { path, data });
}
