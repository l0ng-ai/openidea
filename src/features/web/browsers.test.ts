import { afterEach, describe, expect, it } from "vitest";
import type { ProjectInfo, Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { menuGroupItems, textEditorWrapperFor, useTextEditorWrappers } from "@/workbench/contributions";
import { isHtmlPath, isWebPagePath, isWebPath, isWebResource } from "./browsers";
import { activate } from "./index";

const types = (patterns: string[], removedPatterns: string[] = []) => ({ patterns, removedPatterns, hashbangs: [] });
const setFiles = (files: object) =>
  useProject.setState({ project: { root: "/p" } as ProjectInfo, settings: { files } as Settings });
const toFoo = { fileTypes: { html: types(["*.foo"]) } };
const movedAway = { fileTypes: { html: types([], ["*.html"]), plaintext: types(["*.html"]) } };

afterEach(() => useProject.setState({ project: null, settings: null }));

describe("HTML files follow File Types", () => {
  it.each<[string, object, string, boolean]>([
    ["default .html", {}, "/p/a.html", true],
    ["default .htm", {}, "/p/a.htm", true],
    ["default .xhtml", {}, "/p/a.xhtml", true],
    ["default .shtml", {}, "/p/a.shtml", true],
    ["upper-case default", {}, "/p/A.HTML", true],
    ["no association", {}, "/p/a.foo", false],
    ["a name without a dot", {}, "/p/html", false],
    ["added extension", toFoo, "/p/a.foo", true],
    ["added extension, other case", toFoo, "/p/A.FOO", true],
    ["added file name", { fileTypes: { html: types(["PAGE"]) } }, "/p/PAGE", true],
    ["added glob", { fileTypes: { html: types(["page.*"]) } }, "/p/page.txt", true],
    ["extension given to another language", { fileTypes: { plaintext: types(["*.foo"]) } }, "/p/a.foo", false],
    ["*.html moved to another language", movedAway, "/p/a.html", false],
    ["*.html removed", { fileTypes: { html: types([], ["*.html"]) } }, "/p/a.html", false],
    ["*.html removed keeps the others", { fileTypes: { html: types([], ["*.html"]) } }, "/p/a.htm", true],
    ["override to HTML", { fileTypeOverrides: { "docs/a.txt": "html" } }, "/p/docs/a.txt", true],
    ["override outside the project", { fileTypeOverrides: { "/x/a.txt": "html" } }, "/x/a.txt", true],
    ["override to Django Template", { fileTypeOverrides: { "a.html": "django-html" } }, "/p/a.html", true],
    ["override away from HTML", { fileTypeOverrides: { "a.html": "plaintext" } }, "/p/a.html", false],
    ["override beats a pattern", { ...toFoo, fileTypeOverrides: { "a.foo": "plaintext" } }, "/p/a.foo", false],
  ])("%s", (_name, files, path, expected) => {
    setFiles(files);
    expect(isHtmlPath(path)).toBe(expected);
  });

  it.each<[string, object, string, boolean, boolean]>([
    ["default .html", {}, "/p/a.html", true, true],
    ["default .shtml", {}, "/p/a.shtml", true, true],
    ["no association", {}, "/p/a.foo", false, false],
    ["a name without a dot", {}, "/p/html", false, false],
    ["added extension", toFoo, "/p/a.foo", true, true],
    ["override to HTML", { fileTypeOverrides: { "a.txt": "html" } }, "/p/a.txt", true, true],
    ["*.html moved to another language", movedAway, "/p/a.html", false, true],
    ["*.html moved, other case", movedAway, "/p/A.HTML", false, true],
    ["*.html removed", { fileTypes: { html: types([], ["*.html"]) } }, "/p/a.html", false, true],
    ["override away from HTML", { fileTypeOverrides: { "a.html": "plaintext" } }, "/p/a.html", false, true],
    ["override of .shtml", { fileTypeOverrides: { "a.shtml": "php" } }, "/p/a.shtml", false, true],
    [
      "override of another file type",
      { ...toFoo, fileTypeOverrides: { "a.foo": "plaintext" } },
      "/p/a.foo",
      false,
      false,
    ],
  ])("a browser can open: %s", (_name, files, path, html, page) => {
    setFiles(files);
    expect(isHtmlPath(path)).toBe(html);
    expect(isWebPagePath(path)).toBe(page);
    expect(isWebPath(path)).toBe(page);
  });

  it("keeps SVG files openable in a browser, without the page menu item", () => {
    setFiles({});
    expect(isHtmlPath("/p/a.svg")).toBe(false);
    expect(isWebPagePath("/p/a.svg")).toBe(false);
    expect(isWebPath("/p/A.SVG")).toBe(true);
  });

  it("offers a retyped page in the browser menus without the preview", () => {
    setFiles(movedAway);
    const off = activate();
    try {
      const context = { paths: ["/p/a.html"], dirs: [false] };
      const direct = menuGroupItems("projectView", context).filter(
        (i) => "action" in i && i.action === "web.openInBrowser",
      );
      expect(direct).toHaveLength(1);
      const browser = menuGroupItems("openIn", context).find((i) => "label" in i && i.label === "Browser");
      const labels = (browser as { submenu: { label?: string }[] }).submenu.map((i) => i.label);
      expect(labels).toContain("Default Browser");
      expect(labels).not.toContain("Built-in Preview");
    } finally {
      off();
    }
  });

  it("updates open tabs only when File Types change", () => {
    const off = activate();
    const wrappers = () => useTextEditorWrappers.getState().wrappers;
    try {
      setFiles({});
      const before = wrappers();
      expect(textEditorWrapperFor(before, "/p/a.foo")).toBeUndefined();

      setFiles({ autoSave: true });
      expect(wrappers()).toBe(before);

      setFiles(toFoo);
      expect(wrappers()).not.toBe(before);
      expect(textEditorWrapperFor(wrappers(), "/p/a.foo")?.id).toBe("web.html");

      setFiles(movedAway);
      expect(textEditorWrapperFor(wrappers(), "/p/a.html")).toBeUndefined();
    } finally {
      off();
    }
  });
});

describe("web resources", () => {
  it("are what a page loads, so the built-in preview reloads for them only", () => {
    for (const path of ["/p/index.html", "/p/app.css", "/p/main.js", "/p/data.json", "/p/logo.svg", "/p/a.woff2"])
      expect(isWebResource(path), path).toBe(true);
    for (const path of ["/p/notes.txt", "/p/README.md", "/p/src/Main.java"])
      expect(isWebResource(path), path).toBe(false);
  });
});
