import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, indentUnit } from "@codemirror/language";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { findLanguageDescription, loadSupport } from "./languages";
import { trailingBracketIndent } from "./smartKeys";
import { enterInBlockComment, enterInDocComment } from "./docComment";

const php = (await loadSupport(findLanguageDescription("PHP", "index.php")!))!;

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** Enter at `|` in a PHP method body (`body` is indented eight columns); the body after it, with the caret. */
function enter(body: string, extensions = [Prec.high(trailingBracketIndent)]): string {
  const head = "<?php\nclass A\n{\n    public function f()\n    {\n";
  const text = `${head}${body}\n    }\n}\n`;
  const at = text.indexOf("|");
  const doc = text.replace("|", "");
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [php, indentUnit.of("    "), ...extensions],
    }),
  });
  views.push(view);
  ensureSyntaxTree(view.state, doc.length, 5000);
  // The editor's order (`prefs.ts`): the doc stub, the block comment, then the plain Enter.
  if (!enterInDocComment("php")(view) && !enterInBlockComment(view)) insertNewlineAndIndent(view);
  const out = view.state.doc.toString();
  const caret = view.state.selection.main.head;
  const shown = out.slice(0, caret) + "|" + out.slice(caret);
  return shown.slice(head.length, shown.length - "\n    }\n}\n".length);
}

describe("Enter after a bracket that ends its line", () => {
  it("indents one unit from the line, not under the outer bracket", () => {
    expect(enter("        $this->addMassAction([|")).toBe("        $this->addMassAction([\n            |");
    // Without the rule the PHP mode aligns under the `[`.
    expect(enter("        $this->addMassAction([|", [])).toBe(
      "        $this->addMassAction([\n                             |",
    );
  });

  it("puts the closing bracket back at the line's indentation", () => {
    expect(enter("        $this->addMassAction([|]);")).toBe(
      "        $this->addMassAction([\n            |\n        ]);",
    );
  });

  it("keeps the next element where the last one is", () => {
    expect(enter("        $this->addMassAction([\n            'a' => 1,|\n        ]);")).toBe(
      "        $this->addMassAction([\n            'a' => 1,\n            |\n        ]);",
    );
  });

  it("indents the body of a closure passed as an argument", () => {
    expect(enter("        Route::group(function () {|")).toBe("        Route::group(function () {\n            |");
  });

  it("leaves a single bracket to the language mode", () => {
    expect(enter("        $x = foo(|")).toBe("        $x = foo(\n            |");
    expect(enter("        if ($a) {|")).toBe("        if ($a) {\n            |");
  });

  it("leaves statements inside a closure's body to the language mode", () => {
    const body =
      "        Route::group(function () {\n            $q->where(1)\n                ->orWhere(2);|\n        });";
    const withRule = enter(body);
    expect(withRule).toBe(enter(body, []));
  });

  it("ignores brackets in strings", () => {
    const body = "        $x = ['a', '([',|";
    expect(enter(body)).toBe(enter(body, []));
  });

  it("indents an array opened on a line of its own inside another", () => {
    expect(enter("        $this->add([\n            'a' => [|\n        ]);")).toBe(
      "        $this->add([\n            'a' => [\n                |\n        ]);",
    );
    // Without the rule the PHP mode puts it under the `[`.
    expect(enter("        $this->add([\n            'a' => [|\n        ]);", [])).toBe(
      "        $this->add([\n            'a' => [\n                   |\n        ]);",
    );
    expect(enter("        $this->add([\n            'a' => [\n                1,\n            ],|\n        ]);")).toBe(
      "        $this->add([\n            'a' => [\n                1,\n            ],\n            |\n        ]);",
    );
  });
});

describe("Enter after a case label", () => {
  it("indents the label's statements", () => {
    expect(enter("        switch ($a) {\n            case 1:|\n        }")).toBe(
      "        switch ($a) {\n            case 1:\n                |\n        }",
    );
    expect(enter("        switch ($a) {\n            default:|\n        }")).toBe(
      "        switch ($a) {\n            default:\n                |\n        }",
    );
  });

  it("leaves other lines ending in a colon alone", () => {
    const body = "        $a = $b ? 1 :|";
    expect(enter(body)).toBe(enter(body, []));
  });
});

describe("Enter in a block comment", () => {
  it("closes a docblock just opened", () => {
    expect(enter("        /**|")).toBe("        /**\n         * |\n         */");
  });

  it("continues a line of a docblock with a star", () => {
    expect(enter("        /**\n         * Does a thing.|\n         */")).toBe(
      "        /**\n         * Does a thing.\n         * |\n         */",
    );
    // The rest of the line moves down.
    expect(enter("        /**\n         * Does |a thing.\n         */")).toBe(
      "        /**\n         * Does\n         * |a thing.\n         */",
    );
  });

  it("opens up a docblock written on one line", () => {
    expect(enter("        /** |*/")).toBe("        /**\n         * |\n         */");
  });

  it("leaves code after the comment, and a comment holding code, alone", () => {
    const afterIt = "        /** Note. */|";
    expect(enter(afterIt)).toBe("        /** Note. */\n        |");
    const code = "        /*\n        $a = 1;|\n        */";
    expect(enter(code)).toBe("        /*\n        $a = 1;\n        |\n        */");
  });
});
