import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PRESETS, useKeymap, type Keymap } from "@/platform/keymap";
import { usePlatform } from "@/platform/platformInfo";
import { useProject } from "@/platform/project";
import { EmptyEditor } from "./EditorArea";

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll("dl > div")].map((row) => ({
    cells: [...row.children].map((c) => c.tagName),
    label: row.querySelector("dt")?.textContent,
    keys: row.querySelector("dd")?.textContent,
  }));

// The hint grid has two auto-placed columns; a row missing its key cell pulls the next label into it.
describe("empty editor hints", () => {
  const { os } = usePlatform.getState();
  const { preset: initialPreset } = useKeymap.getState();
  afterEach(() => {
    useKeymap.setState({ preset: initialPreset, overrides: {} });
    useProject.setState({ lightEdit: false });
    usePlatform.setState({ os });
  });

  const cases: Array<{ name: string; preset: string; overrides?: Keymap }> = [
    ...Object.keys(PRESETS).map((preset) => ({ name: preset, preset })),
    { name: "a removed Go to File binding", preset: "intellij-macos", overrides: { "navigate.gotoFile": [] } },
    {
      name: "a mouse-only Recent Files binding",
      preset: "intellij-windows",
      overrides: { "navigate.recentFiles": ["Button4"] },
    },
  ];

  for (const { name, preset, overrides = {} } of cases)
    for (const lightEdit of [false, true])
      it(`keeps a label and a key cell on every row with ${name}${lightEdit ? " in LightEdit" : ""}`, () => {
        useKeymap.setState({ preset, overrides });
        useProject.setState({ lightEdit });
        const all = rows(render(<EmptyEditor />).container);
        const last = all.pop();
        for (const row of all) expect(row.cells, row.label ?? "").toEqual(["DT", "DD"]);
        expect(last).toMatchObject({ cells: ["DT"], label: "Drop files here to open them" });
      });

  it("leaves Recent Files' key cell empty and Navigation Bar's shortcut beside it in VS Code (macOS)", () => {
    usePlatform.setState({ os: "macos" });
    useKeymap.setState({ preset: "vscode-macos", overrides: {} });
    const byLabel = Object.fromEntries(rows(render(<EmptyEditor />).container).map((r) => [r.label, r.keys]));
    expect(byLabel["Recent Files"]).toBe("");
    expect(byLabel["Navigation Bar"]).toBe("⇧⌘.");
  });
});
