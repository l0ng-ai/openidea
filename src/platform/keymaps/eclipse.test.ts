import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAction } from "../actions";
import {
  applyKeymapSettings,
  bindingsFor,
  installKeyboardDispatcher,
  isValidBinding,
  normalizeBinding,
  PRESETS,
  PRESET_TITLES,
  useKeymap,
} from "../keymap";
import { eclipseMacos } from "./eclipse-macos";
import { eclipseWindows } from "./eclipse-windows";
import { intellijMacos } from "./intellij-macos";
import { intellijWindows } from "./intellij-windows";

const initial = useKeymap.getState();
afterEach(() => useKeymap.setState(initial));

const presets = [
  ["eclipse-windows", "Eclipse", eclipseWindows, intellijWindows, "Ctrl"],
  ["eclipse-macos", "Eclipse (macOS)", eclipseMacos, intellijMacos, "Meta"],
] as const;

const normalized = (keys: string[]) => keys.map(normalizeBinding);
const owners = (km: Record<string, string[]>, key: string) =>
  Object.keys(km).filter((id) => normalized(km[id]!).includes(normalizeBinding(key)));

// Shared shortcuts are intentional only on these separate focused surfaces. Existing
// parent collisions are not introduced by this preset; new pairs must be reviewed here.
const shared = [
  ["navigate.gotoClass", "terminal.new"],
  ["navigate.recentLocations", "project.open", "debug.jumpToSource", "diff.jumpToSource", "find.popup.openResult"],
  [
    "navigate.declaration",
    "db.goToDdl",
    "project.open",
    "debug.jumpToSource",
    "diff.jumpToSource",
    "find.popup.openResult",
  ],
  ["navigate.typeHierarchy", "db.editData"],
  ["find.replaceInFile", "agents.findInConversation", "vcs.log.goToRef"],
  ["find.next", "find.popup.nextResult"],
  ["find.previous", "find.popup.previousResult"],
  ["find.usages", "project.findUsages"],
  ["code.quickDocumentation", "db.quickDoc", "debug.setValue", "vcs.changelist.edit"],
  ["code.reformat", "project.reformatCode"],
  ["code.optimizeImports", "project.optimizeImports"],
  ["code.deleteLine", "db.duplicateSource", "project.compareWith", "vcs.showDiff"],
  ["code.moveStatementDown", "find.field.recentSearches", "find.popup.recentSearches"],
  ["code.foldAll", "project.collapseAll"],
  ["refactor.rename", "project.rename", "db.rename", "vcs.changelist.edit", "vcs.log.editMessage", "vcs.shelf.rename"],
  ["refactor.changeSignature", "db.modifyTable"],
  ["refactor.move", "project.move"],
  ["editor.closeTab", "toolwindow.closeContent"],
  ["run.rerun", "debug.rerun", "find.rerun", "usages.rerun"],
  ["debug.smartStepInto", "db.refresh"],
  ["debug.runToCursor", "db.refresh"],
  ["editor.increaseFontSize", "image.zoomIn"],
  ["editor.decreaseFontSize", "image.zoomOut"],
];

describe.each(presets)("%s", (preset, title, km, parent, mod) => {
  it("is listed, loads, switches without stale overrides, and can parent a custom keymap", () => {
    expect(PRESETS[preset]).toBe(km);
    expect(PRESET_TITLES[preset]).toBe(title);
    applyKeymapSettings("vscode-macos", { "navigate.gotoFile": ["Alt+X"] });
    applyKeymapSettings(preset, {});
    expect(useKeymap.getState().preset).toBe(preset);
    expect(bindingsFor("navigate.gotoFile")).toEqual(km["navigate.gotoFile"]);
    applyKeymapSettings(
      "custom.eclipse",
      {},
      {
        "custom.eclipse": { parent: preset, overrides: { "file.save": ["Alt+S"] } },
      },
    );
    expect(useKeymap.getState().preset).toBe(preset);
    expect(bindingsFor("file.save")).toEqual(["Alt+S"]);
    expect(bindingsFor("navigate.gotoFile")).toEqual(km["navigate.gotoFile"]);
  });

  it("has valid bindings, no duplicate entries, and no unreviewed new conflicts", () => {
    for (const [id, keys] of Object.entries(km)) {
      expect(keys.every(isValidBinding), id).toBe(true);
      expect(new Set(normalized(keys)).size, id).toBe(keys.length);
      for (const key of keys) {
        for (const other of owners(km, key).filter((other) => other !== id)) {
          const inherited = owners(parent, key);
          expect(
            (inherited.includes(id) && inherited.includes(other)) ||
              shared.some((group) => group.includes(id) && group.includes(other)),
            `${key}: ${id} / ${other}`,
          ).toBe(true);
        }
      }
    }
  });

  it.each([
    ["navigate.gotoFile", "Shift+R"],
    ["navigate.gotoClass", "Shift+T"],
    ["code.deleteLine", "D"],
    ["code.showIntentions", "1"],
    ["code.optimizeImports", "Shift+O"],
    ["code.reformat", "Shift+F"],
    ["code.commentLine", "/"],
  ])("binds %s", (id, suffix) => {
    expect(normalized(km[id]!)).toContain(normalizeBinding(`${mod}+${suffix}`));
  });

  it("preserves official removals and platform-specific bindings", () => {
    expect(km["navigate.declaration"]).toEqual(["F3"]);
    expect(km["diff.nextDifference"]).toEqual(["Ctrl+F7"]);
    expect(km["diff.prevDifference"]).toEqual(["Shift+F7"]);
    expect(km["code.moveStatementUp"]).toEqual(["Alt+Up"]);
    expect(km["code.moveStatementDown"]).toEqual(["Alt+Down"]);
    for (const id of ["code.moveLineUp", "code.moveLineDown", "navigate.gotoTest", "find.replaceInPath"])
      expect(km[id], id).toEqual([]);
    expect(km["code.completion"]).toEqual(parent["code.completion"]);
    expect(km["navigate.back"]).toContain("Button4");
    expect(km["navigate.forward"]).toContain("Button5");
    expect(km["vcs.push"]).toEqual([]);
  });

  it("leaves undo / redo to the focused component", () => {
    for (const key of [`${mod}+Z`, `${mod}+Shift+Z`]) expect(owners(km, key), key).toEqual([]);
    // Eclipse's Ctrl+Y Redo reaches the editor once Delete Line moves to Ctrl+D.
    if (mod === "Ctrl") expect(owners(km, "Ctrl+Y")).toEqual([]);
  });

  it("distinguishes keypad folding from font size and block comments during dispatch", () => {
    applyKeymapSettings(preset, {});
    const actions = ["code.fold", "editor.decreaseFontSize", "code.foldAll", "code.commentBlock"];
    const runs = actions.map(() => vi.fn());
    const disposers = actions.map((id, i) => registerAction({ id, title: id, run: runs[i]! }));
    const uninstall = installKeyboardDispatcher(window);
    try {
      for (const [code, shiftKey, index] of [
        ["NumpadSubtract", false, 0],
        ["Minus", false, 1],
        ["NumpadDivide", true, 2],
        ["Slash", true, 3],
      ] as const) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            code,
            key: code,
            ctrlKey: mod === "Ctrl",
            metaKey: mod === "Meta",
            shiftKey,
          }),
        );
        expect(runs[index]).toHaveBeenCalledOnce();
      }
    } finally {
      uninstall();
      disposers.forEach((dispose) => dispose());
    }
  });
});

it("uses the bundled Run / Debug choices rather than assuming Ctrl becomes Cmd", () => {
  expect(normalized(eclipseWindows["run.debug"]!)).toEqual(normalized(["Alt+Shift+D", "Shift+F9"]));
  expect(normalized(eclipseWindows["run.run"]!)).toEqual(normalized(["Alt+Shift+X", "Shift+F10"]));
  expect(eclipseWindows["run.rerun"]).toEqual(["Ctrl+F11"]);
  expect(owners(eclipseWindows, "F11")).toEqual([]);
  expect(eclipseMacos["run.debug"]).toEqual(["Meta+F11"]);
  expect(eclipseMacos["run.run"]).toEqual(["Meta+Shift+F11"]);
  expect(eclipseMacos["run.rerun"]).toEqual([]);
  expect(eclipseMacos["navigate.navigationBar"]).toEqual(["Alt+Meta+B"]);
  expect(
    Object.values(eclipseWindows)
      .flat()
      .some((key) => key.includes("Meta")),
  ).toBe(false);
});

it("keeps numeric-keypad aliases working for existing presets", () => {
  applyKeymapSettings("intellij-windows", {});
  const run = vi.fn();
  const dispose = registerAction({ id: "code.fold", title: "code.fold", run });
  const uninstall = installKeyboardDispatcher(window);
  try {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "NumpadSubtract", key: "-", ctrlKey: true }));
    expect(run).toHaveBeenCalledOnce();
  } finally {
    uninstall();
    dispose();
  }
});
