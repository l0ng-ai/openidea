import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings } from "../model/staging";
import { MCP_SERVER_PAGE } from "../pages/mcpServer";
import { BEHAVIOR_PAGES } from "../pages/behavior";
import { OptionsPage } from "../pages/OptionsPage";
import { optionLabels, pageLabels } from "../pages/registry";
import type { PageSpec } from "../pages/spec";

afterEach(cleanup);

const PAGE: PageSpec = {
  id: "test.dependentOptions",
  title: "Dependent options",
  order: 0,
  sections: [
    {
      options: [
        {
          kind: "toggle",
          key: "editor.inlayHints",
          label: "Parent",
          children: [
            { kind: "number", key: "editor.fontSize", label: "Size", min: 6, max: 72 },
            { kind: "text", key: "editor.fontFamily", label: "Family" },
            {
              kind: "select",
              key: "editor.colorScheme",
              label: "Scheme",
              options: [
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
              ],
            },
            {
              kind: "toggle",
              key: "editor.insertSpaces",
              label: "Nested",
              children: [{ kind: "number", key: "editor.tabSize", label: "Tab size", min: 1, max: 16 }],
            },
          ],
        },
        { kind: "number", key: "editor.lineHeight", label: "Line height", min: 1, max: 3, step: 0.1 },
      ],
    },
  ],
};

const TEST_PAGE_CONTEXT = { pageId: PAGE.id, scope: "global" } as const;

function renderPage(parent: boolean) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.editor.inlayHints = parent;
  settings.editor.insertSpaces = true;
  useProject.setState({ settings, project: null });
  openSettings(PAGE.id);
  render(
    <PageContext.Provider value={TEST_PAGE_CONTEXT}>
      <OptionsPage spec={PAGE} />
    </PageContext.Provider>,
  );
}

const dependents = () => [
  screen.getByRole("textbox", { name: "Size" }),
  screen.getByRole("textbox", { name: "Family" }),
  screen.getByRole("button", { name: "Scheme" }),
  screen.getByRole("checkbox", { name: "Nested" }),
  screen.getByRole("textbox", { name: "Tab size" }),
];

describe("dependent options of a checkbox", () => {
  it("are disabled while it is unchecked, nested ones included, and enabled once it is checked", () => {
    renderPage(false);
    for (const control of dependents()) expect(control).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Parent" }));
    for (const control of dependents()) expect(control).toBeEnabled();
  });

  it("leave the options outside the group enabled", () => {
    renderPage(false);
    expect(screen.getByRole("checkbox", { name: "Parent" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Line height" })).toBeEnabled();
  });

  it("put the fixed MCP port under its checkbox and keep it in both search indexes", () => {
    const fixedPort = MCP_SERVER_PAGE.sections!.flatMap((s) => s.options).find((o) => o.label === "Use a fixed port");
    expect(fixedPort).toMatchObject({ kind: "toggle", children: [{ key: "mcpServer.port", label: "Port" }] });
    expect(pageLabels(MCP_SERVER_PAGE.id)).toContain("Port");
    expect(optionLabels(MCP_SERVER_PAGE.id)).toContain("Port");
  });

  it("adjusts project color strength via slider and disables it when toolbar project colors are off", () => {
    const appearance = BEHAVIOR_PAGES.find((p) => p.id === "appearance")!;
    expect(pageLabels(appearance.id)).toContain("Project color strength");

    const settings = structuredClone(DEFAULT_SETTINGS);
    useProject.setState({ settings, project: null });
    openSettings(appearance.id);
    render(
      <PageContext.Provider value={{ pageId: appearance.id, scope: "global" }}>
        <OptionsPage spec={appearance} />
      </PageContext.Provider>,
    );

    const slider = screen.getByRole("slider", { name: "Project color strength" });
    const input = screen.getByRole("textbox", { name: "Project color strength" });
    expect(slider).toBeEnabled();
    expect(slider).toHaveValue("32");
    expect(input).toHaveValue("32");

    fireEvent.change(slider, { target: { value: "48" } });
    expect(input).toHaveValue("48");

    fireEvent.click(screen.getByRole("checkbox", { name: "Use project colors in main toolbar" }));
    expect(slider).toBeDisabled();
    expect(input).toBeDisabled();
  });
});
