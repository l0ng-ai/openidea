import { describe, it, expect } from "vitest";
import { buildPresentation, isModuleFolder, moduleFolderIcon } from "./projectPresentation";
import type { BuildModel } from "./ipc";

const model = (partial: unknown) => ({ maven: null, gradle: [], ...(partial as object) }) as BuildModel;
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
  it("marks nested module folders, not the project root or plain folders", () => {
    const modules = new Map<string, "maven" | "gradle">([
      ["", "maven"],
      ["core", "maven"],
      ["services/api", "gradle"],
    ]);
    expect(isModuleFolder("core", false, modules)).toBe(true);
    expect(isModuleFolder("services/api", false, modules)).toBe(true);
    expect(isModuleFolder("", true, modules)).toBe(false);
    expect(isModuleFolder("services", false, modules)).toBe(false);
    expect(isModuleFolder("core/src", false, modules)).toBe(false);
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
        gradle: [
          {
            projects: [
              { dir: "", tasks: [] },
              { dir: "lib/core", tasks: [] },
            ],
          },
        ],
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
    expect(
      buildPresentation(model({ gradle: [{ projects: [{ dir: "", tasks: [{ name: "bootRun" }] }] }] })).spring,
    ).toBe(true);
  });
  it("keeps plain folders plain", () => expect(buildPresentation(model({})).modules.size).toBe(0));
});

it("includes modules and Spring tasks from every independently linked Gradle build", () => {
  const context = buildPresentation(
    model({
      gradle: [
        {
          projects: [
            { dir: "first", tasks: [] },
            { dir: "first/app", tasks: [] },
          ],
        },
        { projects: [{ dir: "second", tasks: [{ name: "bootRun" }] }] },
      ],
    }),
  );
  expect([...context.modules.keys()]).toEqual(["first", "first/app", "second"]);
  expect(context.spring).toBe(true);
});
