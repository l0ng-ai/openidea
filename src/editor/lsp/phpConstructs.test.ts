import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { languages } from "@codemirror/language-data";
import { phpConstructAt, phpConstructDocumentation } from "./phpConstructs";
import { lspDoc } from "./lsp";
import { quickDefinition, requestHover } from "./hover";
import { gotoTargets } from "./navigation";
import { closePopup, useLspPopup } from "./popupStore";

const php = await languages.find((l) => l.name === "PHP")!.load();
const views: EditorView[] = [];
afterEach(() => {
  closePopup();
  for (const view of views.splice(0)) view.destroy();
});

function state(doc: string) {
  return EditorState.create({ doc, extensions: [php] });
}

describe("PHP language constructs", () => {
  it.each(["empty", "isset", "EMPTY"])("documents %s at either edge of its name", (name) => {
    const s = state(`<?php ${name}($value);`);
    for (const pos of [6, 8, 6 + name.length]) {
      const doc = phpConstructAt(s, pos, "php");
      expect(doc).toMatchObject({ from: 6, to: 6 + name.length });
      expect(doc?.markdown).toContain("PHP language construct");
      expect(doc?.markdown).toContain(`function.${name.toLowerCase()}.php`);
    }
  });

  it.each([
    '<?php $empty = "empty($x)";',
    "<?php // empty($x)",
    "<?php /* empty($x) */",
    "<?php $obj->empty();",
    "<?php $obj?->empty();",
    "<?php Foo::empty();",
    "<?php Foo\\empty();",
    "<?php function empty() {}",
    "<p>empty($x)</p><?php echo 1;",
  ])("does not hijack other occurrences: %s", (text) => {
    const s = state(text);
    for (const match of text.matchAll(/empty/g)) expect(phpConstructAt(s, match.index + 2, "php")).toBeNull();
  });

  it("does not attach PHP docs to other languages or ordinary functions", () => {
    expect(phpConstructAt(state("<?php empty($x);"), 8, "javascript")).toBeNull();
    expect(phpConstructDocumentation("PHP", "strtoupper")).toBeNull();
    expect(phpConstructDocumentation("php", "constructor")).toBeNull();
  });

  it("serves hover, declaration and quick definition without a running server", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "<?php empty($value);",
        selection: { anchor: 8 },
        extensions: [php, lspDoc.of({ doc: 1, path: "/p/a.php", language: "php", uiMode: "PHP", readOnly: false })],
      }),
      parent: document.body,
    });
    views.push(view);
    expect((await requestHover(view, 8))?.contents.value).toContain("empty(mixed $var): bool");
    for (const action of [
      () => gotoTargets(view, "definition"),
      () => gotoTargets(view, "declaration"),
      () => quickDefinition(view),
    ]) {
      await action();
      const popup = useLspPopup.getState().popup;
      expect(popup?.kind).toBe("doc");
      if (popup?.kind === "doc") expect(popup.entries[0]?.markup.value).toContain("no source declaration");
      closePopup();
    }
  });
});
