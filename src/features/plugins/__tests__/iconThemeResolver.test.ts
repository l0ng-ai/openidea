import { describe, expect, it } from "vitest";
import { iconResolver, type IconThemeMap, type IconThemePattern } from "../iconThemeResolver";

const name = (icon: string) => `ext:p/t/${icon}`;
const HIDDEN = "ext:p/t/__hidden";

const SPEC: IconThemePattern = {
  pattern: "^.*\\.spec\\.ts$",
  icon: "test",
  target: "file",
  path: false,
  ignoreCase: true,
  group: null,
  openIcon: null,
};

const MAP: IconThemeMap = {
  file: "file",
  folder: "folder",
  folderOpen: "folder-open",
  fileExtensions: { ts: "ts" },
  fileNames: { "readme.md": "readme" },
  folderNames: { docs: "folder-docs" },
  patterns: [
    SPEC,
    {
      pattern: "/fixtures/",
      icon: "fixture",
      target: "file",
      path: true,
      ignoreCase: false,
      group: "extra",
      openIcon: null,
    },
    {
      pattern: "^src$",
      icon: "folder-src",
      target: "folder",
      path: false,
      ignoreCase: false,
      group: null,
      openIcon: "folder-src-open",
    },
    {
      pattern: "^angular\\.json$",
      icon: "angular",
      target: "file",
      path: false,
      ignoreCase: false,
      group: "angular",
      openIcon: null,
    },
  ],
  overrides: { "chevron-right": "arrow", "symbol-class": "klass", folder: "ui-folder", method: "meth" },
  groups: [
    { id: "extra", name: "Extra", enabled: true },
    { id: "angular", name: "Angular", enabled: false },
  ],
  choices: [
    {
      id: "arrows",
      name: "Arrows",
      default: "plain",
      options: [
        { id: "plain", name: "Default", overrides: {} },
        { id: "plus", name: "Plus", overrides: { "chevron-right": "plus" } },
      ],
    },
  ],
  accent: true,
};

const resolve = (options = {}) => iconResolver(MAP, name, () => true, { hidden: HIDDEN, options });

describe("icon theme resolver", () => {
  it("matches patterns in order before names and extensions", () => {
    const theme = resolve();
    expect(theme.file("A.SPEC.ts")).toBe(name("test"));
    expect(theme.file("a.ts")).toBe(name("ts"));
    expect(theme.file("README.md")).toBe(name("readme"));
    expect(theme.file("x.bin")).toBe(name("file"));
  });

  it("matches path patterns against the normalized path only when one is given", () => {
    const theme = resolve();
    expect(theme.file("a.json", "C:\\p\\fixtures\\a.json")).toBe(name("fixture"));
    expect(theme.file("a.json", "/p/fixtures/a.json")).toBe(name("fixture"));
    expect(theme.file("a.json")).toBe(name("file"));
    expect(theme.file("a.json", "/p/src/a.json")).toBe(name("file"));
  });

  it("follows the groups' defaults and the user's choice of packs", () => {
    expect(resolve().file("angular.json")).toBe(name("file"));
    expect(resolve({ groups: { angular: true } }).file("angular.json")).toBe(name("angular"));
    expect(resolve({ groups: { extra: false } }).file("a.json", "/p/fixtures/a.json")).toBe(name("file"));
  });

  it("uses the open variants for folders holding open files only with hollow folders", () => {
    expect(resolve().folder("src", false, true)).toBe(name("folder-src"));
    expect(resolve({ hollowFolders: true }).folder("src", false, true)).toBe(name("folder-src-open"));
    expect(resolve({ hollowFolders: true }).folder("src", true, false)).toBe(name("folder-src"));
    expect(resolve({ hollowFolders: true }).folder("lib", false, true)).toBe(name("folder-open"));
    expect(resolve().folder("Docs", false)).toBe(name("folder-docs"));
    expect(resolve().folder("lib", true)).toBe(name("folder"));
  });

  it("hides file or folder icons", () => {
    expect(resolve({ hideFiles: true }).file("a.ts")).toBe(HIDDEN);
    expect(resolve({ hideFiles: true }).folder("src", false)).toBe(name("folder-src"));
    expect(resolve({ hideFolders: true }).folder("src", false)).toBe(HIDDEN);
  });

  it("replaces built-in icons, the chosen option first", () => {
    expect(resolve().icon("chevron-right")).toBe(name("arrow"));
    expect(resolve().icon("symbol-class")).toBe(name("klass"));
    expect(resolve({ choices: { arrows: "plus" } }).icon("chevron-right")).toBe(name("plus"));
    expect(resolve({ choices: { arrows: "gone" } }).icon("chevron-right")).toBe(name("arrow"));
    expect(resolve().icon("terminal")).toBeNull();
  });

  it("drops the UI or the symbol icon replacements the user turned off", () => {
    const noUi = resolve({ hideUiIcons: true, choices: { arrows: "plus" } });
    expect(noUi.icon("chevron-right")).toBeNull();
    expect(noUi.icon("folder")).toBeNull();
    expect(noUi.icon("symbol-class")).toBe(name("klass"));
    const noPsi = resolve({ hidePsiIcons: true });
    expect(noPsi.icon("symbol-class")).toBeNull();
    expect(noPsi.icon("method")).toBeNull();
    expect(noUi.icon("method")).toBe(name("meth"));
    expect(noPsi.icon("folder")).toBe(name("ui-folder"));
  });

  it("skips icons the theme does not have and patterns the browser cannot compile", () => {
    const map: IconThemeMap = {
      ...MAP,
      patterns: [
        { ...SPEC, pattern: "(" },
        { ...SPEC, icon: "missing" },
      ],
    };
    const theme = iconResolver(map, name, (n) => n !== name("missing"), { hidden: HIDDEN, options: {} });
    expect(theme.file("a.spec.ts")).toBe(name("ts"));
  });
});
