import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { indentPastedText, matchesFilePatterns, softWrapActive } from "./prefs";
import { detectIndent, effectiveIndent, prefsOf, wrapExtension } from "./setup";
import { ModifiedRanges, saveCleanupChanges } from "../model/document";
import { enforceTabLimit, initialTabsState, openTab } from "../model/tabs";
import { matchesCase } from "@/editor/lsp/completion";
import { DEFAULT_SETTINGS } from "@/features/settings/model/schema";
import type { EditorSettings } from "@/platform/ipc";

describe("editor settings behaviour", () => {
  it("matches soft-wrap file patterns and treats an unset softWrap like the default settings", () => {
    expect(matchesFilePatterns("*.md; *.txt", "/p/README.md")).toBe(true);
    expect(matchesFilePatterns("*.md; *.txt", "/p/main.rs")).toBe(false);
    expect(matchesFilePatterns("*", "/p/main.rs")).toBe(true);
    expect(softWrapActive(undefined, prefsOf(undefined), "/p/README.md")).toBe(
      softWrapActive(DEFAULT_SETTINGS.editor.softWrap, prefsOf(DEFAULT_SETTINGS.editor), "/p/README.md"),
    );
    expect(softWrapActive(undefined, prefsOf(undefined), "/p/main.rs")).toBe(
      softWrapActive(DEFAULT_SETTINGS.editor.softWrap, prefsOf(DEFAULT_SETTINGS.editor), "/p/main.rs"),
    );
    expect(wrapExtension(undefined, "/p/README.md")).toBe(wrapExtension(DEFAULT_SETTINGS.editor, "/p/README.md"));
    expect(softWrapActive(false, prefsOf(undefined), "/p/README.md")).toBe(false);
  });

  it("re-indents a pasted block to the caret column", () => {
    expect(indentPastedText("if x:\n    a()\n    b()", 4, " ", 4)).toBe("if x:\n        a()\n        b()");
    expect(indentPastedText("    a()\n    b()", 0, " ", 4)).toBe("a()\nb()");
    expect(indentPastedText("one line", 8, " ", 4)).toBe("one line");
  });

  it("detects file indents and layers code style overrides", () => {
    expect(detectIndent("a\n  b\n    c\n  d\n")).toEqual({ insertSpaces: true, size: 2 });
    expect(detectIndent("a\n\tb\n\t\tc\n")).toEqual({ insertSpaces: false });
    expect(detectIndent("plain\ntext\n")).toBeNull();
    const info = { id: "python", indent: { tabSize: 4, insertSpaces: true } } as Parameters<typeof effectiveIndent>[1];
    const settings = {
      codeStyle: { languages: { python: { useTab: true, tabSize: 8 } }, detectIndents: true, editorconfig: false },
    } as unknown as EditorSettings;
    expect(effectiveIndent(settings, info)).toEqual({ tabSize: 8, insertSpaces: false });
    expect(effectiveIndent(settings, info, { indentSize: 2, indentStyle: "space" } as never)).toEqual({
      tabSize: 8,
      insertSpaces: false,
    });
    expect(effectiveIndent(settings, info, null, { insertSpaces: true, size: 2 })).toEqual({
      tabSize: 2,
      insertSpaces: true,
    });
  });

  it("removes trailing blank lines and strips all lines on request", () => {
    const state = EditorState.create({ doc: "a  \nb\n\n\n" });
    const changes = saveCleanupChanges(state, new ModifiedRanges(), {
      trim: true,
      finalNewline: true,
      protectLines: new Set(),
      allLines: true,
      trailingBlankLines: true,
    });
    const out = state.update({ changes }).state.doc.toString();
    expect(out).toBe("a\nb\n");
  });

  it("closes unchanged least recently used tabs beyond the limit", () => {
    let s = initialTabsState();
    const pane = s.activePane;
    const ids: string[] = [];
    for (const p of ["a", "b", "c"]) {
      const r = openTab(s, pane, { kind: "file", key: p, path: p });
      s = r.state;
      ids.push(r.tabId);
    }
    s = enforceTabLimit(s, pane, 2, "unchanged", (t) => t.input.path === "a", ids[2]);
    expect(s.panes[pane]!.tabs.map((t) => t.input.key)).toEqual(["a", "c"]);
  });

  it("matches completion case", () => {
    expect(matchesCase("String", "s", "first")).toBe(false);
    expect(matchesCase("string", "s", "first")).toBe(true);
    expect(matchesCase("toString", "tS", "all")).toBe(true);
    expect(matchesCase("tostring", "tS", "all")).toBe(false);
  });
});
