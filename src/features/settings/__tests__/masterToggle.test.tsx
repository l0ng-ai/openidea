import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { PageContext } from "../components/context";
import { DEFAULT_SETTINGS } from "../model/schema";
import { openSettings } from "../model/staging";
import { OptionsPage } from "../pages/OptionsPage";
import { pageLabels } from "../pages/registry";
import type { PageSpec } from "../pages/spec";
import { VCS_PAGES } from "../pages/vcs";

afterEach(cleanup);

const PAGE: PageSpec = {
  id: "test.masterToggle",
  title: "Master toggle",
  order: 0,
  master: { key: "vcs.git.enabled", label: "Enable Git integration", scope: "global" },
  sections: [
    { options: [{ kind: "text", key: "editor.fontFamily", label: "Family" }] },
    {
      title: "More",
      options: [
        { kind: "toggle", key: "editor.insertSpaces", label: "Spaces" },
        { kind: "number", key: "editor.tabSize", label: "Tab size", min: 1, max: 16 },
      ],
    },
  ],
};

function renderPage(enabled: boolean) {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), vcs: { git: { enabled } } } as typeof DEFAULT_SETTINGS;
  useProject.setState({ settings, project: null });
  openSettings(PAGE.id);
  render(
    <PageContext.Provider value={{ pageId: PAGE.id, scope: "project" }}>
      <OptionsPage spec={PAGE} />
    </PageContext.Provider>,
  );
}

const gated = () => [
  screen.getByRole("textbox", { name: "Family" }),
  screen.getByRole("checkbox", { name: "Spaces" }),
  screen.getByRole("textbox", { name: "Tab size" }),
];

describe("a page's master checkbox", () => {
  it("disables every option below it while it is unchecked, and enables them once it is checked", () => {
    renderPage(false);
    const master = screen.getByRole("checkbox", { name: "Enable Git integration" });
    expect(master).toBeEnabled();
    expect(master).not.toBeChecked();
    for (const control of gated()) {
      expect(control).toBeDisabled();
      expect(control.closest("[inert]")).not.toBeNull();
    }
    fireEvent.click(master);
    for (const control of gated()) {
      expect(control).toBeEnabled();
      expect(control.closest("[inert]")).toBeNull();
    }
  });

  it("leaves the options enabled while it is checked", () => {
    renderPage(true);
    expect(screen.getByRole("checkbox", { name: "Enable Git integration" })).toBeChecked();
    for (const control of gated()) expect(control).toBeEnabled();
  });

  it("switches the Git page and is found by search", () => {
    const git = VCS_PAGES.find((p) => p.id === "vcs.git")!;
    expect(git.master).toMatchObject({ key: "vcs.git.enabled", label: "Enable Git integration", scope: "global" });
    expect(pageLabels(git.id)).toContain("Enable Git integration");
  });
});
