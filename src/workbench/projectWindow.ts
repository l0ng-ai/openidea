/** Where a project opens when this window already has one: System Settings › Project › "Open project in". */
import { t } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { confirmLeaveProject, useProject } from "@/platform/project";
import { connectRemote, isRemoteWindow } from "@/platform/remote";
import { ask } from "./messages";
import { maybeEditorService } from "./contributions";

/** "Open project in": `new` | `same` | `attach` | `ask`. */
export function openPolicy(): "ask" | "new" | "same" | "attach" {
  const v = useProject.getState().settings?.general?.openProjectIn;
  return v === "new" || v === "same" || v === "attach" ? v : "ask";
}

/**
 * The window to open project `name` in: this one when it has no project (or LightEdit session), else
 * per "Open project in", asking when set to (and remembering "Don't ask again").
 * `null`: cancelled.
 */
export async function chooseProjectWindow(name: string, allowAttach = true): Promise<"new" | "same" | "attach" | null> {
  const { project, lightEdit } = useProject.getState();
  if (!project && !lightEdit) return "same";
  const canAttach = allowAttach && !!project && !isRemoteWindow();
  const policy = openPolicy();
  const mode = policy === "attach" && !canAttach ? "ask" : policy;
  if (mode !== "ask") return mode;
  const r = await ask({
    title: t("app.window.askTitle"),
    width: canAttach ? 640 : undefined,
    body: t("app.window.askBody", { name }),
    buttons: [
      { id: "cancel", label: t("common.cancel") },
      ...(canAttach ? [{ id: "attach", label: t("app.window.askAttach") }] : []),
      { id: "new", label: t("app.window.askNew") },
      { id: "same", label: t("app.window.askThis"), primary: true },
    ],
    checkbox: t("app.window.askRemember"),
  });
  if (r.button !== "same" && r.button !== "new" && r.button !== "attach") return null;
  if (r.checked) {
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
 * Opens folder `path` on the host of SSH configuration `sshConfig`: focuses the
 * window that has it, else opens it in a new window or (`here`) this one per
 * "Open project in". `false`: cancelled.
 */
export async function openRemoteProject(
  sshConfig: string,
  path: string,
  here: () => Promise<unknown> = () => connectRemote(sshConfig, path),
): Promise<boolean> {
  if ((await call(commands.windowOpenRemote(sshConfig, path, false))).kind === "focused") return true;
  const mode = await chooseProjectWindow(path.replace(/\/+$/, "").split("/").pop() || path, false);
  if (!mode) return false;
  if (mode === "new") {
    await call(commands.windowOpenRemote(sshConfig, path, true));
    return true;
  }
  if (!(await confirmLeaveProject())) return false;
  try {
    await here();
    return true;
  } catch (e) {
    maybeEditorService()?.cancelClose?.();
    throw e;
  }
}
