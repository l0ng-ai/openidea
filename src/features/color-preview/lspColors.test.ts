import { afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen } from "@testing-library/react";
import type { DocumentColor } from "@/platform/ipc";
const ipc = vi.hoisted(() => ({
  lspDocumentColors: vi.fn(),
  lspColorPresentations: vi.fn(),
}));
vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<typeof import("@/platform/ipc")>()),
  commands: ipc,
}));
const menu = vi.hoisted(() => vi.fn());
vi.mock("@/ui", async (original) => ({ ...(await original<typeof import("@/ui")>()), showContextMenu: menu }));
const { lspColorPreview, serverOnlyColors } = await import("./lspColors");
const { disposeColorPicker } = await import("./ColorPicker");
const { useProject } = await import("@/platform/project");
const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
  disposeColorPicker();
  useProject.setState({ settings: null });
  vi.useRealTimers();
  vi.clearAllMocks();
});

const color = (line: number, start: number, end: number, rgb: [number, number, number]): DocumentColor => ({
  range: { start: { line, col: start }, end: { line, col: end } },
  red: rgb[0],
  green: rgb[1],
  blue: rgb[2],
  alpha: 1,
  server: 7,
});
const CSS = "a { color: #ff0000; }\n.b { @apply bg-red-500; }";
const literal = color(0, 11, 18, [1, 0, 0]);
const tailwind = color(1, 12, 22, [0.937, 0.267, 0.267]);

function open(doc: string, language: string) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: lspColorPreview({ doc: 1, path: "/p/a.css", language, uiMode: null, readOnly: false }),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
const swatches = (view: EditorView) => [
  ...view.dom.querySelectorAll<HTMLButtonElement>(".cm-lsp-color-preview button"),
];

it("drops server colors the built-in literal preview already shows at the same range", () => {
  const state = EditorState.create({ doc: CSS });
  expect(serverOnlyColors(state, "css", [literal, tailwind])).toEqual([tailwind]);
  // Outside style sheets a bare hex value is no literal, so the server's swatch stays.
  expect(serverOnlyColors(state, "javascript", [literal, tailwind])).toEqual([literal, tailwind]);
  // A literal inside a larger server range (`text-[#f00]`) is not the same color.
  const wider = color(0, 10, 18, [1, 0, 0]);
  expect(serverOnlyColors(state, "css", [wider])).toEqual([wider]);
  // Two servers reporting one range show one swatch.
  expect(serverOnlyColors(state, "css", [tailwind, { ...tailwind, server: 8 }])).toEqual([tailwind]);
});

it("keeps the server's swatch for the second literal on a line", () => {
  const state = EditorState.create({ doc: "a { color: #ff0000; background: #00ff00; }" });
  const second = color(0, 32, 39, [0, 1, 0]);
  expect(serverOnlyColors(state, "css", [literal, second])).toEqual([second]);
});

it("keeps valid swatches when a server reports a range outside the document", async () => {
  vi.useFakeTimers();
  ipc.lspDocumentColors.mockResolvedValue({ status: "ok", data: [color(2, 0, 6, [0, 1, 0]), tailwind] });
  const view = open(CSS, "css");
  await vi.advanceTimersByTimeAsync(300);
  expect(swatches(view).map((swatch) => swatch.title)).toEqual(["rgba(239, 68, 68, 1)"]);
});

it("shows a swatch per server color and writes the server's presentation on commit", async () => {
  vi.useFakeTimers();
  ipc.lspDocumentColors.mockResolvedValue({ status: "ok", data: [literal, tailwind] });
  ipc.lspColorPresentations.mockResolvedValue({
    status: "ok",
    data: [{ label: "bg-[#00ff00]", edits: [{ range: tailwind.range, new_text: "bg-[#00ff00]" }] }],
  });
  const view = open(CSS, "css");
  await vi.advanceTimersByTimeAsync(300);
  expect(ipc.lspDocumentColors).toHaveBeenCalledWith(1);
  const [swatch, ...rest] = swatches(view);
  expect(rest).toHaveLength(0);
  expect(swatch!.title).toBe("rgba(239, 68, 68, 1)");
  await act(async () => swatch!.click());
  const hex = document.querySelector<HTMLInputElement>('input[aria-label="Hexadecimal"]')!;
  await act(async () => fireEvent.change(hex, { target: { value: "00FF00" } }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
  await vi.advanceTimersByTimeAsync(0);
  expect(ipc.lspColorPresentations).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ range: tailwind.range, red: 0, green: 1, blue: 0, alpha: 1, server: 7 }),
  );
  expect(view.state.doc.line(2).text).toBe(".b { @apply bg-[#00ff00]; }");
});

it("offers a choice when the server presents a color several ways", async () => {
  vi.useFakeTimers();
  ipc.lspDocumentColors.mockResolvedValue({ status: "ok", data: [tailwind] });
  ipc.lspColorPresentations.mockResolvedValue({
    status: "ok",
    data: ["#00ff00", "rgb(0, 255, 0)"].map((label) => ({
      label,
      edits: [{ range: tailwind.range, new_text: label }],
    })),
  });
  const view = open(CSS, "css");
  await vi.advanceTimersByTimeAsync(300);
  await act(async () => swatches(view)[0]!.click());
  const hex = document.querySelector<HTMLInputElement>('input[aria-label="Hexadecimal"]')!;
  await act(async () => fireEvent.change(hex, { target: { value: "00FF00" } }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
  await vi.advanceTimersByTimeAsync(0);
  expect(view.state.doc.toString()).toBe(CSS);
  const items = menu.mock.calls[0]![1] as { label: string; run: () => void }[];
  expect(items.map((i) => i.label)).toEqual(["#00ff00", "rgb(0, 255, 0)"]);
  items[1]!.run();
  expect(view.state.doc.line(2).text).toBe(".b { @apply rgb(0, 255, 0); }");
});

it("says so when the server can't write the picked color", async () => {
  vi.useFakeTimers();
  ipc.lspDocumentColors.mockResolvedValue({ status: "ok", data: [tailwind] });
  ipc.lspColorPresentations.mockResolvedValue({ status: "ok", data: [] });
  const view = open(CSS, "css");
  await vi.advanceTimersByTimeAsync(300);
  await act(async () => swatches(view)[0]!.click());
  const hex = document.querySelector<HTMLInputElement>('input[aria-label="Hexadecimal"]')!;
  await act(async () => fireEvent.change(hex, { target: { value: "00FF00" } }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
  await vi.advanceTimersByTimeAsync(0);
  expect(view.state.doc.toString()).toBe(CSS);
  expect(view.dom.querySelector(".cm-lsp-hint")?.textContent).toBe("This color can't be changed with the picker");
});

it("asks nothing while color gutter icons are off and drops stale answers", async () => {
  vi.useFakeTimers();
  useProject.setState({ settings: { editor: { gutterIconsDisabled: ["colors"] } } as never });
  ipc.lspDocumentColors.mockResolvedValue({ status: "ok", data: [tailwind] });
  const view = open(CSS, "css");
  await vi.advanceTimersByTimeAsync(300);
  expect(ipc.lspDocumentColors).not.toHaveBeenCalled();

  useProject.setState({ settings: null });
  let answer!: (v: unknown) => void;
  ipc.lspDocumentColors.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  await vi.advanceTimersByTimeAsync(300);
  expect(ipc.lspDocumentColors).toHaveBeenCalledTimes(1);
  view.dispatch({ changes: { from: 0, insert: " " } });
  answer({ status: "ok", data: [tailwind] });
  await vi.advanceTimersByTimeAsync(0);
  expect(swatches(view)).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(300);
  expect(swatches(view)).toHaveLength(1);
});
