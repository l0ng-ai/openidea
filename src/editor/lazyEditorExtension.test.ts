import { describe, expect, it, vi } from "vitest";
import { EditorState, Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lazyEditorExtension, type EditorDocContext } from "./api";

const marker = Facet.define<string>();
const ctx = (language: string) => ({ path: `/p/a.${language}`, language }) as EditorDocContext;
const flush = () => new Promise((resolve) => setTimeout(resolve));

describe("lazyEditorExtension", () => {
  it("reconfigures wanted editors once loaded and applies directly afterwards", async () => {
    const load = vi.fn(async () => (c: EditorDocContext) => marker.of(c.language));
    const extensions = lazyEditorExtension((c) => c.language === "sql", load);

    const first = new EditorView({ state: EditorState.create({ extensions: extensions(ctx("sql")) }) });
    expect(first.state.facet(marker)).toEqual([]);
    await flush();
    expect(first.state.facet(marker)).toEqual(["sql"]);

    const second = EditorState.create({ extensions: extensions(ctx("sql")) });
    expect(second.facet(marker)).toEqual(["sql"]);
    expect(extensions(ctx("ts"))).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    first.destroy();
  });
});
