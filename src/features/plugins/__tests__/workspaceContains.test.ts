import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getContext, setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import { usePlugins } from "../store";
import {
  affectsWorkspaceContains,
  refreshWorkspaceContains,
  startWorkspaceContains,
  workspaceContainsKeys,
} from "../workspaceContains";

const ipc = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: unknown) => void>,
  files: {} as Record<string, string[]>,
  readDir: vi.fn(),
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  isTauri: () => true,
  commands: { fsReadDir: (dir: string) => ipc.readDir(dir) },
  onIdeEvent: (name: string, handler: (e: unknown) => void) => {
    ipc.handlers[name] = handler;
    return () => {
      delete ipc.handlers[name];
    };
  },
}));

describe("workspaceContains", () => {
  it("collects keys from when clauses", () => {
    expect(
      workspaceContainsKeys([
        "workspaceContains:a/b.txt && editorFocus",
        null,
        "!workspaceContains:pom.xml",
        "workspaceContains:a/b.txt",
      ]),
    ).toEqual(["workspaceContains:a/b.txt", "workspaceContains:pom.xml"]);
  });

  it("sets each key from its parent folder's listing", async () => {
    const list = vi.fn(async (dir: string) => (dir === "/p/.devcontainer" ? ["devcontainer.json"] : ["src"]));
    await refreshWorkspaceContains(
      ["/p"],
      ["workspaceContains:.devcontainer/devcontainer.json", "workspaceContains:pom.xml"],
      list,
    );
    expect(getContext()["workspaceContains:.devcontainer/devcontainer.json"]).toBe(true);
    expect(getContext()["workspaceContains:pom.xml"]).toBe(false);
    expect(list).toHaveBeenCalledWith("/p");
  });

  it("is false without a project or when the folder can't be read", async () => {
    const list = vi.fn(async (): Promise<string[]> => {
      throw new Error("missing");
    });
    await refreshWorkspaceContains(["/p"], ["workspaceContains:x/y"], list);
    expect(getContext()["workspaceContains:x/y"]).toBe(false);
    setContext("workspaceContains:x/y", true);
    list.mockClear();
    await refreshWorkspaceContains([], ["workspaceContains:x/y"], list);
    expect(list).not.toHaveBeenCalled();
    expect(getContext()["workspaceContains:x/y"]).toBe(false);
  });

  it("is true when any root contains the path", async () => {
    const list = vi.fn(async (dir: string) => (dir === "/b" ? ["pom.xml"] : []));
    await refreshWorkspaceContains(["/a", "/b"], ["workspaceContains:pom.xml"], list);
    expect(getContext()["workspaceContains:pom.xml"]).toBe(true);
  });

  it("ignores keys that are absolute or climb out of the project, and a trailing slash", async () => {
    const list = vi.fn(async (dir: string) => (dir === "/p" ? [".devcontainer"] : []));
    await refreshWorkspaceContains(
      ["/p"],
      [
        "workspaceContains:/etc/passwd",
        "workspaceContains:../a",
        "workspaceContains:a/../../b",
        "workspaceContains:.devcontainer/",
      ],
      list,
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("/p");
    expect(getContext()["workspaceContains:/etc/passwd"]).toBe(false);
    expect(getContext()["workspaceContains:../a"]).toBe(false);
    expect(getContext()["workspaceContains:a/../../b"]).toBe(false);
    expect(getContext()["workspaceContains:.devcontainer/"]).toBe(true);
  });

  it("only picks keys at a word boundary", () => {
    expect(workspaceContainsKeys(["xworkspaceContains:../a", "a && workspaceContains:b"])).toEqual([
      "workspaceContains:b",
    ]);
  });

  it("refreshes only when a watched path or one of its parents changes", () => {
    const keys = ["workspaceContains:.devcontainer/devcontainer.json"];
    const affects = (paths: string[], roots = ["/p"]) => affectsWorkspaceContains(paths, roots, keys);
    expect(affects(["/p2/x"])).toBe(false);
    expect(affects(["/p/src/a.ts"])).toBe(false);
    expect(affects(["/p/.devcontainer"])).toBe(true);
    expect(affects(["/p/.devcontainer/devcontainer.json"])).toBe(true);
    expect(affects(["/q/.devcontainer"], ["/p", "/q"])).toBe(true);
    expect(affects(["/p/.devcontainer"], [])).toBe(false);
  });

  it("ignores a stale refresh that resolves after a newer one", async () => {
    const key = "workspaceContains:pom.xml";
    let releaseOld: (names: string[]) => void = () => {};
    let releaseNew: (names: string[]) => void = () => {};
    const old = new Promise<string[]>((resolve) => (releaseOld = resolve));
    const fresh = new Promise<string[]>((resolve) => (releaseNew = resolve));
    let latest = 0;
    const first = refreshWorkspaceContains(
      ["/a"],
      [key],
      () => old,
      (
        (t) => () =>
          t === latest
      )(++latest),
    );
    const second = refreshWorkspaceContains(
      ["/b"],
      [key],
      () => fresh,
      (
        (t) => () =>
          t === latest
      )(++latest),
    );
    releaseNew(["pom.xml"]);
    await second;
    releaseOld([]);
    await first;
    expect(getContext()[key]).toBe(true);
  });
});

describe.each(["menus", "views"])("startWorkspaceContains (%s)", (point) => {
  const key = "workspaceContains:.devcontainer/devcontainer.json";
  const setProject = (root: string) => useProject.setState({ project: { root, workspace: null } as never });
  const keyIs = (value: boolean) => vi.waitFor(() => expect(getContext()[key]).toBe(value));
  const emit = (name: string, event: unknown) => {
    const handler = ipc.handlers[name];
    if (!handler) {
      throw new Error(`no handler for ${name}`);
    }
    handler(event);
  };
  let stop: () => void;

  beforeEach(() => {
    ipc.files = { "/p": ["src"], "/q": [".devcontainer"], "/q/.devcontainer": ["devcontainer.json"] };
    ipc.readDir.mockReset();
    ipc.readDir.mockImplementation(async (dir: string) => (ipc.files[dir] ?? []).map((name) => ({ name })));
    usePlugins.setState({ ui: [{ pluginId: "x", point, key: "k", decl: { when: key } }] as never });
    setProject("/p");
    setContext(key, undefined);
    stop = startWorkspaceContains();
  });

  afterEach(() => stop());

  it("re-evaluates when the file is created and deleted", async () => {
    await keyIs(false);
    ipc.files["/p"] = [".devcontainer"];
    ipc.files["/p/.devcontainer"] = ["devcontainer.json"];
    emit("fsChanged", { created: ["/p/.devcontainer"], modified: [], removed: [] });
    await keyIs(true);

    ipc.files["/p/.devcontainer"] = [];
    emit("fsChanged", { created: [], modified: [], removed: ["/p/.devcontainer/devcontainer.json"] });
    await keyIs(false);
  });

  it("re-evaluates when the project changes", async () => {
    await keyIs(false);
    setProject("/q");
    await keyIs(true);
  });

  it.each([["/p/.devcontainer"], ["/p"]])("re-evaluates when ignored folder %s changes", async (dir) => {
    await keyIs(false);
    ipc.files["/p/.devcontainer"] = ["devcontainer.json"];
    emit("excludedDirsChanged", { dirs: [dir] });
    await keyIs(true);
  });

  it("ignores unrelated changes", async () => {
    await keyIs(false);
    ipc.readDir.mockClear();
    emit("fsChanged", { created: ["/p/src/a.ts"], modified: [], removed: [] });
    emit("excludedDirsChanged", { dirs: ["/p/node_modules"] });
    expect(ipc.readDir).not.toHaveBeenCalled();
  });

  it("stops listening when disposed", async () => {
    await keyIs(false);
    stop();
    expect(ipc.handlers.fsChanged).toBeUndefined();
    expect(ipc.handlers.excludedDirsChanged).toBeUndefined();
  });
});
