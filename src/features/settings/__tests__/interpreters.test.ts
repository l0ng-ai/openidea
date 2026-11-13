import { describe, expect, it } from "vitest";
import type { ProjectInterpreter, Sdk } from "@/platform/ipc";
import {
  buildInterpreters,
  filterInterpreters,
  interpreterIcon,
  interpreterPathKey,
  owningProject,
  projectName,
  sameInterpreterPath,
  uniqueNames,
  type NamedProject,
} from "../languages/interpreters";

const sdk = (path: string, name: string, home: string | null = null, source = "venv"): Sdk => ({
  path,
  name,
  version: "3.12.0",
  source,
  home,
  extra: null,
});

const SYSTEM = sdk("/usr/bin/python3", "Python 3.12", "/usr", "system");
const PROJECT = sdk("/project/.venv/bin/python", "Python 3.12 (.venv)", "/project/.venv");
const OTHER = sdk("/apps/shop/.venv/bin/python", "Python 3.11 (shop)", "/apps/shop/.venv");
const ADDED = sdk("/envs/tools/bin/python", "Python 3.13 (tools)", "/envs/tools");

const PROJECTS: NamedProject[] = [
  { root: "/project", name: "backend" },
  { root: "/apps/shop", name: "Shop" },
];

const build = (over: Partial<Parameters<typeof buildInterpreters>[0]> = {}) =>
  buildInterpreters({
    detected: [SYSTEM, PROJECT],
    fromProjects: [{ project: "/apps/shop", sdk: OTHER } satisfies ProjectInterpreter],
    added: [ADDED],
    missing: [],
    hidden: [],
    current: PROJECT.path,
    currentProject: "/project",
    projects: PROJECTS,
    ...over,
  });

describe("Python interpreter list", () => {
  it("finds the closest project an interpreter lives in", () => {
    expect(owningProject("/project/.venv/bin/python", PROJECTS)).toBe("/project");
    expect(
      owningProject("/apps/shop/backend/.venv/bin/python", [
        ...PROJECTS,
        { root: "/apps/shop/backend", name: "backend" },
      ]),
    ).toBe("/apps/shop/backend");
    expect(owningProject("/opt/conda/envs/ml/bin/python", PROJECTS)).toBeNull();
    expect(projectName("/apps/shop", PROJECTS)).toBe("Shop");
    expect(projectName("/apps/other", PROJECTS)).toBe("other");
  });

  it("merges detected, other-project and added interpreters, current one first class", () => {
    const rows = build();
    expect(rows.map((row) => row.path)).toEqual([
      "/apps/shop/.venv/bin/python",
      "/usr/bin/python3",
      "/project/.venv/bin/python",
      "/envs/tools/bin/python",
    ]);
    const byPath = new Map(rows.map((row) => [row.path, row]));
    expect(byPath.get(OTHER.path)?.project).toBe("/apps/shop");
    expect(byPath.get(PROJECT.path)?.project).toBe("/project");
    expect(byPath.get(ADDED.path)?.added).toBe(true);
    expect(byPath.get(SYSTEM.path)?.project).toBeNull();
    expect(rows.every((row) => !row.invalid)).toBe(true);
  });

  it("removes hidden interpreters and lists a configured one that no longer runs", () => {
    const rows = build({ hidden: [OTHER.path], current: "/project/.venv/bin/python" });
    expect(rows.some((row) => row.path === OTHER.path)).toBe(false);
    // The interpreter in use stays listed even if it was removed: the project still points at it.
    const kept = build({ hidden: [PROJECT.path] });
    expect(kept.find((row) => row.path === PROJECT.path)).toMatchObject({ invalid: false });
    const gone = build({ current: "/project/gone/python", detected: [SYSTEM] });
    expect(gone.at(-1)).toMatchObject({ path: "/project/gone/python", invalid: true, project: "/project" });
    const missing = build({ added: [], missing: ["/envs/old/bin/python"] });
    expect(missing.find((row) => row.path === "/envs/old/bin/python")).toMatchObject({
      invalid: true,
      added: true,
    });
  });

  it("tells apart interpreters that share a name, as PyCharm does", () => {
    const one = sdk("/a/python", "Python 3.11", null, "system");
    const two = sdk("/b/python", "Python 3.11", null, "system");
    const rows = uniqueNames(build({ detected: [one, two], fromProjects: [], added: [], current: null }));
    expect(rows.map((row) => row.name)).toEqual(["Python 3.11", "Python 3.11 (2)"]);
  });

  it("filters by search text and by the project an interpreter belongs to", () => {
    const rows = build();
    expect(filterInterpreters(rows, { query: "tools", hideOther: false, currentProject: "/project" })).toHaveLength(1);
    expect(filterInterpreters(rows, { query: "cobol", hideOther: false, currentProject: "/project" })).toEqual([]);
    expect(
      filterInterpreters(rows, { query: "", hideOther: true, currentProject: "/project" }).map((row) => row.path),
    ).toEqual(["/usr/bin/python3", "/project/.venv/bin/python", "/envs/tools/bin/python"]);
    // Without an open project nothing belongs to "another" project.
    expect(filterInterpreters(rows, { query: "", hideOther: true, currentProject: null })).toHaveLength(4);
  });

  it("gives each environment source its own icon", () => {
    expect(interpreterIcon("venv")).toBe("python-venv");
    expect(interpreterIcon("pixi")).toBe("python-venv");
    expect(interpreterIcon("conda")).toBe("python-conda");
    expect(interpreterIcon("uv")).toBe("python-uv");
    expect(interpreterIcon("poetry")).toBe("python-poetry");
    expect(interpreterIcon("pyenv")).toBe("python-versions");
    expect(interpreterIcon("mise")).toBe("python-versions");
    expect(interpreterIcon("asdf")).toBe("python-versions");
    expect(interpreterIcon("system")).toBe("project-python");
    expect(interpreterIcon("")).toBe("project-python");
  });

  it("compares interpreter paths across separators, case and project-relative settings", () => {
    expect(sameInterpreterPath("/project/.venv/bin/python", "/project/.venv/bin/python", "/project")).toBe(true);
    expect(sameInterpreterPath(".venv/bin/python", "/project/.venv/bin/python", "/project")).toBe(true);
    expect(
      sameInterpreterPath("C:\\Project\\.venv\\Scripts\\python.exe", "c:/project/.venv/Scripts/python.exe", null),
    ).toBe(true);
    expect(sameInterpreterPath("/a/python", "/b/python", null)).toBe(false);
    // POSIX paths are case-sensitive; Windows paths are not (the drive letter decides, not the host OS).
    expect(sameInterpreterPath("/opt/Python/bin/python", "/opt/python/bin/python", null)).toBe(false);
    expect(interpreterPathKey("C:/Python/python.exe")).toBe("c:/python/python.exe");
    expect(interpreterPathKey("/opt/Python/python")).toBe("/opt/Python/python");
  });

  it("matches a `~/` setting against the interpreter it resolves to", () => {
    // The backend expands `~`; the frontend does not know the home directory.
    expect(
      sameInterpreterPath("~/.pyenv/versions/3.10/bin/python", "/home/me/.pyenv/versions/3.10/bin/python", null),
    ).toBe(true);
    expect(
      sameInterpreterPath("~/.pyenv/versions/3.10/bin/python", "/home/me/.pyenv/versions/3.11/bin/python", null),
    ).toBe(false);
    // `~/.venv` and a project-relative `.venv` resolve to the same absolute path.
    expect(sameInterpreterPath("~/.venv/bin/python", ".venv/bin/python", "/home/me")).toBe(true);
  });
});
