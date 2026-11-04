/** Problems a feature marks on its own text (database console) show in the editor hover like diagnostics. */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { problemProviders } from "@/editor/api";
import { hoverSource } from "./hover";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

function editor() {
  const state = EditorState.create({
    doc: "DELETE FROM t WHERE 1=1",
    extensions: [problemProviders.of(() => [{ from: 20, to: 23, severity: "warning", message: "Unsafe query" }])],
  });
  return (view = new EditorView({ state, parent: document.body.appendChild(document.createElement("div")) }));
}

describe("contributed problems in the hover", () => {
  it("shows the problem under the pointer with its severity icon and no quick-fix links", async () => {
    const tip = await hoverSource(editor(), 21);
    expect(tip).toMatchObject({ pos: 20, end: 23 });
    const { dom } = tip!.create(view!);
    const row = dom.querySelector(".cm-lsp-diag-warning")!;
    expect(row.querySelector(".cm-lsp-diag-message")?.textContent).toBe("Unsafe query");
    expect(row.querySelector(".cm-lsp-diag-icon")).not.toBeNull();
    expect(dom.querySelector(".cm-lsp-link-button")).toBeNull();
  });

  it("stays out away from the problem", async () => {
    expect(await hoverSource(editor(), 3)).toBeNull();
  });
});
