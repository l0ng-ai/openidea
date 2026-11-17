import { expect, it } from "vitest";
import { mavenExternalRoots, resolveMavenDir } from "./mavenRoots";

it("resolves a sibling directory and keeps an absolute one", () => {
  expect(resolveMavenDir("/code/A", "../B")).toBe("/code/B");
  expect(resolveMavenDir("/code/A", "/code/B")).toBe("/code/B");
  expect(resolveMavenDir("/code/A", "core")).toBe("/code/A/core");
});

it("lists an external Maven project and not a module nested inside it", () => {
  const roots = mavenExternalRoots(
    [
      { dir: "", aggregated: false },
      { dir: "core", aggregated: true },
      { dir: "/code/B", aggregated: false },
      { dir: "/code/B/mod", aggregated: true },
      { dir: "/code/B/mod", aggregated: false },
    ],
    "/code/A",
  );
  expect(roots).toEqual([{ id: "mavenExternal:/code/B", label: "B", path: "/code/B", detail: "/code/B" }]);
});
