import { describe, it, expect } from "vitest";
import { buildPresentation, moduleFolderIcon } from "./projectPresentation";
import type { BuildModel } from "./ipc";

const model = (partial: unknown) => ({ maven: null, gradle: null, ...(partial as object) }) as BuildModel;
describe("build presentation context", () => {
  it.each(["maven", "gradle"] as const)("uses distinct %s root and nested module glyphs", (tool) => {
    const modules = new Map([
      ["", tool],
      ["app", tool],
    ]);
    expect(moduleFolderIcon("", true, modules)).toBe(`${tool}-project`);
    expect(moduleFolderIcon("app", false, modules)).toBe(`${tool}-module`);
    expect(moduleFolderIcon("plain", false, modules)).toBeNull();
  });
  it("includes Maven aggregators and modules without source roots", () => {
    const context = buildPresentation(
      model({
        maven: {
          projects: [
            { dir: "", dependencies: [], plugins: [] },
            { dir: "app", dependencies: [{ groupId: "org.springframework.boot" }], plugins: [] },
          ],
        },
      }),
    );
    expect([...context.modules]).toEqual([
      ["", "maven"],
      ["app", "maven"],
    ]);
    expect(context.spring).toBe(true);
  });
  it("includes Gradle root and nested project directories", () => {
    const context = buildPresentation(
      model({
        gradle: {
          projects: [
            { dir: "", tasks: [] },
            { dir: "lib/core", tasks: [] },
          ],
        },
      }),
    );
    expect([...context.modules]).toEqual([
      ["", "gradle"],
      ["lib/core", "gradle"],
    ]);
    expect(context.spring).toBe(false);
  });
  it("detects Spring build plugins and Gradle Boot tasks", () => {
    expect(
      buildPresentation(
        model({
          maven: { projects: [{ dir: "", dependencies: [], plugins: [{ groupId: "org.springframework.boot" }] }] },
        }),
      ).spring,
    ).toBe(true);
    expect(buildPresentation(model({ gradle: { projects: [{ dir: "", tasks: [{ name: "bootRun" }] }] } })).spring).toBe(
      true,
    );
  });
  it("keeps plain folders plain", () => expect(buildPresentation(model({})).modules.size).toBe(0));
});
