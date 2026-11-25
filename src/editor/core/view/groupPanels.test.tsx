import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { registerEditorGroupPanel, registerEditorKind, type EditorInput } from "@/workbench/contributions";
import { useTabs } from "../controller";
import type { Tab } from "../model/tabs";
import { EditorAreaView } from "./EditorArea";

vi.mock("../controller", async (original) => ({
  ...(await original<object>()),
  editorController: () => ({ publishContext: vi.fn(), tabMenu: () => [] }),
}));
vi.mock("./TextEditorHost", () => ({ TextEditorHost: () => <input aria-label="Source" /> }));
vi.mock("./FindBar", () => ({ FindBar: () => null }));
vi.mock("./Banner", () => ({ EditorBanners: () => null, VirtualBanner: () => null }));
vi.mock("./StatusItems", () => ({ CodeBreadcrumbs: () => null }));

const mounts: string[] = [];
function Panel({ paneId, tabId }: { paneId: string; tabId: string | null }) {
  useState(() => mounts.push(paneId));
  return <div data-testid={`panel-${paneId}`}>{tabId ?? "none"}</div>;
}
const disposers = [
  registerEditorKind({
    kind: "image",
    component: ({ input }: { input: EditorInput }) => <p>{input.key}</p>,
    title: (i) => i.key,
  }),
  registerEditorGroupPanel({ id: "test.minimap", width: 90, component: Panel }),
];

const file = (id: string): Tab => ({
  id,
  input: { kind: "file", key: id, path: `/p/${id}` },
  preview: false,
  pinned: false,
});
const image = (id: string): Tab => ({ id, input: { kind: "image", key: id }, preview: false, pinned: false });
const original = useTabs.getState();
const hidden = (paneId: string) => !!screen.getByTestId(`panel-${paneId}`).closest("[hidden]");

afterEach(() => {
  cleanup();
  mounts.length = 0;
  useTabs.setState(original, true);
});
afterAll(() => disposers.forEach((d) => d()));

describe("editor group panels", () => {
  it("mount once per group, follow its text tab, and hide for other editors", () => {
    const tabs = [file("a"), file("b"), image("c")];
    const show = (active: string) =>
      act(() =>
        useTabs.setState({
          layout: { kind: "pane", paneId: "p1" },
          panes: { p1: { id: "p1", tabs, active, mru: [active] } },
          activePane: "p1",
          closed: [],
        }),
      );
    show("a");
    render(<EditorAreaView />);
    expect(screen.getByTestId("panel-p1").textContent).toBe("a");
    expect(screen.getByTestId("panel-p1").parentElement!.style.width).toBe("90px");
    show("b");
    expect(screen.getByTestId("panel-p1").textContent).toBe("b");
    expect(hidden("p1")).toBe(false);
    show("c");
    expect(screen.getByTestId("panel-p1").textContent).toBe("none");
    expect(hidden("p1")).toBe(true);
    show("a");
    expect(hidden("p1")).toBe(false);
    expect(mounts).toEqual(["p1"]);
  });

  it("gives each side of a split its own panel", () => {
    act(() =>
      useTabs.setState({
        layout: {
          kind: "split",
          id: "s",
          dir: "row",
          children: [
            { kind: "pane", paneId: "p1" },
            { kind: "pane", paneId: "p2" },
          ],
        },
        panes: {
          p1: { id: "p1", tabs: [file("a")], active: "a", mru: ["a"] },
          p2: { id: "p2", tabs: [file("b")], active: "b", mru: ["b"] },
        },
        activePane: "p1",
        closed: [],
      }),
    );
    render(<EditorAreaView />);
    expect(screen.getByTestId("panel-p1").textContent).toBe("a");
    expect(screen.getByTestId("panel-p2").textContent).toBe("b");
  });
});
