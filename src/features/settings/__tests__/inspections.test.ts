import { describe, expect, it } from "vitest";
import {
  buildInspectionTree,
  checkState,
  filterInspectionTree,
  inspectionIds,
  setEnabled,
  copyProfile,
  deleteProfile,
  renameProfile,
  setLevel,
  withProfileOverrides,
  pathToInspection,
  setOption,
  type InspectionNode,
} from "../pages/editor/inspectionsModel";
import { splitPageTarget } from "../model/staging";
import { validateInspections } from "@/platform/inspections";
import { NATURAL_LANGUAGES_PAGE, SPELLING_PAGE } from "../pages/editor/spelling";
import { INSPECTIONS_PAGE } from "../pages/editor/inspections";
import { EDITOR_PAGES } from "../pages/editor";

const languages = [
  { name: "Python", servers: ["basedpyright", "ruff"] },
  { name: "Markdown", servers: [] },
  { name: "TypeScript", servers: ["typescript-language-server"] },
  { name: "JavaScript", servers: ["typescript-language-server"] },
];
const seen = [
  { producer: "ruff", code: "F401", source: "Ruff", sample: "`os` imported but unused" },
  { producer: "custom-ls", code: "X1", source: "custom", sample: "" },
];

const find = (nodes: readonly InspectionNode[], key: string): InspectionNode | undefined => {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = find(n.children, key);
    if (hit) return hit;
  }
  return undefined;
};

describe("inspections tree", () => {
  const tree = buildInspectionTree(languages, seen, [{ "lsp:ruff:E501": { severity: "typo" } }]);

  it("groups servers by language with seen and configured codes, built-ins by category", () => {
    expect(tree.map((g) => g.name)).toEqual(["General", "JavaScript", "Other", "Proofreading", "Python", "SQL", "TypeScript"]);
    const python = find(tree, "group:Python")!;
    expect(python.children.map((n) => n.id)).toEqual(["lsp:basedpyright", "lsp:ruff"]);
    expect(python.children[1]!.children.map((n) => n.id)).toEqual(["lsp:ruff:E501", "lsp:ruff:F401"]);
    expect(find(tree, "Python/lsp:ruff:F401")!.description).toContain("imported but unused");
    expect(find(tree, "group:Other")!.children.map((n) => n.id)).toEqual(["lsp:custom-ls"]);
    expect(find(tree, "group:General")!.children.map((n) => n.id)).toContain("builtin:file-references");
    // A server of several languages appears under each, as the same inspection.
    expect(find(tree, "JavaScript/lsp:typescript-language-server")!.description).toContain("TypeScript, JavaScript");
  });

  it("filters by name, code and group, keeping ancestors", () => {
    const out = filterInspectionTree(tree, "f401");
    expect(out.map((g) => g.name)).toEqual(["Python"]);
    expect(inspectionIds(out[0]!)).toEqual(["lsp:ruff", "lsp:ruff:F401"]);
    expect(filterInspectionTree(tree, "python ruff")[0]!.children.map((n) => n.id)).toEqual(["lsp:ruff"]);
    expect(filterInspectionTree(tree, "")).toHaveLength(tree.length);
  });

  it("derives tri-state checkboxes and toggles whole subtrees", () => {
    const python = find(tree, "group:Python")!;
    const ruff = find(tree, "Python/lsp:ruff")!;
    let o = setEnabled({}, find(tree, "Python/lsp:ruff:F401")!, false);
    expect(o).toEqual({ "lsp:ruff:F401": { enabled: false } });
    expect(checkState(o, ruff)).toBe("mixed");
    expect(checkState(o, python)).toBe("mixed");
    o = setEnabled(o, ruff, false);
    expect(checkState(o, ruff)).toBe("off");
    o = setEnabled(o, python, true);
    expect(o).toEqual({});
    expect(checkState(o, python)).toBe("on");
  });

  it("keeps severity and enabled overrides independent", () => {
    let o = setLevel({}, "lsp:ruff", "error");
    o = setEnabled(o, find(tree, "Python/lsp:ruff")!, false);
    expect(o["lsp:ruff"]).toEqual({ severity: "error", enabled: false });
    o = setLevel(o, "lsp:ruff", undefined);
    expect(o["lsp:ruff"]).toEqual({ enabled: false });
  });

  it("registers as Editor › Inspections", () => {
    expect(EDITOR_PAGES).toContain(INSPECTIONS_PAGE);
    expect(INSPECTIONS_PAGE.keywords).toContain("Weak Warning");
  });
});

describe("inspection profile management", () => {
  const base = validateInspections({ default: { a: { enabled: false } }, project: { b: { severity: "error" } } });

  it("copies at either level and selects the copy", () => {
    const s1 = copyProfile(base, "default", "Strict", "ide");
    expect(s1.profile).toBe("ide:strict");
    expect(s1.ideProfiles.strict).toEqual({ name: "Strict", overrides: { a: { enabled: false } } });
    expect(s1.default).toBe(base.default);
    const s2 = copyProfile(s1, "project", "Team", "project");
    expect(s2.profile).toBe("project:team");
    expect(s2.projectProfiles.team!.overrides).toEqual({ b: { severity: "error" } });
    // Copies are independent of their source.
    const s3 = withProfileOverrides(s2, "project:team", {});
    expect(s3.projectProfiles.team!.overrides).toEqual({});
    expect(s3.project).toEqual({ b: { severity: "error" } });
  });

  it("renames and deletes copies only", () => {
    const s1 = copyProfile(base, "default", "Strict", "ide");
    expect(renameProfile(s1, "ide:strict", " Lenient ").ideProfiles.strict!.name).toBe("Lenient");
    expect(renameProfile(s1, "default", "X")).toBe(s1);
    const s2 = deleteProfile(s1, "ide:strict");
    expect(s2.ideProfiles).toEqual({});
    expect(s2.profile).toBe("default");
    expect(deleteProfile(s1, "project")).toBe(s1);
    const s3 = deleteProfile(copyProfile(s1, "default", "Team", "project"), "project:team");
    expect(s3.profile).toBe("project");
  });

  it("registers Natural Languages › Spelling under Editor", () => {
    expect(EDITOR_PAGES).toContain(SPELLING_PAGE);
    expect(SPELLING_PAGE.id.startsWith(`${NATURAL_LANGUAGES_PAGE.id}.`)).toBe(true);
    expect(SPELLING_PAGE.keywords).toContain("accepted words");
  });
});

describe("inspection options and focus (issue #42)", () => {
  it("stores Typo options apart from defaults and keeps them through validation", () => {
    const off = setOption({}, "builtin:spelling", "processCode", false);
    expect(off).toEqual({ "builtin:spelling": { options: { processCode: false } } });
    expect(validateInspections({ default: off }).default).toEqual(off);
    expect(setOption(off, "builtin:spelling", "processCode", true)).toEqual({});
  });

  it("opens Settings on an inspection: page#id, ancestors to expand", () => {
    expect(splitPageTarget("editor.inspections#lsp:ruff:F401")).toEqual({
      pageId: "editor.inspections",
      focus: "lsp:ruff:F401",
    });
    expect(splitPageTarget("editor.general")).toEqual({ pageId: "editor.general", focus: null });
    const tree = buildInspectionTree([], []);
    const path = pathToInspection(tree, "builtin:spelling");
    expect(path).toEqual(["group:Proofreading", "Proofreading/builtin:spelling"]);
    expect(pathToInspection(tree, "nope")).toBeNull();
  });
});
