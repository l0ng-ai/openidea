import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { fireEvent } from "@testing-library/react";
const ipc = vi.hoisted(() => ({
  pluginLanguageVisuals: vi.fn(),
  pluginColorPresentations: vi.fn(async () => ({ status: "ok", data: ["red"] })),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: ipc,
}));
const { pluginColorPreview } = await import("./pluginColors");
const { disposeColorPicker } = await import("./ColorPicker");
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  disposeColorPicker();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("uses plugin presentations to replace precisely the reported range", async () => {
  vi.useFakeTimers();
  ipc.pluginLanguageVisuals.mockResolvedValue({
    status: "ok",
    data: {
      version: 1,
      injections: [],
      gutterActions: [],
      colors: [
        ["p", { range: { start: { line: 0, col: 1 }, end: { line: 0, col: 2 } }, red: 1, green: 0, blue: 0, alpha: 1 }],
      ],
    },
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: "xyz",
      extensions: pluginColorPreview({ doc: 1, path: "/p/a", language: "text", uiMode: null, readOnly: false }),
    }),
    parent: document.body,
  });
  views.push(view);
  await vi.advanceTimersByTimeAsync(300);
  const swatch = view.dom.querySelector<HTMLButtonElement>("button")!;
  await act(async () => swatch.click());
  const picker = document.querySelector<HTMLInputElement>('input[aria-label="Hexadecimal"]')!;
  await act(async () => fireEvent.change(picker, { target: { value: "00FF0080" } }));
  await act(async () => fireEvent.keyDown(document, { key: "Escape" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(view.state.doc.toString()).toBe("xredz");
  expect(ipc.pluginColorPresentations).toHaveBeenCalledWith(
    1,
    "p",
    expect.objectContaining({ red: 0, green: 1, blue: 0, alpha: 128 / 255 }),
  );
});
