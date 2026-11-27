import { describe, expect, it, vi } from "vitest";
import { MAX_COUNT } from "@/editor/core/cm/find";
import {
  findMatchesInNode,
  findPreviewMatches,
  invalidatePreviewIndex,
  openDetailsContaining,
  selectionMatchesInNode,
  setPreviewHighlight,
} from "./highlight";
import type { LiveMarkdownFind } from "./live";

const query: LiveMarkdownFind = {
  search: "token",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  matchLines: [0, 2],
  currentMatchIndex: 0,
};

function preview(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("preview text index", () => {
  it("reuses a 5,000-line DOM index for typing, selection and navigation", () => {
    const root = preview(
      Array.from({ length: 2500 }, (_, i) => `<div data-line="${i * 2}"><p>token</p></div>`).join(""),
    );
    const scan = vi.spyOn(root, "querySelectorAll");
    const lines = Array.from({ length: 2500 }, (_, i) => i * 2);
    const initial = findPreviewMatches(root, { ...query, matchLines: lines });
    expect(initial.ranges).toHaveLength(2500);
    let typed = initial;
    for (const search of ["t", "to", "tok", "toke", "token"]) {
      typed = findPreviewMatches(root, { ...query, search, matchLines: lines });
    }
    const next = findPreviewMatches(root, { ...query, matchLines: lines, currentMatchIndex: 2499 });
    expect(next.current).toBe(typed.ranges[2499]);
    openDetailsContaining(next.current!, root, new Map());
    expect(selectionMatchesInNode(root, "token")).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("rebuilds ranges after rendered text is replaced", () => {
    const root = preview('<div data-line="0"><p>token</p></div>');
    const old = findPreviewMatches(root, query).current;
    root.innerHTML = '<div data-line="0"><p>new token</p></div>';
    invalidatePreviewIndex(root);
    const current = findPreviewMatches(root, query).current;
    expect(current?.toString()).toBe("token");
    expect(current?.startContainer).not.toBe(old?.startContainer);
    expect(root.contains(current!.startContainer)).toBe(true);
  });

  it("does not substitute a match from another block for hidden source text", () => {
    const root = preview('<div data-line="0"><p>token</p></div><div data-line="2"><p>plain</p></div>');
    expect(findPreviewMatches(root, { ...query, currentMatchIndex: 1 }).current).toBeNull();
  });

  it("caps ranges across all blocks", () => {
    const root = preview(`<div data-line="0">${"token ".repeat(MAX_COUNT)}</div><div data-line="2">token</div>`);
    expect(findPreviewMatches(root, query).ranges).toHaveLength(MAX_COUNT);
  });

  it("advances zero-width Unicode regexes by a complete code point", () => {
    const root = preview("😀token");
    expect(findMatchesInNode(root, { ...query, search: "(?=.)|token", regexp: true })).toEqual([]);
    expect(
      findMatchesInNode(root, { ...query, search: "(?=😀)|token", regexp: true }).map((r) => r.toString()),
    ).toEqual(["token"]);
  });

  it("recognises astral letters at whole-word boundaries", () => {
    const root = preview("𐐀token token𐐀 token");
    expect(findMatchesInNode(root, { ...query, wholeWord: true }).map((r) => r.toString())).toEqual(["token"]);
  });

  it("silently skips registration when the Custom Highlight API is unavailable", () => {
    const root = preview("token");
    vi.stubGlobal("Highlight", undefined);
    try {
      expect(() => setPreviewHighlight("markdown-find", root, findMatchesInNode(root, query))).not.toThrow();
      setPreviewHighlight("markdown-find", root, []);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
