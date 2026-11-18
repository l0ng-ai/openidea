import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { setFileDecorations } from "@/workbench/contributions";
import { useTabs } from "../controller";
import type { Tab } from "../model/tabs";
import { EditorAreaView } from "./EditorArea";

vi.mock("../controller", async (original) => ({
  ...(await original<object>()),
  editorController: () => ({ publishContext: vi.fn(), tabMenu: () => [] }),
}));
vi.mock("./TextEditorHost", () => ({ TextEditorHost: () => null }));
vi.mock("./FindBar", () => ({ FindBar: () => null }));
vi.mock("./Banner", () => ({ EditorBanners: () => null, VirtualBanner: () => null }));
vi.mock("./StatusItems", () => ({ CodeBreadcrumbs: () => null }));

const file = (name: string): Tab => ({
  id: name,
  input: { kind: "file", key: name, path: `/p/${name}` },
  preview: false,
  pinned: false,
});
const original = useTabs.getState();
const label = (name: string) =>
  screen
    .getAllByRole("tab")
    .find((t) => t.textContent?.includes(name))!
    .querySelector("[class*=tabLabel]")!;

afterEach(() => {
  cleanup();
  useTabs.setState(original, true);
  setFileDecorations("problems", new Map());
});

describe("editor tabs of files with errors", () => {
  it("underline only the files the problems provider marks as errors", () => {
    const tabs = [file("a.ts"), file("b.ts")];
    act(() =>
      useTabs.setState({
        layout: { kind: "pane", paneId: "p1" },
        panes: { p1: { id: "p1", tabs, active: "a.ts", mru: ["a.ts"] } },
        activePane: "p1",
        closed: [],
      }),
    );
    render(<EditorAreaView />);
    expect(label("a.ts").className).not.toMatch(/error/);

    act(() => setFileDecorations("problems", new Map([["/p/a.ts", { error: true, propagate: true }]])));
    expect(label("a.ts").className).toMatch(/error/);
    expect(label("b.ts").className).not.toMatch(/error/);

    act(() => setFileDecorations("problems", new Map()));
    expect(label("a.ts").className).not.toMatch(/error/);
  });
});
