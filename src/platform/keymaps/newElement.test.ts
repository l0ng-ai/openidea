import { describe, expect, it } from "vitest";
import { compileWhen } from "@/platform/context";
import { GENERATE_KEY_WHEN } from "@/editor/lsp/actions";
import { intellijMacos } from "./intellij-macos";
import { intellijWindows } from "./intellij-windows";
import { vscodeMacos } from "./vscode-macos";

/** IDEA's NewElement (⌘N / Alt+Insert, shared with Generate) and NewElementSamePlace (⌃⌥N / Ctrl+Alt+Insert). */
describe("New keymap", () => {
  it("binds New in This Directory like IDEA", () => {
    expect(intellijMacos["project.newInThisDirectory"]).toEqual(["Ctrl+Alt+N"]);
    expect(intellijWindows["project.newInThisDirectory"]).toEqual(["Ctrl+Alt+Insert"]);
    expect(vscodeMacos["project.newInThisDirectory"]).toEqual([]);
  });

  it.each([intellijMacos, intellijWindows])("lets Generate win the New key only where it applies", (km) => {
    const ids = Object.keys(km);
    const key = km["project.newFile"]![0]!;
    expect(km["code.generate"]).toContain(key);
    expect(ids.indexOf("project.newFile")).toBeLessThan(ids.indexOf("code.generate"));
    const generate = compileWhen(GENERATE_KEY_WHEN);
    expect(generate({ editorLangId: "java" })).toBe(true);
    expect(generate({ editorLangId: "rust" })).toBe(true);
    expect(generate({ editorLangId: "python" })).toBe(true);
    expect(generate({ editorLangId: "ruby" })).toBe(false);
    expect(generate({ editorLangId: "markdown" })).toBe(false);
    expect(generate({})).toBe(false);
  });
});
