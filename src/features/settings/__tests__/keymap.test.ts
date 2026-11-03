import { afterEach, describe, expect, it, vi } from "vitest";
import { allActions, registerAction } from "@/platform/actions";
import {
  applyKeymapSettings,
  bindingsFor,
  defaultPreset,
  installKeyboardDispatcher,
  isValidBinding,
  normalizeBinding,
  PRESETS,
  strokeOf,
  suspendKeyboardDispatch,
  useKeymap,
} from "@/platform/keymap";
import { intellijMacos } from "@/platform/keymaps/intellij-macos";
import { vscodeMacos } from "@/platform/keymaps/vscode-macos";
import {
  addBinding,
  bindingMatches,
  findConflicts,
  isModified,
  removeBinding,
  removeConflicts,
  resetBindings,
  resolveBindings,
  switchPreset,
  whensOverlap,
  activeDraft,
  copyName,
  deleteKeymap,
  duplicateKeymap,
  keymapName,
  renameKeymap,
  validateKeymapName,
  withCustomOverrides,
  type KeymapDraft,
} from "../keymap/model";
import { buildKeymapTree } from "../keymap/KeymapPage";
import { groupPath } from "../keymap/groups";
import { registerLspActions } from "@/editor/lsp/actions";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";

it("finds the translated declaration action by 声明 and its English title", async () => {
  const dispose = registerLspActions();
  try {
    await setLocale("zh");
    for (const query of ["声明", "Go to Declaration or Usages"]) {
      const tree = buildKeymapTree(allActions(), { preset: "intellij-macos", overrides: {} }, query, "");
      const titles = (nodes: typeof tree): string[] =>
        nodes.flatMap((node) => (node.kind === "group" ? titles(node.children) : [node.action.title]));
      expect(titles(tree)).toContain("转到声明或用法");
    }
  } finally {
    dispose();
    _resetI18nForTests();
  }
});

const key = (
  code: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
  k = "",
) => ({
  code,
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("shortcut recording + normalization", () => {
  it("records strokes in canonical form", () => {
    expect(strokeOf(key("KeyD", { metaKey: true, shiftKey: true }, "d"))).toBe("Shift+Meta+D");
    expect(normalizeBinding("Meta+Shift+D")).toBe("Shift+Meta+D");
    expect(strokeOf(key("Comma", { metaKey: true }, ","))).toBe("Meta+,");
    expect(strokeOf(key("F12", { altKey: true }))).toBe("Alt+F12");
    expect(strokeOf(key("MetaLeft", { metaKey: true }, "Meta"))).toBeNull();
    expect(normalizeBinding("meta+k   META+c")).toBe("Meta+K Meta+C");
  });

  it("validates bindings from settings files", () => {
    expect(isValidBinding("Meta+Shift+O")).toBe(true);
    expect(isValidBinding("Meta+K Meta+C")).toBe(true);
    expect(isValidBinding("Shift Shift")).toBe(true);
    expect(isValidBinding("F8")).toBe(true);
    expect(isValidBinding("Hyper+K")).toBe(false);
    expect(isValidBinding("A B C")).toBe(false);
    expect(isValidBinding("")).toBe(false);
    expect(isValidBinding(42)).toBe(false);
  });
});

describe("overrides", () => {
  const draft: KeymapDraft = { preset: "intellij-macos", overrides: {} };

  it("adds, removes and resets, dropping overrides equal to the preset", () => {
    const added = addBinding(draft, "file.save", "Ctrl+S");
    expect(added["file.save"]).toEqual(["Meta+S", "Ctrl+S"]);
    const d2 = { ...draft, overrides: added };
    expect(isModified(d2, "file.save")).toBe(true);
    expect(removeBinding(d2, "file.save", "Ctrl+S")).toEqual({});
    const unbound = removeBinding(draft, "file.save", "Meta+S");
    expect(unbound).toEqual({ "file.save": [] });
    expect(resolveBindings({ ...draft, overrides: unbound }, "file.save")).toEqual([]);
    expect(resetBindings(d2, "file.save")).toEqual({});
  });

  it("de-duplicates equivalent bindings", () => {
    expect(addBinding(draft, "file.save", "meta+s")).toEqual({});
  });

  it("switching presets keeps real overrides and rebases the rest", () => {
    const d = {
      preset: "intellij-macos",
      overrides: { "file.save": ["Meta+S", "Ctrl+S"], "navigate.gotoFile": ["Meta+P"] },
    };
    const next = switchPreset(d, "vscode-macos");
    expect(next.preset).toBe("vscode-macos");
    // Meta+P is VS Code's own default for gotoFile: no longer an override.
    expect(next.overrides).toEqual({ "file.save": ["Meta+S", "Ctrl+S"] });
    expect(resolveBindings(next, "navigate.gotoFile")).toEqual(["Meta+P"]);
    expect(resolveBindings(next, "navigate.declaration")).toEqual(["F12"]);
  });
});

describe("conflicts", () => {
  const actions = [
    { id: "code.duplicateLine", title: "Duplicate Line", category: "Code", when: "editorFocus" },
    { id: "vcs.showDiff", title: "Show Diff", category: "VCS", when: "changesViewFocus" },
    { id: "project.newFile", title: "New File", category: "Project", when: "projectViewFocus" },
    { id: "code.generate", title: "Generate", category: "Code", when: "editorFocus" },
    { id: "chord.one", title: "Chord", when: undefined },
    { id: "mine", title: "Mine", when: "editorFocus" },
  ];
  const draft: KeymapDraft = {
    preset: "intellij-macos",
    overrides: { "chord.one": ["Meta+K Meta+C"], mine: [] },
  };

  it("reports same-binding conflicts in overlapping contexts only", () => {
    const c = findConflicts(draft, "Meta+D", "mine", actions);
    expect(c.map((x) => x.actionId)).toEqual(["code.duplicateLine"]);
    expect(c[0]!.kind).toBe("same");
    // Meta+N: New File (project view) and Generate (editor) — only the editor one overlaps.
    expect(findConflicts(draft, "Meta+N", "mine", actions).map((x) => x.actionId)).toEqual(["code.generate"]);
  });

  it("reports chord prefix conflicts", () => {
    const c = findConflicts(draft, "Meta+K", "mine", actions);
    expect(c).toContainEqual(
      expect.objectContaining({ actionId: "chord.one", kind: "prefix", binding: "Meta+K Meta+C" }),
    );
  });

  it("removes other assignments", () => {
    const c = findConflicts(draft, "Meta+D", "mine", actions);
    const overrides = removeConflicts(draft, c);
    expect(overrides["code.duplicateLine"]).toEqual([]);
    expect(overrides["vcs.showDiff"]).toBeUndefined();
  });

  it("evaluates when-clause overlap", () => {
    expect(whensOverlap(undefined, "editorFocus")).toBe(true);
    expect(whensOverlap("editorFocus", "editorFocus")).toBe(true);
    expect(whensOverlap("editorFocus", "!editorFocus")).toBe(false);
    expect(whensOverlap("editorFocus", "projectViewFocus")).toBe(false);
    expect(whensOverlap("editorFocus && lang == 'rust'", "lang == 'go'")).toBe(false);
    expect(whensOverlap("editorFocus || debug", "debug && !editorFocus")).toBe(true);
    expect(whensOverlap("a == 1", "a != 1")).toBe(false);
    // Focus keys: one focus location at a time; views imply toolWindowFocus.
    expect(whensOverlap("editorFocus", "terminalFocus")).toBe(false);
    expect(whensOverlap("editorFocus", "editorTextFocus")).toBe(true);
    expect(whensOverlap("toolWindowFocus && !popupOpen", "projectViewFocus")).toBe(true);
    expect(whensOverlap("toolWindowFocus", "editorFocus")).toBe(false);
    expect(whensOverlap("projectOpen", "editorFocus")).toBe(true);
  });
});

describe("shortcut search", () => {
  it("matches exact bindings and chord first strokes", () => {
    expect(bindingMatches(["Meta+K Meta+C"], "Meta+K")).toBe(true);
    expect(bindingMatches(["Shift+Meta+O"], "Meta+Shift+O")).toBe(true);
    expect(bindingMatches(["Meta+O"], "Meta+Shift+O")).toBe(false);
  });

  it("filters the keymap tree by name and by shortcut", () => {
    const run = () => {};
    const actions = [
      { id: "file.save", title: "Save All", category: "File", run },
      { id: "navigate.gotoFile", title: "Go to File…", category: "Navigate", run },
      { id: "internal.x", title: "Internal", hidden: true, run },
    ];
    const draft = { preset: "intellij-macos", overrides: {} };
    const all = buildKeymapTree(actions, draft, "", "");
    expect(all.map((n) => n.key)).toEqual(["grp:Main Menu"]);
    const menu = all[0]!.kind === "group" ? all[0]!.children : [];
    expect(menu.map((n) => n.key)).toEqual(["grp:Main Menu/File", "grp:Main Menu/Navigate"]);
    const byName = buildKeymapTree(actions, draft, "gofi", "");
    expect(byName[0]!.kind === "group" && byName[0]!.children.map((n) => n.key)).toEqual(["grp:Main Menu/Navigate"]);
    const byKeys = buildKeymapTree(actions, draft, "", "Meta+S");
    expect(byKeys).toHaveLength(1);
    const file = byKeys[0]!.kind === "group" ? byKeys[0]!.children[0] : undefined;
    expect(file?.kind === "group" && file.children[0]!.key).toBe("file.save");
  });
});

describe("keymap tree groups", () => {
  const run = () => {};
  it("places actions like IDEA: menu order, submenus after actions, other roots last", () => {
    const actions = [
      { id: "find.inFile", title: "Find…", category: "Find", run },
      { id: "edit.undo", title: "Undo", category: "Edit", run },
      { id: "file.save", title: "Save All", category: "File", run },
      { id: "debug.stepOver", title: "Step Over", category: "Debug", run },
      { id: "toolwindow.project", title: "Project", category: "Tool Windows", run },
      { id: "terminal.new", title: "New Terminal", category: "Terminal", run },
      { id: "plugin.hello.say", title: "Say Hello", category: "Hello", run },
      { id: "x.misc", title: "Misc", category: "Weird", run },
      { id: "editor.showHint", title: "Show Hint", run },
    ];
    const tree = buildKeymapTree(actions, { preset: "intellij-macos", overrides: {} }, "", "");
    expect(tree.map((n) => n.key)).toEqual([
      "grp:Main Menu",
      "grp:Editor Actions",
      "grp:Tool Windows",
      "grp:Other",
      "grp:Plugins",
    ]);
    const keys = (n: (typeof tree)[number]): string[] =>
      n.kind === "group" ? [n.key, ...n.children.flatMap(keys)] : [n.key];
    expect(keys(tree[0]!)).toEqual([
      "grp:Main Menu",
      "grp:Main Menu/File",
      "file.save",
      "grp:Main Menu/Edit",
      "edit.undo",
      "grp:Main Menu/Edit/Find",
      "find.inFile",
      "grp:Main Menu/Run",
      "grp:Main Menu/Run/Debugging Actions",
      "debug.stepOver",
    ]);
    expect(keys(tree[4]!)).toEqual([
      "grp:Plugins",
      "grp:Plugins/Hello",
      "plugin.hello.say",
      "grp:Plugins/Terminal",
      "terminal.new",
    ]);
    expect(groupPath({ id: "x.misc", category: "Weird" })).toEqual(["Other", "Weird"]);
  });
});

describe("user keymaps", () => {
  const draft: KeymapDraft = { preset: "vscode-macos", overrides: { "file.save": ["Ctrl+S"] } };

  it("duplicates, renames and deletes", () => {
    expect(copyName("macOS", {})).toBe("macOS copy");
    const dup = duplicateKeymap(draft, {}, "Mine");
    expect(dup.id).toBe("custom.mine");
    expect(dup.customs[dup.id]).toEqual({
      name: "Mine",
      parent: "vscode-macos",
      overrides: { "file.save": ["Ctrl+S"] },
    });
    expect(copyName("Mine", dup.customs)).toBe("Mine copy");
    expect(validateKeymapName("Mine", dup.customs)).toMatch(/already exists/);
    expect(validateKeymapName("Mine", dup.customs, dup.id)).toBeNull();
    expect(validateKeymapName("macOS", {})).toMatch(/already exists/);
    expect(validateKeymapName("  ", {})).toMatch(/empty/);
    expect(duplicateKeymap(draft, dup.customs, "mine!").id).toBe("custom.mine-2");
    const renamed = renameKeymap(dup.customs, dup.id, "Ours");
    expect(keymapName(dup.id, renamed)).toBe("Ours");
    expect(deleteKeymap(renamed, dup.id)).toEqual({ customs: {}, selected: "vscode-macos" });
  });

  it("edits target the selected keymap", () => {
    const customs = duplicateKeymap(draft, {}, "Mine").customs;
    expect(activeDraft("custom.mine", { "x.y": [] }, customs)).toEqual(draft);
    expect(activeDraft("intellij-macos", { "x.y": [] }, customs)).toEqual({
      preset: "intellij-macos",
      overrides: { "x.y": [] },
    });
    expect(activeDraft("custom.gone", {}, customs).preset).toBe(defaultPreset());
    const next = withCustomOverrides(customs, "custom.mine", {});
    expect(next["custom.mine"]!.overrides).toEqual({});
  });

  it("applies a user keymap as its parent preset plus its overrides", () => {
    applyKeymapSettings(
      "custom.mine",
      { "file.save": ["Meta+1"] },
      {
        "custom.mine": { name: "Mine", parent: "vscode-macos", overrides: { "file.save": ["Ctrl+S"] } },
      },
    );
    expect(useKeymap.getState().preset).toBe("vscode-macos");
    expect(bindingsFor("file.save")).toEqual(["Ctrl+S"]);
    applyKeymapSettings(defaultPreset(), {});
  });
});

describe("applyKeymapSettings", () => {
  afterEach(() => useKeymap.setState({ preset: defaultPreset(), overrides: {} }));

  it("ships the VS Code preset for every IntelliJ action id", () => {
    expect(PRESETS["vscode-macos"]).toBe(vscodeMacos);
    expect(Object.keys(intellijMacos).filter((id) => !(id in vscodeMacos))).toEqual([]);
    for (const keys of Object.values(vscodeMacos)) for (const k of keys) expect(isValidBinding(k)).toBe(true);
  });

  it("applies preset + overrides and validates input", () => {
    applyKeymapSettings("vscode-macos", { "file.save": ["ctrl+s", "Bogus+X", 7], "vcs.commit": "Meta+K" });
    expect(useKeymap.getState().preset).toBe("vscode-macos");
    expect(bindingsFor("file.save")).toEqual(["Ctrl+S"]);
    expect(bindingsFor("navigate.gotoFile")).toEqual(["Meta+P"]);
    expect(useKeymap.getState().overrides["vcs.commit"]).toBeUndefined();

    applyKeymapSettings("no-such-preset", null);
    expect(useKeymap.getState()).toMatchObject({ preset: defaultPreset(), overrides: {} });
    expect(bindingsFor("navigate.gotoFile")).toEqual(["Meta+Shift+O"]);
  });

  it("suspends the dispatcher while recording", async () => {
    const run = vi.fn();
    registerAction({ id: "t.suspend", title: "t", run });
    applyKeymapSettings(defaultPreset(), { "t.suspend": ["Meta+Y"] });
    const uninstall = installKeyboardDispatcher(window);
    const press = () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyY", key: "y", metaKey: true }));
    const resume = suspendKeyboardDispatch();
    press();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    resume();
    resume();
    press();
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    uninstall();
  });
});
