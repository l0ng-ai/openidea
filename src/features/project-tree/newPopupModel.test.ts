import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import type { MenuItem } from "@/ui";
import { registerMenuGroup } from "@/workbench/contributions";
import { newMenuItems } from "./contextMenu";
import { closeNewPopup, newPopupRows, openNewPopup, useNewPopup } from "./newPopupModel";
import { useProjectTree } from "./store";

vi.mock("@/platform/actions", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/platform/actions")>();
  return { ...mod, executeAction: vi.fn(mod.executeAction) };
});

const ROOT = "/p";
const labels = (items: MenuItem[], q = "") => newPopupRows(items, q).map((r) => (r.separator ? "-" : r.label));

let disposers: Array<() => void> = [];

beforeEach(() => {
  useProjectTree.setState({ root: ROOT });
  useProject.setState({
    project: { name: "p", root: ROOT, trusted: true, isGit: false, settings: {} } as never,
    settings: {} as never,
  });
  disposers = [
    registerActions([
      { id: "templates.new.file", title: "New Empty File…", run: () => undefined },
      { id: "templates.new.python", title: "New Python File…", run: () => undefined },
      {
        id: "templates.new.stylesheet",
        title: "New Stylesheet…",
        keywords: ["new", "css", "scss", "less"],
        run: () => undefined,
      },
      { id: "http.newRequest", title: "New HTTP Request", run: () => undefined },
    ]),
    registerMenuGroup({
      id: "test.templates",
      menus: ["new"],
      order: 10,
      items: (_menu, ctx) => [
        { kind: "action", action: "templates.new.python", arg: { directory: ctx.paths[0] }, label: "Python File" },
        { kind: "action", action: "templates.new.stylesheet", arg: { directory: ctx.paths[0] }, label: "Stylesheet" },
      ],
    }),
    registerMenuGroup({
      id: "test.http",
      menus: ["new"],
      order: 20,
      items: (_menu, { paths: [directory] }) =>
        directory ? [{ kind: "action", action: "http.newRequest", arg: { directory }, label: "HTTP Request" }] : [],
    }),
  ];
});

afterEach(() => {
  disposers.forEach((d) => d());
  closeNewPopup();
  vi.mocked(executeAction).mockClear();
  useProject.setState({ project: null, settings: null });
  useProjectTree.setState({ root: null });
});

describe("New popup", () => {
  it("lists File, Directory and the contributed file kinds", () => {
    expect(labels(newMenuItems(`${ROOT}/src`))).toEqual([
      "File",
      "Directory",
      "-",
      "Python File",
      "Stylesheet",
      "-",
      "HTTP Request",
    ]);
  });

  it("passes the target directory to contributed kinds", () => {
    const http = newMenuItems(`${ROOT}/api`).find((i) => i.kind === "action" && i.action === "http.newRequest");
    expect(http).toMatchObject({ arg: { directory: `${ROOT}/api` } });
  });

  it("filters by label, then by keyword, without separators", () => {
    const items = newMenuItems(ROOT);
    expect(labels(items, "py")).toEqual(["Python File"]);
    expect(labels(items, "css")).toEqual(["Stylesheet"]);
    expect(labels(items, "http")).toEqual(["HTTP Request"]);
    expect(labels(items, "zzz")).toEqual([]);
    expect(newPopupRows(items, "py")[0]!.matches).toEqual([0, 1]);
  });

  it("asks for the file name in a dialog outside the project view", () => {
    const file = newMenuItems(`${ROOT}/src`, { outsideTree: true })[0] as { label: string; run: () => void };
    expect(file.label).toBe("File");
    file.run();
    expect(executeAction).toHaveBeenCalledWith("templates.new.file", { directory: `${ROOT}/src` });
  });

  it("opens with a fresh request each time", () => {
    openNewPopup({ x: 1, y: 2 }, []);
    const first = useNewPopup.getState().request!.seq;
    openNewPopup({ x: 1, y: 2 }, []);
    expect(useNewPopup.getState().request!.seq).toBe(first + 1);
    closeNewPopup();
    expect(useNewPopup.getState().request).toBeNull();
  });
});
