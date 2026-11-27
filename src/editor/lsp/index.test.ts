import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { intentionProviders } from "@/editor/api";
import { cellLspExtensions, lspExtensions } from "./index";

function providers(items: readonly unknown[]): number {
  const state = EditorState.create({ doc: "create_agent(\n", extensions: items as never });
  return state.facet(intentionProviders).length;
}

describe("notebook cell language features", () => {
  // ⌥↵ in a cell showed only the backend's code actions: the cell had no intention
  // providers at all, so a language's own entries (Python's "create function") were missing.
  it("gives a cell the intention providers a text editor has", () => {
    const text = providers(lspExtensions({ path: "/p/a.py", language: "python", doc: 1 } as never));
    const cell = providers(cellLspExtensions({ path: "/p/a.ipynb", language: "python", doc: 1 } as never));
    expect(text).toBeGreaterThan(0);
    expect(cell).toBe(text);
  });
});
