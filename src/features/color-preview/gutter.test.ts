import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
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
  expect(view.state.doc.toString()).toBe("color: #4c78ce;");

  await act(async () => fireEvent.keyDown(document, { key: "Escape" }));
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
  expect(view.state.doc.toString()).toBe("color: #abcdef80;");
  expect(field("Hexadecimal").value).toBe("ABCDEF80");

  await act(async () => fireEvent.change(field("Hexadecimal"), { target: { value: "00FF0080" } }));
  expect(view.state.doc.toString()).toBe("color: #00ff0080;");
  expect(field("Green").value).toBe("255");

  await act(async () => fireEvent.change(field("Red"), { target: { value: "256" } }));
  expect(view.state.doc.toString()).toBe("color: #00ff0080;");
  expect(field("Red").getAttribute("aria-invalid")).toBe("true");
});
