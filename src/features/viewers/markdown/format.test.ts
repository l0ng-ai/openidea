import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { CONTRIBUTED_FORMAT, useEditorRegistry } from "@/editor/api";
import { formatMarkdownBlock, registerMarkdownFormat } from "./format";

describe("formatMarkdownBlock", () => {
  it("trims trailing whitespace outside fenced code blocks", () => {
    expect(formatMarkdownBlock("text  \nmore\t\n")).toBe("text\nmore\n");
  });

  it("keeps fenced code block contents verbatim", () => {
    const doc = "# Title\n\n```js\nconst x = 1;   \n\n# not a heading\n```\n\n\ntail   \n";
    expect(formatMarkdownBlock(doc)).toBe("# Title\n\n```js\nconst x = 1;   \n\n# not a heading\n```\n\ntail\n");
  });

  it("collapses blank line runs and strips them at the edges", () => {
    expect(formatMarkdownBlock("\n\na\n\n\n\nb\n\n\n")).toBe("a\n\nb\n");
  });

  it("keeps the trailing newline as it was", () => {
    expect(formatMarkdownBlock("a\n\nb")).toBe("a\n\nb");
  });

  it("normalizes heading and list marker spacing", () => {
    expect(formatMarkdownBlock("####   Title   \n\n-   one\n2.  two\n")).toBe("#### Title\n\n- one\n2. two\n");
  });

  it("leaves lines without a space after the heading hashes alone", () => {
    // `#Title` renders as plain text; adding the space would change semantics.
    expect(formatMarkdownBlock("#Title\n")).toBe("#Title\n");
  });

  it("leaves indented code blocks alone beyond trailing whitespace", () => {
    expect(formatMarkdownBlock("para\n\n    # not a heading   \n    - not a list\n")).toBe(
      "para\n\n    # not a heading\n    - not a list\n",
    );
  });

  it("puts one blank line around headings", () => {
    expect(formatMarkdownBlock("para\n## Head\npara\n")).toBe("para\n\n## Head\n\npara\n");
  });

  it("does not add blank lines around a heading at the document edges", () => {
    expect(formatMarkdownBlock("## Head\npara\n## Tail")).toBe("## Head\n\npara\n\n## Tail");
  });

  it("formats the selection without inserting blank lines at its edges", () => {
    expect(formatMarkdownBlock("## Head\ny", false)).toBe("## Head\ny");
  });

  it("is idempotent", () => {
    const doc = "# Title\n\n- one\n\n```js\nkeep  \n```\n\ntail\n";
    const once = formatMarkdownBlock(doc);
    expect(formatMarkdownBlock(once)).toBe(once);
  });
});

describe("registerMarkdownFormat", () => {
  it("contributes a formatter to markdown editors only", () => {
    const unregister = registerMarkdownFormat();
    try {
      const contribution = [...useEditorRegistry.getState().contributions.values()].find(
        (c) => c.id === "markdown.format",
      );
      expect(contribution).toBeDefined();
      const ctx = { doc: 1, path: "/p/README.md", language: "markdown", uiMode: null, readOnly: false };
      const state = EditorState.create({ doc: "a  \nb\n", extensions: contribution!.extensions(ctx) });
      expect(state.languageDataAt<unknown>(CONTRIBUTED_FORMAT, 0)[0]).toBeTypeOf("function");
      const java = contribution!.extensions({ ...ctx, path: "/p/A.java", language: "java" });
      expect(java).toEqual([]);
    } finally {
      unregister();
    }
  });
});
