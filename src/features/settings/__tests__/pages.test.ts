import { describe, expect, it } from "vitest";
import type { SettingsPageContribution } from "@/workbench/contributions";
import {
  breadcrumb,
  buildPageTree,
  filterPageTree,
  flatten,
  highlightIndices,
  matchesTerms,
  queryTerms,
} from "../model/pages";
import { BEHAVIOR_PAGES } from "../pages/behavior";
import { EDITOR_PAGES } from "../pages/editor";
import { specLabels } from "../pages/spec";

const C = () => null;
const page = (p: Partial<SettingsPageContribution> & { id: string; title: string }): SettingsPageContribution => ({
  component: C,
  ...p,
});

const pages = [
  page({ id: "appearance", title: "Appearance", group: "Appearance & Behavior", order: 0 }),
  page({ id: "general", title: "System Settings", group: "Appearance & Behavior", order: 1 }),
  page({ id: "keymap", title: "Keymap", order: 10, keywords: ["shortcut"] }),
  page({ id: "editor.font", title: "Font", group: "Editor", order: 21 }),
  page({ id: "editor.general", title: "General", group: "Editor", order: 20 }),
  page({ id: "languages", title: "Languages & Frameworks", order: 40 }),
  page({ id: "languages.servers", title: "Language Servers", keywords: ["lsp"] }),
  page({ id: "plugins", title: "Plugins" }),
];

describe("page tree", () => {
  it("nests by dotted id, then by group, sorted by order", () => {
    const tree = buildPageTree(pages);
    expect(tree.map((n) => n.title)).toEqual([
      "Appearance & Behavior",
      "Keymap",
      "Editor",
      "Languages & Frameworks",
      "Plugins",
    ]);
    expect(tree[2]!.children.map((n) => n.key)).toEqual(["editor.general", "editor.font"]);
    expect(tree[3]!.children.map((n) => n.key)).toEqual(["languages.servers"]);
    expect(breadcrumb(tree, "editor.font")).toEqual(["Editor", "Font"]);
  });

  it("filters by title, keywords, group path and option labels", () => {
    const tree = buildPageTree(pages);
    const keys = (q: string, labels: Record<string, string[]> = {}) =>
      flatten(filterPageTree(tree, q, (id) => labels[id] ?? []))
        .filter((n) => n.page && (q ? n.matched : true))
        .map((n) => n.key);
    expect(keys("")).toHaveLength(pages.length);
    expect(keys("lsp")).toEqual(["languages.servers"]);
    expect(keys("editor font")).toEqual(["editor.font"]);
    expect(keys("shortcut")).toEqual(["keymap"]);
    expect(keys("soft wrap", { "editor.general": ["Soft-wrap files"] })).toEqual(["editor.general"]);
    expect(keys("nothing-matches-this")).toEqual([]);
  });

  it("highlights every term occurrence in labels", () => {
    expect(queryTerms("  Soft  WRAP ")).toEqual(["soft", "wrap"]);
    expect(highlightIndices("Soft-wrap files", "wrap soft")).toEqual([0, 1, 2, 3, 5, 6, 7, 8]);
    expect(highlightIndices("Font", "")).toBeNull();
    expect(highlightIndices("Font", "xyz")).toBeNull();
    expect(matchesTerms(["Tab size", "Indentation"], ["tab", "indent"])).toBe(true);
    expect(matchesTerms(["Tab size"], ["tab", "indent"])).toBe(false);
  });

  it("indexes built-in option labels for search", () => {
    const general = EDITOR_PAGES.find((p) => p.id === "editor.general")!;
    expect(general.dynamicLabels!()).toEqual(
      expect.arrayContaining(["Soft-wrap files", "Reformat code on save", "Save Files"]),
    );
    const completion = EDITOR_PAGES.find((p) => p.id === "editor.general.codeCompletion")!;
    expect(completion.dynamicLabels!()).toEqual(
      expect.arrayContaining(["Show suggestions as you type", "First letter only"]),
    );
    const appearance = BEHAVIOR_PAGES.find((p) => p.id === "appearance")!;
    expect(specLabels(appearance)).toEqual(
      expect.arrayContaining([
        "Accent colour",
        "High Contrast",
        "UI font size",
        "Zoom",
        "Compact mode",
        "Antialiasing",
      ]),
    );
  });
});

it("indexes toolbar and status bar visibility in Appearance settings", () => {
  const appearance = BEHAVIOR_PAGES.find((p) => p.id === "appearance")!;
  const labels = specLabels(appearance);
  expect(labels).toContain("Show main toolbar");
  expect(labels).toContain("Show status bar");
});
