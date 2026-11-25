import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setContext } from "@/platform/context";
import { operationRepo } from "../actions";
import { useVcs } from "../store";

const ctx = vi.hoisted(() => ({ selection: [] as string[], active: null as string | null }));
vi.mock("@/workbench/contributions", async (original) => ({
  ...(await original<typeof import("@/workbench/contributions")>()),
  projectViewSelection: () => ctx.selection,
  maybeEditorService: () => ({ activePath: () => ctx.active }),
}));

const vcs = useVcs.getState();

beforeEach(() => {
  ctx.selection = [];
  ctx.active = null;
  setContext("activeToolWindow", "");
  useVcs.setState({ root: "/ws", roots: ["/ws/a", "/ws/b"], repo: "/ws/b" });
});

afterEach(() => {
  setContext("activeToolWindow", "");
  useVcs.setState(vcs);
});

describe("operationRepo", () => {
  it("starts on the repository of the action's files (context menus)", () => {
    expect(operationRepo(["/ws/a/src/x.ts"])).toBe("/ws/a");
    expect(operationRepo("/ws/a")).toBe("/ws/a");
    expect(operationRepo({ repo: "/ws/a" })).toBe("/ws/a");
  });

  it("from the keyboard, uses the focused Project view's selection, else the active editor's file", () => {
    ctx.selection = ["/ws/a/lib"];
    ctx.active = "/ws/b/main.ts";
    expect(operationRepo(undefined)).toBe("/ws/b");
    setContext("activeToolWindow", "project");
    expect(operationRepo(undefined)).toBe("/ws/a");
  });

  it("falls back to the selected repository", () => {
    useVcs.setState({ repo: "/ws/a" });
    expect(operationRepo(undefined)).toBe("/ws/a");
    expect(operationRepo(["/elsewhere/file"])).toBe("/ws/a");
  });
});
