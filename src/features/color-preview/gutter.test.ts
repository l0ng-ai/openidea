import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { vue } from "@codemirror/lang-vue";
import { html } from "@codemirror/lang-html";
import { colorPreviewGutter } from "./gutter";
import { disposeColorPicker } from "./ColorPicker";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  disposeColorPicker();
  vi.unstubAllGlobals();
  localStorage.removeItem("openidea.colorPicker.recent.v1");
});

async function openCssPicker() {
  view = new EditorView({
    state: EditorState.create({
      doc: "color: #112233;",
      extensions: [
        history(),
        colorPreviewGutter({ doc: 1, path: "/p/a.css", language: "css", uiMode: null, readOnly: false }),
      ],
    }),
    parent: document.body,
  });
  const swatch = view.dom.querySelector(".cm-openidea-gutter-colors .cm-gutterElement span")!;
  await act(async () => fireEvent.mouseDown(swatch, { button: 0 }));
  return view;
}

const changeHex = async (value: string) =>
  act(async () => fireEvent.change(screen.getByRole("textbox", { name: "Hexadecimal" }), { target: { value } }));

it("discards the preview on Escape and leaves other edits in the document and undo history", async () => {
  const view = await openCssPicker();
  await changeHex("445566");
  expect(view.contentDOM.textContent).toContain("#445566");
  expect(view.state.doc.toString()).toBe("color: #112233;");
  view.dispatch({ changes: { from: 0, insert: "/* note */ " }, userEvent: "input.type" });
  expect(view.contentDOM.textContent).toContain("#445566");
  await act(async () => fireEvent.keyDown(document, { key: "Escape" }));
  expect(view.state.doc.toString()).toBe("/* note */ color: #112233;");
  expect(undoDepth(view.state)).toBe(1);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("color: #112233;");
  expect(localStorage.getItem("openidea.colorPicker.recent.v1")).toBeNull();
});

it.each([
  { dismissal: "Apply", dismiss: () => fireEvent.click(screen.getByRole("button", { name: "Apply" })), commit: true },
  { dismissal: "outside click", dismiss: () => fireEvent.pointerDown(document.body), commit: true },
  {
    dismissal: "Cancel",
    dismiss: () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
    commit: false,
  },
  { dismissal: "scroll", dismiss: (view: EditorView) => fireEvent.scroll(view.scrollDOM), commit: false },
])("$dismissal closes the picker and preserves independent edits", async ({ dismiss, commit }) => {
  const view = await openCssPicker();
  view.dispatch({ changes: { from: 0, insert: "/* note */ " }, userEvent: "input.type" });
  await changeHex("aabbcc");
  await changeHex("445566");
  expect(view.contentDOM.textContent).toContain("#445566");
  await act(async () => dismiss(view));
  expect(screen.queryByRole("dialog", { name: "Color picker" })).not.toBeInTheDocument();
  expect(view.state.doc.toString()).toBe(`/* note */ color: ${commit ? "#445566" : "#112233"};`);
  expect(undoDepth(view.state)).toBe(commit ? 2 : 1);
  if (commit) {
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("/* note */ color: #112233;");
  }
});

it("discards a preview whose color was changed by another edit", async () => {
  const view = await openCssPicker();
  await changeHex("445566");
  view.dispatch({ changes: { from: 7, to: 14, insert: "#aabbcc" }, userEvent: "input.type" });
  expect(view.contentDOM.textContent).toContain("#aabbcc");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
  expect(view.state.doc.toString()).toBe("color: #aabbcc;");
  expect(undoDepth(view.state)).toBe(1);
});

it("samples a screen color and offers it again as a recent color", async () => {
  vi.stubGlobal(
    "EyeDropper",
    class {
      async open() {
        return { sRGBHex: "#4c78ce" };
      }
    },
  );
  view = new EditorView({
    state: EditorState.create({
      doc: "color: #abcdef;",
      extensions: colorPreviewGutter({ doc: 1, path: "/p/a.css", language: "css", uiMode: null, readOnly: false }),
    }),
    parent: document.body,
  });
  const open = async () => {
    const swatch = view!.dom.querySelector(".cm-openidea-gutter-colors .cm-gutterElement span")!;
    await act(async () => fireEvent.mouseDown(swatch, { button: 0 }));
  };
  await open();
  await act(async () => fireEvent.click(document.querySelector('button[aria-label="Pick screen color"]')!));
  expect(view.contentDOM.textContent).toContain("#4c78ce");

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply" })));
  expect(view.state.doc.toString()).toBe("color: #4c78ce;");
  expect(JSON.parse(localStorage.getItem("openidea.colorPicker.recent.v1")!)).toEqual(["#4c78ceff"]);

  await open();
  expect(document.querySelector('button[aria-label="Recent color #4C78CEFF"]')).not.toBeNull();
  await act(async () =>
    fireEvent.change(document.querySelector('input[aria-label="Hexadecimal"]')!, { target: { value: "FF0000" } }),
  );
  await act(async () => fireEvent.click(document.querySelector('button[aria-label="Recent color #4C78CEFF"]')!));
  expect(view.state.doc.toString()).toBe("color: #4c78ce;");
});

it("ignores color-like Vue template text while previewing embedded styles", () => {
  view = new EditorView({
    state: EditorState.create({
      doc: '<template>\n<h1>Issue #1811: ConfigProvider z-index</h1>\n<div style="color: #abc">Text</div>\n</template>\n<style>\nh1 { color: #ff0080; }\n</style>',
      extensions: [
        vue(),
        colorPreviewGutter({ doc: 1, path: "/p/a.vue", language: "vue", uiMode: null, readOnly: false }),
      ],
    }),
    parent: document.body,
  });
  const swatches = [...view.dom.querySelectorAll(".cm-openidea-gutter-colors .cm-gutterElement span[title]")];
  expect(swatches.map((swatch) => swatch.getAttribute("title"))).toEqual(["#abc", "#ff0080"]);
});

it("ignores color-like HTML text while previewing inline styles", () => {
  view = new EditorView({
    state: EditorState.create({
      doc: '<h1>Issue #1811: ConfigProvider z-index</h1>\n<div style="color: #abc">Text</div>',
      extensions: [
        html(),
        colorPreviewGutter({ doc: 1, path: "/p/a.html", language: "html", uiMode: null, readOnly: false }),
      ],
    }),
    parent: document.body,
  });
  const swatches = [...view.dom.querySelectorAll(".cm-openidea-gutter-colors .cm-gutterElement span[title]")];
  expect(swatches.map((swatch) => swatch.getAttribute("title"))).toEqual(["#abc"]);
});

it("updates a CSS literal from alpha and hex fields and ignores invalid input", async () => {
  view = new EditorView({
    state: EditorState.create({
      doc: "color: #abcdef;",
      extensions: colorPreviewGutter({ doc: 1, path: "/p/a.css", language: "css", uiMode: null, readOnly: false }),
    }),
    parent: document.body,
  });
  const swatch = view.dom.querySelector(".cm-openidea-gutter-colors .cm-gutterElement span")!;
  await act(async () => fireEvent.mouseDown(swatch, { button: 0 }));

  const field = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  await act(async () => fireEvent.change(field("Alpha percent"), { target: { value: "50" } }));
  expect(view.contentDOM.textContent).toContain("#abcdef80");
  expect(field("Hexadecimal").value).toBe("ABCDEF80");

  await act(async () => fireEvent.change(field("Hexadecimal"), { target: { value: "00FF0080" } }));
  expect(view.contentDOM.textContent).toContain("#00ff0080");
  expect(field("Green").value).toBe("255");

  await act(async () => fireEvent.change(field("Red"), { target: { value: "256" } }));
  expect(view.contentDOM.textContent).toContain("#00ff0080");
  expect(view.state.doc.toString()).toBe("color: #abcdef;");
  expect(field("Red").getAttribute("aria-invalid")).toBe("true");
});
