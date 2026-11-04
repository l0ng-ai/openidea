/**
 * `@tauri-apps/plugin-dialog` as the app imports it (a Vite alias points here):
 * the package itself, except that folder requests on Android go to the app's own
 * folder picker (src-tauri/gen/android/.../FolderPickerPlugin.kt): the plugin
 * cannot pick folders on mobile.
 */
import { open as openPlugin } from "../../node_modules/@tauri-apps/plugin-dialog/dist-js/index.js";
import { invoke } from "@tauri-apps/api/core";

export * from "../../node_modules/@tauri-apps/plugin-dialog/dist-js/index.js";

const android = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

export const open = (async (options) => {
  if (!android || !options?.directory) return openPlugin(options);
  const { path } = await invoke<{ path?: string }>("plugin:folder-picker|pick_folder", {
    title: options.title,
    defaultPath: options.defaultPath,
  });
  if (!path) return null;
  return options.multiple ? [path] : path;
}) as typeof openPlugin;
