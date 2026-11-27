import { describe, expect, it } from "vitest";
import {
  blobLink,
  blobPathCandidates,
  isRemoteOf,
  linkInfo,
  linkSpans,
  markdownLink,
  pastedUrl,
} from "./composerLinks";

describe("linkSpans", () => {
  const urls = (text: string) => linkSpans(text).map((s) => [text.slice(s.from, s.to), s.url, s.label]);

  it("finds bare URLs without the punctuation that ends the sentence", () => {
    expect(urls("see https://docs.rs/serde, and (https://a.dev/x).")).toEqual([
      ["https://docs.rs/serde", "https://docs.rs/serde", null],
      ["https://a.dev/x", "https://a.dev/x", null],
    ]);
  });

  it("ends a URL at Chinese text and full-width punctuation", () => {
    expect(urls("看看https://github.com/o/r/pull/12，然后合并")).toEqual([
      ["https://github.com/o/r/pull/12", "https://github.com/o/r/pull/12", null],
    ]);
  });

  it("finds Markdown links with their labels, escaped brackets and parentheses included", () => {
    const text = `read ${markdownLink("the [draft] spec", "https://en.wikipedia.org/wiki/Rust_(language)")} now`;
    expect(urls(text)).toEqual([
      [
        "[the \\[draft\\] spec](https://en.wikipedia.org/wiki/Rust_%28language%29)",
        "https://en.wikipedia.org/wiki/Rust_%28language%29",
        "the [draft] spec",
      ],
    ]);
  });

  it("skips a bare scheme, other schemes and URLs inside words", () => {
    expect(urls("https:// ftp://a.dev xhttps://a.dev @https://a.dev")).toEqual([]);
  });
});

describe("linkInfo", () => {
  it("names issues, pull requests and commits by repository and id", () => {
    expect(linkInfo("https://github.com/l0ng-ai/openidea/pull/12")).toEqual({ kind: "pr", text: "openidea#12" });
    expect(linkInfo("https://github.com/o/r/issues/7#issuecomment-1")).toEqual({ kind: "issue", text: "r#7" });
    expect(linkInfo("https://gitlab.com/g/sub/r/-/merge_requests/3")).toEqual({ kind: "pr", text: "r!3" });
    expect(linkInfo("https://github.com/o/r/commit/abcdef1234567")).toEqual({ kind: "commit", text: "r@abcdef1" });
    expect(linkInfo("https://linear.app/acme/issue/ENG-42/fix-it")).toEqual({ kind: "issue", text: "ENG-42" });
  });

  it("names a page by its host and path, or by its label", () => {
    expect(linkInfo("https://www.example.com/docs/%E6%96%87/?q=1")).toEqual({
      kind: "web",
      text: "example.com/docs/文",
    });
    expect(linkInfo("https://github.com/o/r")).toEqual({ kind: "web", text: "github.com/o/r" });
    expect(linkInfo("https://github.com/o/r/pull/1", "the fix")).toEqual({ kind: "pr", text: "the fix" });
  });
});

describe("blobLink", () => {
  it("reads the repository, ref and path, and the lines", () => {
    const link = blobLink("https://github.com/o/r/blob/feat/x/src/a%20b.ts#L10-L20")!;
    expect(link).toEqual({
      host: "github.com",
      repo: "o/r",
      segments: ["feat", "x", "src", "a b.ts"],
      dir: false,
      lines: { from: 10, to: 20 },
    });
    expect(blobPathCandidates(link)).toEqual(["x/src/a b.ts", "src/a b.ts", "a b.ts"]);
    expect(blobLink("https://github.com/o/r/blob/main/a.ts#L5C2")?.lines).toEqual({ from: 5, to: 5 });
    expect(blobLink("https://github.com/o/r/tree/main/src/")).toMatchObject({ dir: true, segments: ["main", "src"] });
  });

  it("is null for other links", () => {
    expect(blobLink("https://github.com/o/r/pull/1")).toBeNull();
    expect(blobLink("https://github.com/o/r/blob/main")).toBeNull();
    expect(blobLink("https://example.com/o/r/blob/main/a.ts")).toBeNull();
    expect(blobLink("https://github.com/o/r/blob/main/../a.ts")).toBeNull();
  });

  it("matches the repository's remotes, SSH or HTTPS, case aside", () => {
    const link = blobLink("https://github.com/L0ng-AI/OpenIdea/blob/main/a.ts")!;
    expect(isRemoteOf(["git@github.com:l0ng-ai/openidea.git"], link)).toBe(true);
    expect(isRemoteOf(["https://github.com/l0ng-ai/openidea"], link)).toBe(true);
    expect(isRemoteOf(["git@github.com:someone/openidea.git"], link)).toBe(false);
  });
});

it("pastedUrl takes a lone URL only", () => {
  expect(pastedUrl("  https://a.dev/x \n")).toBe("https://a.dev/x");
  expect(pastedUrl("see https://a.dev/x")).toBeNull();
  expect(pastedUrl("https://a.dev/x\nhttps://b.dev")).toBeNull();
});
