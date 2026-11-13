import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlameLine, Commit } from "@/bindings";
import { useI18n } from "@/platform/i18n";
import { blameSlot, toggleAnnotations } from "../blame";
import { closeBlamePopup } from "../BlamePopup";
import { useVcs } from "../store";

const mocks = vi.hoisted(() => ({ blame: vi.fn(), log: vi.fn(), action: vi.fn() }));
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: mocks.action,
}));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: { ...actual.commands, vcsBlame: mocks.blame, vcsLog: mocks.log },
  };
});

const sha = "f122f5afd61fa24a16a5e1c76c7ed6cbad833c93";
const otherSha = "12852f79a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const lines: BlameLine[] = [
  { commit: sha, author: "Aleks Zlateski", timeMs: Date.UTC(2026, 7, 3, 22, 20), summary: "mai_blob_cpp: opt-in" },
  { commit: sha, author: "Aleks Zlateski", timeMs: Date.UTC(2026, 7, 3, 22, 20), summary: "mai_blob_cpp: opt-in" },
  { commit: otherSha, author: "Dan Crankshaw", timeMs: Date.UTC(2025, 9, 31, 18, 20), summary: "Support DCP" },
];
const fullCommit: Commit = {
  id: sha,
  shortId: sha.slice(0, 8),
  parents: [],
  author: "Aleks Zlateski",
  email: "azlateski@microsoft.com",
  timeMs: Date.UTC(2026, 7, 3, 22, 20),
  summary: "mai_blob_cpp: opt-in",
  message:
    "mai_blob_cpp: opt-in\n\n## Summary\n\nMakes the native extension opt-in (see 12852f79, build 20261110, deadbeef).",
  refs: [],
};

let view: EditorView | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useI18n.setState({ locale: "en", texts: {} });
  useVcs.setState({ available: true, root: "/repo", repo: "/repo", roots: ["/repo"] });
  mocks.blame.mockResolvedValue({ status: "ok", data: lines });
  mocks.log.mockResolvedValue({ status: "ok", data: [fullCommit] });
});

afterEach(() => {
  closeBlamePopup();
  view?.destroy();
  view = undefined;
  vi.useRealTimers();
});

describe("git blame gutter and commit popup", () => {
  it("highlights matching commit lines on hover, shows the commit popup, and jumps to Git Log on click", async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: "first\nsecond\nthird", extensions: [blameSlot()] }),
    });
    await toggleAnnotations(view, "/repo/src/main.py");
    const gutterElements = [...view.dom.querySelectorAll<HTMLElement>(".cm-vcs-blame .cm-gutterElement")];
    const firstLine = gutterElements.find((el) => el.querySelector(`[data-commit="${sha}"]`))!;
    const thirdLine = gutterElements.find((el) => el.querySelector(`[data-commit="${otherSha}"]`))!;
    expect(firstLine).toBeDefined();
    expect(thirdLine).toBeDefined();

    const firstBg = firstLine.querySelector<HTMLElement>(".cm-vcs-blame-line")?.style.backgroundColor;
    const secondBg = gutterElements
      .filter((el) => el.querySelector(`[data-commit="${sha}"]`))[1]
      ?.querySelector<HTMLElement>(".cm-vcs-blame-line")?.style.backgroundColor;
    const thirdBg = thirdLine.querySelector<HTMLElement>(".cm-vcs-blame-line")?.style.backgroundColor;
    expect(firstBg).toBeTruthy();
    expect(firstBg).toBe(secondBg);
    expect(firstBg).not.toBe(thirdBg);

    fireEvent.mouseOver(firstLine);
    const highlighted = view.dom.querySelectorAll(".cm-vcs-blame .cm-gutterElement.cm-vcs-blame-same-commit");
    expect(highlighted.length).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(260);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: sha })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "12852f79" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "20261110" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "deadbeef" })).not.toBeInTheDocument();
    expect(screen.getByText(/Aleks Zlateski <azlateski@microsoft\.com>/)).toBeInTheDocument();
    expect(screen.getByText(/Makes the native extension opt-in/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: sha }));
    });
    expect(mocks.action).toHaveBeenCalledWith("vcs.showCommit", sha);
  });
});
