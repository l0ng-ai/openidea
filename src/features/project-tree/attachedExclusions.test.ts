import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateProjectStructure } from "@/platform/languageSettings";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { resolveMenuItems, type MenuItem } from "@/ui";
import { contextMenuItems } from "./contextMenu";
import { directoryRole, markDirectory } from "./markDirectory";
import type { ProjectNode } from "./model";
import { useProjectTree } from "./store";

const memberSet = vi.fn();
const settingsSet = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      projectWorkspaceMemberSet: (...a: unknown[]) => memberSet(...a),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
      settingsGet: async () => ({ status: "ok", data: {} }),
    },
  };
});

const ROOT = "/w/app";
const LIB = "/w/lib";

const folder = (path: string): ProjectNode => ({
  key: path,
  path,
  chain: [path],
  label: path.slice(path.lastIndexOf("/") + 1),
  dir: true,
  root: false,
  entry: null,
  ignored: false,
  excluded: false,
  symlink: false,
});

const markAs = (path: string) => {
  const item = resolveMenuItems(contextMenuItems([folder(path)])).find((r) => r.label === "Mark Directory as");
  return item?.submenu ? resolveMenuItems(item.submenu as MenuItem[]).map((r) => r.label) : undefined;
};

beforeEach(() => {
  memberSet.mockReset().mockResolvedValue({ status: "ok", data: null });
  settingsSet.mockReset().mockResolvedValue({ status: "ok", data: {} });
  useProjectTree.setState({ root: ROOT });
  useProject.setState({
    project: {
      name: "app",
      root: ROOT,
      trusted: true,
      isGit: false,
      settings: {},
      workspace: { version: 1, name: "app", projects: [ROOT, LIB] },
    } as never,
    settings: { projectStructure: { excluded: ["gen"] } } as never,
  });
  // `lib` excludes its `notes` and has a `target` detected from its build file.
  useProjectRoots.setState({
    root: ROOT,
    detected: [],
    attached: [
      {
        root: LIB,
        structure: validateProjectStructure({ excluded: ["notes"] }),
        detected: [{ path: "target", kind: "excluded", detectedFrom: "pom.xml" }],
      },
    ],
  });
});

afterEach(() => {
  useProject.setState({ project: null, settings: null });
  useProjectTree.setState({ root: null });
  useProjectRoots.setState({ root: null, detected: [], attached: [] });
});

describe("Mark Directory as in an attached project", () => {
  it("reads each project's own exclusions", () => {
    expect(directoryRole(`${ROOT}/gen`)).toBe("excluded");
    expect(directoryRole(`${LIB}/gen`)).toBeNull();
    expect(directoryRole(`${LIB}/notes`)).toBe("excluded");
    expect(directoryRole(`${LIB}/target`)).toBe("excluded");
  });

  it("offers Excluded or Cancel Exclusion only", () => {
    expect(markAs(`${LIB}/gen`)).toEqual(["Excluded"]);
    expect(markAs(`${LIB}/notes`)).toEqual(["Cancel Exclusion"]);
    expect(markAs(`${ROOT}/src`)).toContain("Sources Root");
    expect(markAs("/elsewhere/gen")).toBeUndefined();
  });

  it("writes to the attached project's settings, not the open project's", async () => {
    await markDirectory(`${LIB}/gen`, "excluded");
    expect(memberSet).toHaveBeenCalledWith(LIB, "projectStructure.excluded", '["gen","notes"]');
    await markDirectory(`${LIB}/notes`, null);
    expect(memberSet).toHaveBeenCalledWith(LIB, "projectStructure.excluded", "[]");
    // A detected exclusion is cancelled by unmarking it, as in the open project.
    await markDirectory(`${LIB}/target`, null);
    expect(memberSet).toHaveBeenCalledWith(LIB, "projectStructure.unmarked", '["target"]');
    expect(settingsSet).not.toHaveBeenCalled();
  });
});
