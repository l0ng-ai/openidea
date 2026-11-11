/**
 * File and folder pickers. Same calls as `@tauri-apps/plugin-dialog`, which shows the desktop's own
 * chooser through xdg-desktop-portal on Linux. When a Linux session has neither a portal nor
 * `zenity`, the plugin returns nothing and a picker looks cancelled, so those sessions get a GTK
 * chooser from the backend instead.
 */
import {
  open as pluginOpen,
  save as pluginSave,
  type OpenDialogOptions,
  type OpenDialogReturn,
  type SaveDialogOptions,
} from "@tauri-apps/plugin-dialog";
import { call, commands } from "@/platform/ipc";

let needsGtk: boolean | undefined;
// Asked once when the module loads, so a picker only waits for the answer if it opens first.
const probe = (async () => {
  try {
    needsGtk = await commands.fileDialogNeedsGtk();
  } catch {
    needsGtk = false;
  }
})();

async function pluginDialogsUnavailable(): Promise<boolean> {
  if (needsGtk === undefined) await probe;
  return needsGtk === true;
}

type Filters = OpenDialogOptions["filters"];

function gtkFilters(filters: Filters) {
  return (filters ?? []).map(({ name, extensions }) => ({ name, extensions }));
}

async function gtkPick(options: {
  title?: string;
  defaultPath?: string;
  directory?: boolean;
  multiple?: boolean;
  save?: boolean;
  filters?: Filters;
}): Promise<string[] | null> {
  return call(
    commands.gtkPickPaths({
      title: options.title ?? null,
      defaultPath: options.defaultPath ?? null,
      directory: options.directory ?? false,
      multiple: options.multiple ?? false,
      save: options.save ?? false,
      filters: gtkFilters(options.filters),
    }),
  );
}

export async function open<T extends OpenDialogOptions>(options: T = {} as T): Promise<OpenDialogReturn<T>> {
  if (needsGtk === false || !(await pluginDialogsUnavailable())) return pluginOpen(options);
  const paths = await gtkPick(options);
  return (options.multiple ? paths : (paths?.[0] ?? null)) as OpenDialogReturn<T>;
}

export async function save(options: SaveDialogOptions = {}): Promise<string | null> {
  if (needsGtk === false || !(await pluginDialogsUnavailable())) return pluginSave(options);
  return (await gtkPick({ ...options, save: true }))?.[0] ?? null;
}
