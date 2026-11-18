import { afterEach, describe, expect, it } from "vitest";
import type { ProjectInfo, Settings } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { textEditorWrapperFor, useTextEditorWrappers } from "@/workbench/contributions";
import { isHtmlPath, isWebPath, isWebResource } from "./browsers";
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
    expect(isWebPath(path)).toBe(expected);
  });

  it("keeps SVG files openable in a browser", () => {
    setFiles({});
    expect(isHtmlPath("/p/a.svg")).toBe(false);
    expect(isWebPath("/p/A.SVG")).toBe(true);
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
