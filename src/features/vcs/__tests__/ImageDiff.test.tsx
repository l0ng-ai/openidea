import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { _emitEditorEvent } from "@/editor/api";
import { useProject } from "@/platform/project";
import { commands } from "@/platform/ipc";
import { stagedDocument, stagedDocumentLifecycle } from "../stagedDocument";
import { ImageDiff } from "../ImageDiff";
import type { DiffData } from "../diffInput";
import { loadImageFrames, type ImageFrame } from "../imageDiffFrames";
import { useVcs } from "../store";

vi.mock("../imageDiffFrames", () => ({ loadImageFrames: vi.fn() }));

const data: DiffData = { path: "/x.svg", left: { type: "rev", rev: "HEAD" }, right: { type: "worktree" } };
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("discards a late read after a diff switch and refreshes on a matching save or repository change", async () => {
  let finish!: (frames: ImageFrame[]) => void;
  const loader = vi.mocked(loadImageFrames);
  loader.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  loader.mockResolvedValue([{ kind: "absent" }, { kind: "error", error: "current failure" }]);
  const { rerender } = render(<ImageDiff data={data} />);
  const updated = { ...data, path: "/y.svg" };
  rerender(<ImageDiff data={updated} />);
  expect(await screen.findByText("No image on this side")).toBeVisible();
  expect(screen.getByText(/current failure/)).toBeVisible();
  await act(async () => finish([{ kind: "error", error: "old failure" }, { kind: "absent" }]));
  expect(screen.queryByText(/old failure/)).toBeNull();
  expect(loader.mock.calls[0]![2]()).toBe(true);

  act(() => _emitEditorEvent({ type: "docSaved", doc: 7, path: "/x.svg" }));
  expect(loader).toHaveBeenCalledTimes(2);
  act(() => _emitEditorEvent({ type: "docSaved", doc: 8, path: "/y.svg" }));
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  act(() => useVcs.setState((s) => ({ version: s.version + 1 })));
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(4));
});

it("keeps immutable historical images loaded when the repository refreshes", async () => {
  const loader = vi.mocked(loadImageFrames).mockResolvedValue([{ kind: "absent" }, { kind: "absent" }]);
  render(
    <ImageDiff
      data={{
        ...data,
        left: { type: "rev", rev: "a".repeat(40) },
        right: { type: "rev", rev: "b".repeat(64) },
      }}
    />,
  );
  expect(await screen.findAllByText("No image on this side")).toHaveLength(2);
  act(() => useVcs.setState((s) => ({ version: s.version + 1 })));
  expect(loader).toHaveBeenCalledTimes(1);
});

it("hands the editor host's focus to the image viewer for file navigation", async () => {
  vi.mocked(loadImageFrames).mockResolvedValue([{ kind: "absent" }, { kind: "absent" }]);
  const { container } = render(
    <div data-editor-focus tabIndex={-1}>
      <ImageDiff data={data} forwardFocus />
    </div>,
  );
  const host = container.firstElementChild as HTMLElement;
  host.focus();
  expect(host.firstElementChild).toHaveFocus();
  await screen.findAllByText("No image on this side");
});

it("refreshes when the working SVG has unsaved edits", async () => {
  const loader = vi.mocked(loadImageFrames).mockResolvedValue([{ kind: "absent" }, { kind: "absent" }]);
  render(<ImageDiff data={data} />);
  await screen.findAllByText("No image on this side");
  act(() => _emitEditorEvent({ type: "docChanged", doc: 1, path: data.path, baseVersion: 1, version: 2, changes: [] }));
  await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
});

it("refreshes for successive edits in an SVG staging editor opened after the image diff", async () => {
  const loader = vi.mocked(loadImageFrames).mockResolvedValue([{ kind: "absent" }, { kind: "absent" }]);
  const project = useProject.getState().project;
  useProject.setState({ project: { root: "/r" } as never });
  const path = "/r/staged.svg";
  render(<ImageDiff data={{ path, left: data.left, right: { type: "rev", rev: ":0" } }} />);
  await screen.findAllByText("No image on this side");
  const snapshot = vi
    .spyOn(commands, "vcsStagedText")
    .mockResolvedValue({ status: "ok", data: { text: "clean", version: "v1" } });
  const doc = stagedDocument(path, "image-test")!;
  try {
    await act(async () => {
      await doc.reload();
      doc.edit({ from: 0, to: 5, insert: "draft" });
    });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    act(() => doc.edit({ from: 5, insert: " again" }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(3));
  } finally {
    cleanup();
    doc.discard();
    snapshot.mockRestore();
    await stagedDocumentLifecycle().close({ key: "image-test", kind: "diff" });
    useProject.setState({ project });
  }
});
