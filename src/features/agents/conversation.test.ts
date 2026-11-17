import { describe, expect, it } from "vitest";
import {
  fileHref,
  findAll,
  findRanges,
  formatDuration,
  isFindRangeShown,
  pathLink,
  quoteText,
  symbolRef,
  withQuote,
} from "./conversation";

describe("quoting", () => {
  it("quotes each line and leaves a line to type on", () => {
    expect(quoteText("one\n\ntwo\n")).toBe("> one\n>\n> two\n\n");
  });
  it("adds the quote after a draft", () => {
    expect(withQuote("", "x")).toBe("> x\n\n");
    expect(withQuote("Why?  ", "x")).toBe("Why?\n\n> x\n\n");
  });
});

describe("pathLink", () => {
  const cwd = "/repo";
  it("resolves relative paths with a line and column", () => {
    expect(pathLink("src/lib.rs", cwd)).toEqual({ path: "/repo/src/lib.rs" });
    expect(pathLink("./src/main.rs:12", cwd)).toEqual({ path: "/repo/src/main.rs", line: 11 });
    expect(pathLink("a/b.ts:3:5", cwd)).toEqual({ path: "/repo/a/b.ts", line: 2, col: 4 });
    expect(pathLink("Cargo.toml", cwd)).toEqual({ path: "/repo/Cargo.toml" });
    expect(pathLink("/abs/x.py#L7", cwd)).toEqual({ path: "/abs/x.py", line: 6 });
  });
  it("ignores code that isn't a path", () => {
    for (const t of [
      "foo()",
      "cargo test",
      "https://x.dev/a.md",
      "inventory",
      "1.5",
      "v2.0",
      "a.b()",
      "failing-tests",
      "tests/",
    ]) {
      expect(pathLink(t, cwd)).toBeNull();
    }
  });
});

describe("symbolRef", () => {
  it("reads the forms a reply names a symbol in", () => {
    expect(symbolRef("FooView")).toMatchObject({ name: "FooView", kinds: expect.arrayContaining(["class"]) });
    expect(symbolRef("load()")).toMatchObject({ name: "load", kinds: ["function", "method", "constructor"] });
    expect(symbolRef("validate(input)")).toMatchObject({ name: "validate" });
    expect(symbolRef("has_header")).toMatchObject({ name: "has_header", kinds: ["function", "method", "constructor"] });
    expect(symbolRef("loadConfig")).toMatchObject({ name: "loadConfig" });
    expect(symbolRef("Config.load")).toMatchObject({ name: "load", container: "Config" });
    expect(symbolRef("Config::load()")).toMatchObject({ name: "load", container: "Config" });
    expect(symbolRef("lib.rs::has_header")).toMatchObject({ name: "has_header", file: "lib.rs" });
    expect(symbolRef("src/a.ts#load")).toMatchObject({ name: "load", file: "src/a.ts" });
  });
  it("leaves words, keywords, literals, commands and code plain", () => {
    for (const text of [
      "true",
      "null",
      "inventory",
      "None",
      "False",
      "Self",
      "Some(x)",
      "None.value",
      "42",
      "1.5",
      "cargo test",
      "git log --oneline",
      "x = 1",
      "a && b",
      "$HOME",
      "foo(bar(1))",
      "TODO",
      "src/",
    ]) {
      expect(symbolRef(text)).toBeNull();
    }
  });
});

describe("fileHref", () => {
  const cwd = "C:/repo";
  it("resolves a link against the task folder", () => {
    expect(fileHref("docs/my%20notes.md:3", cwd)).toEqual({ path: "C:/repo/docs/my notes.md", line: 2 });
    expect(fileHref("/abs/x.py#L7", cwd)).toEqual({ path: "/abs/x.py", line: 6 });
    expect(fileHref("https://x.dev/a.md", cwd)).toBeNull();
    expect(fileHref("#top", cwd)).toBeNull();
  });
  // On Windows, opening `//server/share` signs in to that server with the user's credentials.
  it("names no network share, however the link spells it", () => {
    for (const href of [
      "//evil/share/x.md",
      "%2F%2Fevil/share/x.md",
      "/%2Fevil/share/x.md",
      "/\\evil/share/x.md",
      "/%5Cevil/share/x.md",
      "%5C%5Cevil%5Cshare%5Cx.md",
    ]) {
      expect(fileHref(href, cwd), href).toBeNull();
    }
    expect(fileHref("%5Cevil/share/x.md", ""), "no task folder").toBeNull();
  });
  it("follows links in a task that is on a share", () => {
    expect(fileHref("docs/a.md", "//nas/work/app")).toEqual({ path: "//nas/work/app/docs/a.md" });
  });
});

describe("formatDuration", () => {
  it("scales the unit", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(2 * 3600_000 + 3 * 60_000)).toBe("2h 03m");
  });
});

describe("finding", () => {
  it("finds every occurrence, ignoring case", () => {
    expect(findAll("Abc abc ABC", "abc")).toEqual([0, 4, 8]);
    expect(findAll("aaa", "")).toEqual([]);
  });
  it("maps matches to DOM ranges", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>one <code>two</code> one</p>";
    expect(findRanges(root, "one").map((r) => r.toString())).toEqual(["one", "one"]);
    expect(findRanges(root, "TWO")).toHaveLength(1);
  });
  it("skips user-select:none chrome, buttons, svgs and mermaid source, and hides ranges in closed <details>", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<details><summary style="user-select: none">Confirming summary</summary><div>hidden confirm body</div></details>',
      "<details><summary>stop_bash confirm</summary><pre>tool confirm output</pre></details>",
      "<button>confirm button</button>",
      "<svg><text>confirm svg</text></svg>",
      '<div data-mermaid-state="ok"><pre><code>graph TD; confirm</code></pre></div>',
      "<p>Visible confirm</p>",
    ].join("");
    const ranges = findRanges(root, "confirm");
    expect(ranges.map((r) => r.startContainer.parentElement?.tagName)).toEqual(["DIV", "SUMMARY", "PRE", "P"]);

    // Simulate WebKit's content-visibility: hidden on closed <details>, where getClientRects() stays non-empty.
    for (const r of ranges) r.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    expect(ranges.filter((r) => isFindRangeShown(r, root)).map((r) => r.startContainer.parentElement?.tagName)).toEqual(
      ["SUMMARY", "P"],
    );

    for (const d of root.querySelectorAll("details")) d.open = true;
    expect(ranges.filter((r) => isFindRangeShown(r, root)).map((r) => r.startContainer.parentElement?.tagName)).toEqual(
      ["DIV", "SUMMARY", "PRE", "P"],
    );
  });
});
