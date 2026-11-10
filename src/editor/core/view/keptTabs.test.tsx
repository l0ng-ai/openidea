import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { registerEditorKind, type EditorInput } from "@/workbench/contributions";
import { useTabs } from "../controller";
import type { Tab } from "../model/tabs";
import { EditorAreaView } from "./EditorArea";

vi.mock("../controller", async (original) => ({
  ...(await original<object>()),
  editorController: () => ({ publishContext: vi.fn(), tabMenu: () => [] }),
}));
vi.mock("./TextEditorHost", () => ({
  TextEditorHost: () => <input aria-label="Source" />,
}));
vi.mock("./FindBar", () => ({ FindBar: () => null }));
vi.mock("./Banner", () => ({
  EditorBanners: () => null,
  VirtualBanner: () => null,
}));
vi.mock("./StatusItems", () => ({ CodeBreadcrumbs: () => null }));

const mounts: string[] = [];
function Kept({ input }: { input: EditorInput }) {
  const name = input.key;
  useState(() => mounts.push(name));
  return <div data-testid={name}>{name}</div>;
}
const disposers = [
  registerEditorKind({
    kind: "kept",
    component: Kept,
    title: (i) => i.key,
    keepAlive: true,
  }),
  registerEditorKind({ kind: "plain", component: Kept, title: (i) => i.key }),
];

/** Shown, or kept mounted behind the shown tab (its rendering skipped). */
const shown = (id: string) => !screen.getByTestId(id).closest("[aria-hidden]");

const tab = (id: string, kind: string): Tab => ({
  id,
  input: { kind, key: id },
  preview: false,
  pinned: false,
});
const original = useTabs.getState();

function show(tabs: Tab[], active: string) {
  act(() =>
    useTabs.setState((s) => {
      const mru = [active, ...(s.panes.p1?.mru ?? []).filter((id) => id !== active && tabs.some((t) => t.id === id))];
      return {
        layout: { kind: "pane", paneId: "p1" },
        panes: { p1: { id: "p1", tabs, active, mru } },
        activePane: "p1",
        closed: [],
      };
    }),
  );
}

afterEach(() => {
  cleanup();
  mounts.length = 0;
  useTabs.setState(original, true);
});
afterAll(() => disposers.forEach((d) => d()));

describe("keep-alive editor kinds", () => {
  it("keep their recent tabs mounted and hidden while another tab is active", () => {
    const tabs = [tab("a", "kept"), tab("b", "kept"), tab("c", "plain")];
    show(tabs, "a");
    render(<EditorAreaView />);
    show(tabs, "b");
    show(tabs, "c");
    expect(shown("a")).toBe(false);
    expect(shown("b")).toBe(false);
    expect(shown("c")).toBe(true);
    show(tabs, "a");
    show(tabs, "c");
    // Only the plain tab is built again; the kept ones are shown as they were.
    expect(mounts).toEqual(["a", "b", "c", "c"]);
    expect(screen.queryAllByTestId("c")).toHaveLength(1);
  });

  it("let the least recently used kept tabs go beyond the limit", () => {
    const tabs = Array.from({ length: 7 }, (_, i) => tab(`k${i}`, "kept"));
    show(tabs, "k0");
    render(<EditorAreaView />);
    for (const t of tabs) show(tabs, t.id);
    expect(screen.queryByTestId("k0")).toBeNull();
    expect(screen.queryByTestId("k1")).toBeNull();
    expect(shown("k2")).toBe(false);
    expect(shown("k6")).toBe(true);
  });
});
