/** Where a project opens when this window already has one: System Settings › Project › "Open project in". */
import { t, tx } from "@/platform/i18n";
import { call, commands, type RemoteTarget } from "@/platform/ipc";
import { confirmLeaveProject, useProject } from "@/platform/project";
import { connectRemote, isRemoteWindow } from "@/platform/remote";
import { ask } from "./messages";
import { maybeEditorService } from "./contributions";

/** "Open project in": `new` | `same` | `ask`. */
export function openPolicy(): "ask" | "new" | "same" {
  const v = useProject.getState().settings?.general?.openProjectIn;
  return v === "new" || v === "same" ? v : "ask";
}

/**
 * The window to open project `name` in: this one when it has no project (or LightEdit session), else
 * per "Open project in", asking when set to (and remembering "Don't ask again").
 * `null`: cancelled.
 */
export async function chooseProjectWindow(
  name: string,
  allowAttach = true,
): Promise<"new" | "same" | "attach" | "tab" | null> {
  const { project, lightEdit } = useProject.getState();
  if (!project && !lightEdit) return "same";
  // Both ways of keeping this window's project: a workspace folder, or a project tab of this window.
  const canAdd = allowAttach && !!project && !isRemoteWindow();
  const mode = openPolicy();
  if (mode !== "ask") return mode;
  const r = await ask({
    title: t("app.window.askTitle"),
    width: canAdd ? 640 : undefined,
    body: canAdd
      ? tx`Projects can be opened in a new window, replace the current project, be attached to the already opened projects, or open as a new tab of this window.\nHow would you like to open "${name}"?`
      : t("app.window.askBody", { name }),
    buttons: [
      { id: "cancel", label: t("common.cancel") },
      ...(canAdd
        ? [
            { id: "attach", label: t("app.window.askAttach") },
            { id: "tab", label: tx`New Tab` },
          ]
        : []),
      { id: "new", label: t("app.window.askNew") },
      { id: "same", label: t("app.window.askThis"), primary: true },
    ],
    checkbox: t("app.window.askRemember"),
  });
  // "Attach" and "New Tab" are one-off: "Open project in" has no value for them, so Don't ask again ignores both.
  if (r.button !== "same" && r.button !== "new" && r.button !== "attach" && r.button !== "tab") return null;
  if (r.checked && (r.button === "same" || r.button === "new")) {
    try {
      useProject.setState({
        settings: await call(commands.settingsSet("global", "general.openProjectIn", JSON.stringify(r.button))),
      });
    } catch {
      /* the choice still applies to this open */
    }
  }
  return r.button;
}

/**
 * Opens folder `path` of `target` (an SSH host or a WSL distribution): focuses the
 * window that has it, else opens it in a new window or (`here`) this one per
 * "Open project in". `false`: cancelled.
 */
export async function openRemoteProject(
  target: RemoteTarget,
  path: string,
  here: () => Promise<unknown> = () => connectRemote(target, path),
): Promise<boolean> {
  if ((await call(commands.windowOpenRemote(target, path, false))).kind === "focused") return true;
  const mode = await chooseProjectWindow(path.replace(/\/+$/, "").split("/").pop() || path, false);
  if (!mode) return false;
  if (mode === "new") {
    await call(commands.windowOpenRemote(target, path, true));
    return true;
  }
  // The remote host's project doesn't take this window's untitled buffers.
  if (!(await confirmLeaveProject(false))) return false;
  try {
    await here();
    return true;
  } catch (e) {
    maybeEditorService()?.cancelClose?.();
    throw e;
  }
}
