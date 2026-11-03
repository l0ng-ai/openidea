import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { missingAdapter } from "./missingAdapter";
import { useOverlays } from "./ui/popoverStore";

/** Each request owns its popup state; late responses cannot reopen or overwrite another picker. */
export async function openAttachPopup(mode: "all" | "unity" = "all") {
  if (!isTauri()) {
    notifications().notify({ group: "run", level: "warning", title: "Attaching needs the desktop app" });
    return;
  }
  const projectRoot = useProject.getState().project?.root ?? null;
  const pending = { processes: null, error: null, mode, projectRoot };
  useOverlays.setState({ attach: pending });
  const current = () =>
    useOverlays.getState().attach === pending && (useProject.getState().project?.root ?? null) === projectRoot;
  try {
    const processes = await call(
      mode === "unity" ? commands.debugUnityProcesses() : commands.debugAttachableProcesses(),
    );
    if (current()) useOverlays.setState({ attach: { ...pending, processes } });
  } catch (e) {
    if (current())
      useOverlays.setState({
        attach: {
          ...pending,
          processes: [],
          error: e instanceof Error ? e.message : String(e),
          installTool: mode === "unity" ? missingAdapter("unity", e)?.tool : undefined,
        },
      });
  }
}

export async function installAttachAdapter() {
  const state = useOverlays.getState().attach;
  if (!state?.installTool) return;
  await executeAction("tools.install", state.installTool);
  if (useOverlays.getState().attach === state && useProject.getState().project?.root === state.projectRoot) {
    await openAttachPopup(state.mode);
  }
}
