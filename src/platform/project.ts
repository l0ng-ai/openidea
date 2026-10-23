/** The project open in this window. */
import { create } from "zustand";
import { call, commands, type ProjectInfo, type Settings } from "./ipc";
import { isVirtualUri, virtualContainer, virtualName, virtualParent } from "./virtualDocs";

interface ProjectState {
  project: ProjectInfo | null;
  /** Effective settings (project-layered when a project is open). */
  settings: Settings | null;
  opening: boolean;
}

export const useProject = create<ProjectState>(() => ({ project: null, settings: null, opening: false }));

let leaveGuard: (() => Promise<boolean>) | null = null;

/** Installs the check run before this window leaves its project (unsaved changes). */
export function provideLeaveProjectGuard(guard: () => Promise<boolean>): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

/** False when the user chose to stay (another project in place, Close Project). */
export function confirmLeaveProject(): Promise<boolean> {
  return useProject.getState().project && leaveGuard ? leaveGuard() : Promise.resolve(true);
}

let startupLaunch: Promise<void> | null = null;

/** Installs this window's startup launch (the project it was started or created for, features/app/windows.ts). */
export function provideStartupLaunch(launch: Promise<void>) {
  startupLaunch = launch;
}

/** Settles once the startup launch has opened its project (if any), so a restore doesn't race it. */
export function startupLaunchHandled(): Promise<void> {
  return (startupLaunch ?? Promise.resolve()).catch(() => {});
}

export async function openProject(path: string): Promise<ProjectInfo> {
  useProject.setState({ opening: true });
  try {
    const project = await call(commands.openProject(path));
    useProject.setState({ project, settings: project.settings });
    return project;
  } finally {
    useProject.setState({ opening: false });
  }
}

export async function closeProject() {
  await commands.closeProject();
  useProject.setState({ project: null });
}

export async function loadSettings() {
  useProject.setState({ settings: await commands.settingsGet() });
}

/** Joins and normalises POSIX-style paths returned by the backend. */
/** Path relative to `root`; a virtual document (library class) shows where it comes from. */
export function relativePath(root: string, path: string): string {
  if (isVirtualUri(path)) return [virtualContainer(path), virtualName(path)].filter(Boolean).join(" › ");
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** Project-relative directory of `path`; "" for files directly in `root`. */
export function relativeDir(root: string, path: string): string {
  if (isVirtualUri(path)) return virtualContainer(path);
  const dir = dirname(path);
  return dir === root ? "" : relativePath(root, dir);
}

export function basename(path: string): string {
  if (isVirtualUri(path)) return virtualName(path);
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  if (isVirtualUri(path)) return virtualParent(path);
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
