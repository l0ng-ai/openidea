import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import type { RemoteSession } from "@/platform/ipc";
import { handleFileDrop, type FileDropDeps } from "./fileDrop";

function deps(dirs: string[] = []) {
  const calls: string[] = [];
  const d: FileDropDeps = {
    isDir: async (p) => dirs.includes(p),
    openFile: async (p, focus) => void calls.push(`file ${p}${focus ? " (focus)" : ""}`),
    openProject: async (p) => void calls.push(`project ${p}`),
  };
  return { d, calls };
}

/** A window with the editor, a Project view (owns drops) with a row, and the prompt box (owns drops). */
function mountWindow() {
  document.body.innerHTML = `
    <main id="editor"><div id="tabs"></div></main>
    <div id="project" data-owns-file-drop><div id="row"><span>src</span></div></div>
    <div id="composer" data-owns-file-drop><textarea id="prompt"></textarea></div>`;
  const at: Record<string, string> = { "1,1": "tabs", "2,2": "row", "3,3": "prompt", "4,4": "project" };
  document.elementFromPoint = (x: number, y: number) => {
    const id = at[`${x},${y}`];
    return id ? document.getElementById(id) : null;
  };
}

describe("files dropped from the OS", () => {
  beforeEach(() => {
    mountWindow();
    useProject.setState({ project: { root: "/p", name: "p" } } as never);
  });
  afterEach(() => {
    useProject.setState({ project: null } as never);
    useRemote.setState({ session: null });
    document.body.innerHTML = "";
  });

  it("opens each dropped file in its own tab, focusing the last; works for files outside the project", async () => {
    const { d, calls } = deps();
    await handleFileDrop(["/p/a.ts", "/elsewhere/notes.md"], 1, 1, d);
    expect(calls).toEqual(["file /p/a.ts", "file /elsewhere/notes.md (focus)"]);
  });

  it("opens a dropped folder as a project, after the files", async () => {
    const { d, calls } = deps(["/work/other", "/work/third"]);
    await handleFileDrop(["/work/other", "/x/readme.txt", "/work/third"], 1, 1, d);
    expect(calls).toEqual(["file /x/readme.txt (focus)", "project /work/other"]);
  });

  it("opens a path it cannot classify as a file", async () => {
    const { d, calls } = deps();
    d.isDir = () => Promise.reject(new Error("gone"));
    await handleFileDrop(["/gone.txt"], 1, 1, d);
    expect(calls).toEqual(["file /gone.txt (focus)"]);
  });

  it("keeps opening the rest when one file fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { d, calls } = deps();
    const open = d.openFile;
    d.openFile = (p, f) => (p === "/bad" ? Promise.reject(new Error("denied")) : open(p, f));
    await handleFileDrop(["/bad", "/good"], 1, 1, d);
    expect(calls).toEqual(["file /good (focus)"]);
  });

  it.each([
    ["a Project view row", 2, 2],
    ["the Project view background", 4, 4],
    ["the prompt box", 3, 3],
  ])("leaves drops over %s to that region", (_, x, y) => {
    const { d, calls } = deps(["/dir"]);
    expect(handleFileDrop(["/a.ts", "/dir"], x, y, d)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("acts on drops outside any element (window chrome)", async () => {
    const { d, calls } = deps();
    await handleFileDrop(["/a.ts"], 9, 9, d);
    expect(calls).toEqual(["file /a.ts (focus)"]);
  });

  it("leaves drops to the Welcome screen when no project is open, and ignores remote windows", () => {
    const { d } = deps();
    useProject.setState({ project: null } as never);
    expect(handleFileDrop(["/a.ts"], 1, 1, d)).toBeNull();
    useProject.setState({ project: { root: "/p", name: "p" } } as never);
    useRemote.setState({ session: {} as RemoteSession });
    expect(handleFileDrop(["/a.ts"], 1, 1, d)).toBeNull();
    expect(handleFileDrop([], 1, 1, d)).toBeNull();
  });

  it("opens drops on a LightEdit window as more tabs there; a folder still opens as a project", async () => {
    const { d, calls } = deps(["/work/app"]);
    useProject.setState({ project: null, lightEdit: true } as never);
    await handleFileDrop(["/x/b.txt", "/work/app"], 1, 1, d);
    expect(calls).toEqual(["file /x/b.txt (focus)", "project /work/app"]);
    useProject.setState({ lightEdit: false } as never);
  });
});
