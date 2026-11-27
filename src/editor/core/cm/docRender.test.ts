import { describe, expect, it } from "vitest";
import { extractInlineTags, hasContent, renderDoc, restoreInlineTags, splitBody, stripMarkers } from "./docRender";

describe("hasContent", () => {
  it("agrees with renderDoc on which comments render to nothing", () => {
    const cases: Array<[string, "block" | "line"]> = [
      ["/** */", "block"],
      ["/**\n *\n */", "block"],
      ["/** Books a room. */", "block"],
      ["/**\n * @param id the room\n */", "block"],
      ["/** @hide */", "block"],
      ["///", "line"],
      ["/// Frees a room.", "line"],
      ["//!", "line"],
    ];
    for (const [text, style] of cases)
      expect(hasContent(text, style), text).toBe(renderDoc(text, style, (md) => `<p>${md}</p>`) !== null);
  });
});

/** Stands in for the Markdown renderer: wraps a paragraph, leaves the text alone. */
const markdown = (md: string) => `<p>${md}</p>`;

describe("stripMarkers", () => {
  it("drops the markers of a block comment", () => {
    const text = ["/**", " * One.", " * Two.", " */"].join("\n");
    expect(stripMarkers(text, "block")).toBe("One.\nTwo.");
  });

  it("keeps the indent that follows the marker, so code blocks survive", () => {
    const text = ["/**", " * Text:", " *", " *     code();", " */"].join("\n");
    expect(stripMarkers(text, "block")).toBe("Text:\n\n    code();");
  });

  it("handles a one-line comment", () => {
    expect(stripMarkers("/** Just this. */", "block")).toBe("Just this.");
  });

  it("does not eat a line that only closes the comment", () => {
    expect(stripMarkers("/**\n * Text.\n */", "block")).toBe("Text.");
  });

  it("drops /// and //! of line comments", () => {
    expect(stripMarkers("/// One.\n/// Two.", "line")).toBe("One.\nTwo.");
    expect(stripMarkers("//! Crate docs.", "line")).toBe("Crate docs.");
  });
});

describe("splitBody", () => {
  it("separates the description from block tags", () => {
    const { description, tags } = splitBody("Does a thing.\n\n@param id the id\n@return the thing");
    expect(description).toBe("Does a thing.");
    expect(tags).toEqual([
      { tag: "param", name: "id", type: null, text: "the id" },
      { tag: "return", name: null, type: null, text: "the thing" },
    ]);
  });

  it("lets a tag's text wrap onto the following lines", () => {
    const { tags } = splitBody("@param id the id,\nwhich wraps");
    expect(tags).toEqual([{ tag: "param", name: "id", type: null, text: "the id,\nwhich wraps" }]);
  });

  it("leaves an @ inside a sentence alone", () => {
    const { description, tags } = splitBody("Mail to a@b.com for help.");
    expect(description).toBe("Mail to a@b.com for help.");
    expect(tags).toEqual([]);
  });

  it("keeps an unknown tag whole rather than splitting off a name", () => {
    expect(splitBody("@apiNote Call it twice.").tags).toEqual([
      { tag: "apiNote", name: null, type: null, text: "Call it twice." },
    ]);
  });

  it("reads a line starting with @ inside a code block as code, not as a tag", () => {
    const pre = splitBody("Use it:\n<pre>\n@Override\nvoid run() {}\n</pre>\nDone.");
    expect(pre.tags).toEqual([]);
    expect(pre.description).toBe("Use it:\n<pre>\n@Override\nvoid run() {}\n</pre>\nDone.");
    const fenced = splitBody("Use it:\n```\n@Test\nfun works() {}\n```\n@param id the id");
    expect(fenced.description).toContain("@Test");
    expect(fenced.tags.map((t) => t.tag)).toEqual(["param"]);
  });

  it("splits off the type of a JSDoc or PHPDoc tag, so it is not taken for the name", () => {
    expect(splitBody("@param {number} a - the first").tags).toEqual([
      { tag: "param", name: "a", type: "number", text: "the first" },
    ]);
    expect(splitBody("@param {Map<string, {id: number}>} m the map").tags[0]).toMatchObject({
      name: "m",
      type: "Map<string, {id: number}>",
    });
    expect(splitBody("@param int $a the first").tags).toEqual([
      { tag: "param", name: "$a", type: "int", text: "the first" },
    ]);
    expect(splitBody("@throws {RangeError} when out of range").tags).toEqual([
      { tag: "throws", name: "RangeError", type: null, text: "when out of range" },
    ]);
    expect(splitBody("@returns {string} the name").tags).toEqual([
      { tag: "returns", name: null, type: "string", text: "the name" },
    ]);
  });
});

describe("extractInlineTags", () => {
  it("renders {@code} as escaped code", () => {
    const { text, html } = extractInlineTags("Use {@code a < b}.");
    expect(html).toEqual(["<code>a &#60; b</code>"]);
    expect(restoreInlineTags(text, html)).toBe("Use <code>a &#60; b</code>.");
  });

  it("keeps a code span out of the Markdown, so a_b_c is not italicised", () => {
    const { text } = extractInlineTags("{@code a_b_c}");
    expect(text).not.toContain("a_b_c");
  });

  it("shows a link's label when it has one, the target otherwise", () => {
    expect(extractInlineTags("{@link Foo#bar(int) the bar}").html[0]).toContain("the bar");
    expect(extractInlineTags("{@link Foo#bar(int)}").html[0]).toContain("Foo#bar(int)");
  });

  it("counts nesting, so a brace inside {@code} does not end it", () => {
    const { html } = extractInlineTags("{@code Map<K, {V}>} rest");
    expect(html).toEqual(["<code>Map&#60;K, {V}&#62;</code>"]);
  });

  it("leaves an unclosed tag as written", () => {
    const text = "{@code never closed";
    expect(extractInlineTags(text)).toEqual({ text, html: [] });
  });

  it("drops {@inheritDoc}, which has nothing of its own to show", () => {
    expect(extractInlineTags("{@inheritDoc}").html).toEqual([""]);
  });
});

describe("renderDoc", () => {
  it("renders the description and groups the tags into sections", () => {
    const comment = [
      "/**",
      " * Books a room.",
      " *",
      " * @param id the room",
      " * @param when the day",
      " * @return the booking",
      " * @throws Busy if it is taken",
      " */",
    ].join("\n");
    const doc = renderDoc(comment, "block", markdown);
    expect(doc?.description).toBe("<p>Books a room.</p>");
    expect(doc?.sections.map((s) => s.title)).toEqual(["Params", "Returns", "Throws"]);
    expect(doc?.sections[0]?.rows.map((r) => r.name)).toEqual(["id", "when"]);
    expect(doc?.sections[2]?.rows[0]?.name).toBe("Busy");
  });

  it("puts @return and @returns in one section", () => {
    const doc = renderDoc("/**\n * @return a\n * @returns b\n */", "block", markdown);
    expect(doc?.sections).toHaveLength(1);
    expect(doc?.sections[0]?.rows).toHaveLength(2);
  });

  it("shows every tag: those it knows under their titles, any other under its own name", () => {
    const doc = renderDoc(
      "/**\n * Adds.\n * @example\n * add(1, 2)\n * @property id the id\n * @hide\n * @custom it\n */",
      "block",
      (md) => md,
    );
    expect(doc?.sections.map((s) => [s.title, s.translate])).toEqual([
      ["Properties", true],
      ["Examples", true],
      ["@hide", false],
      ["@custom", false],
    ]);
    expect(doc?.sections[1]?.rows[0]?.html).toBe("add(1, 2)");
    expect(doc?.sections[3]?.rows[0]?.html).toBe("it");
  });

  it("returns null for a comment with nothing to show", () => {
    expect(renderDoc("/**\n *\n */", "block", markdown)).toBeNull();
  });

  it("renders a tagless comment", () => {
    expect(renderDoc("/** Just prose. */", "block", markdown)?.description).toBe("<p>Just prose.</p>");
  });
});
