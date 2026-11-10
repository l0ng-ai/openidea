/**
 * Window title, IDEA style: `<project> – <file>`; with Settings › Appearance ›
 * "Always show full path in window header" the file's full path. A remote
 * project names its host: `<project> [<user@host>] – <file>`.
 */
import { useEditorRegistry } from "@/editor/api";
import { t, useI18n } from "@/platform/i18n";
import { isTauri } from "@/platform/ipc";
import { basename, useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";

export function windowTitle(
  project: string | null | undefined,
  file: string | null | undefined,
  fullPath = false,
  host: string | null = null,
): string {
  const name = file ? (fullPath ? file : basename(file)) : null;
  if (!project) return name ?? t("app.title.default");
  const where = host ? `${project} [${host}]` : project;
  return name ? `${where} – ${name}` : where;
}

export function installWindowTitle(): () => void {
  let last: string | null = null;
  let setNative: ((title: string) => void) | null = null;
  if (isTauri()) {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      setNative = (title) => void w.setTitle(title).catch(() => {});
      if (last !== null) setNative(last);
    });
  }
  const update = () => {
    const { project, settings } = useProject.getState();
    const fullPath = settings?.appearance?.fullPathInTitle === true;
    const host = useRemote.getState().session?.host ?? null;
    const title = windowTitle(
      project?.displayName || project?.name,
      useEditorRegistry.getState().active?.ctx.path,
      fullPath,
      host,
    );
    if (title === last) return;
    last = title;
    if (typeof document !== "undefined") document.title = title;
    setNative?.(title);
  };
  update();
  const unsubs = [
    useProject.subscribe(update),
    useEditorRegistry.subscribe(update),
    useI18n.subscribe(update),
    useRemote.subscribe(update),
  ];
  return () => unsubs.forEach((u) => u());
}
