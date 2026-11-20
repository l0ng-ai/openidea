import { afterEach, expect, it } from "vitest";
import { isIgnoredName } from "./ignoredNames";
import { useProject } from "./project";

const initial = useProject.getState();
afterEach(() => useProject.setState(initial, true));

function withNames(ignoredNames: string[]) {
  useProject.setState({ settings: { files: { ignoredNames } } } as never);
}

it("matches the defaults by exact name and by wildcard", () => {
  expect(isIgnoredName(".git")).toBe(true);
  expect(isIgnoredName("module.pyc")).toBe(true);
  expect(isIgnoredName("notes.txt~")).toBe(true);
  expect(isIgnoredName("module.py")).toBe(false);
  expect(isIgnoredName("pyc")).toBe(false);
});

it("anchors every wildcard and keeps other pattern characters literal", () => {
  withNames(["*.log", "build?", "a+b.(x)"]);
  expect(isIgnoredName("server.log")).toBe(true);
  expect(isIgnoredName("server.log.1")).toBe(false);
  expect(isIgnoredName("build1")).toBe(true);
  expect(isIgnoredName("build12")).toBe(false);
  expect(isIgnoredName("a+b.(x)")).toBe(true);
  expect(isIgnoredName("aab.x")).toBe(false);
});

it("follows the setting when it changes, and ignores entries with a path", () => {
  withNames(["dist", "out/*"]);
  expect(isIgnoredName("dist")).toBe(true);
  expect(isIgnoredName(".git")).toBe(false);
  expect(isIgnoredName("out")).toBe(false);
  withNames([]);
  expect(isIgnoredName("dist")).toBe(false);
});
